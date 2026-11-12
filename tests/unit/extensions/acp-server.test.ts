/**
 * ACP server framing, dispatch, turns and shutdown. Clauses:
 * `specs/60` B60-B67. Every turn runner here is scripted: no model, no
 * provider, no process, no socket.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AcpFailureMessage,
  AcpInboundMessage,
  AcpRequestPermissionParams,
  AcpSessionUpdate,
  AcpSuccessMessage,
} from "../../../src/acp/protocol.ts";
import { agentMessageChunk } from "../../../src/acp/protocol.ts";
import type { AcpSessionStore } from "../../../src/acp/server.ts";
import {
  createAcpConfirm,
  type AcpPermissionResponse,
  type AcpTurnRunner,
} from "../../../src/exec/acp-runner.ts";
import type { TurnOutcome, TurnRunner } from "../../../src/exec/turn.ts";
import type { SessionStore } from "../../../src/session/store.ts";
import { isRecord } from "../../../src/transport/schema.ts";
import {
  AcpHarness,
  SESSION_ID,
  cancelledOutcome,
  completed,
  deferred,
  openSession,
  scriptedRunner,
} from "./acp-helpers.ts";

type AssertAssignable<T extends U, U> = T;

// A real session store and a real exec turn runner both satisfy the seams the
// ACP server accepts.
type StoreIsCompatible = AssertAssignable<SessionStore, AcpSessionStore>;
type RunnerIsCompatible = AssertAssignable<TurnRunner, AcpTurnRunner>;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1 },
};

function successOf(frame: AcpInboundMessage): AcpSuccessMessage {
  assert.ok(!("method" in frame), "expected a response, not a call");
  assert.ok("result" in frame, "expected a successful response");
  return frame;
}

function failureOf(frame: AcpInboundMessage): AcpFailureMessage {
  assert.ok(!("method" in frame), "expected a response, not a call");
  assert.ok("error" in frame, "expected a failed response");
  return frame;
}

function resultOf(frame: AcpInboundMessage): Readonly<Record<string, unknown>> {
  const result = successOf(frame).result;
  assert.ok(isRecord(result), "expected an object result");
  return result;
}

function isSessionUpdate(value: unknown): value is AcpSessionUpdate {
  return isRecord(value) && typeof value["sessionUpdate"] === "string";
}

function updateOf(frame: AcpInboundMessage): AcpSessionUpdate {
  assert.ok("method" in frame);
  assert.equal(frame.method, "session/update");
  const params = frame.params;
  assert.ok(isRecord(params), "expected session/update params");
  const update = params["update"];
  assert.ok(isSessionUpdate(update), "expected a session update");
  return update;
}

function updateName(update: AcpSessionUpdate): string {
  return update.sessionUpdate;
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

test("framing: a frame split across chunks is reassembled and answered", async () => {
  const harness = new AcpHarness({});
  const text = JSON.stringify(INITIALIZE);
  harness.sendRaw(text.slice(0, 23));
  harness.sendRaw(`${text.slice(23)}\n`);
  const response = await harness.nextResponse(1);
  const result = resultOf(response);
  assert.deepEqual(result["agentInfo"], {
    name: "droide",
    title: "Factory Droid",
    version: "0.4.0",
  });
  assert.equal(result["protocolVersion"], 1);
  await harness.dispose();

  for (const line of harness.rawLines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed["jsonrpc"], "2.0");
  }
});

test("framing: malformed JSON, a non-object and an unknown method are refused", async () => {
  const harness = new AcpHarness({});
  harness.sendRaw("{\n");
  const parseError = failureOf(
    await harness.next((frame) => !("method" in frame) && frame.id === null),
  );
  assert.equal(parseError.error.code, -32700);

  harness.sendRaw("[]\n");
  const shapeError = failureOf(
    await harness.next((frame) => !("method" in frame) && frame.id === null),
  );
  assert.equal(shapeError.error.code, -32600);

  harness.send({
    jsonrpc: "2.0",
    id: 9,
    method: "session/does_not_exist",
    params: {},
  });
  const unknown = failureOf(await harness.nextResponse(9));
  assert.equal(unknown.error.code, -32601);
  assert.match(
    unknown.error.message,
    /"Method not found": session\/does_not_exist/,
  );

  harness.send({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} });
  const invalid = failureOf(await harness.nextResponse(10));
  assert.equal(invalid.error.code, -32602);
  await harness.dispose();
});

test("framing: an oversized frame is a parse error and the stream continues", async () => {
  const harness = new AcpHarness({ maxFrameBytes: 2048 });
  harness.sendRaw(
    `{"jsonrpc":"2.0","method":"x","params":"${"a".repeat(3000)}"}\n`,
  );
  const error = failureOf(
    await harness.next((frame) => !("method" in frame) && frame.id === null),
  );
  assert.equal(error.error.code, -32700);
  assert.match(error.error.message, /above the 2048-byte limit/);

  harness.send(INITIALIZE);
  const result = resultOf(await harness.nextResponse(1));
  assert.equal(result["protocolVersion"], 1);
  await harness.dispose();
});

test("initialize: the handshake advertises B62's capabilities and auth methods", async () => {
  const harness = new AcpHarness({});
  harness.send(INITIALIZE);
  const capabilities = resultOf(await harness.nextResponse(1))[
    "agentCapabilities"
  ];
  assert.deepEqual(capabilities, {
    loadSession: true,
    sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    auth: { logout: {} },
    _meta: { "terminal-auth": true },
  });
  await harness.dispose();
});

test("session/new: authentication, MCP conversion and a stored session (B63, B64)", async () => {
  const harness = new AcpHarness({ nextSessionId: () => SESSION_ID });
  harness.send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/work", mcpServers: [] },
  });
  assert.equal(failureOf(await harness.nextResponse(2)).error.code, -32000);

  harness.send({
    jsonrpc: "2.0",
    id: 3,
    method: "authenticate",
    params: { methodId: "nope" },
  });
  assert.equal(failureOf(await harness.nextResponse(3)).error.code, -32602);

  harness.send({
    jsonrpc: "2.0",
    id: 4,
    method: "authenticate",
    params: { methodId: "factory-api-key" },
  });
  assert.deepEqual(resultOf(await harness.nextResponse(4)), {});

  harness.send({
    jsonrpc: "2.0",
    id: 5,
    method: "session/new",
    params: {
      cwd: "/work",
      mcpServers: [{ type: "acp", name: "client-mcp", serverId: "m1" }],
    },
  });
  const mcpError = failureOf(await harness.nextResponse(5));
  assert.equal(mcpError.error.code, -32602);
  assert.match(
    mcpError.error.message,
    /MCP servers with the acp transport are not supported/,
  );

  harness.send({
    jsonrpc: "2.0",
    id: 6,
    method: "session/new",
    params: {
      cwd: "/work",
      mcpServers: [{ name: "shell", command: "node", args: [], env: [] }],
    },
  });
  assert.deepEqual(resultOf(await harness.nextResponse(6)), {
    sessionId: SESSION_ID,
  });
  assert.equal(harness.store.rows.get(SESSION_ID)?.cwd, "/work");
  await harness.dispose();
});

test("prompt: one turn streams ordered updates before its response (B65, B68)", async () => {
  const requests: string[] = [];
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (request, sink) => {
      requests.push(request.prompt);
      await sink.assistant({
        id: "m1",
        reasoningContent: "weighing options",
        blocks: [
          { kind: "thinking", text: "make a plan" },
          { kind: "text", text: "the answer" },
          {
            kind: "tool_use",
            toolUseId: "t1",
            name: "Execute",
            input: { command: "ls" },
          },
        ],
      });
      await sink.toolResult({
        toolUseId: "t1",
        messageId: "m1",
        isError: false,
        text: "a.ts",
      });
      return completed();
    }),
  });

  harness.send({
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    },
  });
  const { updates, response } = await collectUntilResponse(harness, 7);

  assert.deepEqual(updates.map(updateName), [
    "agent_thought_chunk",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
  ]);
  assert.deepEqual(updates[0], {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "weighing options" },
    messageId: "m1",
  });
  assert.deepEqual(updates[2], {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "the answer" },
    messageId: "m1",
  });
  assert.equal(
    updates[3]?.sessionUpdate === "tool_call" ? updates[3].status : "",
    "pending",
  );
  assert.equal(
    updates[4]?.sessionUpdate === "tool_call_update" ? updates[4].status : "",
    "completed",
  );
  assert.deepEqual(resultOf(response), { stopReason: "end_turn" });
  assert.deepEqual(requests, ["hello\nworld"]);
  await harness.dispose();
});

test("prompt: an empty prompt becomes Process request and images reach the runner (B65)", async () => {
  let seenPrompt = "";
  let seenImages = 0;
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (request) => {
      seenPrompt = request.prompt;
      seenImages = request.images.length;
      return completed();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 8,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    },
  });
  const { updates, response } = await collectUntilResponse(harness, 8);
  assert.deepEqual(updates, []);
  assert.deepEqual(resultOf(response), { stopReason: "end_turn" });
  assert.equal(seenPrompt, "Process request");
  assert.equal(seenImages, 1);
  await harness.dispose();
});

test("prompt: a recognized moderation failure becomes a refusal (B66)", async () => {
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (): Promise<TurnOutcome> => ({
      kind: "failed",
      message: "provider reported content moderation",
    })),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 9,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
  });
  const { updates, response } = await collectUntilResponse(harness, 9);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.sessionUpdate, "agent_message_chunk");
  assert.match(
    updates[0]?.sessionUpdate === "agent_message_chunk"
      ? String((updates[0].content as { text?: unknown }).text)
      : "",
    /blocked by model provider safety checks/,
  );
  assert.deepEqual(resultOf(response), { stopReason: "refusal" });
  await harness.dispose();
});

test("prompt: any other failure sends Error text and fails with internal error (B66)", async () => {
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async () => ({
      kind: "failed",
      message: "the provider exploded",
    })),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 10,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
  });
  const { updates, response } = await collectUntilResponse(harness, 10);
  assert.equal(updates.length, 1);
  const first = updates[0];
  assert.equal(first?.sessionUpdate, "agent_message_chunk");
  if (first === undefined || first.sessionUpdate !== "agent_message_chunk") {
    throw new assert.AssertionError({ message: "expected agent text" });
  }
  assert.equal(first.content.type, "text");
  assert.equal(
    first.content.type === "text" ? first.content.text : "",
    "Error: the provider exploded",
  );
  const failure = failureOf(response);
  assert.equal(failure.error.code, -32603);
  assert.equal(failure.error.message, "the provider exploded");
  await harness.dispose();
});

test("permissions: session/request_permission round-trips the selected option (B69)", async () => {
  const answers: AcpPermissionResponse[] = [];
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (request, sink) => {
      answers.push(
        await sink.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: "t1", title: "Execute" },
          options: [
            { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
            { optionId: "cancel", name: "Reject", kind: "reject_once" },
          ],
        }),
      );
      return completed();
    }),
  });

  harness.send({
    jsonrpc: "2.0",
    id: 11,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "run it" }] },
  });
  const request = await harness.next(
    (frame) =>
      "method" in frame && frame.method === "session/request_permission",
  );
  assert.ok("id" in request);
  assert.deepEqual("params" in request ? request.params : undefined, {
    sessionId,
    toolCall: { toolCallId: "t1", title: "Execute" },
    options: [
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
      { optionId: "cancel", name: "Reject", kind: "reject_once" },
    ],
  });
  harness.send({
    jsonrpc: "2.0",
    id: request.id,
    result: { outcome: { outcome: "selected", optionId: "proceed_once" } },
  });
  const response = await harness.nextResponse(11);
  assert.deepEqual(resultOf(response), { stopReason: "end_turn" });
  assert.deepEqual(answers, [
    { outcome: "selected", optionId: "proceed_once" },
  ]);
  await harness.dispose();
});

test("permissions: a malformed answer is treated as cancelled (B69)", async () => {
  const answers: AcpPermissionResponse[] = [];
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (request, sink) => {
      answers.push(
        await sink.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: "t1", title: "Execute" },
          options: [
            { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
          ],
        }),
      );
      return completed();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 12,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "run it" }] },
  });
  const request = await harness.next(
    (frame) =>
      "method" in frame && frame.method === "session/request_permission",
  );
  assert.ok("id" in request);
  harness.send({ jsonrpc: "2.0", id: request.id, result: { nope: true } });
  const response = await harness.nextResponse(12);
  assert.deepEqual(resultOf(response), { stopReason: "end_turn" });
  assert.deepEqual(answers, [{ outcome: "cancelled" }]);
  await harness.dispose();
});

test("cancel: session/cancel overtakes a running prompt and returns cancelled (B67)", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (_request, sink) => {
      await sink.update(agentMessageChunk("working"));
      started.resolve();
      await new Promise<void>((resolve) => {
        if (sink.signal.aborted) {
          aborted.resolve();
          resolve();
          return;
        }
        sink.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      return cancelledOutcome();
    }),
  });

  harness.send({
    jsonrpc: "2.0",
    id: 13,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "long task" }] },
  });
  const first = await harness.next(
    (frame) =>
      "method" in frame &&
      updateOf(frame).sessionUpdate === "agent_message_chunk",
  );
  assert.equal(updateOf(first).sessionUpdate, "agent_message_chunk");
  await started.promise;
  harness.send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
  const response = await harness.nextResponse(13);
  assert.deepEqual(resultOf(response), { stopReason: "cancelled" });
  await aborted.promise;
  await harness.dispose();
});

test("cancel: a permission request resolves cancelled when the turn is aborted (B67)", async () => {
  const answers: AcpPermissionResponse[] = [];
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (request, sink) => {
      answers.push(
        await sink.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: "t1", title: "Execute" },
          options: [
            { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
          ],
        }),
      );
      return sink.signal.aborted ? cancelledOutcome() : completed();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 14,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "run" }] },
  });
  await harness.next(
    (frame) =>
      "method" in frame && frame.method === "session/request_permission",
  );
  harness.send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
  const response = await harness.nextResponse(14);
  assert.deepEqual(resultOf(response), { stopReason: "cancelled" });
  assert.deepEqual(answers, [{ outcome: "cancelled" }]);
  await harness.dispose();
});

test("prompt: a second prompt while one runs is an invalid request (B65)", async () => {
  const started = deferred<void>();
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (_request, sink) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        sink.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return cancelledOutcome();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 15,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "one" }] },
  });
  await started.promise;
  harness.send({
    jsonrpc: "2.0",
    id: 16,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "two" }] },
  });
  const busy = failureOf(await harness.nextResponse(16));
  assert.equal(busy.error.code, -32600);
  assert.match(
    busy.error.message,
    /A prompt is already running for this session/,
  );
  harness.send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
  assert.deepEqual(resultOf(await harness.nextResponse(15)), {
    stopReason: "cancelled",
  });
  await harness.dispose();
});

test("refusals: unknown sessions, bad params and unimplemented methods", async () => {
  const harness = new AcpHarness({ authenticated: true });
  harness.send({
    jsonrpc: "2.0",
    id: 17,
    method: "session/prompt",
    params: { sessionId: SESSION_ID, prompt: [{ type: "text", text: "x" }] },
  });
  const unknownSession = failureOf(await harness.nextResponse(17));
  assert.equal(unknownSession.error.code, -32602);
  assert.match(unknownSession.error.message, /Unknown session identifier/);

  harness.send({
    jsonrpc: "2.0",
    id: 18,
    method: "session/close",
    params: { sessionId: SESSION_ID },
  });
  assert.equal(failureOf(await harness.nextResponse(18)).error.code, -32602);

  harness.send({
    jsonrpc: "2.0",
    id: 19,
    method: "session/load",
    params: { sessionId: SESSION_ID, cwd: "/work", mcpServers: [] },
  });
  assert.equal(failureOf(await harness.nextResponse(19)).error.code, -32601);

  harness.send({
    jsonrpc: "2.0",
    id: 20,
    method: "session/prompt",
    params: { sessionId: SESSION_ID, prompt: "not an array" },
  });
  assert.equal(failureOf(await harness.nextResponse(20)).error.code, -32602);
  await harness.dispose();
});

test("close: session/close aborts the turn and removes the session (B71)", async () => {
  const started = deferred<void>();
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (_request, sink) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        sink.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return cancelledOutcome();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 21,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "run" }] },
  });
  await started.promise;
  harness.send({
    jsonrpc: "2.0",
    id: 22,
    method: "session/close",
    params: { sessionId },
  });
  assert.deepEqual(resultOf(await harness.nextResponse(22)), {});
  assert.deepEqual(resultOf(await harness.nextResponse(21)), {
    stopReason: "cancelled",
  });
  assert.equal(harness.store.rows.get(sessionId)?.deleted, true);
  await harness.dispose();
});

test("shutdown: EOF during a turn aborts it, answers it and flushes every frame", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (_request, sink) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        sink.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      return cancelledOutcome();
    }),
  });

  harness.send({
    jsonrpc: "2.0",
    id: 23,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "run" }] },
  });
  await started.promise;
  await harness.dispose();
  await aborted.promise;

  const response = await harness.nextResponse(23);
  assert.deepEqual(resultOf(response), { stopReason: "cancelled" });
  assert.equal(harness.rawLines.length > 0, true);
});

test("plan: a TodoWrite call becomes a plan update instead of a tool card (B68)", async () => {
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (_request, sink) => {
      await sink.assistant({
        id: "m1",
        blocks: [
          {
            kind: "tool_use",
            toolUseId: "t9",
            name: "TodoWrite",
            input: {
              todos:
                "1. [pending] read the spec\n2. [completed] write the tests",
            },
          },
        ],
      });
      return completed();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 30,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "plan it" }] },
  });
  const { updates, response } = await collectUntilResponse(harness, 30);
  assert.equal(updates.length, 1);
  const plan = updates[0];
  assert.equal(plan?.sessionUpdate, "plan");
  assert.deepEqual(plan?.sessionUpdate === "plan" ? plan.entries : undefined, [
    { content: "read the spec", priority: "medium", status: "pending" },
    { content: "write the tests", priority: "medium", status: "completed" },
  ]);
  assert.deepEqual(resultOf(response), { stopReason: "end_turn" });
  await harness.dispose();
});

test("cancel: $/cancel_request aborts the prompt with that request id (B67)", async () => {
  const started = deferred<void>();
  const { harness, sessionId } = await openSession({
    runner: scriptedRunner(async (_request, sink) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        sink.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return cancelledOutcome();
    }),
  });
  harness.send({
    jsonrpc: "2.0",
    id: 31,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "run" }] },
  });
  await started.promise;
  harness.send({
    jsonrpc: "2.0",
    method: "$/cancel_request",
    params: { requestId: 31 },
  });
  assert.deepEqual(resultOf(await harness.nextResponse(31)), {
    stopReason: "cancelled",
  });
  await harness.dispose();
});

test("logout: removes authentication and later session/new is refused (B61)", async () => {
  const harness = new AcpHarness({ authenticated: true });
  harness.send({ jsonrpc: "2.0", id: 32, method: "logout", params: {} });
  assert.deepEqual(resultOf(await harness.nextResponse(32)), {});
  harness.send({
    jsonrpc: "2.0",
    id: 33,
    method: "session/new",
    params: { cwd: "/work", mcpServers: [] },
  });
  assert.equal(failureOf(await harness.nextResponse(33)).error.code, -32000);
  await harness.dispose();
});

test("permissions: createAcpConfirm maps a selected allow kind to approval (B69)", async () => {
  let asked: AcpRequestPermissionParams | undefined;
  const approve = createAcpConfirm({
    sessionId: "s",
    ask: async (params) => {
      asked = params;
      return { outcome: "selected", optionId: "proceed_always" };
    },
  });
  assert.equal(
    await approve({
      toolId: "Execute",
      llmId: "Execute",
      toolClass: "execute",
    }),
    true,
  );
  assert.deepEqual(asked?.toolCall, {
    toolCallId: "permission-Execute",
    title: "Execute",
  });
  assert.deepEqual(
    asked?.options.map((option) => [option.optionId, option.kind]),
    [
      ["proceed_once", "allow_once"],
      ["proceed_always", "allow_always"],
      ["cancel", "reject_once"],
    ],
  );

  const deny = createAcpConfirm({
    sessionId: "s",
    ask: async () => ({ outcome: "cancelled" }),
  });
  assert.equal(await deny({ toolId: "Execute", toolClass: "execute" }), false);
});
