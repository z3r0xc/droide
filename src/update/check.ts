/**
 * Update checks.
 *
 * Contract: `docs/adr/0007-update-channel.md`, with the command surface from
 * `specs/10-cli-surface.md` §B75. The release feed is GitHub's; the running
 * version is `package.json`; nothing here installs anything.
 *
 * Every response is untrusted input: bounded, parsed, and compared as semver.
 */
export interface ReleaseInfo {
  readonly tag: string;
  readonly url: string;
}

export type UpdateCheck =
  | { readonly kind: "current"; readonly version: string }
  | {
      readonly kind: "available";
      readonly version: string;
      readonly url: string;
      readonly current: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface CheckForUpdateOptions {
  /** `owner/repo` on GitHub. */
  readonly repository: string;
  readonly currentVersion: string;
  readonly fetch: typeof fetch;
  /** Bounded body read; the release JSON we need is tiny. */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly nowIso?: string;
}

export const MAX_RELEASE_BODY_BYTES = 64 * 1024;
export const RELEASE_TIMEOUT_MS = 5_000;

/** Parse `v1.2.3` or `1.2.3` into numeric parts; anything else is `null`. */
export function parseSemver(value: string): readonly number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined)
    return null;
  return [Number(major), Number(minor), Number(patch)];
}

/** Negative when `left` is older, zero when equal, positive when newer. */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function releaseUrl(repository: string): URL {
  return new URL(`https://api.github.com/repos/${repository}/releases/latest`);
}

/** Read at most `limit` bytes from a response body. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`release metadata exceeds ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Ask the release feed whether a newer version exists. Never throws. */
export async function checkForUpdate(
  options: CheckForUpdateOptions,
): Promise<UpdateCheck> {
  const limit = options.maxBytes ?? MAX_RELEASE_BODY_BYTES;
  try {
    const response = await options.fetch(releaseUrl(options.repository), {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "droide-update-check",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? RELEASE_TIMEOUT_MS),
    });

    if (response.status === 404) {
      // GitHub answers 404 both for "no releases" and for a repository an
      // anonymous client cannot see (private): say both, do not guess.
      return {
        kind: "unavailable",
        reason:
          "no release feed visible to an anonymous client (no releases yet, or a private repository)",
      };
    }
    if (response.status === 403 || response.status === 429) {
      // An anonymous client is rate-limited per address; the same answer comes
      // for a blocked network. Both are temporary, so name the cause and the
      // wait rather than reporting a bare status.
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

    const text = await readBounded(response, limit);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        kind: "unavailable",
        reason: "release feed returned malformed JSON",
      };
    }
    if (payload === null || typeof payload !== "object") {
      return {
        kind: "unavailable",
        reason: "release feed returned an unexpected document",
      };
    }
    const tag =
      "tag_name" in payload && typeof payload.tag_name === "string"
        ? payload.tag_name
        : undefined;
    const htmlUrl =
      "html_url" in payload && typeof payload.html_url === "string"
        ? payload.html_url
        : undefined;
    if (tag === undefined) {
      return { kind: "unavailable", reason: "release has no tag" };
    }
    if (parseSemver(tag) === null) {
      return {
        kind: "unavailable",
        reason: `release tag ${tag} is not a semantic version`,
      };
    }

    const order = compareSemver(tag, options.currentVersion);
    if (order === null) {
      return {
        kind: "unavailable",
        reason: `cannot compare ${tag} with ${options.currentVersion}`,
      };
    }
    if (order <= 0) return { kind: "current", version: options.currentVersion };
    return {
      kind: "available",
      version: tag.replace(/^v/, ""),
      url:
        htmlUrl ?? `https://github.com/${options.repository}/releases/latest`,
      current: options.currentVersion,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
