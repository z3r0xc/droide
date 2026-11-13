/**
 * `update` command body.
 *
 * Contract: `docs/adr/0007-update-channel.md`, `docs/adr/0009-update-installation.md`
 * and `specs/10-cli-surface.md` §B75.
 *
 * `--check` is the read-only path it always was. Without it the command
 * installs the release the feed offers, or the version named by `--version`,
 * through {@link installRelease}: digest first, stage, swap, probe. Every
 * refusal is a message plus exit 1; only a completed install (or an
 * already-current installation) exits 0.
 */
import {
  checkForUpdate,
  compareSemver,
  MAX_RELEASE_BODY_BYTES,
  parseSemver,
  RELEASE_TIMEOUT_MS,
  type UpdateCheck,
} from "../update/check.ts";
import {
  installRelease,
  parseReleaseDocument,
  UpdateInstallError,
  type InstallFs,
  type InstallProbe,
  type InstallReleaseOptions,
  type InstallReleaseResult,
  type ReleaseDocument,
  type UpdatePlatform,
} from "../update/install.ts";

export interface UpdateOptions {
  readonly check?: boolean;
  readonly version?: string;
}

export interface UpdateDeps {
  readonly currentVersion: string;
  readonly repository: string;
  readonly fetch: typeof fetch;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  /** Where the installed tree lives; required to install, unused by `--check`. */
  readonly installDir?: string;
  readonly fs?: InstallFs;
  readonly clock?: () => number;
  readonly probe?: InstallProbe;
  readonly platform?: UpdatePlatform;
  readonly arch?: string;
}

/** Render the read-only check result. Wording is ours (B75 pins codes, not text). */
export function renderUpdateResult(result: UpdateCheck): string {
  switch (result.kind) {
    case "current":
      return `droide ${result.version} is up to date.\n`;
    case "available":
      return `droide ${result.version} is available (running ${result.current}).\n${result.url}\n`;
    case "unavailable":
      return `could not check for updates: ${result.reason}\n`;
  }
}

/** Render what an install did, including a skipped probe. */
export function renderInstallResult(result: InstallReleaseResult): string {
  const installed = `installed droide ${result.version} in ${result.installDir}.\n`;
  return result.probeNote === undefined
    ? `${installed}the new binary answered \`--version\`.\n`
    : `${installed}the new binary could not be probed (${result.probeNote}).\n`;
}

