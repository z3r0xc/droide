/**
 * The file-discovery backend behind `Glob` and `Grep`.
 *
 * Contract: `specs/90-native-layer.md` (the helper boundary: `search.walk`,
 * `search.text`, `path.resolve`) and `specs/30-tools-and-sandbox.md` B19/B20
 * (the tools' own matching, ordering, truncation and refusal text).
 *
 * Two implementations:
 *
 * - `local` — the existing TypeScript walk (`walkFiles`). It is the default and
 *   the fallback: nothing in this build needs the helper to search.
 * - `helper` — `crates/droide-native` walks the tree (`search.walk`), narrows a
 *   literal `Grep` to the files that contain the query (`search.text`) and
 *   re-checks containment (`path.resolve`).
 *
 * Selection is deliberately conservative and lives in
 * {@link createSearchBackend}: the helper is used only when the caller asks for
 * it (`nativeBackend: "helper"`) **and** the binary exists. Any failure of a
 * helper call — a refused start, a dead process, a bad frame, a late answer —
 * marks the backend degraded, is recorded as a {@link SearchBackendDiagnostic},
 * and the same call answers from `local`; a broken helper degrades a run
 * instead of breaking it. A path the helper *refuses* as outside the workspace
 * root is not a failure: it is the containment guarantee, and it stays a
 * refusal.
 *
 * What the backend never decides: the tools keep their include/exclude matrix,
 * credential floor, result bounds and output shapes. `search.walk` only
 * replaces the directory walk, so `Glob` returns the same absolute paths in the
 * same order and `Grep` intersects its own candidates with the helper's hits.
 * The helper's documented limits are narrower than the tools' in two places,
 * and both are handled here rather than leaking into a result:
 *
 * - a walk cut at the helper's 10 000-path ceiling falls back to `local` and
 *   disables narrowing, whose own walk carries the same ceiling;
 * - a text search cut at its 1 000-hit ceiling returns `null` (no narrowing),
 *   and files above its 1 MiB per-file read budget stay candidates, because a
 *   match could live only there.
 *
 * `search.walk` never enters a VCS metadata directory (`.git`, `.hg`, `.svn`,
 * `.jj`) and follows symlinks; `walkFiles` does neither. A helper-backed run
 * therefore reports no file under those directories, which is the helper's
 * documented behaviour. Discovery still happens for a root outside the
 * workspace root: the tools allow an absolute path anywhere, and containment is
 * only asserted for a path already inside the root.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { createNativeClient, type NativeClient } from "../native/client.ts";
import { NativeError } from "../native/errors.ts";
import { pathResolve, searchText, searchWalk } from "../native/methods.ts";
import { NATIVE_ERROR_CODES } from "../native/protocol.ts";
import { ToolFailure } from "./errors.ts";
import { isInside } from "./fs/paths.ts";
import { walkFiles, type WalkEntry } from "./fs/walk.ts";

/** `crates/droide-native` `search.rs`: the most paths one walk can return. */
const NATIVE_WALK_LIMIT = 10_000;
/** `crates/droide-native` `search.rs`: the most text hits one search returns. */
const NATIVE_TEXT_HIT_LIMIT = 1_000;
/** `crates/droide-native` `search.rs`: a larger file is not searched for text. */
export const NATIVE_FILE_BYTES_LIMIT = 1 << 20;

export type NativeBackendKind = "local" | "helper";

export type SearchBackendDiagnosticCode =
  "native-helper-unavailable" | "native-helper-failed";

/** A degradation this run observed; never a user-facing error by itself. */
export interface SearchBackendDiagnostic {
  readonly code: SearchBackendDiagnosticCode;
  readonly message: string;
}

/** A literal query the helper can answer exactly. */
export interface LiteralQuery {
  readonly query: string;
  readonly caseSensitive: boolean;
}

/** One line the helper matched, relative to the root it searched. */
export interface LiteralHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * What `Glob` and `Grep` need from a filesystem: discovery, an optional exact
 * narrowing, and a containment check.
 */
export interface SearchBackend {
  readonly kind: NativeBackendKind;
  /** Every degradation observed so far, oldest first. */
  readonly diagnostics: readonly SearchBackendDiagnostic[];
  /**
   * Every regular file under `root`, sorted by `/`-separated relative path.
   * The caller applies its own filters and bound.
   */
  discover(root: string): Promise<readonly WalkEntry[]>;
  /**
   * The files under `root` containing `request.query`, or `null` when this
   * backend cannot narrow the search exactly (the caller then reads them all).
   */
  text(
    root: string,
    request: LiteralQuery,
  ): Promise<readonly LiteralHit[] | null>;
  /**
   * Asserts that `candidate` stays inside `root`, or throws `ToolFailure` with
   * the tools' escape wording. Callers only pass a path inside the root.
   */
  contain(root: string, candidate: string): Promise<void>;
  /** Releases the helper process; idempotent. */
  close(): Promise<void>;
}

/** The default implementation: the TypeScript walk the tools always used. */
class LocalSearchBackend implements SearchBackend {
  readonly kind = "local";
  private readonly recorded: SearchBackendDiagnostic[];

