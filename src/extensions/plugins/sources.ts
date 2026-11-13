/**
 * Plugin and marketplace sources. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B34 (the six source kinds), B35 (verification and provenance) and B36
 * (enablement policy: the strict allowlist and the token-host binding).
 *
 * A source is parsed once from untrusted JSON, normalised into a discriminated
 * union, and materialised into a directory. Git goes through the same injected
 * runner the marketplace code uses; the network goes through an injected
 * `fetch`; the filesystem goes through an injected {@link SourceIo}. Nothing in
 * this module reads a global on its own, so a test can point every kind at a
 * `file://` URL or a path under a temporary directory and prove no case dials
 * out.
 *
 * `archive` limits are Claude Code's published numbers (`ARCHIVE_LIMITS`)
 * because a marketplace that installs there has to install here, and a hostile
 * one has to fail the same way.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import type { Settings } from "../../config/schema.ts";
import { isRecord } from "../guards.ts";
import {
  DEFAULT_GIT_TIMEOUT_MS,
  defaultGitRunner,
  GIT_MISSING_EXIT,
  PluginOperationError,
  type GitRunner,
} from "./marketplace.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type PluginSourceKind =
  "github" | "url" | "local" | "git-subdir" | "npm" | "archive";

export interface GithubSource {
  readonly source: "github";
  readonly repo: string;
  readonly ref?: string;
  readonly sha?: string;
}

export interface UrlSource {
  readonly source: "url";
  readonly url: string;
  readonly ref?: string;
  readonly sha?: string;
}

export interface LocalSource {
  readonly source: "local";
  readonly path: string;
}

export interface GitSubdirSource {
  readonly source: "git-subdir";
  readonly url: string;
  readonly path: string;
  readonly ref?: string;
  readonly sha?: string;
}

export interface NpmSource {
  readonly source: "npm";
  readonly package: string;
  readonly version?: string;
  readonly registry?: string;
  readonly authTokenEnvVar?: string;
}

export interface ArchiveSource {
  readonly source: "archive";
  readonly url: string;
  readonly sha256?: string;
  readonly authTokenEnvVar?: string;
}

export type PluginSource =
  | GithubSource
  | UrlSource
  | LocalSource
  | GitSubdirSource
  | NpmSource
  | ArchiveSource;

/** Resolved package metadata recorded on an npm-sourced install (B35). */
export interface InstalledNpmMetadata {
  readonly spec: string;
  readonly version: string;
  readonly resolved?: string;
  readonly integrity?: string;
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NPM_PACKAGE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GITHUB_CLONE_URL_PATTERN =
  /^(?:(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com(?:\/|:(?!\d+(?:\/|$)))|(?:[^@/]+@)?github\.com(?:\/|:(?=[^/]+\/[^/]+$)))([^/]+)\/([^/]+)$/iu;

function invalidSource(detail: string): PluginOperationError {
  return new PluginOperationError("source-invalid", detail);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  describe: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw invalidSource(`${describe} has a non-string "${key}".`);
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  describe: string,
): string {
  const value = optionalString(record, key, describe);
  if (value === undefined || value.trim() === "")
    throw invalidSource(`${describe} is missing a "${key}".`);
  return value.trim();
}

function readRef(
  record: Record<string, unknown>,
  describe: string,
): string | undefined {
  const ref = optionalString(record, "ref", describe)?.trim();
  if (ref === undefined || ref === "") return undefined;
  if (ref.startsWith("-"))
    throw invalidSource(
      `A git branch or tag name can't start with "-" (${describe}).`,
    );
  return ref;
}

function readSha(
  record: Record<string, unknown>,
  describe: string,
): string | undefined {
  const sha = optionalString(record, "sha", describe)?.trim();
  if (sha === undefined || sha === "") return undefined;
  if (!GIT_SHA_PATTERN.test(sha.toLowerCase()))
    throw invalidSource(
      `A "sha" must be a full 40-character commit SHA (${describe}).`,
    );
  return sha.toLowerCase();
}

/** Canonicalise a GitHub clone URL, browser link or SSH address to `owner/repo`. */
export function canonicalizeGithubRepository(text: string): string {
  const trimmed = text.trim().replace(/\/+$/u, "");
  const fromUrl = GITHUB_CLONE_URL_PATTERN.exec(trimmed);
  const repository =
    fromUrl === null ? trimmed : `${fromUrl[1] ?? ""}/${fromUrl[2] ?? ""}`;
  const withoutGit = repository.replace(/\.git$/iu, "");
  if (!GITHUB_REPOSITORY_PATTERN.test(withoutGit))
    throw invalidSource(
      `Expected a GitHub repository in owner/repo format, got "${text}".`,
    );
  return withoutGit;
}

function readGitSubdirPath(
  record: Record<string, unknown>,
  describe: string,
): string {
  const raw = requiredString(record, "path", describe);
  const trimmed = raw.replace(/[/\\]+$/u, "");
  const value = trimmed === "" ? raw : trimmed;
  if (value === "." || value === "") return ".";
  if (
    isAbsolute(value) ||
    /^(?:[A-Za-z]:)?[/\\]/u.test(value) ||
    value
      .split(/[/\\]/u)
      .some((segment) => segment === "." || segment === ".." || segment === "")
  )
    throw invalidSource(
      `A "git-subdir" path must stay inside the repository (${describe}).`,
    );
  return value;
}

function readNpmVersion(
  record: Record<string, unknown>,
  describe: string,
): string | undefined {
  const version = optionalString(record, "version", describe)?.trim();
  if (version === undefined || version === "") return undefined;
  if (/[:/\\]/u.test(version) || version.startsWith("."))
    throw invalidSource(
      `Expected a semver version, range or dist-tag, not a path, git or URL spec (${describe}).`,
    );
  return version;
}

function readNpmRegistry(
  record: Record<string, unknown>,
  describe: string,
): string | undefined {
  const registry = optionalString(record, "registry", describe)?.trim();
  if (registry === undefined || registry === "") return undefined;
  const parsed = URL.canParse(registry) ? new URL(registry) : undefined;
  const valid =
    parsed !== undefined &&
    (parsed.protocol === "https:" || parsed.protocol === "file:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!valid)
    throw invalidSource(
      `Expected an https registry URL without credentials, a query string or a fragment (${describe}).`,
    );
  return registry.replace(/\/+$/u, "");
}

function readTokenVariable(
  record: Record<string, unknown>,
  describe: string,
): string | undefined {
  const name = optionalString(record, "authTokenEnvVar", describe)?.trim();
  if (name === undefined || name === "") return undefined;
  if (!ENV_VAR_PATTERN.test(name))
    throw invalidSource(
      `Expected a valid environment variable name for "authTokenEnvVar" (${describe}).`,
    );
  return name;
}

/**
 * Parse one source object (B34). A `git-subdir` without `path` is refused, a
 * `sha` must be a full commit, and a crediting-shaped npm or archive source is
 * refused before anything is downloaded.
 */
export function parsePluginSource(
  value: unknown,
  describe = "The source",
): PluginSource {
  if (!isRecord(value))
    throw invalidSource(`${describe} is not an object with a "source" field.`);
  const kind = value["source"];
  if (typeof kind !== "string")
    throw invalidSource(`${describe} is missing a "source" field.`);

  switch (kind) {
    case "github":
      return {
        source: "github",
        repo: canonicalizeGithubRepository(
          requiredString(value, "repo", describe),
        ),
        ...pin(value, describe),
      };
    case "url": {
      const url = requiredString(value, "url", describe);
      if (!URL.canParse(url) && !/^[^@\s/]+@[^:\s]+:.+$/u.test(url))
        throw invalidSource(`${describe} has a "url" that is not a URL.`);
      return { source: "url", url, ...pin(value, describe) };
    }
    case "local":
      return {
        source: "local",
        path: requiredString(value, "path", describe),
      };
    case "git-subdir": {
      const url = requiredString(value, "url", describe);
      return {
        source: "git-subdir",
        url,
        path: readGitSubdirPath(value, describe),
        ...pin(value, describe),
      };
    }
    case "npm": {
      const name = requiredString(value, "package", describe);
      if (!NPM_PACKAGE_PATTERN.test(name))
        throw invalidSource(
          `Expected an npm package name such as "lodash" or "@scope/pkg" (${describe}).`,
        );
      const version = readNpmVersion(value, describe);
      const registry = readNpmRegistry(value, describe);
      const authTokenEnvVar = readTokenVariable(value, describe);
      return {
        source: "npm",
        package: name,
        ...(version === undefined ? {} : { version }),
        ...(registry === undefined ? {} : { registry }),
        ...(authTokenEnvVar === undefined ? {} : { authTokenEnvVar }),
      };
    }
    case "archive": {
      const url = requiredString(value, "url", describe);
      const sha256 = optionalString(value, "sha256", describe)?.trim();
      const authTokenEnvVar = readTokenVariable(value, describe);
      return {
        source: "archive",
        url,
        ...(sha256 === undefined || sha256 === ""
          ? {}
          : { sha256: sha256.toLowerCase() }),
        ...(authTokenEnvVar === undefined ? {} : { authTokenEnvVar }),
      };
    }
    default:
      throw invalidSource(
        `${describe} has an unknown source kind "${kind}". Use one of github, url, local, git-subdir, npm or archive.`,
      );
  }
}

function pin(
  value: Record<string, unknown>,
  describe: string,
): { readonly ref?: string; readonly sha?: string } {
  const ref = readRef(value, describe);
  const sha = readSha(value, describe);
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(sha === undefined ? {} : { sha }),
  };
}

/** The JSON shape a source is persisted as. Key order is fixed for hashing. */
export function serialisePluginSource(
  source: PluginSource,
): Record<string, unknown> {
  switch (source.source) {
    case "github":
      return {
        source: "github",
        repo: source.repo,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        ...(source.sha === undefined ? {} : { sha: source.sha }),
      };
    case "url":
      return {
        source: "url",
        url: source.url,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        ...(source.sha === undefined ? {} : { sha: source.sha }),
      };
    case "local":
      return { source: "local", path: source.path };
    case "git-subdir":
      return {
        source: "git-subdir",
        url: source.url,
        path: source.path,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        ...(source.sha === undefined ? {} : { sha: source.sha }),
      };
    case "npm":
      return {
        source: "npm",
        package: source.package,
        ...(source.version === undefined ? {} : { version: source.version }),
        ...(source.registry === undefined ? {} : { registry: source.registry }),
        ...(source.authTokenEnvVar === undefined
          ? {}
          : { authTokenEnvVar: source.authTokenEnvVar }),
      };
    case "archive":
      return {
        source: "archive",
        url: source.url,
        ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
        ...(source.authTokenEnvVar === undefined
          ? {}
          : { authTokenEnvVar: source.authTokenEnvVar }),
      };
  }
}

/** SHA-256 of a source's canonical form (B35), compared on load. */
export function pluginSourceHash(source: PluginSource): string {
  return createHash("sha256")
    .update(JSON.stringify(serialisePluginSource(source)), "utf8")
    .digest("hex");
}

function normalisePath(path: string): string {
  const unified = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return unified.startsWith("./") ? unified.slice(2) : unified;
}

function identity(source: PluginSource): string {
  switch (source.source) {
    case "github":
      return JSON.stringify([
        "github",
        source.repo.toLowerCase(),
        source.ref,
        source.sha?.toLowerCase(),
      ]);
    case "url":
      return JSON.stringify([
        "url",
        source.url,
        source.ref,
        source.sha?.toLowerCase(),
      ]);
    case "local":
      return JSON.stringify(["local", normalisePath(source.path)]);
    case "git-subdir":
      return JSON.stringify([
        "git-subdir",
        source.url,
        normalisePath(source.path),
        source.ref,
        source.sha?.toLowerCase(),
      ]);
    case "npm":
      return JSON.stringify([
        "npm",
        source.package,
        source.version ?? "latest",
        source.registry ?? "https://registry.npmjs.org",
      ]);
    case "archive":
      return JSON.stringify([
        "archive",
        source.url,
        source.sha256?.toLowerCase(),
      ]);
  }
}

/** Whether two sources address the same artifact. */
export function sourcesEqual(left: PluginSource, right: PluginSource): boolean {
  return left.source === right.source && identity(left) === identity(right);
}

function repositoryKey(
  source: Exclude<PluginSource, { source: "local" }>,
): string {
  if (source.source === "github")
    return JSON.stringify(["github", source.repo.toLowerCase()]);
  if (source.source === "url" || source.source === "git-subdir") {
    const github = /github\.com[:/]([^/]+)\/([^/#]+?)(?:\.git)?$/iu.exec(
      source.url,
    );
    return github === null
      ? JSON.stringify(["url", source.url])
      : JSON.stringify([
          "github",
          `${github[1] ?? ""}/${github[2] ?? ""}`.toLowerCase(),
        ]);
  }
  return JSON.stringify([source.source, identity(source)]);
}

function commitPin(source: GithubSource | UrlSource | GitSubdirSource): {
  readonly ref?: string;
  readonly sha?: string;
} {
  if (
    source.sha === undefined &&
    source.ref !== undefined &&
    GIT_SHA_PATTERN.test(source.ref.toLowerCase())
  )
    return { sha: source.ref.toLowerCase() };
  return {
    ...(source.ref === undefined ? {} : { ref: source.ref }),
    ...(source.sha === undefined ? {} : { sha: source.sha }),
  };
}

/**
 * Whether one allowlist entry admits `source` (B36). Every field the entry
 * sets must match; a GitHub clone URL matches its `owner/repo` shorthand; an
 * entry naming only a ref refuses a candidate pinned to a bare SHA; archives
 * are never approved by a repository allowlist.
 */
export function isSourceAllowedBy(
  allowed: PluginSource,
  candidate: PluginSource,
): boolean {
  if (candidate.source === "archive" || candidate.source === "npm")
    return false;
  if (allowed.source === "local" || candidate.source === "local")
    return sourcesEqual(allowed, candidate);
  if (allowed.source === "npm" || allowed.source === "archive") return false;

  const allowedPin = commitPin(allowed);
  const candidatePin = commitPin(candidate);
  const allowedSubdir =
    allowed.source === "git-subdir" ? normalisePath(allowed.path) : undefined;
  const candidateSubdir =
    candidate.source === "git-subdir"
      ? normalisePath(candidate.path)
      : undefined;
  return (
    allowedSubdir === candidateSubdir &&
    (allowedPin.ref === undefined || allowedPin.ref === candidatePin.ref) &&
    (allowedPin.sha === undefined
      ? allowedPin.ref === undefined || candidatePin.sha === undefined
      : allowedPin.sha === candidatePin.sha) &&
    repositoryKey(allowed) === repositoryKey(candidate)
  );
}

/** An absent allowlist admits everything; an empty one admits nothing. */
export function isSourceAllowed(
  allowlist: readonly PluginSource[] | undefined,
  source: PluginSource,
): boolean {
  return (
    allowlist === undefined ||
    allowlist.some((allowed) => isSourceAllowedBy(allowed, source))
  );
}

function redactUrl(raw: string): string {
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/u, "");
  }
  return raw.replace(/^[^@/]+@/u, "");
}

function terminalSafe(value: string): string {
  return value.replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
}

/** One-line rendering used in refusals and listings (credentials removed). */
export function formatPluginSource(source: PluginSource): string {
  switch (source.source) {
    case "github":
      return terminalSafe(`github:${source.repo}`);
    case "url":
      return terminalSafe(redactUrl(source.url));
    case "local":
      return terminalSafe(`local:${source.path}`);
    case "git-subdir":
      return terminalSafe(`git-subdir:${redactUrl(source.url)}#${source.path}`);
    case "npm":
      return terminalSafe(
        `npm:${source.package}${source.version === undefined ? "" : `@${source.version}`}`,
      );
    case "archive":
      return terminalSafe(`archive:${redactUrl(source.url)}`);
  }
}

/** The clone URL for a git source. */
export function gitUrlForPluginSource(source: PluginSource): string {
  switch (source.source) {
    case "github":
      return `https://github.com/${source.repo}.git`;
    case "url":
    case "git-subdir":
      return source.url;
    case "local":
      return source.path;
    case "npm":
    case "archive":
      throw invalidSource(
        `A "${source.source}" source is downloaded, not cloned.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Policy (B36)
// ---------------------------------------------------------------------------

export interface PluginPolicy {
  /** `strictKnownMarketplaces`: absent admits everything, empty admits nothing. */
  readonly allowedSources?: readonly PluginSource[];
  /** `extraKnownMarketplaces`: registrations that may be created on demand. */
  readonly extraMarketplaces: ReadonlyMap<string, PluginSource>;
  /** `pluginTokenHosts`: environment variable → the one host it may reach. */
  readonly tokenHosts: ReadonlyMap<string, string>;
}

export interface PolicyLayer {
  readonly level: string;
  readonly settings: Settings;
}

export const NO_PLUGIN_POLICY: PluginPolicy = {
  extraMarketplaces: new Map(),
  tokenHosts: new Map(),
};

function settingsInvalid(error: unknown): never {
  if (error instanceof PluginOperationError)
    throw new PluginOperationError("settings-invalid", error.message, {
      cause: error,
    });
  throw error;
}

function parseAllowlist(
  values: readonly unknown[] | undefined,
): readonly PluginSource[] | undefined {
  if (values === undefined) return undefined;
  try {
    return values.map((value, index) =>
      parsePluginSource(value, `strictKnownMarketplaces[${index}]`),
    );
  } catch (error) {
    settingsInvalid(error);
  }
}

function parseExtraMarketplaces(
  record: Readonly<Record<string, unknown>> | undefined,
): ReadonlyMap<string, PluginSource> {
  const result = new Map<string, PluginSource>();
  if (record === undefined) return result;
  for (const [name, value] of Object.entries(record)) {
    if (!isRecord(value) || value["source"] === undefined)
      throw new PluginOperationError(
        "settings-invalid",
        `extraKnownMarketplaces["${name}"] must be an object with a "source".`,
      );
    try {
      result.set(
        name,
        parsePluginSource(value["source"], `extraKnownMarketplaces["${name}"]`),
      );
    } catch (error) {
      settingsInvalid(error);
    }
  }
  return result;
}

/**
 * Resolve the plugin policy from the settings that were loaded. Token hosts
 * are honored from user and organization settings only — a marketplace names
 * the variable, so a checked-in project setting must not be able to point a
 * download at an attacker's host. A project (or runtime) setting that names a
 * token host is refused rather than silently ignored.
 */
export function resolvePluginPolicy(
  settings: Settings,
  layers: readonly PolicyLayer[],
): PluginPolicy {
  const tokenHosts = new Map<string, string>();
  for (const layer of [...layers].reverse()) {
    const hosts = layer.settings.pluginTokenHosts;
    if (hosts === undefined || Object.keys(hosts).length === 0) continue;
    if (layer.level !== "user" && layer.level !== "org")
      throw new PluginOperationError(
        "settings-invalid",
        `pluginTokenHosts is only read from user and organization settings, but ${layer.level} settings name a token host. Move it to your user settings.`,
      );
    for (const [name, host] of Object.entries(hosts))
      tokenHosts.set(name, host);
  }

  const allowedSources =
    settings.strictKnownMarketplaces === undefined
      ? undefined
      : parseAllowlist(settings.strictKnownMarketplaces);
  return {
    ...(allowedSources === undefined ? {} : { allowedSources }),
    extraMarketplaces: parseExtraMarketplaces(settings.extraKnownMarketplaces),
    tokenHosts,
  };
}

// ---------------------------------------------------------------------------
// Injected surfaces
// ---------------------------------------------------------------------------

/** Everything the fetchers touch on disk. Bytes, because archives are binary. */
export interface SourceIo {
  readonly writeFile: (path: string, bytes: Uint8Array) => void;
  readonly makeDirectory: (path: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  readonly exists: (path: string) => boolean;
  /** Immediate directory entry names, sorted, for plugin-root discovery. */
  readonly listDirectory: (path: string) => readonly string[];
}

export const defaultSourceIo: SourceIo = {
  writeFile(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  },
  makeDirectory(path) {
    mkdirSync(path, { recursive: true });
  },
  rename(from, to) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  },
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
  exists(path) {
    return existsSync(path);
  },
  listDirectory(path) {
    try {
      return readdirSync(path).sort();
    } catch {
      return [];
    }
  },
};

export interface SourceFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type SourceFetch = (
  url: string,
  init: {
    readonly headers: Record<string, string>;
    readonly redirect: "manual";
    readonly signal?: AbortSignal;
  },
) => Promise<SourceFetchResponse>;

export const defaultSourceFetch: SourceFetch = (url, init) => fetch(url, init);

export interface ArchiveLimits {
  readonly maxDownloadBytes: number;
  readonly downloadTimeoutMs: number;
  readonly maxRedirects: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxCompressionRatio: number;
}

/** Claude Code's published archive limits (B34). */
export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxDownloadBytes: 256 * 1024 * 1024,
  downloadTimeoutMs: 120_000,
  maxRedirects: 5,
  maxEntries: 100_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 50,
};

export interface SourceDeps {
  readonly runGit?: GitRunner;
  readonly fetch?: SourceFetch;
  readonly io?: SourceIo;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tokenHosts?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Injected for tests: the signal a download's wall-clock budget becomes. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  readonly limits?: ArchiveLimits;
}

function limitError(detail: string): PluginOperationError {
  return new PluginOperationError("archive-limit", detail);
}

const DEFAULT_FETCH_TIMEOUT = (ms: number): AbortSignal =>
  AbortSignal.timeout(ms);

function downloadSignal(
  deps: SourceDeps,
  limits: ArchiveLimits,
): AbortSignal | undefined {
  const timeout = (deps.timeoutSignal ?? DEFAULT_FETCH_TIMEOUT)(
    limits.downloadTimeoutMs,
  );
  if (deps.signal === undefined) return timeout;
  return AbortSignal.any([deps.signal, timeout]);
}

function abortedError(
  signal: AbortSignal,
  limits: ArchiveLimits,
): PluginOperationError {
  return new PluginOperationError(
    "source-fetch-failed",
    `The download timed out after ${Math.round(limits.downloadTimeoutMs / 1000)} seconds.`,
    signal.reason === undefined ? undefined : { cause: signal.reason },
  );
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  limits: ArchiveLimits,
): void {
  if (signal?.aborted === true) throw abortedError(signal, limits);
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

function validateDownloadUrl(value: string): URL {
  if (!URL.canParse(value))
    throw invalidSource("The plugin source URL is invalid.");
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "file:") ||
    url.username !== "" ||
    url.password !== ""
  )
    throw invalidSource(
      "Plugin source URLs must use https:// and cannot embed credentials.",
    );
  return url;
}

/** The URL's host without IPv6 brackets or a trailing dot. */
export function normalizedHost(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

/**
 * Normalise a `pluginTokenHosts` binding (B36) the way a download URL's host
 * is normalised. Anything that is not a bare host — a URL, a path with a port —
 * yields `undefined` and never matches.
 */
export function normalizedBindingHost(value: string): string | undefined {
  const trimmed = value.trim();
  const host =
    trimmed.includes(":") && !trimmed.startsWith("[")
      ? `[${trimmed}]`
      : trimmed;
  if (host.startsWith("[") && !host.endsWith("]")) return undefined;
  if (!URL.canParse(`https://${host}`)) return undefined;
  const url = new URL(`https://${host}`);
  return url.host === url.hostname && `https://${url.host}/` === url.href
    ? normalizedHost(url)
    : undefined;
}

function authHeaders(
  source: NpmSource | ArchiveSource,
  url: string,
  deps: SourceDeps,
): Record<string, string> {
  const name = source.authTokenEnvVar;
  if (name === undefined) return {};
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  const host = parsed === undefined ? undefined : normalizedHost(parsed);
  const bound = deps.tokenHosts?.[name];
  if (
    bound === undefined ||
    host === undefined ||
    normalizedBindingHost(bound) !== host
  ) {
    throw new PluginOperationError(
      "source-denied",
      `This plugin needs the token in "${name}", but your settings don't allow sending it to ${host ?? "this source's server"}. Ask an administrator to allow it.`,
    );
  }
  const token = deps.env?.[name]?.trim();
  if (token === undefined || token === "") {
    throw new PluginOperationError(
      "source-invalid",
      `This plugin's source requires authentication but environment variable "${name}" is not set.`,
    );
  }
  return { Authorization: `Bearer ${token.replace(/[\r\n]/gu, "")}` };
}

async function readBody(
  response: SourceFetchResponse,
  maxBytes: number,
  signal: AbortSignal | undefined,
  limits: ArchiveLimits,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw limitError(
      "The plugin archive is larger than Droide allows. Contact the plugin's publisher.",
    );
  }
  if (response.body === undefined || response.body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes)
      throw limitError(
        "The plugin archive is larger than Droide allows. Contact the plugin's publisher.",
      );
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    throwIfAborted(signal, limits);
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw limitError(
        "The plugin archive is larger than Droide allows. Contact the plugin's publisher.",
      );
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function downloadBytes(
  value: string,
  headers: Record<string, string>,
  deps: SourceDeps,
): Promise<Uint8Array> {
  const limits = deps.limits ?? ARCHIVE_LIMITS;
  const fetchImpl = deps.fetch ?? defaultSourceFetch;
  const signal = downloadSignal(deps, limits);
  throwIfAborted(signal, limits);

  let current = validateDownloadUrl(value).toString();
  const origin = new URL(current).origin;
  for (let hop = 0; ; hop += 1) {
    const url = validateDownloadUrl(current);
    if (signal !== undefined && signal.aborted)
      throw abortedError(signal, limits);
    let response: SourceFetchResponse;
    try {
      response = await fetchImpl(url.toString(), {
        headers: url.origin === origin ? headers : {},
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal !== undefined && signal.aborted)
        throw abortedError(signal, limits);
      throw new PluginOperationError(
        "source-fetch-failed",
        `Could not download plugin. Check that the source exists and that you can access it.`,
        { cause: error },
      );
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (location === null || location === "")
        throw new PluginOperationError(
          "source-fetch-failed",
          "The plugin server returned a broken redirect. Contact the plugin's publisher.",
        );
      if (hop >= limits.maxRedirects)
        throw new PluginOperationError(
          "source-fetch-failed",
          "The plugin download was redirected too many times.",
        );
      current = new URL(location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new PluginOperationError(
        "source-fetch-failed",
        response.status === 401
          ? `The plugin server refused the download (HTTP ${response.status}). Check the plugin's credentials.`
          : `The plugin download failed (HTTP ${response.status}). Try again later, or contact the plugin's publisher.`,
      );
    }
    try {
      return await readBody(response, limits.maxDownloadBytes, signal, limits);
    } catch (error) {
      if (signal !== undefined && signal.aborted)
        throw abortedError(signal, limits);
      if (error instanceof PluginOperationError) throw error;
      throw new PluginOperationError(
        "source-fetch-failed",
        "Could not download plugin. Check that the source exists and that you can access it.",
        { cause: error },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

function incompleteArchive(): PluginOperationError {
  return new PluginOperationError(
    "source-invalid",
    "The archive is incomplete or is not a zip file.",
  );
}

function unsafeEntry(): PluginOperationError {
  return new PluginOperationError(
    "source-invalid",
    "The archive contains an unsafe file path. Contact the plugin's publisher.",
  );
}

function overlongEntry(): PluginOperationError {
  return new PluginOperationError(
    "source-invalid",
    "The archive contains a file path that is too long. Contact the plugin's publisher.",
  );
}

function linkedEntry(): PluginOperationError {
  return new PluginOperationError(
    "source-invalid",
    "The archive contains a symbolic link, which Droide does not install. Contact the plugin's publisher.",
  );
}

/** Longest entry name, and longest single segment, an archive may carry. */
const MAX_ENTRY_NAME_LENGTH = 1024;
const MAX_ENTRY_SEGMENT_LENGTH = 255;

/**
 * The path an archive entry is written to, relative to the extraction root, or
 * `null` for the root itself. Absolute names, drive letters, backslashes,
 * `..` segments and over-long names are refused before anything is written;
 * the caller then joins the result under the extraction root, so no entry can
 * escape it.
 */
function safeEntryPath(name: string): string | null {
  if (
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/u.test(name)
  )
    throw unsafeEntry();
  const segments = name
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (segments.includes("..")) throw unsafeEntry();
  const relative = segments.join("/");
  if (
    relative.length > MAX_ENTRY_NAME_LENGTH ||
    segments.some((part) => part.length > MAX_ENTRY_SEGMENT_LENGTH)
  )
    throw overlongEntry();
  return segments.length === 0 ? null : relative;
}

/** A destination inside `target`, refusing anything that resolves outside it. */
function entryTarget(target: string, relative: string): string {
  const destination = resolvePath(target, relative);
  const root = resolvePath(target);
  if (destination !== root && !destination.startsWith(`${root}${sep}`))
    throw unsafeEntry();
  return destination;
}

function isInsignificantZeros(
  bytes: Uint8Array,
  start: number,
  length: number,
): boolean {
  const end = Math.min(bytes.byteLength, start + length);
  for (let index = start; index < end; index += 1)
    if (bytes[index] !== 0) return false;
  return true;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  /** The high 16 bits are the Unix mode when the archive was built on Unix. */
  readonly externalAttributes: number;
}

function findEndOfCentralDirectory(view: DataView): number {
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= floor; offset -= 1)
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  return -1;
}

function readZip64Extra(
  extra: Uint8Array,
  entry: { size: number; compressed: number; offset: number },
): void {
  let index = 0;
  while (index + 4 <= extra.byteLength) {
    const view = new DataView(extra.buffer, extra.byteOffset + index, 4);
    const tag = view.getUint16(0, true);
    const length = view.getUint16(2, true);
    const body = extra.subarray(index + 4, index + 4 + length);
    if (tag === 0x0001) {
      const bodyView = new DataView(
        body.buffer,
        body.byteOffset,
        body.byteLength,
      );
      let cursor = 0;
      if (entry.size === 0xffffffff && cursor + 8 <= body.byteLength) {
        entry.size = Number(bodyView.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (entry.compressed === 0xffffffff && cursor + 8 <= body.byteLength) {
        entry.compressed = Number(bodyView.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (entry.offset === 0xffffffff && cursor + 8 <= body.byteLength)
        entry.offset = Number(bodyView.getBigUint64(cursor, true));
    }
    index += 4 + length;
  }
}

function readCentralDirectory(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw incompleteArchive();
  let entryCount = view.getUint16(eocd + 10, true);
  let centralOffset = view.getUint32(eocd + 16, true);

  if (
    eocd >= 20 &&
    view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE
  ) {
    const recordOffset = Number(view.getBigUint64(eocd - 12, true));
    if (
      recordOffset + 56 <= bytes.byteLength &&
      view.getUint32(recordOffset, true) === ZIP64_EOCD_SIGNATURE
    ) {
      entryCount = Number(view.getBigUint64(recordOffset + 32, true));
      centralOffset = Number(view.getBigUint64(recordOffset + 48, true));
    }
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > bytes.byteLength ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE
    )
      throw incompleteArchive();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const extra = bytes.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    const name = new TextDecoder("utf-8").decode(nameBytes);
    const sizes = {
      size: uncompressedSize,
      compressed: compressedSize,
      offset: localOffset,
    };
    readZip64Extra(extra, sizes);
    entries.push({
      name,
      method,
      flags,
      compressedSize: sizes.compressed,
      uncompressedSize: sizes.size,
      localOffset: sizes.offset,
      externalAttributes,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    entry.localOffset + 30 > bytes.byteLength ||
    view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_SIGNATURE
  )
    throw incompleteArchive();
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw incompleteArchive();
  return bytes.subarray(start, end);
}

/**
 * Extract a zip into `target` (which must not exist), enforcing every limit in
 * B34: entry count, per-file and total uncompressed size, and the compression
 * ratio against the downloaded byte count.
 */
function extractZipArchive(
  bytes: Uint8Array,
  target: string,
  limits: ArchiveLimits,
  io: SourceIo,
): void {
  const effectiveTotal = Math.min(
    limits.maxTotalBytes,
    Math.floor(bytes.byteLength * limits.maxCompressionRatio),
  );
  const ratioBound = effectiveTotal < limits.maxTotalBytes;
  const entries = readCentralDirectory(bytes);
  if (entries.length > limits.maxEntries)
    throw limitError(
      `The plugin archive has more than ${limits.maxEntries.toLocaleString("en-US")} files. Contact the plugin's publisher.`,
    );

  io.makeDirectory(target);
  let written = 0;
  for (const entry of entries) {
    const relative = safeEntryPath(entry.name);
    if (relative === null) continue;
    // Unix mode lives in the high 16 bits; 0o120000 is S_IFLNK.
    if (((entry.externalAttributes >>> 16) & 0o170000) === 0o120000)
      throw linkedEntry();
    if ((entry.flags & 0x1) !== 0)
      throw new PluginOperationError(
        "source-invalid",
        "The archive contains an encrypted file, which Droide cannot read.",
      );
    const destination = entryTarget(target, relative);
    if (entry.name.endsWith("/")) {
      io.makeDirectory(destination);
      continue;
    }
    if (entry.uncompressedSize > limits.maxFileBytes)
      throw limitError(
        "The plugin archive contains a file larger than Droide allows. Contact the plugin's publisher.",
      );
    if (written + entry.uncompressedSize > effectiveTotal)
      throw limitError(
        ratioBound
          ? "The plugin archive expands far more than it should. Contact the plugin's publisher."
          : "The plugin archive is larger than Droide allows. Contact the plugin's publisher.",
      );
    const data = entryData(bytes, entry);
    let output: Uint8Array;
    if (entry.method === 0) {
      if (data.byteLength !== entry.uncompressedSize) throw incompleteArchive();
      output = data;
    } else if (entry.method === 8) {
      try {
        output = new Uint8Array(
          inflateRawSync(data, {
            maxOutputLength: Math.min(
              limits.maxFileBytes + 1,
              effectiveTotal - written + 1,
            ),
          }),
        );
      } catch (error) {
        throw new PluginOperationError(
          "source-invalid",
          "The archive is incomplete or is not a zip file.",
          { cause: error },
        );
      }
    } else {
      throw new PluginOperationError(
        "source-invalid",
        "The archive uses a compression method Droide cannot read.",
      );
    }
    if (output.byteLength > limits.maxFileBytes)
      throw limitError(
        "The plugin archive contains a file larger than Droide allows. Contact the plugin's publisher.",
      );
    written += output.byteLength;
    io.writeFile(destination, output);
  }
}

// ---------------------------------------------------------------------------
// Tar (npm tarballs)
// ---------------------------------------------------------------------------

function readTarString(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder("utf-8").decode(
    end === -1 ? slice : slice.subarray(0, end),
  );
}

function readTarOctal(
  bytes: Uint8Array,
  start: number,
  length: number,
): number {
  const text = readTarString(bytes, start, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) throw incompleteArchive();
  return value;
}

/** Extract an npm `.tgz` (gzip + tar) into `target`, dropping the top folder. */
function extractTarball(
  bytes: Uint8Array,
  target: string,
  limits: ArchiveLimits,
  io: SourceIo,
): void {
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(
      gunzipSync(bytes, { maxOutputLength: limits.maxTotalBytes + 1 }),
    );
  } catch (error) {
    throw new PluginOperationError(
      "source-invalid",
      "The npm package could not be decompressed.",
      { cause: error },
    );
  }

  io.makeDirectory(target);
  let offset = 0;
  let entryCount = 0;
  let written = 0;
  let pendingLongName: string | undefined;
  while (offset + 512 <= tar.byteLength) {
    if (isInsignificantZeros(tar, offset, 512)) break;
    entryCount += 1;
    if (entryCount > limits.maxEntries)
      throw limitError(
        `The plugin package has more than ${limits.maxEntries.toLocaleString("en-US")} files. Contact the plugin's publisher.`,
      );
    const name = readTarString(tar, offset, 100);
    const size = readTarOctal(tar, offset + 124, 12);
    const type = String.fromCharCode(tar[offset + 156] ?? 0);
    const prefix = readTarString(tar, offset + 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw incompleteArchive();

    if (type === "L") {
      pendingLongName = readTarString(tar, dataStart, size);
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === "x" || type === "g" || type === "K") {
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }

    const fullName =
      pendingLongName ?? (prefix === "" ? name : `${prefix}/${name}`);
    pendingLongName = undefined;
    // Tar types 1 and 2 are hard links and symbolic links; neither is installed.
    if (type === "1" || type === "2") throw linkedEntry();
    const relative = safeEntryPath(fullName.replace(/^package\//u, ""));
    if (relative !== null) {
      const destination = entryTarget(target, relative);
      if (type === "5") {
        io.makeDirectory(destination);
      } else if (type === "0" || type === "\0") {
        if (size > limits.maxFileBytes)
          throw limitError(
            "The plugin package contains a file larger than Droide allows. Contact the plugin's publisher.",
          );
        if (written + size > limits.maxTotalBytes)
          throw limitError(
            "The plugin package is larger than Droide allows. Contact the plugin's publisher.",
          );
        written += size;
        io.writeFile(destination, tar.subarray(dataStart, dataEnd));
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

// ---------------------------------------------------------------------------
// Plugin root (B33)
// ---------------------------------------------------------------------------

/** Directory markers that identify a plugin root when no manifest exists. */
export const PLUGIN_ROOT_MARKERS = [
  ".droide-plugin",
  ".claude-plugin",
  "skills",
  "commands",
  "agents",
  "droids",
  "hooks",
  "output-styles",
  "mcp.json",
  ".mcp.json",
] as const;

function hasMarker(directory: string, io: SourceIo): boolean {
  return PLUGIN_ROOT_MARKERS.some((marker) =>
    io.exists(join(directory, marker)),
  );
}

/**
 * Resolve the plugin root inside an extracted archive: the extraction root,
 * else the single wrapper directory, else the first bounded descendant with a
 * component marker. Refuses an archive with no plugin in it.
 */
export function findPluginRoot(
  root: string,
  io: SourceIo = defaultSourceIo,
): string {
  if (hasMarker(root, io)) return root;
  const entries = [...io.listDirectory(root)].sort();
  const directories = entries.filter((entry: string) =>
    hasMarker(join(root, entry), io),
  );
  const first = directories[0];
  if (first !== undefined) return join(root, first);
  if (entries.length === 1 && directories.length === 0) {
    const only = entries[0];
    if (only !== undefined) {
      const nested = join(root, only);
      const nestedEntries = [...io.listDirectory(nested)].sort();
      const nestedFirst = nestedEntries.find((entry: string) =>
        hasMarker(join(nested, entry), io),
      );
      if (nestedFirst !== undefined) return join(nested, nestedFirst);
      if (hasMarker(nested, io)) return nested;
    }
  }
  throw new PluginOperationError(
    "source-invalid",
    "The archive does not contain a plugin: no skills, commands, agents, droids, hooks, output-styles or mcp.json was found.",
  );
}

// ---------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------

export interface MaterializeOptions {
  /** The directory the artifact must be written to; it must not exist yet. */
  readonly target: string;
  /** Base for a relative `local` path (the marketplace root). */
  readonly baseDirectory?: string;
  readonly deps?: SourceDeps;
}

export interface MaterializedSource {
  /** The directory holding the artifact (the same as `target`, or the local path). */
  readonly directory: string;
  /** The version that names the installed cache directory. */
  readonly version: string;
  /** The full commit the artifact was fetched at, when it came from git. */
  readonly commit?: string;
  /** Resolved npm metadata, recorded so auto-update can see a new publish. */
  readonly npm?: InstalledNpmMetadata;
  /** The normalised source to record as provenance. */
  readonly source: PluginSource;
}

function randomSuffix(): string {
  return randomUUID().replace(/-/gu, "");
}

function containedPath(root: string, relative: string): string {
  const target = resolvePath(root, relative);
  const resolvedRoot = resolvePath(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`))
    throw invalidSource(
      `The "git-subdir" path "${relative}" climbs out of the repository.`,
    );
  return target;
}

async function readGitCommit(
  directory: string,
  deps: SourceDeps,
): Promise<string | undefined> {
  const result = await (deps.runGit ?? defaultGitRunner)(
    ["rev-parse", "HEAD"],
    {
      cwd: directory,
      timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    },
  );
  if (result.code !== 0) return undefined;
  const commit = result.stdout.trim().toLowerCase();
  return GIT_SHA_PATTERN.test(commit) ? commit : undefined;
}

async function runGitChecked(
  args: readonly string[],
  cwd: string,
  deps: SourceDeps,
): Promise<void> {
  const runner = deps.runGit ?? defaultGitRunner;
  const result = await runner(args, {
    cwd,
    timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  if (result.code === 0) return;
  if (result.code === GIT_MISSING_EXIT)
    throw new PluginOperationError(
      "git-missing",
      "git is required for this plugin source but was not found on PATH.",
    );
  const detail = result.stderr
    .split(/\r?\n/u)
    .find((line) => line.trim() !== "");
  throw new PluginOperationError(
    "git-failed",
    `git ${args[0] ?? "command"} failed${detail === undefined ? ` with exit code ${result.code}` : `: ${terminalSafe(detail)}`}.`,
  );
}

async function cloneGitSource(
  source: GithubSource | UrlSource | GitSubdirSource,
  target: string,
  deps: SourceDeps,
  io: SourceIo,
): Promise<string> {
  if (io.exists(target))
    throw invalidSource(`The plugin source target ${target} already exists.`);
  io.makeDirectory(dirname(target));
  const url = gitUrlForPluginSource(source);
  await runGitChecked(
    [
      "clone",
      "--depth=1",
      "--no-tags",
      ...(source.ref === undefined ? [] : ["--branch", source.ref]),
      "--",
      url,
      target,
    ],
    dirname(target),
    deps,
  );
  if (source.sha !== undefined) {
    await runGitChecked(
      ["fetch", "--depth=1", "--no-tags", "--", url, source.sha],
      target,
      deps,
    );
    await runGitChecked(["reset", "--hard", "FETCH_HEAD"], target, deps);
  }
  const commit = await readGitCommit(target, deps);
  if (commit === undefined)
    throw new PluginOperationError(
      "git-failed",
      `The plugin checkout at ${target} has no commit.`,
    );
  return commit;
}

function semverParts(
  value: string,
): readonly [number, number, number] | undefined {
  const match = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/u.exec(value.trim());
  if (match === null) return undefined;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minorText = match[2];
  const patchText = match[3];
  if (Number.isNaN(major)) return undefined;
  return [
    major,
    minorText === undefined || minorText === "x" || minorText === "*"
      ? 0
      : Number.parseInt(minorText, 10),
    patchText === undefined || patchText === "x" || patchText === "*"
      ? 0
      : Number.parseInt(patchText, 10),
  ];
}

function compareSemver(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function satisfiesComparator(
  version: readonly number[],
  comparator: string,
): boolean {
  const match = /^(\^|~|>=|<=|>|<|=)?(.*)$/u.exec(comparator.trim());
  if (match === null) return false;
  const operator = match[1] ?? "";
  const target = semverParts(match[2] ?? "");
  if (target === undefined) return false;
  if (operator === "^") {
    const upper: readonly [number, number, number] =
      target[0] > 0
        ? [target[0] + 1, 0, 0]
        : target[1] > 0
          ? [0, target[1] + 1, 0]
          : [0, 0, target[2] + 1];
    return (
      compareSemver(version, target) >= 0 && compareSemver(version, upper) < 0
    );
  }
  if (operator === "~")
    return (
      compareSemver(version, target) >= 0 &&
      compareSemver(version, [target[0], target[1] + 1, 0]) < 0
    );
  if (operator === ">=") return compareSemver(version, target) >= 0;
  if (operator === "<=") return compareSemver(version, target) <= 0;
  if (operator === ">") return compareSemver(version, target) > 0;
  if (operator === "<") return compareSemver(version, target) < 0;
  return compareSemver(version, target) === 0;
}

function satisfies(version: string, spec: string): boolean {
  if (spec === "*" || spec === "x" || spec === "" || spec === "latest")
    return true;
  const comparators = spec.split(/\s+/u).filter(Boolean);
  return comparators.every((comparator) => {
    if (/^(\d+|x|\*)(\.(\d+|x|\*)){0,2}$/u.test(comparator)) {
      const target = semverParts(comparator);
      return (
        target !== undefined &&
        compareSemver(semverParts(version) ?? [], target) === 0
      );
    }
    return satisfiesComparator(semverParts(version) ?? [], comparator);
  });
}

function sortVersions(versions: readonly string[]): readonly string[] {
  return [...versions].sort((left, right) =>
    compareSemver(semverParts(left) ?? [], semverParts(right) ?? []),
  );
}

interface NpmVersionDocument {
  readonly version: string;
  readonly dist: {
    readonly tarball: string;
    readonly integrity?: string;
  };
}

interface NpmMetadata {
  readonly versions: Readonly<Record<string, NpmVersionDocument>>;
  readonly distTags: Readonly<Record<string, string>>;
}

function parseNpmMetadata(bytes: Uint8Array): NpmMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (error) {
    throw new PluginOperationError(
      "source-invalid",
      "The npm registry returned a document Droide could not read.",
      { cause: error },
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed["versions"]))
    throw new PluginOperationError(
      "source-invalid",
      "The npm registry returned a document Droide could not read.",
    );
  const versions: Record<string, NpmVersionDocument> = {};
  for (const [version, value] of Object.entries(parsed["versions"])) {
    if (!isRecord(value) || !isRecord(value["dist"])) continue;
    const tarball = value["dist"]["tarball"];
    if (typeof tarball !== "string") continue;
    const integrity = value["dist"]["integrity"];
    versions[version] = {
      version,
      dist: {
        tarball,
        ...(typeof integrity === "string" ? { integrity } : {}),
      },
    };
  }
  const rawTags = parsed["dist-tags"];
  const distTags: Record<string, string> = {};
  if (isRecord(rawTags))
    for (const [tag, value] of Object.entries(rawTags))
      if (typeof value === "string") distTags[tag] = value;
  return { versions, distTags };
}

function selectNpmVersion(
  metadata: NpmMetadata,
  spec: string | undefined,
): string {
  const requested = spec ?? "latest";
  if (Object.hasOwn(metadata.versions, requested)) return requested;
  const tagged = metadata.distTags[requested];
  if (tagged !== undefined && Object.hasOwn(metadata.versions, tagged))
    return tagged;
  const matching = sortVersions(
    Object.keys(metadata.versions).filter((version) =>
      satisfies(version, requested),
    ),
  );
  const chosen = matching.at(-1);
  if (chosen === undefined)
    throw new PluginOperationError(
      "plugin-not-found",
      `The npm registry has no version of this package that matches "${requested}".`,
    );
  return chosen;
}

function verifyIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const [algorithm, encoded] = integrity.split("-", 2);
  const digest = encoded?.split("?")[0];
  if (algorithm === undefined || digest === undefined) return false;
  if (algorithm !== "sha512" && algorithm !== "sha256" && algorithm !== "sha1")
    return false;
  const actual = createHash(algorithm).update(bytes).digest("base64");
  return actual === digest;
}

function encodeNpmPackage(name: string): string {
  return name.replace("/", "%2f");
}

async function materializeNpm(
  source: NpmSource,
  target: string,
  deps: SourceDeps,
  io: SourceIo,
  limits: ArchiveLimits,
): Promise<InstalledNpmMetadata> {
  const registry = source.registry ?? "https://registry.npmjs.org";
  const metadataUrl = `${registry}/${encodeNpmPackage(source.package)}`;
  const metadata = parseNpmMetadata(
    await downloadBytes(
      metadataUrl,
      authHeaders(source, metadataUrl, deps),
      deps,
    ),
  );
  const version = selectNpmVersion(metadata, source.version);
  const document = metadata.versions[version];
  if (document === undefined)
    throw new PluginOperationError(
      "plugin-not-found",
      `The npm registry has no version "${version}" of this package.`,
    );
  const tarball = await downloadBytes(
    document.dist.tarball,
    authHeaders(source, document.dist.tarball, deps),
    deps,
  );
  if (document.dist.integrity !== undefined) {
    if (!verifyIntegrity(tarball, document.dist.integrity))
      throw new PluginOperationError(
        "checksum-mismatch",
        "The downloaded npm package does not match the integrity the registry publishes.",
      );
  }
  const staging = `${target}.staging-${randomSuffix()}`;
  io.makeDirectory(staging);
  try {
    extractTarball(tarball, staging, limits, io);
    io.rename(staging, target);
  } catch (error) {
    io.remove(staging);
    throw error;
  }
  return {
    spec: source.version ?? "latest",
    version,
    resolved: document.dist.tarball,
    ...(document.dist.integrity === undefined
      ? {}
      : { integrity: document.dist.integrity }),
  };
}

async function materializeArchive(
  source: ArchiveSource,
  target: string,
  deps: SourceDeps,
  io: SourceIo,
  limits: ArchiveLimits,
): Promise<{ readonly version: string; readonly digest: string }> {
  if (source.sha256 !== undefined && !SHA256_PATTERN.test(source.sha256))
    throw invalidSource(
      "The marketplace's checksum for this plugin is malformed. Ask the marketplace owner to fix it.",
    );
  const bytes = await downloadBytes(
    source.url,
    authHeaders(source, source.url, deps),
    deps,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (source.sha256 !== undefined && digest !== source.sha256)
    throw new PluginOperationError(
      "checksum-mismatch",
      "The downloaded archive doesn't match the checksum the marketplace expects. Ask the marketplace owner to update it.",
    );
  const staging = `${target}.staging-${randomSuffix()}`;
  io.makeDirectory(staging);
  try {
    extractZipArchive(bytes, staging, limits, io);
    const root = findPluginRoot(staging, io);
    if (root !== staging) io.rename(root, target);
    else io.rename(staging, target);
    if (root !== staging) io.remove(staging);
    return { version: `archive-${digest.slice(0, 12)}`, digest };
  } catch (error) {
    io.remove(staging);
    throw error;
  }
}

/**
 * Materialise one source into `target`. `local` is used in place; `github`,
 * `url` and `git-subdir` clone; `npm` and `archive` download and extract.
 * The returned `version` names the installed cache directory and the returned
 * `commit`/`npm` are the provenance the caller records (B35).
 */
export async function materializeSource(
  source: PluginSource,
  options: MaterializeOptions,
): Promise<MaterializedSource> {
  const deps = options.deps ?? {};
  const io = deps.io ?? defaultSourceIo;
  const limits = deps.limits ?? ARCHIVE_LIMITS;
  const target = options.target;

  switch (source.source) {
    case "local": {
      const base = options.baseDirectory;
      const directory =
        isAbsolute(source.path) || base === undefined
          ? source.path
          : resolvePath(base, source.path);
      if (!io.exists(directory))
        throw new PluginOperationError(
          "source-missing",
          `The plugin source directory ${directory} does not exist.`,
        );
      const commit = await readGitCommit(directory, deps);
      return {
        directory,
        version: commit === undefined ? "local" : commit.slice(0, 12),
        ...(commit === undefined ? {} : { commit }),
        source: { source: "local", path: directory },
      };
    }
    case "github":
    case "url": {
      const commit = await cloneGitSource(source, target, deps, io);
      return {
        directory: target,
        version: commit.slice(0, 12),
        commit,
        source,
      };
    }
    case "git-subdir": {
      const checkout = `${target}.checkout-${randomSuffix()}`;
      io.makeDirectory(dirname(target));
      try {
        const commit = await cloneGitSource(source, checkout, deps, io);
        if (source.path !== ".") {
          const subdirectory = containedPath(checkout, source.path);
          if (!io.exists(subdirectory))
            throw new PluginOperationError(
              "source-missing",
              `The repository has no directory "${source.path}".`,
            );
          if (io.exists(target))
            throw invalidSource(
              `The plugin source target ${target} already exists.`,
            );
          io.rename(subdirectory, target);
        } else if (io.exists(target)) {
          throw invalidSource(
            `The plugin source target ${target} already exists.`,
          );
        } else {
          io.rename(checkout, target);
        }
        return {
          directory: target,
          version: commit.slice(0, 12),
          commit,
          source,
        };
      } finally {
        if (io.exists(checkout)) io.remove(checkout);
      }
    }
    case "npm": {
      const npm = await materializeNpm(source, target, deps, io, limits);
      return {
        directory: target,
        version: npm.version,
        npm,
        source,
      };
    }
    case "archive": {
      const archive = await materializeArchive(
        source,
        target,
        deps,
        io,
        limits,
      );
      return {
        directory: target,
        version: archive.version,
        source,
      };
    }
  }
}
