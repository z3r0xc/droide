/**
 * The context every tool execution receives.
 *
 * Contract: `src/README.md` boundary rules — `config/` is the only reader of
 * `process.cwd()`/`process.env`, so a tool is handed the workspace root and the
 * injected {@link Environment} instead of reading them.
 */
import type { Environment } from "../config/paths.ts";
import type { SearchBackend } from "./native-backend.ts";

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
  /**
   * Discovery backend for `Glob` and `Grep` (`specs/90-native-layer.md`).
   * Omitted means the local walk, which is also what a configured-but-broken
   * helper degrades to.
   */
  readonly nativeBackend?: SearchBackend;
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
/** The default tracker: one record per path, replaced by each read. */
export class FileReadTracker implements ReadTracker {
  private readonly records = new Map<string, ReadRecord>();

  record(path: string, record: ReadRecord): void {
    this.records.set(path, record);
  }

  check(path: string): ReadRecord | undefined {
    return this.records.get(path);
  }
}
