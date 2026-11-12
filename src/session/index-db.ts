/**
 * The session index database: opening it, proving its shape, recovering from a
 * corrupt file, and the transcript-index row writes. Contract:
 * `specs/40-sessions-and-storage.md` B1-B16, plus the transcript projection the
 * search path reads (B23-B26, B30, B47).
 *
 * Three guarantees matter to every caller:
 *
 * - an open settles the connection exactly the way B2 documents (WAL, no
 *   auto-checkpoint, bounded journal, foreign keys on, busy timeout at rest);
 * - a file that is not the shape this build's migrations produce is refused
 *   before a single row is read (B12);
 * - a file SQLite reports as corrupt is moved aside into `quarantine/` and the
 *   open retries once on a fresh file (B14) — the transcripts are the user's
 *   data, the index is disposable, so recovery never costs a session.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { IndexShapeError } from "./errors.ts";
import type { SessionClock } from "./ids.ts";
import type { IndexedTranscriptRow } from "./index-planner.ts";
import { migrateSessionIndex, type MigrateReport } from "./migrate.ts";
import type { SessionKind } from "./store.ts";

export interface OpenSessionIndexOptions {
  readonly dbPath: string;
  readonly clock: SessionClock;
}

/** Where a corrupt file was moved, and why (B14). */
export interface QuarantineReport {
  readonly directory: string;
  readonly database: string;
  readonly files: readonly string[];
  readonly reason: string;
}

export interface OpenedSessionIndex {
  readonly db: DatabaseSync;
  readonly migration: MigrateReport;
  /** Present only when the open had to move a corrupt file aside. */
  readonly quarantine: QuarantineReport | null;
}

const NEVER_INDEX_MARKER = ".metadata_never_index";
const QUARANTINE_DIR = "quarantine";
const SIDECARS = ["-wal", "-shm"] as const;

/**
 * Settle the connection in the order B2 fixes: `auto_vacuum` first (it cannot
 * be changed in place later), then the journal and its policy, then locks.
 */
function applyPragmas(db: DatabaseSync): void {
  // `auto_vacuum` is read before the rest, and set only when the file is not
  // already incremental: the value cannot be changed in place on a populated
  // database, and a redundant write is a page of churn.
  const autoVacuum = db.prepare("PRAGMA auto_vacuum").get();
  const mode =
    autoVacuum !== null &&
    typeof autoVacuum === "object" &&
    "auto_vacuum" in autoVacuum
      ? autoVacuum.auto_vacuum
      : undefined;
  if (typeof mode !== "number" || mode !== 2) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  }

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("PRAGMA journal_size_limit = 524288");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("PRAGMA foreign_keys = ON");
}

function writeNeverIndexMarker(directory: string): void {
  try {
    // Best effort: a spyware/backup tool that honours it must not learn the
    // index exists, but a refused write must never block the open (B1).
    writeFileSync(join(directory, NEVER_INDEX_MARKER), "");
  } catch {
    // Deliberately ignored.
  }
}

interface SqliteError extends Error {
  readonly errcode?: number;
}

/**
 * SQLite's unusable-page results: `SQLITE_CORRUPT` (11), its extended forms
 * (`SQLITE_CORRUPT_VTAB`, `..._SEQUENCE`, `..._INDEX` — same low byte) and
 * `SQLITE_NOTADB` (26).
 */
function isCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as SqliteError).errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === 11 || primary === 26;
  }
  return /database disk image is malformed|file is not a database/i.test(
    error.message,
  );
}

