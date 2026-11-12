import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CACHE_SCHEMA_VERSION,
  MigrationChecksumMismatchError,
  SchemaTooNewError,
  migrateSessionIndex,
  openSessionIndexDatabase,
} from "../../../src/session/index.ts";
import { makeSessionFixture, mutableClock } from "./helpers.ts";

const TABLES = ["meta", "sessions", "session_ingest", "session_spans", "session_term_filters"];
const INDEXES = [
  "session_spans_embedded_text_idx",
  "session_spans_unembedded_idx",
  "sessions_caller",
  "sessions_mission",
  "sessions_parent",
  "sessions_recency",
  "sessions_subagent",
];
const TRIGGERS = [
  "session_spans_vector_deleted",
  "session_spans_vector_inserted",
  "session_spans_vector_updated",
  "sessions_daemon_fields_stale",
  "sessions_settings_rewritten",
];

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
}

function columnSnapshot(db: DatabaseSync, table: string): string[] {
  return asRows(db.prepare(`PRAGMA table_info(${table})`).all()).map(
    (row) =>
      `c${String(row["cid"])}=${String(row["name"])}|${String(row["type"])}|${String(
        row["notnull"],
      )}|${row["dflt_value"] === null ? "-" : String(row["dflt_value"])}|${String(row["pk"])}`,
  );
}

test("migrating an empty database produces the head schema snapshot", (t) => {
  const fixture = makeSessionFixture("droide-migrate-snapshot-");
  const { db } = openSessionIndexDatabase({ dbPath: fixture.dbPath, clock: mutableClock(1000) });
  t.after(() => {
    db.close();
    fixture.cleanup();
  });

  const objects = asRows(
    db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all(),
  ).map((row) => `${String(row["type"])}:${String(row["name"])}`);

  assert.deepEqual(objects, [
    ...INDEXES.map((name) => `index:${name}`),
    ...["meta", "schema_migrations", "session_ingest", "session_spans", "session_term_filters", "sessions"].map(
      (name) => `table:${name}`,
    ),
    ...TRIGGERS.map((name) => `trigger:${name}`),
  ]);

  assert.deepEqual(
    TABLES.map((table) => `${table}:${columnSnapshot(db, table).length}`),
    [
      "meta:2",
      "sessions:20",
      "session_ingest:12",
      "session_spans:12",
      "session_term_filters:2",
    ],
  );

  const sessions = columnSnapshot(db, "sessions");
  assert.equal(sessions[0], "c0=session_id|TEXT|0|-|1");
  assert.equal(sessions[10], "c10=tags|BLOB|1|jsonb('{}')|0");
  assert.equal(sessions[19], "c19=settings_write_seq|INTEGER|0|-|0");

  const ingest = columnSnapshot(db, "session_ingest");
  assert.deepEqual(ingest.slice(9), [
    "c9=span_tail_offset|INTEGER|1|0|0",
    "c10=span_tail_line|INTEGER|1|0|0",
    "c11=span_tail_index|INTEGER|1|0|0",
  ]);

  const spans = columnSnapshot(db, "session_spans");
  assert.equal(spans.length, 12);
  assert.equal(spans[0], "c0=session_id|TEXT|1|-|1");
  assert.equal(spans[1], "c1=span_index|INTEGER|1|-|2");

  const meta = asRows(db.prepare("SELECT key, value FROM meta").all());
  assert.equal(meta.length, 1);
  assert.equal(meta[0]?.["key"], "vector_epoch");
  assert.equal(meta[0]?.["value"], "0");

  const ledger = asRows(
    db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
  ).map((row) => `${String(row["version"])}:${String(row["name"])}`);
  assert.deepEqual(ledger, [
    "1:baseline",
    "2:transcript-summary-fingerprint",
    "3:tags-role-key",
    "4:daemon-session-fields",
    "5:schema-version",
    "6:spans-and-search",
    "7:term-prefixes",
    "8:whole-transcript-records",
    "9:vector-bookkeeping",
  ]);

  const journal = asRows(db.prepare("PRAGMA journal_mode").all())[0];
  assert.equal(journal?.["journal_mode"], "wal");
  const foreignKeys = asRows(db.prepare("PRAGMA foreign_keys").all())[0];
  assert.equal(foreignKeys?.["foreign_keys"], 1);
  assert.equal(existsSync(join(fixture.dir, "cache", "session-index", ".metadata_never_index")), true);
});

test("migrating again is a no-op that does not touch the ledger", (t) => {
  const fixture = makeSessionFixture("droide-migrate-idempotent-");

  const first = openSessionIndexDatabase({ dbPath: fixture.dbPath, clock: mutableClock(1000) });
  const appliedAt = asRows(
    first.db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all(),
  );
  first.db.close();

  const second = openSessionIndexDatabase({ dbPath: fixture.dbPath, clock: mutableClock(2000) });
  t.after(() => {
    second.db.close();
    fixture.cleanup();
  });

  assert.deepEqual(second.migration, {
    applied: [],
    headVersion: CACHE_SCHEMA_VERSION,
    alreadyCurrent: true,
  });
  assert.deepEqual(
    asRows(second.db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all()),
    appliedAt,
  );
});

test("a ledger version this build does not know is refused", (t) => {
  const fixture = makeSessionFixture("droide-migrate-newer-");
  t.after(() => fixture.cleanup());

  const opened = openSessionIndexDatabase({ dbPath: fixture.dbPath, clock: mutableClock(1000) });
  opened.db
    .prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    )
    .run(CACHE_SCHEMA_VERSION + 1, "future", "abcdef0123456789", 1234);
  opened.db.close();

  assert.throws(
    () => openSessionIndexDatabase({ dbPath: fixture.dbPath, clock: mutableClock(1000) }),
    (error: unknown) => {
      assert.ok(error instanceof SchemaTooNewError);
      assert.equal(error.code, "schema-too-new");
      assert.deepEqual(error.foundVersions, [CACHE_SCHEMA_VERSION + 1]);
      return true;
    },
  );
});

test("a released migration whose checksum changed fails the open", (t) => {
  const fixture = makeSessionFixture("droide-migrate-checksum-");

  const opened = openSessionIndexDatabase({ dbPath: fixture.dbPath, clock: mutableClock(1000) });
  opened.db.prepare("UPDATE schema_migrations SET checksum = 'deadbeefdeadbeef' WHERE version = 1").run();
  opened.db.close();

  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    fixture.cleanup();
  });
  assert.throws(
    () => migrateSessionIndex(raw, { clock: mutableClock(1000) }),
    (error: unknown) => {
      assert.ok(error instanceof MigrationChecksumMismatchError);
      assert.equal(error.version, 1);
      assert.equal(error.migrationName, "baseline");
      return true;
    },
  );
});