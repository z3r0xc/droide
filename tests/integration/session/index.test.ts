import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CACHE_SCHEMA_VERSION,
  IndexShapeError,
  createSessionIdFactory,
  openSessionIndexDatabase,
  openSessionStore,
  upsertIndexedTranscript,
  type JsonObject,
  type SessionStore,
} from "../../../src/session/index.ts";
import {
  makeSessionFixture,
  mutableClock,
  type SessionFixture,
} from "./helpers.ts";

const clock = mutableClock(1000);
const ids = createSessionIdFactory({ now: () => 1_000 });

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
}

function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pragma(db: DatabaseSync, name: string): Record<string, unknown> {
  const rows = asRows(db.prepare(`PRAGMA ${name}`).all());
  const first = rows[0];
  return first ?? {};
}

function openStore(
  fixture: { readonly dbPath: string; readonly sessionsDir: string },
  searchIndex = true,
): SessionStore {
  return openSessionStore({
    dbPath: fixture.dbPath,
    sessionsDir: fixture.sessionsDir,
    clock,
    searchIndex,
  });
}

function appendAll(
  store: SessionStore,
  sessionId: string,
  records: readonly JsonObject[],
): void {
  for (const record of records) {
    const timestamp = record["timestamp"];
    if (typeof timestamp === "number") clock.set(timestamp);
    store.appendTranscriptRecord(sessionId, record);
  }
}

test("opening creates the cache layout and settles the connection", (t) => {
  const fixture = makeSessionFixture("droide-index-open-");
  const opened = openSessionIndexDatabase({
    dbPath: fixture.dbPath,
    clock: mutableClock(1000),
  });
  t.after(() => {
    opened.db.close();
    fixture.cleanup();
  });

  assert.equal(opened.quarantine, null);
  assert.equal(opened.migration.headVersion, CACHE_SCHEMA_VERSION);
  assert.equal(
    existsSync(
      join(fixture.dir, "cache", "session-index", ".metadata_never_index"),
    ),
    true,
  );

  assert.equal(pragma(opened.db, "journal_mode")["journal_mode"], "wal");
  assert.equal(Number(pragma(opened.db, "auto_vacuum")["auto_vacuum"]), 2);
  assert.equal(
    Number(pragma(opened.db, "wal_autocheckpoint")["wal_autocheckpoint"]),
    0,
  );
  assert.equal(
    Number(pragma(opened.db, "journal_size_limit")["journal_size_limit"]),
    524288,
  );
  assert.equal(Number(pragma(opened.db, "synchronous")["synchronous"]), 1);
  assert.equal(Number(pragma(opened.db, "busy_timeout")["timeout"]), 0);
  assert.equal(Number(pragma(opened.db, "foreign_keys")["foreign_keys"]), 1);
});

test("a database missing a column the migrations produce is refused", (t) => {
  const fixture = makeSessionFixture("droide-index-shape-column-");
  const opened = openSessionIndexDatabase({
    dbPath: fixture.dbPath,
    clock: mutableClock(1000),
  });
  opened.db.close();

  const raw = new DatabaseSync(fixture.dbPath);
  raw.exec("ALTER TABLE sessions DROP COLUMN host_id");
  raw.close();
  t.after(() => fixture.cleanup());

  assert.throws(
    () =>
      openSessionIndexDatabase({
        dbPath: fixture.dbPath,
        clock: mutableClock(1000),
      }),
    (error: unknown) => {
      assert.ok(error instanceof IndexShapeError);
      assert.equal(error.code, "index-shape");
      assert.equal(error.state, "missing-column");
      assert.equal(error.key, "sessions.host_id");
      return true;
    },
  );
});

test("an extra trigger is a foreign object, not a tolerated table", (t) => {
  const fixture = makeSessionFixture("droide-index-shape-trigger-");
  const opened = openSessionIndexDatabase({
    dbPath: fixture.dbPath,
    clock: mutableClock(1000),
  });
  opened.db.exec(
    "CREATE TRIGGER extra_writer AFTER INSERT ON sessions BEGIN SELECT 1; END",
  );
  opened.db.close();
  t.after(() => fixture.cleanup());

  assert.throws(
    () =>
      openSessionIndexDatabase({
        dbPath: fixture.dbPath,
        clock: mutableClock(1000),
      }),
    (error: unknown) => {
      assert.ok(error instanceof IndexShapeError);
      assert.equal(error.state, "foreign-object");
      assert.equal(error.key, "extra_writer");
      return true;
    },
  );
});

