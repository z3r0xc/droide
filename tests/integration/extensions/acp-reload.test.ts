/**
 * A `cli_acp` session outlives the process that created it. Clause:
 * `specs/60-extensions-mcp-and-skills.md` B63 (the row's producer hint) with
 * `specs/40-sessions-and-storage.md` B57 (the column and its migration).
 *
 * The store is real: a temporary cache database on disk, reopened between the
 * two servers, so "after a restart" means a second `openSessionStore` rather
 * than a second in-memory fake.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpSessionStore } from "../../../src/acp/server.ts";
import { TranscriptUnavailableError } from "../../../src/session/errors.ts";
import {
  openSessionStore,
  type SessionStore,
} from "../../../src/session/store.ts";
import { isRecord } from "../../../src/transport/schema.ts";
import { AcpHarness, SESSION_ID } from "../../unit/extensions/acp-helpers.ts";
import {
  makeSessionFixture,
  mutableClock,
  type SessionFixture,
} from "../session/helpers.ts";

/**
 * The seam `exec -o acp` builds over a real store: create, remove, list, read
 * and the row's title and hint. It mirrors `runAcpOutput`'s adapter, which is
 * what ships, without the exec-only project-key and transcript plumbing.
 */
function acpStoreOver(store: SessionStore): AcpSessionStore {
  return {
    registerSession(input) {
      const sessionId = input.sessionId ?? "missing-id";
      if (store.getSession(sessionId) !== null) return { sessionId };
      store.registerSession({
        sessionId,
        cwd: input.cwd ?? null,
        projectKey: "",
        firstEventAt: input.firstEventAt ?? 0,
        originHint: input.originHint ?? null,
      });
      return { sessionId };
    },
    deleteSession: (sessionId) => store.deleteSession(sessionId),
    listSessions: (options) => store.listSessions(options),
    readSession(sessionId) {
      try {
        return store.readSession(sessionId);
      } catch (error) {
        if (error instanceof TranscriptUnavailableError) return [];
        throw error;
      }
    },
    readSessionMeta(sessionId) {
      const row = store.getSession(sessionId);
      return row === null
        ? null
        : { title: row.title, originHint: row.originHint };
    },
  };
}

function openStore(fixture: SessionFixture): SessionStore {
  return openSessionStore({
    dbPath: fixture.dbPath,
    sessionsDir: fixture.sessionsDir,
    clock: mutableClock(1000),
  });
}

function listedHint(
  result: Readonly<Record<string, unknown>>,
  sessionId: string,
): unknown {
  const sessions = result["sessions"];
  assert.ok(Array.isArray(sessions), "expected a sessions array");
  const row = sessions.find(
    (candidate) => isRecord(candidate) && candidate["sessionId"] === sessionId,
  );
  assert.ok(isRecord(row), `expected ${sessionId} in the listing`);
  return row["_meta"];
}

test("a cli_acp session is recognised after the process restarts (B63)", async (t) => {
  const fixture = makeSessionFixture("droide-acp-reload-");

  const first = openStore(fixture);
  const creating = new AcpHarness<AcpSessionStore>({
    authenticated: true,
    nextSessionId: () => SESSION_ID,
    store: acpStoreOver(first),
  });
  creating.send({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/work", mcpServers: [] },
  });
  await creating.nextResponse(1);
  await creating.dispose();

  const stored = first.getSession(SESSION_ID);
  assert.ok(stored !== null);
  assert.equal(stored.cwd, "/work");
  assert.equal(stored.originHint, "cli_acp");
  assert.equal(first.listSessions()[0]?.originHint, "cli_acp");
  // A row another producer made carries no hint, so the two are separable.
  first.registerSession({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: "/other",
  });
  first.close();

  // Second process: same file, no in-memory state carried over.
  const second = openStore(fixture);
  t.after(() => second.close());
  assert.equal(second.getSession(SESSION_ID)?.originHint, "cli_acp");

  const resumed = new AcpHarness<AcpSessionStore>({
    authenticated: true,
    store: acpStoreOver(second),
  });
  t.after(() => resumed.dispose());
  resumed.send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/resume",
    params: { sessionId: SESSION_ID, cwd: "/work", mcpServers: [] },
  });
  await resumed.nextResponse(2);
  resumed.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/list",
    params: {},
  });
  const listed = await resumed.nextResponse(3);
  assert.ok("result" in listed);
  const result = listed.result;
  assert.ok(isRecord(result));
  assert.deepEqual(listedHint(result, SESSION_ID), {
    droide: { originHint: "cli_acp" },
  });
  const untagged = "11111111-2222-4333-8444-555555555555";
  assert.equal(listedHint(result, untagged), undefined);
  // Registered last so it runs after the stores above are closed: on Windows a
  // live database handle keeps the temporary folder from being removed.
  t.after(() => fixture.cleanup());
});
