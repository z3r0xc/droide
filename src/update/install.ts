/**
 * Installing a release.
 *
 * Contract: `docs/adr/0009-update-installation.md`, with the command surface
 * from `specs/10-cli-surface.md` §B75. The release document is the one
 * `--check` just read (ADR 0007); this module never chooses a feed.
 *
 * The sequence is fixed:
 *
 * 1. resolve the release's `sha256` asset and the archive for this platform;
 *    a release that publishes either without the other is refused, never
 *    "trusted because it came over HTTPS";
 * 2. stream the archive into `<installDir>/update/<version>/`, hashing while
 *    writing, then compare the digest in constant time;
 * 3. extract beside the download and stage the tree;
 * 4. move the current entries aside to `<installDir>/.old-<version>` and the
 *    staged entries into place (rename inside one directory, never a copy);
 * 5. run the probe once; a probe that fails restores `.old-<version>` and the
 *    install is reported as failed.
 *
 * One writer at a time: a lock file in the update directory, opened with
 * `wx` (O_EXCL), released in `finally`, and considered stale after one hour so
 * a crashed process cannot wedge the command forever.
 *
 * Nothing here elevates: an installation directory the process cannot write
 * produces a typed refusal naming the exact path. Every outside effect
 * (`fetch`, `fs`, the clock, the probe) is injected, so tests never open a
 * socket, never spawn a process and never touch the real installation.
 */
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { isRecord } from "../extensions/guards.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A release asset as the GitHub release document describes it. */
export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

/** The part of a release document installation needs. */
export interface ReleaseDocument {
  /** The tag, `v`-prefixed or not. */
  readonly tag: string;
  readonly pageUrl: string | null;
  readonly assets: readonly ReleaseAsset[];
}

/** The platforms a release archive names. */
export type UpdatePlatform = "win32" | "darwin" | "linux";