test("a corrupt file is quarantined beside the database and the open retries", (t) => {
  const fixture = makeSessionFixture("droide-index-quarantine-");
  mkdirSync(dirname(fixture.dbPath), { recursive: true });
  const original = Buffer.alloc(4096, 7);
  writeFileSync(fixture.dbPath, original);
  writeFileSync(`${fixture.dbPath}-wal`, "stale write-ahead log");

  // Two older quarantine folders that already hold this database: the move
  // keeps the two newest, so the oldest must disappear (B14).
  const root = join(dirname(fixture.dbPath), "quarantine");
  for (const name of [
    "2000-01-01T00-00-00-000Z_1",
    "2000-01-02T00-00-00-000Z_1",
  ]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "index.db"), "old");
  }

  const opened = openSessionIndexDatabase({
    dbPath: fixture.dbPath,
    clock: mutableClock(1000),
  });
  t.after(() => {
    opened.db.close();
    fixture.cleanup();
  });

  const quarantine = opened.quarantine;
  assert.ok(quarantine !== null);
  assert.match(quarantine.reason, /not a database/i);
  // SQLite drops a sidecar it cannot use while opening, so only the main file
  // is guaranteed to be there to move; what was moved is what the report lists.
  assert.deepEqual(readdirSync(quarantine.directory), ["index.db"]);
  assert.deepEqual(quarantine.files, [join(quarantine.directory, "index.db")]);
  assert.equal(
    readFileSync(join(quarantine.directory, "index.db")).length,
    original.length,
  );

  const holders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(holders.length, 2);
  assert.equal(holders.includes("2000-01-01T00-00-00-000Z_1"), false);

  // The retried file is a working index at head.
  const ledger = opened.db
    .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
    .get();
  assert.equal(Number(ledger?.["n"]), CACHE_SCHEMA_VERSION);
});

test("the index row upsert is idempotent and the triggers keep it honest", (t) => {
  const fixture = makeSessionFixture("droide-index-triggers-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const sessionId = store.registerSession({
    sessionId: ids.next(),
    title: "Indexed",
    mission: "mission-1",
  }).sessionId;
  appendAll(store, sessionId, [
    {
      type: "session_start",
      title: "Indexed",
      cwd: "C:/work",
      timestamp: 900,
    },
    {
      type: "message",
      message: { role: "user", content: "needle in the file" },
      timestamp: 1_000,
    },
  ]);

  assert.deepEqual(store.reindex(), {
    scanned: 1,
    inserted: 1,
    updated: 0,
    deleted: 0,
    skipped: 0,
  });

  const transcriptPath = `${sessionId}.jsonl`;
  const valueCount = (): number => {
    const counted = raw
      .prepare(
        "SELECT COUNT(*) AS n FROM transcript_index_value WHERE transcript_path = ?",
      )
      .get(transcriptPath);
    return isRow(counted) ? Number(counted["n"]) : 0;
  };
  const selected = raw
    .prepare(
      "SELECT transcript_mtime_ms, transcript_size, mission, json(tags) AS tags_json FROM transcript_index WHERE transcript_path = ?",
    )
    .get(transcriptPath);
  const row = isRow(selected) ? selected : undefined;
  assert.ok(row !== undefined);
  assert.equal(row["mission"], "mission-1");
  assert.deepEqual(JSON.parse(String(row["tags_json"])), {});
  const cached = valueCount();
  assert.ok(cached > 0);

  // The same fingerprint is a no-op: one row, the cached values untouched.
  upsertIndexedTranscript(
    raw,
    {
      transcriptPath,
      sessionId,
      projectKey: "",
      transcriptMtimeMs: Number(row["transcript_mtime_ms"]),
      transcriptSize: Number(row["transcript_size"]),
    },
    4_000,
  );
  const afterUpsert = raw
    .prepare(
      "SELECT COUNT(*) AS n FROM transcript_index WHERE transcript_path = ?",
    )
    .get(transcriptPath);
  assert.equal(isRow(afterUpsert) ? Number(afterUpsert["n"]) : 0, 1);
  assert.equal(valueCount(), cached);

  // A settings-derived column on the session row reaches the projection row
  // through the trigger (B19/B22).
  raw
    .prepare("UPDATE sessions SET mission = 'mission-2' WHERE session_id = ?")
    .run(sessionId);
  const synced = raw
    .prepare("SELECT mission FROM transcript_index WHERE transcript_path = ?")
    .get(transcriptPath);
  assert.equal(isRow(synced) ? synced["mission"] : undefined, "mission-2");

  // A changed fingerprint invalidates the cached values before the new ones
  // land, so a stale projection can never answer a search.
  upsertIndexedTranscript(
    raw,
    {
      transcriptPath,
      sessionId,
      projectKey: "",
      transcriptMtimeMs: Number(row["transcript_mtime_ms"]),
      transcriptSize: Number(row["transcript_size"]) + 1,
    },
    5_000,
  );
  assert.equal(valueCount(), 0);
});

