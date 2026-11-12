/**
 * The context every tool execution receives.
 *
 * Contract: `src/README.md` boundary rules — `config/` is the only reader of
 * `process.cwd()`/`process.env`, so a tool is handed the workspace root and the
 * injected {@link Environment} instead of reading them.
 */
import type { Environment } from "../config/paths.ts";

/** What a tool needs to resolve paths and name files. */
export interface ToolContext {
  /** Absolute workspace root: the base for relative paths. */
  readonly root: string;
  readonly environment: Environment;
  /**
   * Files read in this session, so `Edit` can refuse a file it has not seen
   * and one changed after it was read (B22). Omitted means no tracking.
   */
  readonly reads?: ReadTracker;
}

/** The read/write record `Edit` compares against (B22). */
export interface ReadRecord {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ReadTracker {
  record(path: string, record: ReadRecord): void;
  check(path: string): ReadRecord | undefined;
}