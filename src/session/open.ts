/**
 * Opening the session index file. Contract: `specs/40-sessions-and-storage.md`
 * B1-B2. Path resolution belongs to the config layer: this module only takes a
 * `dbPath`, creates its parent, and settles the connection.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SessionClock } from "./ids.ts";
import { migrateSessionIndex, type MigrateReport } from "./migrate.ts";

export interface OpenSessionIndexOptions {
  readonly dbPath: string;
  readonly clock: SessionClock;
}

export interface OpenedSessionIndex {
  readonly db: DatabaseSync;
  readonly migration: MigrateReport;
}

const NEVER_INDEX_MARKER = ".metadata_never_index";

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

export function openSessionIndexDatabase(
  options: OpenSessionIndexOptions,
): OpenedSessionIndex {
  const directory = dirname(options.dbPath);
  mkdirSync(directory, { recursive: true });
  try {
    // Best effort: a spyware/backup tool that honours it must not learn the
    // index exists, but a refused write must never block the open (B1).
    writeFileSync(join(directory, NEVER_INDEX_MARKER), "");
  } catch {
    // Deliberately ignored.
  }

  const db = new DatabaseSync(options.dbPath);
  try {
    applyPragmas(db);
    const migration = migrateSessionIndex(db, { clock: options.clock });
    return { db, migration };
  } catch (error) {
    db.close();
    throw error;
  }
}