test("a second refresh plans only skips and writes nothing", (t) => {
  const fixture = makeSessionFixture("droide-index-idempotent-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const root = store.registerSession({
    sessionId: ids.next(),
    title: "Root",
  }).sessionId;
  appendAll(store, root, [
    { type: "message", message: { role: "user", content: "root needle" } },
  ]);
  const fork = store.registerSession({
    sessionId: ids.next(),
    title: "Fork",
    projectKey: "btw",
  }).sessionId;
  appendAll(store, fork, [
    { type: "message", message: { role: "user", content: "fork needle" } },
  ]);

  const dump = (): readonly string[] => [
    ...asRows(
      raw
        .prepare(
          "SELECT transcript_path, session_id, project_key, transcript_mtime_ms, transcript_size, indexed_at FROM transcript_index ORDER BY transcript_path",
        )
        .all(),
    ).map((row) => JSON.stringify(row)),
    ...asRows(
      raw
        .prepare(
          "SELECT transcript_path, line_number, ordinal, kind, is_summary, value_lower FROM transcript_index_value ORDER BY transcript_path, line_number, ordinal",
        )
        .all(),
    ).map((row) => JSON.stringify(row)),
  ];

  assert.deepEqual(store.reindex(), {
    scanned: 2,
    inserted: 2,
    updated: 0,
    deleted: 0,
    skipped: 0,
  });
  const first = dump();
  assert.equal(first.length > 2, true);

  assert.deepEqual(store.reindex(), {
    scanned: 2,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 2,
  });
  assert.deepEqual(dump(), first);

  // The file the plan saw is gone: the row and its values go with it (B30).
  rmSync(join(fixture.sessionsDir, "btw", `${fork}.jsonl`));
  assert.deepEqual(store.reindex(), {
    scanned: 1,
    inserted: 0,
    updated: 0,
    deleted: 1,
    skipped: 1,
  });
  const remaining = asRows(
    raw.prepare("SELECT transcript_path FROM transcript_index").all(),
  );
  assert.deepEqual(
    remaining.map((row) => row["transcript_path"]),
    [`${root}.jsonl`],
  );
});

interface ParitySeed {
  readonly fixture: SessionFixture;
  readonly store: SessionStore;
  readonly alpha: string;
  readonly titled: string;
  readonly hidden: string;
  readonly child: string;
}

function seedParity(): ParitySeed {
  const fixture = makeSessionFixture("droide-index-parity-");
  const store = openStore(fixture);

  const alpha = store.registerSession({
    sessionId: ids.next(),
    title: "Release plan",
    cwd: "C:/work/alpha",
  }).sessionId;
  appendAll(store, alpha, [
    {
      type: "session_start",
      title: "Release plan",
      cwd: "C:/work/alpha",
      timestamp: 900,
    },
    {
      type: "message",
      message: { role: "user", content: "needle in the haystack" },
      timestamp: 1_000,
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a needle in thought" },
          {
            type: "tool_use",
            id: "needle-id",
            name: "grep",
            input: { pattern: "needle", path: "src" },
          },
        ],
      },
      timestamp: 1_100,
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "found needle" }],
          },
        ],
      },
      timestamp: 1_200,
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: "needle doc",
            },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "bmVlZGxl",
            },
          },
        ],
      },
      timestamp: 1_300,
    },
  ]);

  const titled = store.registerSession({
    sessionId: ids.next(),
    title: "needle",
  }).sessionId;
  appendAll(store, titled, [
    { type: "session_start", title: "needle", timestamp: 400 },
    {
      type: "message",
      message: { role: "user", content: "needle" },
      timestamp: 500,
    },
  ]);

  const hidden = store.registerSession({
    sessionId: ids.next(),
    title: "Hidden",
  }).sessionId;
  appendAll(store, hidden, [
    {
      type: "message",
      message: { role: "user", content: "needle" },
      timestamp: 600,
    },
  ]);
  const raw = new DatabaseSync(fixture.dbPath);
  raw
    .prepare(
      "UPDATE sessions SET has_user_visible_messages = 0 WHERE session_id = ?",
    )
    .run(hidden);
  raw.close();

  const child = store.registerSession({
    sessionId: ids.next(),
    title: "Child",
    callingSessionId: alpha,
  }).sessionId;
  appendAll(store, child, [
    {
      type: "message",
      message: { role: "user", content: "needle" },
      timestamp: 700,
    },
  ]);

  return { fixture, store, alpha, titled, hidden, child };
}