/** The subset of `node:fs/promises` the installer uses, so tests can pin it. */
export interface InstallFileHandle {
  write(chunk: Uint8Array): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface InstallStat {
  readonly mtimeMs: number;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

export interface InstallFs {
  readonly mkdir: (
    path: string,
    options: { readonly recursive: true },
  ) => Promise<unknown>;
  readonly open: (
    path: string,
    flags: "r" | "w" | "wx",
  ) => Promise<InstallFileHandle>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (
    path: string,
    data: string | Uint8Array,
  ) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly stat: (path: string) => Promise<InstallStat>;
}

/** What a probe is asked about the freshly installed tree. */
export interface InstallProbeInput {
  readonly installDir: string;
  readonly version: string;
  /** The installed executable, or `null` when the tree has none to run. */
  readonly executable: string | null;
}

export type InstallProbeResult =
  | { readonly status: "passed" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly detail: string };

export type InstallProbe = (
  input: InstallProbeInput,
) => Promise<InstallProbeResult>;

export interface InstallReleaseOptions {
  readonly release: ReleaseDocument;
  /** Everything the installer downloads goes through this. */
  readonly fetch: typeof fetch;
  /** Where the currently installed tree lives; also the staging root. */
  readonly installDir: string;
  readonly fs?: InstallFs;
  /** Milliseconds since the epoch; decides lock staleness. */
  readonly clock?: () => number;
  /** Default: run `<bin> --version`, bounded to 15 s. */
  readonly probe?: InstallProbe;
  readonly platform?: UpdatePlatform;
  readonly arch?: string;
}

export interface InstallReleaseResult {
  readonly version: string;
  readonly installDir: string;
  readonly archive: string;
  readonly executable: string | null;
  readonly probe: "passed" | "skipped";
  /** Set when the probe was skipped, so the command can say why. */
  readonly probeNote?: string;
}

export type UpdateInstallErrorCode =
  | "invalid-release"
  | "missing-sha256-asset"
  | "missing-platform-asset"
  | "missing-digest-entry"
  | "version-mismatch"
  | "not-installed"
  | "not-writable"
  | "locked"
  | "download-failed"
  | "truncated-download"
  | "checksum-mismatch"
  | "corrupt-archive"
  | "unsafe-archive"
  | "stage-failed"
  | "swap-failed"
  | "probe-failed";

export class UpdateInstallError extends Error {
  readonly code: UpdateInstallErrorCode;

  constructor(
    code: UpdateInstallErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "UpdateInstallError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Staging lives under the installation, beside it on the same device. */
export const UPDATE_DIR_NAME = "update";
export const STAGED_DIR_NAME = "staged";
/** The lock file, opened `wx` so the OS enforces one holder. */
export const UPDATE_LOCK_NAME = ".lock";
/** A lock older than this is left over from a crash, not a live install. */
export const UPDATE_LOCK_STALE_MS = 60 * 60 * 1000;
/** The rollback probe's budget (ADR 0009 §4). */
export const PROBE_TIMEOUT_MS = 15_000;
/** The digest document is a few lines; anything large is not one. */
export const MAX_DIGEST_BYTES = 64 * 1024;
/** No release is expected to be larger than this. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Asset names a release may use for its checksum document. */
export const DIGEST_ASSET_NAMES = [
  "sha256",
  "sha256.txt",
  "sha256sums.txt",
  "checksums.txt",
] as const;

const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar"] as const;
const RESERVED_ENTRIES = [UPDATE_DIR_NAME] as const;
const OLD_PREFIX = ".old-";

// ---------------------------------------------------------------------------
// Release document and asset selection
// ---------------------------------------------------------------------------

/** Parse a GitHub release document; `null` when it is not one. */
export function parseReleaseDocument(payload: unknown): ReleaseDocument | null {
  if (!isRecord(payload)) return null;
  const tag = payload.tag_name;
  if (typeof tag !== "string" || tag.length === 0) return null;
  const assets: ReleaseAsset[] = [];
  const rawAssets = payload.assets;
  if (rawAssets !== undefined) {
    if (!Array.isArray(rawAssets)) return null;
    for (const raw of rawAssets) {
      if (!isRecord(raw)) continue;
      const name = raw.name;
      const url = raw.browser_download_url ?? raw.url;
      if (typeof name !== "string" || typeof url !== "string") continue;
      assets.push({ name, url });
    }
  }
  const pageUrl =
    typeof payload.html_url === "string" ? payload.html_url : null;
  return { tag, pageUrl, assets };
}

function semverOf(value: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(value.trim());
  return match?.[1] ?? null;
}

function platformAliases(platform: UpdatePlatform): readonly string[] {
  switch (platform) {
    case "win32":
      return ["win32", "windows"];
    case "darwin":
      return ["darwin", "macos", "mac"];
    case "linux":
      return ["linux"];
  }
}

/** The canonical archive name a release is expected to publish. */
export function archiveAssetName(
  version: string,
  platform: UpdatePlatform,
  arch: string,
): string {
  return `droide-${semverOf(version) ?? version}-${platform}-${arch}.tar.gz`;
}

function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function findDigestAsset(assets: readonly ReleaseAsset[]): ReleaseAsset | null {
  for (const asset of assets) {
    const lower = asset.name.toLowerCase();
    if (
      (DIGEST_ASSET_NAMES as readonly string[]).some(
        (known) => lower === known.toLowerCase(),
      )
    ) {
      return asset;
    }
  }
  return null;
}

function findPlatformArchive(
  assets: readonly ReleaseAsset[],
  version: string,
  platform: UpdatePlatform,
  arch: string,
): ReleaseAsset | null {
  const canonical = archiveAssetName(version, platform, arch);
  const exact = assets.find(
    (asset) => asset.name.toLowerCase() === canonical.toLowerCase(),
  );
  if (exact !== undefined) return exact;

  const aliases = platformAliases(platform);
  const candidates = assets.filter((asset) => {
    if (!isArchiveName(asset.name)) return false;
    const lower = asset.name.toLowerCase();
    const hasPlatform = aliases.some((alias) => lower.includes(`-${alias}-`));
    const hasArch = lower.includes(`-${arch.toLowerCase()}`);
    return hasPlatform && hasArch;
  });
  if (candidates.length > 0) return candidates[0] ?? null;

  const platformOnly = assets.filter((asset) => {
    if (!isArchiveName(asset.name)) return false;
    const lower = asset.name.toLowerCase();
    return aliases.some((alias) => lower.includes(`-${alias}-`));
  });
  if (platformOnly.length === 1) return platformOnly[0] ?? null;
  return null;
}

interface ResolvedAssets {
  readonly archive: ReleaseAsset;
  readonly digest: ReleaseAsset;
}

function resolveAssets(
  release: ReleaseDocument,
  platform: UpdatePlatform,
  arch: string,
): ResolvedAssets {
  const version = semverOf(release.tag);
  if (version === null) {
    throw new UpdateInstallError(
      "invalid-release",
      `release tag ${release.tag} is not a semantic version; nothing was installed`,
    );
  }
  const digest = findDigestAsset(release.assets);
  if (digest === null) {
    throw new UpdateInstallError(
      "missing-sha256-asset",
      `release ${release.tag} publishes no sha256 asset; refusing to install without a digest`,
    );
  }
  const archive = findPlatformArchive(release.assets, version, platform, arch);
  if (archive === null) {
    throw new UpdateInstallError(
      "missing-platform-asset",
      `release ${release.tag} has no ${platform}-${arch} archive (expected ${archiveAssetName(version, platform, arch)})`,
    );
  }
  if (
    archive.name === "" ||
    archive.name === "." ||
    archive.name === ".." ||
    /[\\/]/.test(archive.name)
  ) {
    throw new UpdateInstallError(
      "unsafe-archive",
      `release asset ${JSON.stringify(archive.name)} is not a plain file name; nothing was installed`,
    );
  }
  const embedded = /(\d+\.\d+\.\d+)/.exec(archive.name)?.[0] ?? null;
  if (embedded !== null && embedded !== version) {
    throw new UpdateInstallError(
      "version-mismatch",
      `release ${release.tag} publishes ${archive.name} for version ${embedded}; refusing to install it`,
    );
  }
  return { archive, digest };
}

// ---------------------------------------------------------------------------
// Digest document
// ---------------------------------------------------------------------------

export interface DigestEntry {
  readonly sha256: string;
  /** The file the line names, or `null` for a bare digest. */
  readonly name: string | null;
}

/** Parse `sha256sum`-style lines: hex, whitespace, optional `*` and name. */
export function parseDigestDocument(text: string): readonly DigestEntry[] {
  const entries: DigestEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line);
    if (match === null) continue;
    const hex = match[1];
    if (hex === undefined) continue;
    const name = match[2] === undefined ? null : match[2].trim();
    entries.push({ sha256: hex.toLowerCase(), name });
  }
  return entries;
}

/** The digest for `archiveName`; refuses when the document omits it. */
export function findDigestFor(
  entries: readonly DigestEntry[],
  archiveName: string,
  releaseTag: string,
): string {
  const wanted = archiveName.toLowerCase();
  const named = entries.find(
    (entry) => entry.name !== null && entry.name.toLowerCase() === wanted,
  );
  if (named !== undefined) return named.sha256;
  const basenamed = entries.find((entry) => {
    if (entry.name === null) return false;
    const parts = entry.name.split(/[\\/]/);
    return (parts[parts.length - 1] ?? "").toLowerCase() === wanted;
  });
  if (basenamed !== undefined) return basenamed.sha256;
  const bare = entries.filter((entry) => entry.name === null);
  if (bare.length === 1 && bare[0] !== undefined) return bare[0].sha256;
  throw new UpdateInstallError(
    "missing-digest-entry",
    `the sha256 asset for ${releaseTag} does not list ${archiveName}; nothing was installed`,
  );
}

// ---------------------------------------------------------------------------
// Filesystem adapter
// ---------------------------------------------------------------------------

/** `node:fs/promises`, narrowed to {@link InstallFs}. */
export const defaultInstallFs: InstallFs = {
  mkdir: (path, options) => mkdir(path, options),
  open: (path, flags) => open(path, flags),
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeFile(path, data),
  rename: (from, to) => rename(from, to),
  rm: (path, options) => rm(path, options),
  chmod: (path, mode) => chmod(path, mode),
  stat: (path) => stat(path),
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Filesystem refusals that mean "you may not write here", not "bug". */
const NOT_WRITABLE_CODES: Readonly<Record<string, true>> = {
  EACCES: true,
  EPERM: true,
  EROFS: true,
  ENOTDIR: true,
  EEXIST: true,
};

function notWritable(installDir: string, error: unknown): UpdateInstallError {
  return new UpdateInstallError(
    "not-writable",
    `cannot write to the installation directory ${installDir} (${describeError(error)}); the update was not installed. Re-run it from an account that owns that directory — this command never elevates privileges.`,
    { cause: error },
  );
}

async function exists(
  fs: InstallFs,
  path: string,
): Promise<InstallStat | null> {
  try {
    return await fs.stat(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

interface LockHandle {
  release(): Promise<void>;
}

async function releaseQuietly(fs: InstallFs, path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch {
    // A lock we cannot remove is stale after an hour; never mask the install.
  }
}

async function acquireLock(
  fs: InstallFs,
  updateDir: string,
  now: number,
): Promise<LockHandle> {
  const lockPath = join(updateDir, UPDATE_LOCK_NAME);
  const tryOpen = async (): Promise<LockHandle | null> => {
    let handle: InstallFileHandle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (errorCode(error) === "EEXIST") return null;
      throw error;
    }
    try {
      await handle.write(Buffer.from(`${now}\n`, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { release: () => releaseQuietly(fs, lockPath) };
  };

  const first = await tryOpen();
  if (first !== null) return first;

  const stat = await exists(fs, lockPath);
  const age = stat === null ? Number.POSITIVE_INFINITY : now - stat.mtimeMs;
  if (age <= UPDATE_LOCK_STALE_MS) {
    throw new UpdateInstallError(
      "locked",
      `another update is already running (lock file ${lockPath}); if no update is running, delete that file and retry`,
    );
  }
  await releaseQuietly(fs, lockPath);
  const second = await tryOpen();
  if (second !== null) return second;
  throw new UpdateInstallError(
    "locked",
    `another update is already running (lock file ${lockPath}); if no update is running, delete that file and retry`,
  );
}

// ---------------------------------------------------------------------------
// Download and verification
// ---------------------------------------------------------------------------

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new UpdateInstallError(
          "download-failed",
          `the digest asset exceeds ${limit} bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

async function fetchDigestDocument(
  asset: ReleaseAsset,
  fetchImpl: typeof fetch,
): Promise<readonly DigestEntry[]> {
  let response: Response;
  try {
    response = await fetchImpl(asset.url, {
      headers: {
        accept: "text/plain",
        "user-agent": "droide-updater",
      },
    });
  } catch (error) {
    throw new UpdateInstallError(
      "download-failed",
      `could not download ${asset.name} (${describeError(error)}); nothing was installed`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new UpdateInstallError(
      "download-failed",
      `downloading ${asset.name} answered ${response.status}; nothing was installed`,
    );
  }
  return parseDigestDocument(await readBoundedText(response, MAX_DIGEST_BYTES));
}

async function writeAll(
  handle: InstallFileHandle,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk.subarray(offset));
    if (bytesWritten <= 0) {
      throw new UpdateInstallError(
        "download-failed",
        "the download stopped making progress; nothing was installed",
      );
    }
    offset += bytesWritten;
  }
}

function constantTimeEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/** Stream one asset to `destination`, hashing and verifying as it writes. */
async function downloadVerified(
  fs: InstallFs,
  fetchImpl: typeof fetch,
  asset: ReleaseAsset,
  destination: string,
  expectedHex: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(asset.url, {
      headers: {
        accept: "application/octet-stream",
        "user-agent": "droide-updater",
      },
    });
  } catch (error) {
    throw new UpdateInstallError(
      "download-failed",
      `could not download ${asset.name} (${describeError(error)}); nothing was installed`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new UpdateInstallError(
      "download-failed",
      `downloading ${asset.name} answered ${response.status}; nothing was installed`,
    );
  }
  const body = response.body;
  if (body === null) {
    throw new UpdateInstallError(
      "truncated-download",
      `${asset.name} arrived with no body; nothing was installed`,
    );
  }
  const declared = response.headers.get("content-length");
  const declaredBytes =
    declared === null || declared.trim() === "" ? null : Number(declared);

  const hash = createHash("sha256");
  let written = 0;
  let handle: InstallFileHandle | null = null;
  try {
    handle = await fs.open(destination, "w");
    const reader = body.getReader();
    try {
      for (;;) {
        let next: {
          readonly done: boolean;
          readonly value?: Uint8Array | undefined;
        };
        try {
          next = await reader.read();
        } catch (error) {
          throw new UpdateInstallError(
            "truncated-download",
            `the download of ${asset.name} stopped after ${written} bytes (${describeError(error)}); nothing was installed`,
            { cause: error },
          );
        }
        if (next.done) break;
        const value = next.value;
        if (value === undefined) continue;
        written += value.byteLength;
        if (written > MAX_ARCHIVE_BYTES) {
          await reader.cancel();
          throw new UpdateInstallError(
            "download-failed",
            `${asset.name} exceeds ${MAX_ARCHIVE_BYTES} bytes; nothing was installed`,
          );
        }
        hash.update(value);
        await writeAll(handle, value);
      }
    } finally {
      reader.releaseLock();
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof UpdateInstallError) throw error;
    throw new UpdateInstallError(
      "download-failed",
      `could not write ${destination} (${describeError(error)}); nothing was installed`,
      { cause: error },
    );
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // The download already failed or finished; closing is best effort.
      }
    }
  }

  if (
    declaredBytes !== null &&
    Number.isFinite(declaredBytes) &&
    declaredBytes >= 0 &&
    written !== declaredBytes
  ) {
    await fs.rm(destination, { recursive: true, force: true });
    throw new UpdateInstallError(
      "truncated-download",
      `${asset.name} was truncated at ${written} of ${declaredBytes} bytes; nothing was installed`,
    );
  }

  const expected = Buffer.from(expectedHex, "hex");
  if (!constantTimeEquals(hash.digest(), expected)) {
    await fs.rm(destination, { recursive: true, force: true });
    throw new UpdateInstallError(
      "checksum-mismatch",
      `${asset.name} does not match its published sha256; the download was discarded and nothing was installed`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tar extraction
// ---------------------------------------------------------------------------

interface TarEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Permission bits from the header, masked to `0o777`. */
  readonly mode: number;
  readonly data: Uint8Array;
}

function corrupt(message: string): UpdateInstallError {
  return new UpdateInstallError(
    "corrupt-archive",
    `${message}; nothing was installed`,
  );
}

function unsafe(message: string): UpdateInstallError {
  return new UpdateInstallError(
    "unsafe-archive",
    `${message}; nothing was installed`,
  );
}

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function readTarString(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const slice = bytes.subarray(start, start + length);
  let end = 0;
  while (end < slice.byteLength && byteAt(slice, end) !== 0) end += 1;
  return new TextDecoder().decode(slice.subarray(0, end)).trim();
}

function readTarOctal(
  bytes: Uint8Array,
  start: number,
  length: number,
): number {
  const text = readTarString(bytes, start, length).replace(/\0/g, "").trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) throw corrupt("an archive header has a bad size");
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function verifyTarChecksum(header: Uint8Array): void {
  const recorded = readTarOctal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : byteAt(header, index);
  }
  if (sum !== recorded) throw corrupt("an archive header failed its checksum");
}

function safeArchivePath(raw: string): string {
  const cleaned = raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (cleaned === "") throw unsafe("an archive entry has an empty path");
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw unsafe(`archive entry ${raw} has an absolute path`);
  }
  const segments = cleaned.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw unsafe(`archive entry ${raw} escapes the installation directory`);
  }
  return segments.join("/");
}

function parseTar(bytes: Uint8Array): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    verifyTarChecksum(header);
    const size = readTarOctal(header, 124, 12);
    const type = String.fromCharCode(byteAt(header, 156));
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength)
      throw corrupt("an archive entry runs past the end of the file");
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "L") {
      pendingLongName = readTarString(data, 0, data.byteLength);
    } else if (type === "x" || type === "g") {
      // Extended headers carry metadata this installer does not need.
    } else if (type === "1" || type === "2") {
      throw unsafe(
        "the archive contains a link, which this installer never creates",
      );
    } else {
      const full =
        pendingLongName ?? (prefix === "" ? name : `${prefix}/${name}`);
      const path = safeArchivePath(full);
      const mode = readTarOctal(header, 100, 8) & 0o777;
      if (type === "5") {
        entries.push({
          path,
          kind: "directory",
          mode: mode === 0 ? 0o755 : mode,
          data: new Uint8Array(0),
        });
      } else if (type === "0" || type === "\0" || type === "7") {
        entries.push({
          path,
          kind: "file",
          mode: mode === 0 ? 0o644 : mode,
          data,
        });
      } else {
        throw unsafe(
          `the archive contains an unsupported entry type ${JSON.stringify(type)}`,
        );
      }
      pendingLongName = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function decompress(bytes: Uint8Array): Uint8Array {
  if (byteAt(bytes, 0) === 0x1f && byteAt(bytes, 1) === 0x8b) {
    try {
      return gunzipSync(bytes);
    } catch (error) {
      throw new UpdateInstallError(
        "corrupt-archive",
        `the archive could not be decompressed (${describeError(error)}); nothing was installed`,
        { cause: error },
      );
    }
  }
  return bytes;
}

interface ExtractedTree {
  readonly entries: readonly string[];
}

/** Extract `archivePath` under `destination`; returns its top-level names. */
async function extractArchive(
  fs: InstallFs,
  archivePath: string,
  destination: string,
  archiveName: string,
): Promise<ExtractedTree> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(archivePath);
  } catch (error) {
    throw new UpdateInstallError(
      "download-failed",
      `${archiveName} could not be read back (${describeError(error)}); nothing was installed`,
      { cause: error },
    );
  }
  const entries = parseTar(decompress(bytes));
  if (entries.length === 0) throw corrupt(`${archiveName} contains no files`);

  await fs.mkdir(destination, { recursive: true });
  const topLevel = new Set<string>();
  for (const entry of entries) {
    const first = entry.path.split("/")[0] ?? "";
    if (
      RESERVED_ENTRIES.some((reserved) => first === reserved) ||
      first.startsWith(OLD_PREFIX)
    ) {
      throw unsafe(`archive entry ${entry.path} uses a reserved name`);
    }
    topLevel.add(first);
    const target = join(destination, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await fs.mkdir(target, { recursive: true });
      await fs.chmod(target, entry.mode);
      continue;
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, entry.data);
    await fs.chmod(target, entry.mode);
  }
  if (topLevel.size === 0) throw corrupt(`${archiveName} contains no files`);
  return { entries: [...topLevel].sort() };
}

// ---------------------------------------------------------------------------
// Swap and rollback
// ---------------------------------------------------------------------------

function oldDirectoryName(version: string): string {
  return `${OLD_PREFIX}${version}`;
}

function executableName(platform: UpdatePlatform): string {
  return platform === "win32" ? "droide.exe" : "droide";
}

async function findExecutable(
  fs: InstallFs,
  installDir: string,
  platform: UpdatePlatform,
): Promise<string | null> {
  const name = executableName(platform);
  for (const candidate of [
    join(installDir, name),
    join(installDir, "bin", name),
  ]) {
    const found = await exists(fs, candidate);
    if (found !== null && found.isFile()) return candidate;
  }
  return null;
}

interface MovedEntry {
  readonly name: string;
  readonly hadOld: boolean;
}

async function swapIntoPlace(
  fs: InstallFs,
  installDir: string,
  stagedDir: string,
  entries: readonly string[],
  version: string,
): Promise<readonly MovedEntry[]> {
  const oldDir = join(installDir, oldDirectoryName(version));
  const moved: MovedEntry[] = [];
  const rollback = async (): Promise<boolean> => {
    let restored = true;
    for (const entry of [...moved].reverse()) {
      try {
        await fs.rm(join(installDir, entry.name), {
          recursive: true,
          force: true,
        });
      } catch {
        restored = false;
      }
      if (entry.hadOld) {
        try {
          await fs.rename(
            join(oldDir, entry.name),
            join(installDir, entry.name),
          );
        } catch {
          restored = false;
        }
      }
    }
    return restored;
  };

  try {
    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.mkdir(oldDir, { recursive: true });
    for (const name of entries) {
      const target = join(installDir, name);
      const current = await exists(fs, target);
      if (current !== null) {
        await fs.rename(target, join(oldDir, name));
      }
      moved.push({ name, hadOld: current !== null });
      await fs.rename(join(stagedDir, name), target);
    }
    return moved;
  } catch (error) {
    const restored = await rollback();
    if (restored) {
      try {
        await fs.rm(oldDir, { recursive: true, force: true });
      } catch {
        // The empty backup is harmless if it cannot be removed.
      }
    }
    throw new UpdateInstallError(
      "swap-failed",
      restored
        ? `could not move the staged files into ${installDir} (${describeError(error)}); the previous installation was restored`
        : `could not move the staged files into ${installDir} (${describeError(error)}); the previous files are in ${oldDir}`,
      { cause: error },
    );
  }
}

async function restorePrevious(
  fs: InstallFs,
  installDir: string,
  moved: readonly MovedEntry[],
  version: string,
): Promise<void> {
  const oldDir = join(installDir, oldDirectoryName(version));
  for (const entry of [...moved].reverse()) {
    await fs.rm(join(installDir, entry.name), {
      recursive: true,
      force: true,
    });
    if (entry.hadOld) {
      await fs.rename(join(oldDir, entry.name), join(installDir, entry.name));
    }
  }
  await fs.rm(oldDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Default probe
// ---------------------------------------------------------------------------

/** Run `<bin> --version` once, bounded to {@link PROBE_TIMEOUT_MS}. */
export const defaultInstallProbe: InstallProbe = async (input) => {
  if (input.executable === null) {
    return {
      status: "skipped",
      reason: "the installed tree contains no executable to probe",
    };
  }
  const { promise, resolve: finish } =
    Promise.withResolvers<InstallProbeResult>();
  let stdout = "";
  let stderr = "";
  let settled = false;
  const settle = (result: InstallProbeResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(result);
  };
  const child = spawn(input.executable, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    settle({
      status: "failed",
      detail: `--version did not finish within ${PROBE_TIMEOUT_MS} ms`,
    });
  }, PROBE_TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    settle({ status: "failed", detail: describeError(error) });
  });
  child.on("close", (code) => {
    const printed = stdout.trim();
    if (code !== 0) {
      settle({
        status: "failed",
        detail: `--version exited with ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
      });
      return;
    }
    if (!printed.split(/\s+/).includes(input.version)) {
      settle({
        status: "failed",
        detail: `--version printed ${JSON.stringify(printed)}, expected ${input.version}`,
      });
      return;
    }
    settle({ status: "passed" });
  });
  return await promise;
};

function platformFromProcess(): UpdatePlatform {
  switch (process.platform) {
    case "win32":
      return "win32";
    case "darwin":
      return "darwin";
    default:
      return "linux";
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install one release into `installDir`. Every failure is a typed
 * {@link UpdateInstallError}; a failed probe restores the previous tree before
 * the error is thrown.
 */
export async function installRelease(
  options: InstallReleaseOptions,
): Promise<InstallReleaseResult> {
  const fs = options.fs ?? defaultInstallFs;
  const clock = options.clock ?? Date.now;
  const platform = options.platform ?? platformFromProcess();
  const arch = options.arch ?? process.arch;
  const version = semverOf(options.release.tag);
  const { archive, digest } = resolveAssets(options.release, platform, arch);
  const displayVersion = version ?? options.release.tag;
  const installDir = options.installDir;

  const installStat = await exists(fs, installDir);
  if (installStat === null || !installStat.isDirectory()) {
    throw new UpdateInstallError(
      "not-installed",
      installStat === null
        ? `there is no installation directory at ${installDir}; nothing was changed`
        : `${installDir} is not a directory; nothing was changed`,
    );
  }

  const updateDir = join(installDir, UPDATE_DIR_NAME);
  try {
    await fs.mkdir(updateDir, { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && NOT_WRITABLE_CODES[code] === true) {
      throw notWritable(installDir, error);
    }
    throw error;
  }

  const lock = await acquireLock(fs, updateDir, clock());
  let installed = false;
  try {
    const versionDir = join(updateDir, displayVersion);
    try {
      await fs.mkdir(versionDir, { recursive: true });
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && NOT_WRITABLE_CODES[code] === true) {
        throw notWritable(installDir, error);
      }
      throw error;
    }

    const digestEntries = await fetchDigestDocument(digest, options.fetch);
    const expected = findDigestFor(
      digestEntries,
      archive.name,
      options.release.tag,
    );

    const archivePath = join(versionDir, archive.name);
    await downloadVerified(fs, options.fetch, archive, archivePath, expected);
    const stagedDir = join(versionDir, STAGED_DIR_NAME);
    let tree: ExtractedTree;
    try {
      tree = await extractArchive(fs, archivePath, stagedDir, archive.name);
    } catch (error) {
      if (error instanceof UpdateInstallError) throw error;
      const code = errorCode(error);
      if (code !== undefined && NOT_WRITABLE_CODES[code] === true) {
        throw notWritable(installDir, error);
      }
      throw new UpdateInstallError(
        "stage-failed",
        `could not stage ${archive.name} under ${versionDir} (${describeError(error)}); nothing was installed`,
        { cause: error },
      );
    }

    const moved = await swapIntoPlace(
      fs,
      installDir,
      stagedDir,
      tree.entries,
      displayVersion,
    );
    installed = true;

    let executable: string | null = null;
    let probeResult: InstallProbeResult;
    try {
      executable = await findExecutable(fs, installDir, platform);
      const probe = options.probe ?? defaultInstallProbe;
      probeResult = await probe({
        installDir,
        version: displayVersion,
        executable,
      });
    } catch (error) {
      probeResult = {
        status: "failed",
        detail: `the probe threw: ${describeError(error)}`,
      };
    }

    if (probeResult.status === "failed") {
      try {
        await restorePrevious(fs, installDir, moved, displayVersion);
        installed = false;
      } catch (error) {
        throw new UpdateInstallError(
          "probe-failed",
          `the new installation failed its probe (${probeResult.detail}) and could not be rolled back (${describeError(error)}); the previous files are in ${join(installDir, oldDirectoryName(displayVersion))}`,
          { cause: error },
        );
      }
      throw new UpdateInstallError(
        "probe-failed",
        `the new installation failed its probe (${probeResult.detail}); the previous installation was restored`,
      );
    }

    try {
      await fs.rm(versionDir, { recursive: true, force: true });
    } catch {
      // A successful install is not failed over leftover staging files.
    }
    const base: InstallReleaseResult = {
      version: displayVersion,
      installDir,
      archive: archive.name,
      executable,
      probe: probeResult.status,
    };
    return probeResult.status === "skipped"
      ? { ...base, probeNote: probeResult.reason }
      : base;
  } finally {
    if (!installed) {
      try {
        await fs.rm(join(updateDir, displayVersion), {
          recursive: true,
          force: true,
        });
      } catch {
        // The failure that brought us here is the one worth reporting.
      }
    }
    await lock.release();
  }
}
