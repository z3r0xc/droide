import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  DuplicateSessionError,
  InvalidArgumentError,
  InvalidTranscriptRecordError,
  StoreClosedError,
  UnknownSessionError,
  createSessionIdFactory,
  openSessionStore,
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

function openStore(fixture: SessionFixture): SessionStore {
  return openSessionStore({
    dbPath: fixture.dbPath,
    sessionsDir: fixture.sessionsDir,
    clock,
  });
}

function countRows(db: DatabaseSync, table: string, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
    .get(sessionId);
  if (row === null || typeof row !== "object" || !("count" in row)) return -1;
  return typeof row.count === "number" ? row.count : -1;
}

test("appended records read back in file order", (t) => {
  const fixture = makeSessionFixture("droide-store-append-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const session = store.registerSession({
    sessionId: ids.next(),
    cwd: "C:/work/alpha",
    title: "First session",
    firstEventAt: 500,
  });

  const first = store.appendTranscriptRecord(session.sessionId, {
    type: "message",
    message: { role: "user", content: "hello" },
    timestamp: 1_000,
  });
  assert.equal(first.messagesCount, 1);
  assert.equal(first.hasUserVisibleMessages, true);
  assert.equal(first.lastEventAt, 1_000);

  const second = store.appendTranscriptRecord(session.sessionId, {
    type: "message",
    message: { role: "assistant", content: "hi" },
    timestamp: 1_200,
  });
  assert.equal(second.messagesCount, 2);
  assert.equal(second.lastEventAt, 1_200);
  assert.equal(second.hasUserVisibleMessages, true);

  const records = store.readSession(session.sessionId);
  assert.deepEqual(records, [
    {
      type: "message",
      message: { role: "user", content: "hello" },
      timestamp: 1_000,
    },
    {
      type: "message",
      message: { role: "assistant", content: "hi" },
      timestamp: 1_200,
    },
  ]);
  assert.equal(countRows(raw, "session_ingest", session.sessionId), 1);
});

test("a refused append leaves no partial line and no index change", (t) => {
  const fixture = makeSessionFixture("droide-store-refused-");
  const store = openStore(fixture);
  t.after(() => {
    store.close();
    fixture.cleanup();
  });

  const session = store.registerSession({ sessionId: ids.next() });
  assert.throws(
    () =>
      store.appendTranscriptRecord(
        session.sessionId,
        [] as unknown as JsonObject,
      ),
    InvalidTranscriptRecordError,
  );

  const path = `${fixture.sessionsDir}/${session.sessionId}.jsonl`;
  assert.equal(existsSync(path), false);
  assert.equal(store.getSession(session.sessionId)?.messagesCount, 0);

  const grown = store.appendTranscriptRecord(session.sessionId, {
    type: "message",
    message: { role: "user", content: "kept" },
  });
  const sizeBefore = statSync(path).size;
  assert.equal(grown.messagesCount, 1);

  const circular: Record<string, unknown> = { type: "message" };
  circular["self"] = circular;
  assert.throws(
    () =>
      store.appendTranscriptRecord(
        session.sessionId,
        circular as unknown as JsonObject,
      ),
    InvalidTranscriptRecordError,
  );
  assert.equal(statSync(path).size, sizeBefore);
  assert.equal(store.getSession(session.sessionId)?.messagesCount, 1);

  assert.throws(
    () =>
      store.appendTranscriptRecord("8de06b5d-1db6-46e8-b909-d724036aa898", {
        type: "message",
      }),
    UnknownSessionError,
  );
});

test("a duplicate session id is a constraint failure with no partial row", (t) => {
  const fixture = makeSessionFixture("droide-store-duplicate-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const session = store.registerSession({
    sessionId: ids.next(),
    title: "Original",
  });
  assert.throws(
    () =>
      store.registerSession({
        sessionId: session.sessionId,
        title: "Replacement",
      }),
    DuplicateSessionError,
  );

  assert.equal(store.listSessions({ includeArchived: true }).length, 1);
  assert.equal(store.getSession(session.sessionId)?.title, "Original");
  assert.equal(countRows(raw, "session_ingest", session.sessionId), 1);
});

