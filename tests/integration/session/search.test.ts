import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import {
  InvalidArgumentError,
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

interface Seeded {
  readonly fixture: SessionFixture;
  readonly store: SessionStore;
  readonly alpha: string;
  readonly titled: string;
  readonly hidden: string;
  readonly child: string;
}

function seed(t: TestContext): Seeded {
  const fixture = makeSessionFixture("droide-search-");
  const store = openStore(fixture);
  const raw = new DatabaseSync(fixture.dbPath);
  t.after(() => {
    raw.close();
    store.close();
    fixture.cleanup();
  });

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
            id: "needle-id-should-not-match",
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
              data: "needle document",
            },
          },
        ],
      },
      timestamp: 1_300,
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [
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
      timestamp: 1_400,
    },
    {
      type: "message",
      message: { role: "assistant", content: "unrelated" },
      timestamp: 1_500,
    },
  ]);

  const titled = store.registerSession({
    sessionId: ids.next(),
    title: "needle",
  }).sessionId;
  appendAll(store, titled, [
    {
      type: "session_start",
      title: "needle",
      cwd: "C:/work/beta",
      timestamp: 400,
    },
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
  raw
    .prepare(
      "UPDATE sessions SET has_user_visible_messages = 0 WHERE session_id = ?",
    )
    .run(hidden);

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

test("search returns newest-first hits with the documented fields", (t) => {
  const { store, alpha, titled, child } = seed(t);

  const result = store.search("needle", { limitHits: 20, contextChars: 5 });
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    [titled, alpha, child],
  );
  assert.deepEqual(result.sessionCount, { count: 3, exact: true });
  assert.equal(result.complete, true);

  const alphaResult = result.sessions.find(
    (session) => session.sessionId === alpha,
  );
  assert.ok(alphaResult);
  assert.equal(alphaResult.title, "Release plan");
  assert.deepEqual(
    alphaResult.hits.map((hit) => hit.docId),
    ["line:5", "line:4", "line:3", "line:3", "line:2"],
  );

  const tool = alphaResult.hits.find((hit) => hit.kind === "tool_use");
  assert.ok(tool);
  assert.equal(tool.toolName, "grep");
  const thinking = alphaResult.hits.find(
    (hit) => hit.kind === "message_text" && hit.messageRole === "assistant",
  );
  assert.ok(thinking);
  assert.match(thinking.snippets[0] ?? "", /needle/);
  const userHit = alphaResult.hits.find(
    (hit) =>
      hit.kind === "message_text" &&
      hit.messageRole === "user" &&
      hit.docId === "line:2",
  );
  assert.ok(userHit);
});

test("hits are capped newest-first and limits clamp the page, not the count", (t) => {
  const { store, alpha } = seed(t);

  const capped = store.search("needle", { limitHits: 2 });
  const hits = capped.sessions.find(
    (session) => session.sessionId === alpha,
  )?.hits;
  assert.deepEqual(
    hits?.map((hit) => hit.docId),
    ["line:5", "line:4"],
  );

  const page = store.search("needle", { limitSessions: 1, limitHits: 2 });
  assert.equal(page.sessions.length, 1);
  assert.deepEqual(page.sessionCount, { count: 3, exact: true });
});

test("ids, base64 sources and signature-like fields are not searchable", (t) => {
  const { store } = seed(t);
  assert.equal(store.search("needle-id-should-not-match").sessions.length, 0);
  assert.equal(store.search("bmVlZGxl").sessions.length, 0);
  assert.equal(store.search("bmVlZ").sessions.length, 0);
});

test("kind filters select only blocks of that kind and exclude the title", (t) => {
  const { store } = seed(t);

  const toolResults = store.search("needle", {
    kind: "tool_result",
    limitHits: 20,
  });
  assert.equal(toolResults.sessions.length, 1);
  assert.deepEqual(
    toolResults.sessions[0]?.hits.map((hit) => hit.kind),
    ["tool_result"],
  );

  const documents = store.search("needle", { kind: "document", limitHits: 20 });
  assert.equal(documents.sessions.length, 1);
  assert.deepEqual(
    documents.sessions[0]?.hits.map((hit) => hit.docId),
    ["line:5"],
  );

  assert.equal(
    store.search("release", { kind: "message_text" }).sessions.length,
    0,
  );
  assert.equal(store.search("release", { kind: "all" }).sessions.length, 1);
});

test("title matches rank first but count as summary hits only when they win the cap", (t) => {
  const { store, titled } = seed(t);
  const result = store.search("needle");
  assert.equal(result.sessions[0]?.sessionId, titled);

  const titledHits = result.sessions[0]?.hits ?? [];
  assert.ok(titledHits.some((hit) => hit.docId === "line:2"));
});

test("scope filters honour children, hidden, project and time windows", (t) => {
  const { store, child, hidden } = seed(t);

  assert.equal(
    store.search("needle", { excludeChildren: true }).sessions.length,
    2,
  );
  assert.equal(store.search("needle").sessions.length, 3);
  assert.equal(
    store.search("needle", { includeHidden: true }).sessions.length,
    4,
  );
  assert.ok(
    store
      .search("needle", { includeHidden: true })
      .sessions.some((session) => session.sessionId === hidden),
  );
  assert.equal(
    store.search("needle", { projectKey: "-C-work-alpha" }).sessions.length,
    0,
  );
  assert.equal(store.search("needle", { since: 900 }).sessions.length, 1);
  assert.equal(store.search("needle", { until: 800 }).sessions.length, 2);
  assert.ok(
    store
      .search("needle", { excludeChildren: false })
      .sessions.some((session) => session.sessionId === child),
  );
});

test("the org rule admits unattributed rows alongside the active org", (t) => {
  const { store } = seed(t);

  assert.equal(
    store.search("needle", { activeOrgId: "org-1" }).sessions.length,
    3,
  );

  const orgSession = store.registerSession({
    sessionId: ids.next(),
    orgId: "org-2",
    title: "Org session",
  }).sessionId;
  appendAll(store, orgSession, [
    {
      type: "message",
      message: { role: "user", content: "needle" },
      timestamp: 800,
    },
  ]);

  assert.equal(
    store.search("needle", { activeOrgId: "org-1" }).sessions.length,
    3,
  );
  assert.equal(
    store.search("needle", { activeOrgId: "org-2" }).sessions.length,
    4,
  );
  assert.equal(store.search("needle").sessions.length, 3);
});

test("snippets are trimmed to the context radius with ellipses", (t) => {
  const { store } = seed(t);
  const hits =
    store.search("needle", { limitHits: 20, contextChars: 0 }).sessions[0]
      ?.hits ?? [];
  assert.ok(hits.some((hit) => hit.snippets[0] === "needle"));
});

test("search validates the query and every limit before scanning", (t) => {
  const { store } = seed(t);

  assert.throws(() => store.search("   "), InvalidArgumentError);
  assert.throws(() => store.search("x".repeat(501)), InvalidArgumentError);
  for (const limitSessions of [0, 1.5, 1001]) {
    assert.throws(
      () => store.search("needle", { limitSessions }),
      InvalidArgumentError,
    );
  }
  for (const limitHits of [0, 1.5, 21]) {
    assert.throws(
      () => store.search("needle", { limitHits }),
      InvalidArgumentError,
    );
  }
  for (const contextChars of [-1, 1.5, 1001]) {
    assert.throws(
      () => store.search("needle", { contextChars }),
      InvalidArgumentError,
    );
  }
  assert.throws(
    () => store.search("needle", { kind: "bogus" as unknown as "all" }),
    InvalidArgumentError,
  );
  assert.throws(
    () => store.search("needle", { since: -1 }),
    InvalidArgumentError,
  );
});

test("a session whose transcript vanished makes the result incomplete", (t) => {
  const { store } = seed(t);
  store.registerSession({ sessionId: ids.next(), title: "No file" });

  const result = store.search("needle");
  assert.equal(result.complete, false);
  assert.equal(result.coverageReason, "transcript-missing");
});
