/**
 * The `session/update` kinds B68 names that this slice produces outside a
 * turn's content stream: `session_info_update`, `available_commands_update`
 * and `usage_update`, plus the no-op rule each of them shares — an update with
 * no change behind it is not sent. Every runner here is scripted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AcpInboundMessage,
  AcpSessionUpdate,
} from "../../../src/acp/protocol.ts";
import type { ExecUsage } from "../../../src/exec/records.ts";
import { ZERO_USAGE } from "../../../src/exec/records.ts";
import type { TurnOutcome } from "../../../src/exec/turn.ts";
import { isRecord } from "../../../src/transport/schema.ts";
import {
  AcpHarness,
  FakeSessionStore,
  SESSION_ID,
  cancelledOutcome,
  openSession,
  scriptedRunner,
} from "./acp-helpers.ts";

function isSessionUpdate(value: unknown): value is AcpSessionUpdate {
  return isRecord(value) && typeof value["sessionUpdate"] === "string";
}

function updateOf(frame: AcpInboundMessage): AcpSessionUpdate {
  assert.ok("method" in frame, "expected a notification");
  assert.equal(frame.method, "session/update");
  const params = frame.params;
  assert.ok(isRecord(params), "expected session/update params");
  const update = params["update"];
  assert.ok(isSessionUpdate(update), "expected a session update");
  return update;
}

async function collectUntilResponse(
  harness: AcpHarness,
  id: number,
): Promise<{
  readonly updates: AcpSessionUpdate[];
  readonly response: AcpInboundMessage;
}> {
  const updates: AcpSessionUpdate[] = [];
  for (;;) {
    const frame = await harness.next(
      (candidate) => "method" in candidate || candidate.id === id,
    );
    if ("method" in frame) {
      updates.push(updateOf(frame));
      continue;
    }
    return { updates, response: frame };
  }
}

function updatesNamed(
  updates: readonly AcpSessionUpdate[],
  name: AcpSessionUpdate["sessionUpdate"],
): AcpSessionUpdate[] {
  return updates.filter((update) => update.sessionUpdate === name);
}

const USAGE: ExecUsage = Object.freeze({
  ...ZERO_USAGE,
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 30,
});

function completedWith(usage: ExecUsage): TurnOutcome {
  return { kind: "completed", finalText: "done", numTurns: 1, usage };
}

function prompt(id: number, sessionId: string): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "continue" }],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* session_info_update                                                        */
/* -------------------------------------------------------------------------- */

test("updates: a title change is one session_info_update and nothing else (B68)", async () => {
  const { harness, sessionId } = await openSession({ clock: () => 5_000 });
  // A session created now has no title, so its creation reports none.
  harness.send(prompt(20, sessionId));
  const first = await collectUntilResponse(harness, 20);
  assert.deepEqual(updatesNamed(first.updates, "session_info_update"), []);

  harness.store.setTitle(sessionId, "Fix the flaky test");
  harness.send(prompt(21, sessionId));
  const second = await collectUntilResponse(harness, 21);
  assert.deepEqual(updatesNamed(second.updates, "session_info_update"), [
    {
      sessionUpdate: "session_info_update",
      title: "Fix the flaky test",
      updatedAt: new Date(5_000).toISOString(),
    },
  ]);

  // The same title on the next turn is not a change, so it is not re-sent.
  harness.send(prompt(22, sessionId));
  const third = await collectUntilResponse(harness, 22);
  assert.deepEqual(updatesNamed(third.updates, "session_info_update"), []);
  await harness.dispose();
});

test("updates: session/load reports a stored title once (B68, B71)", async () => {
  const store = new FakeSessionStore();
  store.registerSession({ sessionId: SESSION_ID, cwd: "/work" });
  store.setTitle(SESSION_ID, "Stored title");

  const harness = new AcpHarness({ store, authenticated: true });
  harness.send({
    jsonrpc: "2.0",
    id: 30,
    method: "session/load",
    params: { sessionId: SESSION_ID, cwd: "/work", mcpServers: [] },
  });
  await harness.nextResponse(30);
  const update = updateOf(await harness.next((frame) => "method" in frame));
  assert.deepEqual(update, {
    sessionUpdate: "session_info_update",
    title: "Stored title",
    updatedAt: new Date(0).toISOString(),
  });
  await harness.dispose();
});