function quarantineName(at: Date): string {
  // ISO-8601 with `:` and `.` replaced: safe as a directory name everywhere.
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${stamp}_${process.pid}`;
}

function pruneQuarantine(root: string, database: string): void {
  let holders: string[];
  try {
    holders = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, entry.name, database)),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const stale of holders.slice(0, Math.max(0, holders.length - 2))) {
    try {
      rmSync(join(root, stale), { recursive: true, force: true });
    } catch {
      // A folder a peer still holds is not worth failing the open over.
    }
  }
}

/**
 * Move the database and its sidecars into a timestamped quarantine folder.
 * Sidecars go first, then the main file, then anything that appeared at the
 * live path while the move ran (B14). A refused rename propagates: the caller
 * rethrows the original corruption, leaving the file where it is.
 */
function quarantineDatabase(
  dbPath: string,
  cause: unknown,
  at: Date,
): QuarantineReport {
  const directory = dirname(dbPath);
  const root = join(directory, QUARANTINE_DIR);
  const database = basename(dbPath);
  const target = join(root, quarantineName(at));
  mkdirSync(target, { recursive: true });

  const files: string[] = [];
  const move = (from: string, to: string): void => {
    if (!existsSync(from)) return;
    renameSync(from, to);
    files.push(to);
  };

  for (const suffix of SIDECARS)
    move(`${dbPath}${suffix}`, join(target, `${database}${suffix}`));
  move(dbPath, join(target, database));
  for (const suffix of SIDECARS) {
    const late = `${dbPath}${suffix}`;
    if (existsSync(late)) move(late, join(target, `${database}${suffix}.late`));
  }

  pruneQuarantine(root, database);
  return {
    directory: target,
    database,
    files,
    reason: cause instanceof Error ? cause.message : String(cause),
  };
}

interface SchemaColumn {
  readonly name: string;
  readonly signature: string;
}

interface ExpectedSchema {
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly SchemaColumn[];
  }[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
}

function columnsOf(db: DatabaseSync, table: string): SchemaColumn[] {
  return asRows(
    db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all(),
  )
    .map((row) => ({
      name: String(row["name"]),
      signature: `${String(row["name"])}|${String(row["type"])}|${String(row["notnull"])}|${
        row["dflt_value"] === null ? "-" : String(row["dflt_value"])
      }|${String(row["pk"])}`,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function objectNames(db: DatabaseSync, type: string): string[] {
  return asRows(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type),
  ).map((row) => String(row["name"]));
}

function readExpectedSchema(db: DatabaseSync): ExpectedSchema {
  const tables = objectNames(db, "table").map((name) => ({
    name,
    columns: columnsOf(db, name),
  }));
  return {
    tables,
    indexes: objectNames(db, "index"),
    triggers: objectNames(db, "trigger"),
  };
}

let expectedSchema: ExpectedSchema | null = null;

/**
 * The shape this build's migrations produce, built once in a throwaway
 * `:memory:` database. Migration SQL is the single source of truth for the
 * shape; writing it down twice is how the two drift apart.
 */
function expectedSessionIndexSchema(): ExpectedSchema {
  if (expectedSchema !== null) return expectedSchema;
  const memory = new DatabaseSync(":memory:");
  try {
    migrateSessionIndex(memory, {
      clock: { now: () => 0 },
    });
    expectedSchema = readExpectedSchema(memory);
    return expectedSchema;
  } finally {
    memory.close();
  }
}

/**
 * The file behind `db` must have every table, every column of those tables and
 * every index this build's migrations produce; extra tables and indexes are
 * tolerated, an extra trigger or view is not (B12/B13). First failure wins, in
 * table → column → index → foreign-object order.
 */
export function validateIndexShape(db: DatabaseSync): void {
  const expected = expectedSessionIndexSchema();
  const actualTables = new Set(objectNames(db, "table"));

  for (const table of expected.tables) {
    if (!actualTables.has(table.name)) {
      throw new IndexShapeError("missing-table", table.name);
    }
  }

  for (const table of expected.tables) {
    const actual = new Map(
      columnsOf(db, table.name).map((column) => [column.name, column]),
    );
    for (const column of table.columns) {
      const found = actual.get(column.name);
      if (found === undefined) {
        throw new IndexShapeError(
          "missing-column",
          `${table.name}.${column.name}`,
        );
      }
      if (found.signature !== column.signature) {
        throw new IndexShapeError(
          "column-changed",
          `${table.name}.${column.name}`,
        );
      }
    }
  }

  const actualIndexes = new Set(objectNames(db, "index"));
  for (const name of expected.indexes) {
    if (!actualIndexes.has(name))
      throw new IndexShapeError("missing-index", name);
  }

  const expectedTriggers = new Set(expected.triggers);
  for (const name of objectNames(db, "trigger")) {
    if (!expectedTriggers.has(name))
      throw new IndexShapeError("foreign-object", name);
  }
  const views = objectNames(db, "view");
  const firstView = views[0];
  if (firstView !== undefined)
    throw new IndexShapeError("foreign-object", firstView);
}

function openOnce(options: OpenSessionIndexOptions): OpenedSessionIndex {
  const db = new DatabaseSync(options.dbPath);
  try {
    applyPragmas(db);
    const migration = migrateSessionIndex(db, { clock: options.clock });
    validateIndexShape(db);
    return { db, migration, quarantine: null };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openSessionIndexDatabase(
  options: OpenSessionIndexOptions,
): OpenedSessionIndex {
  const directory = dirname(options.dbPath);
  mkdirSync(directory, { recursive: true });
  writeNeverIndexMarker(directory);

  try {
    return openOnce(options);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;

    let quarantine: QuarantineReport;
    try {
      quarantine = quarantineDatabase(options.dbPath, error, new Date());
    } catch {
      // The filesystem refused the move (a peer holds the file on Windows).
      // The original failure is the one worth reporting.
      throw error;
    }

    // One retry on a fresh file; a second failure propagates and leaves the
    // fresh file where it is (B14).
    return { ...openOnce(options), quarantine };
  }
}

/* ------------------------------------------------------------------------- */
/* Transcript-index rows.                                                    */
/* ------------------------------------------------------------------------- */

function readIndexedRow(row: Record<string, unknown>): IndexedTranscriptRow {
  return {
    transcriptPath: String(row["transcript_path"]),
    sessionId: String(row["session_id"]),
    projectKey: String(row["project_key"]),
    transcriptMtimeMs: Number(row["transcript_mtime_ms"]),
    transcriptSize: Number(row["transcript_size"]),
  };
}

export function readIndexedTranscripts(
  db: DatabaseSync,
): readonly IndexedTranscriptRow[] {
  return asRows(
    db
      .prepare(
        `SELECT transcript_path, session_id, project_key,
                transcript_mtime_ms, transcript_size
           FROM transcript_index
          ORDER BY transcript_path ASC`,
      )
      .all(),
  ).map(readIndexedRow);
}

/**
 * Insert the row, or refresh it when the same path is already indexed. Keyed by
 * the transcript path; the fingerprint columns are what a later plan compares.
 * The migration's trigger drops the cached values when the fingerprint moves.
 */
export function upsertIndexedTranscript(
  db: DatabaseSync,
  row: IndexedTranscriptRow,
  indexedAt: number,
): void {
  db.prepare(
    `INSERT INTO transcript_index (
       transcript_path, session_id, project_key,
       transcript_mtime_ms, transcript_size, indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (transcript_path) DO UPDATE SET
       session_id = excluded.session_id,
       project_key = excluded.project_key,
       transcript_mtime_ms = excluded.transcript_mtime_ms,
       transcript_size = excluded.transcript_size,
       indexed_at = excluded.indexed_at`,
  ).run(
    row.transcriptPath,
    row.sessionId,
    row.projectKey,
    row.transcriptMtimeMs,
    row.transcriptSize,
    indexedAt,
  );
}

export function deleteIndexedTranscript(
  db: DatabaseSync,
  transcriptPath: string,
): boolean {
  const result = db
    .prepare("DELETE FROM transcript_index WHERE transcript_path = ?")
    .run(transcriptPath);
  return Number(result.changes) > 0;
}

export interface TranscriptIndexValueRow {
  readonly lineNumber: number;
  readonly ordinal: number;
  readonly kind: SessionKind;
  readonly toolName: string | null;
  readonly messageRole: string | null;
  readonly isSummary: boolean;
  /** The value lowercased with the same rule the literal scan uses. */
  readonly valueLower: string;
}

/** Replace one transcript's cached values; the row itself must already exist. */
export function replaceTranscriptIndexValues(
  db: DatabaseSync,
  transcriptPath: string,
  values: readonly TranscriptIndexValueRow[],
): void {
  db.prepare(
    "DELETE FROM transcript_index_value WHERE transcript_path = ?",
  ).run(transcriptPath);
  const insert = db.prepare(
    `INSERT INTO transcript_index_value (
       transcript_path, line_number, ordinal, kind, tool_name, message_role,
       is_summary, value_lower
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const value of values) {
    insert.run(
      transcriptPath,
      value.lineNumber,
      value.ordinal,
      value.kind,
      value.toolName,
      value.messageRole,
      value.isSummary ? 1 : 0,
      value.valueLower,
    );
  }
}

/**
 * The paths whose cached values contain the needle — the sessions a search does
 * not need to read. The predicate is exactly the literal scan's: a case-folded
 * substring, summary values excluded whenever a kind filter is set (B48).
 */
export function matchingIndexedPaths(
  db: DatabaseSync,
  needleLower: string,
  kind: SessionKind | "all",
): readonly string[] {
  const all = kind === "all" ? 1 : 0;
  return asRows(
    db
      .prepare(
        `SELECT DISTINCT transcript_path
           FROM transcript_index_value
          WHERE instr(value_lower, ?) > 0
            AND (? = 1 OR (kind = ? AND is_summary = 0))
          ORDER BY transcript_path ASC`,
      )
      .all(needleLower, all, kind),
  ).map((row) => String(row["transcript_path"]));
}
