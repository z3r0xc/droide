/**
 * Typed failures for the session store. Contract:
 * `specs/40-sessions-and-storage.md` ("Errors") plus this slice's migration rules.
 *
 * Every failure a caller can act on is a class, never a bare string: the CLI
 * distinguishes "refuse the command" from "retry after yielding" from "rebuild
 * the index", and a code makes that switch explicit.
 */

export type SessionStoreErrorCode =
  | "schema-too-new"
  | "migration-checksum-mismatch"
  | "migration-version-invalid"
  | "migration-version-duplicate"
  | "migration-failed"
  | "invalid-argument"
  | "unknown-session"
  | "duplicate-session"
  | "invalid-session-id"
  | "invalid-project-key"
  | "outside-sessions-dir"
  | "invalid-transcript-record"
  | "transcript-corrupt"
  | "transcript-unavailable"
  | "missing-ingest-row"
  | "corrupt-session-row"
  | "store-closed";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

/** The file records a migration this build does not know; opening it would
 * silently run against a shape we cannot validate. */
export class SchemaTooNewError extends SessionStoreError {
  readonly headVersion: number;
  readonly foundVersions: readonly number[];

  constructor(headVersion: number, foundVersions: readonly number[]) {
    super(
      "schema-too-new",
      `session index schema version ${foundVersions.join(", ")} is newer than this build's ${headVersion}`,
    );
    this.name = "SchemaTooNewError";
    this.headVersion = headVersion;
    this.foundVersions = foundVersions;
  }
}

/** A released migration was edited: the ledger identity no longer matches. */
export class MigrationChecksumMismatchError extends SessionStoreError {
  readonly version: number;
  readonly name: string;
  readonly recorded: string;
  readonly expected: string;

  constructor(version: number, name: string, recorded: string, expected: string) {
    super(
      "migration-checksum-mismatch",
      `session index migration checksum mismatch for ${version}:${name}`,
    );
    this.name = "MigrationChecksumMismatchError";
    this.version = version;
    this.name = name;
    this.recorded = recorded;
    this.expected = expected;
  }
}

export class InvalidMigrationVersionError extends SessionStoreError {
  readonly version: number;

  constructor(version: number, detail: string) {
    super("migration-version-invalid", `session index migration ${detail}: ${version}`);
    this.name = "InvalidMigrationVersionError";
    this.version = version;
  }
}

export class DuplicateMigrationVersionError extends SessionStoreError {
  readonly version: number;

  constructor(version: number) {
    super("migration-version-duplicate", `duplicate session index migration version ${version}`);
    this.name = "DuplicateMigrationVersionError";
    this.version = version;
  }
}

export class MigrationFailedError extends SessionStoreError {
  readonly version: number;
  readonly name: string;

  constructor(migration: { readonly version: number; readonly name: string }, cause: unknown) {
    super("migration-failed", `session index migration ${migration.version}:${migration.name} failed`, {
      cause,
    });
    this.name = "MigrationFailedError";
    this.version = migration.version;
    this.name = migration.name;
  }
}

export class InvalidArgumentError extends SessionStoreError {
  constructor(message: string) {
    super("invalid-argument", message);
    this.name = "InvalidArgumentError";
  }
}

export class UnknownSessionError extends SessionStoreError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("unknown-session", `no indexed session ${sessionId}`);
    this.name = "UnknownSessionError";
    this.sessionId = sessionId;
  }
}

export class DuplicateSessionError extends SessionStoreError {
  readonly sessionId: string;

  constructor(sessionId: string, cause?: unknown) {
    super("duplicate-session", `session ${sessionId} is already indexed`, { cause });
    this.name = "DuplicateSessionError";
    this.sessionId = sessionId;
  }
}

export class InvalidSessionIdError extends SessionStoreError {
  constructor(value: string) {
    super("invalid-session-id", `session id is not a lowercase UUIDv4: ${JSON.stringify(value)}`);
    this.name = "InvalidSessionIdError";
  }
}

export class InvalidProjectKeyError extends SessionStoreError {
  constructor(value: string) {
    super("invalid-project-key", `project key is not a sessions-dir relative key: ${JSON.stringify(value)}`);
    this.name = "InvalidProjectKeyError";
  }
}

/** A stored project key would resolve outside the sessions directory (B17). */
export class OutsideSessionsDirError extends SessionStoreError {
  constructor(sessionId: string) {
    super("outside-sessions-dir", `indexed session ${sessionId} resolves outside the sessions dir`);
    this.name = "OutsideSessionsDirError";
  }
}

export class InvalidTranscriptRecordError extends SessionStoreError {
  constructor(detail: string, cause?: unknown) {
    super("invalid-transcript-record", `transcript record is not a JSON object: ${detail}`, { cause });
    this.name = "InvalidTranscriptRecordError";
  }
}

export class TranscriptCorruptError extends SessionStoreError {
  readonly line: number;

  constructor(line: number, cause: unknown) {
    super("transcript-corrupt", `transcript line ${line} is not a JSON object`, { cause });
    this.name = "TranscriptCorruptError";
    this.line = line;
  }
}

export class TranscriptUnavailableError extends SessionStoreError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("transcript-unavailable", `no transcript for session ${sessionId}`);
    this.name = "TranscriptUnavailableError";
    this.sessionId = sessionId;
  }
}

export class MissingIngestRowError extends SessionStoreError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("missing-ingest-row", `session ${sessionId} has no session_ingest bookkeeping row`);
    this.name = "MissingIngestRowError";
    this.sessionId = sessionId;
  }
}

export class CorruptSessionRowError extends SessionStoreError {
  constructor(sessionId: string, detail: string) {
    super("corrupt-session-row", `session ${sessionId} row is corrupt: ${detail}`);
    this.name = "CorruptSessionRowError";
  }
}

export class StoreClosedError extends SessionStoreError {
  constructor() {
    super("store-closed", "session store is closed");
    this.name = "StoreClosedError";
  }
}