test("the indexed and literal search paths answer identically", (t) => {
  const { fixture, store, alpha, titled, child } = seedParity();
  t.after(() => {
    store.close();
    fixture.cleanup();
  });

  // Before any refresh the index has no rows: the fallback must be the literal
  // scan, so the answer cannot depend on whether a pass has run yet.
  const beforeIndex = store.search("needle", {
    limitHits: 20,
    contextChars: 5,
  });
  assert.equal(beforeIndex.complete, true);

  assert.deepEqual(store.reindex(), {
    scanned: 4,
    inserted: 4,
    updated: 0,
    deleted: 0,
    skipped: 0,
  });

  const cases = [
    { query: "needle", options: { limitHits: 20, contextChars: 5 } },
    { query: "needle", options: {} },
    { query: "needle", options: { kind: "tool_result" as const } },
    { query: "needle", options: { kind: "tool_use" as const, limitHits: 20 } },
    { query: "needle", options: { kind: "document" as const } },
    { query: "needle", options: { excludeChildren: true } },
    { query: "needle", options: { includeHidden: true, limitHits: 20 } },
    { query: "needle", options: { includeArchived: true } },
    { query: "needle", options: { since: 900 } },
    { query: "needle", options: { until: 800 } },
    { query: "needle", options: { activeOrgId: "org-1" } },
    { query: "release", options: {} },
    { query: "bmVlZGxl", options: {} },
    { query: "needle-id", options: {} },
    { query: "missing", options: {} },
  ] as const;

  for (const testCase of cases) {
    const literal = store.search(testCase.query, {
      ...testCase.options,
      useIndex: false,
    });
    const indexed = store.search(testCase.query, testCase.options);
    assert.deepEqual(
      indexed,
      literal,
      `query ${testCase.query} diverged for ${JSON.stringify(testCase.options)}`,
    );
  }

  assert.deepEqual(
    store.search("needle", { limitHits: 20 }).sessions.map((s) => s.sessionId),
    [titled, alpha, child],
  );
});

test("the index is only trusted for a transcript whose fingerprint still matches", (t) => {
  const { fixture, store } = seedParity();
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });
  store.reindex();

  const indexed = store.search("needle", { limitHits: 20 });
  const literal = store.search("needle", { limitHits: 20, useIndex: false });
  assert.deepEqual(indexed, literal);

  // Mutating the projection directly proves the search consults it: the row
  // still matches its file, so the session is skipped without being read.
  raw.exec(
    "DELETE FROM transcript_index_value WHERE instr(value_lower, 'needle') > 0",
  );
  const mutated = store.search("needle", { limitHits: 20 });
  assert.equal(mutated.sessions.length, 0);
  assert.equal(
    store.search("needle", { limitHits: 20, useIndex: false }).sessions.length,
    3,
  );
});

test("a transcript changed after the refresh is scanned, not trusted", (t) => {
  const { fixture, store } = seedParity();
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });
  store.reindex();

  const row = asRows(
    raw
      .prepare(
        "SELECT transcript_path, transcript_size FROM transcript_index ORDER BY transcript_path LIMIT 1",
      )
      .all(),
  )[0];
  assert.ok(row !== undefined);
  const transcriptPath = String(row["transcript_path"]);
  const absolute = join(fixture.sessionsDir, transcriptPath);
  writeFileSync(
    absolute,
    `${readFileSync(absolute, "utf8")}${JSON.stringify({
      type: "message",
      message: { role: "user", content: "late needle" },
    })}\n`,
  );
  assert.notEqual(statSync(absolute).size, Number(row["transcript_size"]));

  const indexed = store.search("late", { limitHits: 20 });
  const literal = store.search("late", { limitHits: 20, useIndex: false });
  assert.deepEqual(indexed, literal);
  assert.equal(indexed.sessions.length, 1);
});

test("the store-level flag keeps the prefilter out of the answer", (t) => {
  const fixture = makeSessionFixture("droide-index-flag-");
  const store = openStore(fixture, false);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const sessionId = store.registerSession({
    sessionId: ids.next(),
    title: "Flagged",
  }).sessionId;
  appendAll(store, sessionId, [
    {
      type: "message",
      message: { role: "user", content: "needle" },
      timestamp: 1_000,
    },
  ]);
  store.reindex();

  // The index is populated but the flag is off: an empty projection must not
  // change the answer, so the literal scan runs.
  raw.exec("DELETE FROM transcript_index_value");
  const result = store.search("needle");
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.sessionId, sessionId);
});
