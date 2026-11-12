/**
 * Applying the cache migrations. Contract: `specs/40-sessions-and-storage.md`
 * B6-B11, with one deliberate difference: a ledger entry for a version this
 * build does not know is refused rather than tolerated, because an older binary
 * cannot validate the shape a newer migration produced (this slice's ticket).
 */

import type { DatabaseSync } from "node:sqlite";

import type { SessionClock } from "./ids.ts";
import {
  InvalidMigrationVersionError,
  MigrationChecksumMismatchError,
  MigrationFailedError,
  SchemaTooNewError,
} from "./errors.ts";
import { CACHE_MIGRATIONS, CACHE_SCHEMA_VERSION, type SessionMigration } from "./migrations.ts";

export interface MigrateOptions {
  readonly clock: SessionClock;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

export interface MigrateReport {
  readonly applied: readonly number[];
  readonly headVersion: number;
  /** True when the file already had every known migration (B8: no write). */
  readonly alreadyCurrent: boolean;
}

const DELIBERATE_BUSY_TIMEOUT_MS = 5000;
const RESTING_BUSY_TIMEOUT_MS = 0;

interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

function isSqlRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readInt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.NaN;
}

function readText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export function ensureLedger(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       checksum   TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
}

export function readMigrationLedger(db: DatabaseSync): readonly AppliedMigration[] {
  const rows = db
    .prepare(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
    )
    .all();
  const ledger: AppliedMigration[] = [];
  for (const raw of rows) {
    if (!isSqlRow(raw)) continue;
    const version = readInt(raw, "version");
    if (!Number.isInteger(version) || version < 1) {
      throw new InvalidMigrationVersionError(version, "ledger version is not a positive integer");
    }
    ledger.push({
      version,
      name: readText(raw, "name"),
      checksum: readText(raw, "checksum"),
      appliedAt: readInt(raw, "applied_at"),
    });
  }
  return ledger;
}

function withBusyTimeout<T>(db: DatabaseSync, timeoutMs: number, work: () => T): T {
  db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
  try {
    return work();
  } finally {
    db.exec(`PRAGMA busy_timeout = ${RESTING_BUSY_TIMEOUT_MS}`);
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was open (the failure came from BEGIN or COMMIT itself);
    // the original error is the one worth propagating.
  }
}

function applyOne(
  db: DatabaseSync,
  migration: SessionMigration,
  ledger: Map<number, LedgerRow>,
  clock: SessionClock,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    // A peer may have committed this version while we waited for the writer
    // slot; the ledger is re-read inside the transaction (B9).
    const current = readMigrationLedger(db);
    if (current.some((entry) => entry.version === migration.version)) {
      rollbackQuietly(db);
      return false;
    }

    db.exec(migration.sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(migration.version, migration.name, migration.checksum, clock.now());
    db.exec("COMMIT");
    ledger.set(migration.version, {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      appliedAt: clock.now(),
    });
    return true;
  } catch (error) {
    rollbackQuietly(db);
    throw new MigrationFailedError(migration, error);
  }
}

function checkpointTruncate(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // The WAL is an optimisation; a checkpoint another connection blocks must
    // not turn a committed migration into a failed open.
  }
}

export function migrateSessionIndex(db: DatabaseSync, options: MigrateOptions): MigrateReport {
  ensureLedger(db);
  const ledger = new Map<number, LedgerRow>();
  const known = new Map<number, SessionMigration>(
    CACHE_MIGRATIONS.map((migration) => [migration.version, migration]),
  );

  const found = readMigrationLedger(db);
  const unknown: number[] = [];
  for (const entry of found) {
    if (entry.version > CACHE_SCHEMA_VERSION) {
      unknown.push(entry.version);
      continue;
    }
    const migration = known.get(entry.version);
    if (migration === undefined) {
      unknown.push(entry.version);
      continue;
    }
    if (entry.checksum !== migration.checksum) {
      throw new MigrationChecksumMismatchError(
        entry.version,
        entry.name,
        entry.checksum,
        migration.checksum,
      );
    }
    ledger.set(entry.version, entry);
  }
  if (unknown.length > 0) {
    throw new SchemaTooNewError(CACHE_SCHEMA_VERSION, [...unknown].sort((a, b) => a - b));
  }

  const pending = CACHE_MIGRATIONS.filter((migration) => !ledger.has(migration.version));
  if (pending.length === 0) {
    return { applied: [], headVersion: CACHE_SCHEMA_VERSION, alreadyCurrent: true };
  }

  const applied: number[] = [];
  withBusyTimeout(db, DELIBERATE_BUSY_TIMEOUT_MS, () => {
    for (const migration of pending) {
      if (applyOne(db, migration, ledger, options.clock)) {
        applied.push(migration.version);
      }
    }
  });
  checkpointTruncate(db);

  return { applied, headVersion: CACHE_SCHEMA_VERSION, alreadyCurrent: false };
}