/* -------------------------------------------------------------------------- */
/* available_commands_update                                                  */
/* -------------------------------------------------------------------------- */

test("updates: commands arrive after session/new and only when the set changes (B68)", async () => {
  let commands = [
    { name: "review", description: "Review a diff" },
    { name: "commit", description: "Write a commit" },
  ];
  const harness = new AcpHarness({
    authenticated: true,
    nextSessionId: () => SESSION_ID,
    commands: () => commands,
  });
  harness.send({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/work", mcpServers: [] },
  });
  await harness.nextResponse(1);
  const first = updateOf(await harness.next((frame) => "method" in frame));
  assert.deepEqual(first, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "commit", description: "Write a commit" },
      { name: "review", description: "Review a diff" },
    ],
  });

  // An unchanged set at the next prompt is not a change.
  harness.send(prompt(2, SESSION_ID));
  const unchanged = await collectUntilResponse(harness, 2);
  assert.deepEqual(
    updatesNamed(unchanged.updates, "available_commands_update"),
    [],
  );

  commands = [{ name: "review", description: "Review a diff" }];
  harness.send(prompt(3, SESSION_ID));
  const changed = await collectUntilResponse(harness, 3);
  assert.deepEqual(updatesNamed(changed.updates, "available_commands_update"), [
    {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review a diff" }],
    },
  ]);
  await harness.dispose();
});

test("updates: no command supplier means no command update (B68)", async () => {
  const { harness, sessionId } = await openSession({});
  harness.send(prompt(4, sessionId));
  const { updates } = await collectUntilResponse(harness, 4);
  assert.deepEqual(updatesNamed(updates, "available_commands_update"), []);
  await harness.dispose();
});

/* -------------------------------------------------------------------------- */
/* current_mode_update / config_option_update                                 */
/* -------------------------------------------------------------------------- */

test("updates: a config option that does not change emits nothing (B68, B70)", async () => {
  const { harness, sessionId } = await openSession({ model: "m0" });
  harness.send({
    jsonrpc: "2.0",
    id: 40,
    method: "session/set_config_option",
    params: { sessionId, configId: "model", value: "m0" },
  });
  const response = await harness.nextResponse(40);
  assert.ok("result" in response);
  assert.deepEqual(harness.frames, []);

  harness.send({
    jsonrpc: "2.0",
    id: 41,
    method: "session/set_model",
    params: { sessionId, modelId: "m0" },
  });
  await harness.nextResponse(41);
  assert.deepEqual(harness.frames, []);
  await harness.dispose();
});

test("updates: set_model sends config_option_update without a mode update (B68, B70)", async () => {
  const { harness, sessionId } = await openSession({ model: "m0" });
  harness.send({
    jsonrpc: "2.0",
    id: 42,
    method: "session/set_model",
    params: { sessionId, modelId: "m1" },
  });
  const { updates } = await collectUntilResponse(harness, 42);
  assert.deepEqual(
    updates.map((update) => update.sessionUpdate),
    ["config_option_update"],
  );
  const update = updates[0];
  assert.ok(update?.sessionUpdate === "config_option_update");
  assert.deepEqual(
    update.configOptions.map((option) => [option.id, option.currentValue]),
    [
      ["model", "m1"],
      ["reasoning_effort", "medium"],
      ["autonomy_level", "normal"],
    ],
  );
  await harness.dispose();
});

test("updates: a mode that does not change emits neither setting update (B68, B70)", async () => {
  const { harness, sessionId } = await openSession({});
  harness.send({
    jsonrpc: "2.0",
    id: 43,
    method: "session/set_config_option",
    params: { sessionId, configId: "autonomy_level", value: "normal" },
  });
  await harness.nextResponse(43);
  assert.deepEqual(harness.frames, []);
  await harness.dispose();
});