test("listing orders by recency, hides btw and archived rows, and breaks ties by cwd", (t) => {
  const fixture = makeSessionFixture("droide-store-list-");
  const store = openStore(fixture);
  t.after(() => {
    store.close();
    fixture.cleanup();
  });

  function add(
    title: string,
    projectKey: string,
    timestamp: number,
    cwd?: string,
    archivedAt?: string,
  ): string {
    clock.set(timestamp);
    const session = store.registerSession({
      sessionId: ids.next(),
      projectKey,
      cwd: cwd ?? null,
      title,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    });
    store.appendTranscriptRecord(session.sessionId, {
      type: "message",
      message: { role: "user", content: title },
      timestamp,
    });
    return session.sessionId;
  }

  const a = add("A", "", 2_000);
  const b = add("B", "", 1_999);
  add("BTW", "btw", 3_000);
  const archived = add(
    "Archived",
    "",
    4_000,
    undefined,
    "2026-01-01T00:00:00.000Z",
  );

  assert.deepEqual(
    store.listSessions().map((item) => item.title),
    ["A", "B"],
  );
  assert.deepEqual(
    store.listSessions({ includeArchived: true }).map((item) => item.title),
    ["Archived", "A", "B"],
  );

  const older = add("Tie", "", 2_500, "C:/work/other");
  const preferred = add("Tie", "", 2_500, "C:/work/app");
  const ordered = store.listSessions({ cwd: "C:/work/app", limit: 2 });
  assert.deepEqual(
    ordered.map((item) => item.sessionId),
    [preferred, older],
  );
  assert.equal(store.listSessions({ limit: 1, offset: 1 }).length, 1);
  assert.equal(store.listSessions({ offset: 100 }).length, 0);
  assert.equal(store.getSession(a)?.messagesCount, 1);
  assert.equal(store.getSession(b)?.messagesCount, 1);
  assert.equal(
    store.getSession(archived)?.archivedAt,
    "2026-01-01T00:00:00.000Z",
  );
});

test("listing rejects limits outside the documented bounds", (t) => {
  const fixture = makeSessionFixture("droide-store-limits-");
  const store = openStore(fixture);
  t.after(() => {
    store.close();
    fixture.cleanup();
  });

  for (const limit of [-1, 1.5, 1001, Number.NaN]) {
    assert.throws(() => store.listSessions({ limit }), InvalidArgumentError);
  }
  for (const offset of [-1, 1_000_001]) {
    assert.throws(() => store.listSessions({ offset }), InvalidArgumentError);
  }
});

test("tags round-trip and mark settings unread through the trigger", (t) => {
  const fixture = makeSessionFixture("droide-store-tags-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const session = store.registerSession({ sessionId: ids.next() });
  store.tag(session.sessionId, "subagent", 1);
  store.tag(session.sessionId, "exec", { note: "manual" });
  assert.deepEqual(store.getSession(session.sessionId)?.tags, {
    subagent: 1,
    exec: { note: "manual" },
  });
  assert.equal(countRows(raw, "sessions", session.sessionId), 1);

  const ingest = raw
    .prepare(
      "SELECT settings_mtime_ms FROM session_ingest WHERE session_id = ?",
    )
    .get(session.sessionId);
  assert.equal(
    ingest !== null && typeof ingest === "object"
      ? ingest["settings_mtime_ms"]
      : null,
    -1,
  );

  store.untag(session.sessionId, "subagent");
  assert.deepEqual(store.getSession(session.sessionId)?.tags, {
    exec: { note: "manual" },
  });
  assert.throws(() => store.tag(ids.next(), "subagent"), UnknownSessionError);
  assert.throws(() => store.tag(session.sessionId, ""), InvalidArgumentError);
});

test("deleting a session cascades its bookkeeping, spans and term filter", (t) => {
  const fixture = makeSessionFixture("droide-store-cascade-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

  const session = store.registerSession({ sessionId: ids.next() });
  raw
    .prepare(
      "INSERT INTO session_spans (session_id, span_index, line_start, line_end, text) VALUES (?, 1, 1, 2, 'text')",
    )
    .run(session.sessionId);
  raw
    .prepare(
      "INSERT INTO session_term_filters (session_id, filter) VALUES (?, ?)",
    )
    .run(session.sessionId, new Uint8Array([1, 2, 3]));

  assert.equal(store.deleteSession(session.sessionId), true);
  for (const table of [
    "session_ingest",
    "session_spans",
    "session_term_filters",
  ]) {
    assert.equal(countRows(raw, table, session.sessionId), 0);
  }
  assert.equal(store.getSession(session.sessionId), null);
  assert.equal(store.deleteSession(session.sessionId), false);
});

test("the store refuses work after close", (t) => {
  const fixture = makeSessionFixture("droide-store-closed-");
  const store = openStore(fixture);
  t.after(() => fixture.cleanup());

  store.close();
  store.close();
  assert.throws(() => store.listSessions(), StoreClosedError);
  assert.throws(() => store.getSession(ids.next()), StoreClosedError);
  assert.throws(() => store.search("x"), StoreClosedError);
});