  constructor(recorded: readonly SearchBackendDiagnostic[] = []) {
    this.recorded = [...recorded];
  }

  get diagnostics(): readonly SearchBackendDiagnostic[] {
    return [...this.recorded];
  }

  discover(root: string): Promise<readonly WalkEntry[]> {
    return walkFiles(root);
  }

  text(): Promise<readonly LiteralHit[] | null> {
    return Promise.resolve(null);
  }

  contain(root: string, candidate: string): Promise<void> {
    const resolved = nodePath.resolve(root, candidate);
    if (!isInside(root, resolved)) {
      return Promise.reject(
        new ToolFailure(
          `Cannot access a path outside the workspace root: "${candidate}"`,
        ),
      );
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The native implementation, with a one-way trip to `local` on any failure. */
class HelperSearchBackend implements SearchBackend {
  readonly kind = "helper";
  private readonly recorded: SearchBackendDiagnostic[] = [];
  private readonly client: NativeClient;
  private degraded = false;
  /** Set when the helper's walk was cut: its text search walks the same way. */
  private walkTruncated = false;

  constructor(client: NativeClient) {
    this.client = client;
  }

  get diagnostics(): readonly SearchBackendDiagnostic[] {
    return [...this.recorded];
  }

  /**
   * The first failure ends the helper's participation for this run and is kept
   * as the diagnostic; repeating the failing request would only cost a timeout
   * per tool call.
   */
  private degrade(method: string, error: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.recorded.push({
      code: "native-helper-failed",
      message:
        `native helper ${this.client.helperPath} failed ${method} ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        `Glob and Grep continue with the local walk`,
    });
  }

  async discover(root: string): Promise<readonly WalkEntry[]> {
    if (this.degraded) return await walkFiles(root);
    try {
      const result = await searchWalk(this.client, {
        root,
        maxResults: NATIVE_WALK_LIMIT,
        includeHidden: true,
      });
      // A cut walk may have dropped files the tools would report, and the
      // local walk has no such ceiling; the tool's result must not narrow here.
      if (result.truncated) {
        this.walkTruncated = true;
        return await walkFiles(root);
      }
      return result.paths.map((relative) => ({
        absolute: nodePath.join(root, ...relative.split("/")),
        relative,
      }));
    } catch (error) {
      this.degrade("search.walk", error);
      return await walkFiles(root);
    }
  }

  async text(
    root: string,
    request: LiteralQuery,
  ): Promise<readonly LiteralHit[] | null> {
    if (this.degraded || this.walkTruncated) return null;
    try {
      const result = await searchText(this.client, {
        root,
        query: request.query,
        maxHits: NATIVE_TEXT_HIT_LIMIT,
        caseSensitive: request.caseSensitive,
        includeHidden: true,
      });
      // Hits are a narrowing, so a cut list cannot be trusted: the caller
      // reads every candidate instead of silently dropping the rest.
      if (result.truncated) return null;
      return result.hits;
    } catch (error) {
      this.degrade("search.text", error);
      return null;
    }
  }

  async contain(root: string, candidate: string): Promise<void> {
    if (this.degraded) return;
    const relative = nodePath.relative(root, candidate);
    try {
      await pathResolve(this.client, {
        root,
        path: relative === "" ? "." : relative.split(nodePath.sep).join("/"),
      });
    } catch (error) {
      if (
        error instanceof NativeError &&
        error.code === NATIVE_ERROR_CODES.invalidParams
      ) {
        throw new ToolFailure(
          `Cannot access a path outside the workspace root: "${candidate}"`,
          { cause: error },
        );
      }
      // A broken helper is not a containment verdict.
      this.degrade("path.resolve", error);
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export interface CreateSearchBackendOptions {
  readonly kind: NativeBackendKind;
  /** Absolute helper path; absent means "not installed", never a failure. */
  readonly helperPath?: string;
  /** Injected in tests; defaults to the real client factory. */
  readonly openHelper?: (helperPath: string) => Promise<NativeClient>;
}

/**
 * Pick the backend for a run.
 *
 * `local` unless the caller asked for `helper` and the binary exists. A binary
 * that exists but cannot start (or fails its version handshake) is recorded as
 * a diagnostic and the session runs on `local`.
 */
export async function createSearchBackend(
  options: CreateSearchBackendOptions,
): Promise<SearchBackend> {
  if (options.kind === "local") return new LocalSearchBackend();
  const helperPath = options.helperPath;
  if (helperPath === undefined || !fs.existsSync(helperPath)) {
    return new LocalSearchBackend();
  }
  try {
    const client =
      options.openHelper === undefined
        ? await createNativeClient({ helperPath })
        : await options.openHelper(helperPath);
    return new HelperSearchBackend(client);
  } catch (error) {
    return new LocalSearchBackend([
      {
        code: "native-helper-unavailable",
        message:
          `native helper ${helperPath} could not be used ` +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          `Glob and Grep use the local walk`,
      },
    ]);
  }
}