type ReleaseLookup =
  | { readonly kind: "release"; readonly release: ReleaseDocument }
  | { readonly kind: "not-found"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

async function readBounded(response: Response, limit: number): Promise<string> {
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
        throw new Error(`release metadata exceeds ${limit} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

function releaseUrl(repository: string, tag: string | null): URL {
  return tag === null
    ? new URL(`https://api.github.com/repos/${repository}/releases/latest`)
    : new URL(
        `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      );
}

/**
 * Read the release document for the latest release, or for one tag. A tag may
 * be published with or without the `v` prefix, so a 404 on one spelling tries
 * the other; only then is it "not found".
 */
async function fetchRelease(
  repository: string,
  version: string | null,
  fetchImpl: typeof fetch,
): Promise<ReleaseLookup> {
  const tags = version === null ? [null] : [`v${version}`, version];
  let notFound = "the release feed has no such release";
  for (const tag of tags) {
    let response: Response;
    try {
      response = await fetchImpl(releaseUrl(repository, tag), {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "droide-updater",
        },
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 404) {
      notFound =
        version === null
          ? "no release feed visible to an anonymous client (no releases yet, or a private repository)"
          : `no release tagged ${version} is published`;
      continue;
    }
    if (response.status === 403 || response.status === 429) {
      // Same cause as the check path: an address that has spent its anonymous
      // budget. Say so, because the bare status reads like a broken feed.
      const reset = response.headers.get("x-ratelimit-reset");
      const wait =
        reset === null
          ? null
          : Math.max(0, Number.parseInt(reset, 10) * 1000 - Date.now());
      return {
        kind: "unavailable",
        reason:
          wait === null || !Number.isFinite(wait)
            ? `the release feed is rate-limited (HTTP ${response.status}); try again later`
            : `the release feed is rate-limited (HTTP ${response.status}); try again in ${Math.max(1, Math.ceil(wait / 60_000))} minute(s)`,
      };
    }
    if (!response.ok) {
      return {
        kind: "unavailable",
        reason: `release feed answered ${response.status}`,
      };
    }
    let text: string;
    try {
      text = await readBounded(response, MAX_RELEASE_BODY_BYTES);
    } catch (error) {
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        kind: "unavailable",
        reason: "release feed returned malformed JSON",
      };
    }
    const release = parseReleaseDocument(payload);
    if (release === null) {
      return {
        kind: "unavailable",
        reason: "release feed returned an unexpected document",
      };
    }
    return { kind: "release", release };
  }
  return { kind: "not-found", reason: notFound };
}

async function installFromFeed(
  options: UpdateOptions,
  deps: UpdateDeps,
): Promise<void> {
  const requested = options.version;
  if (requested !== undefined && parseSemver(requested) === null) {
    deps.writeError(
      `invalid --version ${JSON.stringify(requested)}: expected a semantic version such as 1.2.3\n`,
    );
    deps.setExitCode(1);
    return;
  }
  const installDir = deps.installDir;
  if (installDir === undefined) {
    deps.writeError(
      "cannot install an update: this build does not know its installation directory\n",
    );
    deps.setExitCode(1);
    return;
  }

  const lookup = await fetchRelease(
    deps.repository,
    requested ?? null,
    deps.fetch,
  );
  if (lookup.kind === "not-found") {
    deps.writeError(`could not install an update: ${lookup.reason}\n`);
    deps.setExitCode(1);
    return;
  }
  if (lookup.kind === "unavailable") {
    deps.writeError(`could not read the release feed: ${lookup.reason}\n`);
    deps.setExitCode(1);
    return;
  }

  const { release } = lookup;
  if (parseSemver(release.tag) === null) {
    deps.writeError(
      `release tag ${release.tag} is not a semantic version; refusing to install it\n`,
    );
    deps.setExitCode(1);
    return;
  }
  if (requested !== undefined && compareSemver(release.tag, requested) !== 0) {
    deps.writeError(
      `the feed answered with release ${release.tag}, not ${requested}; refusing to install it\n`,
    );
    deps.setExitCode(1);
    return;
  }

  const order = compareSemver(release.tag, deps.currentVersion);
  if (order === null) {
    deps.writeError(
      `cannot compare ${release.tag} with ${deps.currentVersion}; refusing to install it\n`,
    );
    deps.setExitCode(1);
    return;
  }
  if (requested === undefined && order <= 0) {
    deps.write(`droide ${deps.currentVersion} is up to date.\n`);
    deps.setExitCode(0);
    return;
  }
  if (
    requested !== undefined &&
    compareSemver(requested, deps.currentVersion) === 0
  ) {
    deps.write(`droide ${deps.currentVersion} is already installed.\n`);
    deps.setExitCode(0);
    return;
  }

  const installOptions: InstallReleaseOptions = {
    release,
    fetch: deps.fetch,
    installDir,
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    ...(deps.arch === undefined ? {} : { arch: deps.arch }),
  };

  try {
    const result = await installRelease(installOptions);
    deps.write(renderInstallResult(result));
    deps.setExitCode(0);
  } catch (error) {
    if (error instanceof UpdateInstallError) {
      deps.writeError(`${error.message}\n`);
    } else {
      deps.writeError(
        `update failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    deps.setExitCode(1);
  }
}

/**
 * Exit codes: 0 the check ran or the install completed, 1 the check failed, the
 * request was invalid, or the install failed (B75, ADR 0007, ADR 0009).
 */
export async function runUpdateCommand(
  options: UpdateOptions,
  deps: UpdateDeps,
): Promise<void> {
  if (options.check !== true) {
    await installFromFeed(options, deps);
    return;
  }

  const result = await checkForUpdate({
    repository: deps.repository,
    currentVersion: deps.currentVersion,
    fetch: deps.fetch,
  });

  deps.write(renderUpdateResult(result));
  deps.setExitCode(result.kind === "unavailable" ? 1 : 0);
}