/* -------------------------------------------------------------------------- */
/* usage_update                                                               */
/* -------------------------------------------------------------------------- */

test("updates: usage_update reports a completed turn's tokens against the limit (B68)", async () => {
  const { harness, sessionId } = await openSession({
    contextLimitFor: (model) => (model === "" ? 200_000 : null),
    runner: scriptedRunner(async () => completedWith(USAGE)),
  });
  harness.send(prompt(50, sessionId));
  const first = await collectUntilResponse(harness, 50);
  assert.deepEqual(updatesNamed(first.updates, "usage_update"), [
    { sessionUpdate: "usage_update", used: 150, size: 200_000 },
  ]);

  // The same numbers are not a change, so the next identical turn is silent.
  harness.send(prompt(51, sessionId));
  const second = await collectUntilResponse(harness, 51);
  assert.deepEqual(updatesNamed(second.updates, "usage_update"), []);
  await harness.dispose();
});

test("updates: no usage_update without a known limit or a completed turn (B68)", async () => {
  const unknownLimit = await openSession({
    runner: scriptedRunner(async () => completedWith(USAGE)),
  });
  unknownLimit.harness.send(prompt(52, unknownLimit.sessionId));
  const first = await collectUntilResponse(unknownLimit.harness, 52);
  assert.deepEqual(updatesNamed(first.updates, "usage_update"), []);
  await unknownLimit.harness.dispose();

  const cancelled = await openSession({
    contextLimitFor: () => 200_000,
    runner: scriptedRunner(async () => cancelledOutcome()),
  });
  cancelled.harness.send(prompt(53, cancelled.sessionId));
  const second = await collectUntilResponse(cancelled.harness, 53);
  assert.deepEqual(updatesNamed(second.updates, "usage_update"), []);
  await cancelled.harness.dispose();
});

/* -------------------------------------------------------------------------- */
/* The row's producer hint                                                    */
/* -------------------------------------------------------------------------- */

test("session/new records cli_acp and session/list reports it (B63, B71)", async () => {
  const { harness, sessionId } = await openSession({});
  assert.equal(harness.store.rows.get(sessionId)?.originHint, "cli_acp");
  harness.send({
    jsonrpc: "2.0",
    id: 60,
    method: "session/list",
    params: {},
  });
  const frame = await harness.nextResponse(60);
  assert.ok("result" in frame);
  const result = frame.result;
  assert.ok(isRecord(result));
  const sessions = result["sessions"];
  assert.ok(Array.isArray(sessions));
  const row = sessions.find(
    (candidate) => isRecord(candidate) && candidate["sessionId"] === sessionId,
  );
  assert.ok(isRecord(row));
  assert.deepEqual(row["_meta"], { droide: { originHint: "cli_acp" } });
  await harness.dispose();
});

test("session/resume keeps the hint a closed session left behind (B63, B71)", async () => {
  const store = new FakeSessionStore();
  store.registerSession({
    sessionId: SESSION_ID,
    cwd: "/work",
    originHint: "cli_acp",
  });

  const harness = new AcpHarness({ store, authenticated: true });
  harness.send({
    jsonrpc: "2.0",
    id: 61,
    method: "session/resume",
    params: { sessionId: SESSION_ID, cwd: "/work", mcpServers: [] },
  });
  await harness.nextResponse(61);
  harness.send({
    jsonrpc: "2.0",
    id: 62,
    method: "session/list",
    params: {},
  });
  const frame = await harness.nextResponse(62);
  assert.ok("result" in frame);
  const result = frame.result;
  assert.ok(isRecord(result));
  const sessions = result["sessions"];
  assert.ok(Array.isArray(sessions));
  const row = sessions.find(
    (candidate) => isRecord(candidate) && candidate["sessionId"] === SESSION_ID,
  );
  assert.ok(isRecord(row));
  assert.deepEqual(row["_meta"], { droide: { originHint: "cli_acp" } });
  await harness.dispose();
});
