import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  runSearchCommand,
  type SearchDeps,
} from "../../../src/cli/search-command.ts";
import {
  openSessionStore,
  type SessionStore,
} from "../../../src/session/store.ts";

interface Captured {
  deps: SearchDeps;
  out(): string;
  err(): string;
  code(): number;
}

const SESSION_ID = "3f2b8c1e-9a4d-4f6b-8c2e-1a2b3c4d5e6f";

function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capture(openStore: () => Promise<SessionStore>): Captured {
  let out = "";
  let err = "";
  let code = 0;
  return {
    deps: {
      openStore,
      write: (text) => (out += text),
      writeError: (text) => (err += text),
      setExitCode: (value) => {
        code = value;
      },
    },
    out: () => out,
    err: () => err,
    code: () => code,
  };
}

async function withStore(
  run: (store: SessionStore, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "droide-search-"));
  const store = openSessionStore({
    dbPath: join(dir, "index.db"),
    sessionsDir: join(dir, "sessions"),
    clock: { now: () => 1_700_000_000_000 },
  });
  try {
    store.registerSession({ sessionId: SESSION_ID, title: "Session one" });
    store.appendTranscriptRecord(SESSION_ID, {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "the needle is here" }],
      },
      timestamp: 1_700_000_000_000,
    });
    store.appendTranscriptRecord(SESSION_ID, {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "haystack" }],
      },
      timestamp: 1_700_000_001_000,
    });
    await run(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a matching session is found and rendered as JSON", async () => {
  await withStore(async (store) => {
    const captured = capture(async () => store);

    await runSearchCommand("needle", { json: true }, captured.deps);

    const parsed: unknown = JSON.parse(captured.out());
    assert.equal(typeof parsed, "object");
    const payload = parsed as {
      sessions: Array<{
        sessionId: string;
        hits: Array<{ snippets: string[] }>;
      }>;
    };
    assert.equal(payload.sessions[0]?.sessionId, SESSION_ID);
    assert.equal(payload.sessions[0]?.hits.length, 1);
    assert.match(
      payload.sessions[0]?.hits[0]?.snippets.join(" ") ?? "",
      /needle/,
    );
    assert.equal(captured.code(), 0);
  });
});

test("text output names the session and the match count", async () => {
  await withStore(async (store) => {
    const captured = capture(async () => store);

    await runSearchCommand("needle", {}, captured.deps);

    assert.match(captured.out(), /1 session matched "needle"/);
    assert.match(
      captured.out(),
      new RegExp(`^${SESSION_ID} Session one · 1$`, "m"),
    );
    assert.match(captured.out(), /needle/);
  });
});

test("a kind filter excludes other kinds", async () => {
  await withStore(async (store) => {
    const captured = capture(async () => store);

    await runSearchCommand(
      "needle",
      { kind: "tool_use", json: true },
      captured.deps,
    );

    const parsed: unknown = JSON.parse(captured.out());
    const payload = parsed as { sessions: unknown[] };
    assert.equal(payload.sessions.length, 0);
    assert.equal(captured.code(), 0);
  });
});

test("an unknown kind is refused before the store is opened", async () => {
  let opened = 0;
  const captured = capture(async () => {
    opened += 1;
    throw new Error("should not open");
  });

  await runSearchCommand("x", { kind: "nope" }, captured.deps);

  assert.equal(opened, 0);
  assert.match(captured.err(), /Invalid --kind value: nope/);
  assert.equal(captured.code(), 1);
});

test("out-of-range limits are refused with the documented bounds", async () => {
  const captured = capture(async () => {
    throw new Error("should not open");
  });

  await runSearchCommand("x", { limitSessions: "0" }, captured.deps);
  assert.match(
    captured.err(),
    /limitSessions must be an integer between 1 and 1000/,
  );
  assert.equal(captured.code(), 1);

  const second = capture(async () => {
    throw new Error("should not open");
  });
  await runSearchCommand("x", { limitHits: "21" }, second.deps);
  assert.match(second.err(), /limitHits must be an integer between 1 and 20/);
});

test("a store failure is reported and exits 1", async () => {
  const captured = capture(async () => {
    throw new Error("disk gone");
  });

  await runSearchCommand("x", {}, captured.deps);

  assert.match(captured.err(), /search failed: disk gone/);
  assert.equal(captured.code(), 1);
});

test("an aborted query exits 130", async () => {
  const captured = capture(async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });

  await runSearchCommand("x", {}, captured.deps);

  assert.equal(captured.code(), 130);
  assert.equal(captured.err(), "");
});

test("--reindex brings the transcript index up to date before the query", async () => {
  await withStore(async (store, dir) => {
    const captured = capture(async () => store);

    await runSearchCommand("needle", { reindex: true }, captured.deps);

    const db = new DatabaseSync(join(dir, "index.db"));
    try {
      const counted = db
        .prepare("SELECT COUNT(*) AS n FROM transcript_index")
        .get();
      assert.equal(isRow(counted) ? Number(counted["n"]) : 0, 1);
      const values = db
        .prepare("SELECT COUNT(*) AS n FROM transcript_index_value")
        .get();
      assert.equal(isRow(values) ? Number(values["n"]) > 0 : false, true);
    } finally {
      db.close();
    }
    assert.match(captured.out(), /1 session matched "needle"/);
    assert.equal(captured.code(), 0);
  });
});
