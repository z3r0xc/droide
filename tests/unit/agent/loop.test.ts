import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { createExecToolRunner } from "../../../src/exec/runner.ts";
import { runTurn } from "../../../src/agent/loop.ts";
import { toolCallId, type Message } from "../../../src/agent/messages.ts";
import type {
  PermissionDecision,
  PermissionRequest,
  Provider,
  ProviderDelta,
  ToolResult,
  TurnDependencies,
  TurnEvent,
} from "../../../src/agent/ports.ts";
import { PNG_SIGNATURE, readTool } from "../../../src/tools/fs/read.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { makeToolFixture } from "../tools/helpers.ts";

const AT = 1_700_000_000_000;

function user(text: string, extra: Partial<Message> = {}): Message {
  return {
    id: `u_${text}`,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

interface Harness {
  readonly deps: TurnDependencies;
  readonly events: TurnEvent[];
  readonly executed: Array<{ name: string; input: unknown }>;
  readonly sleeps: number[];
  calls: number;
}

function harness(
  script: (
    call: number,
    messages: readonly Message[],
  ) => ProviderDelta[] | Error,
  options: {
    decision?: PermissionDecision;
    confirmed?: boolean;
    toolResult?: ToolResult;
    maxAttempts?: number;
  } = {},
): Harness {
  const events: TurnEvent[] = [];
  const executed: Array<{ name: string; input: unknown }> = [];
  const sleeps: number[] = [];
  let calls = 0;
  let ids = 0;

  const provider: Provider = {
    async *stream(messages) {
      const delta = script(calls, messages);
      calls += 1;
      if (delta instanceof Error) throw delta;
      for (const item of delta) yield item;
    },
  };

  const deps: TurnDependencies = {
    provider,
    tools: {
      async execute(name, input) {
        executed.push({ name, input });
        return options.toolResult ?? { content: `${name} ok` };
      },
    },
    permissions: {
      decide(_request: PermissionRequest): PermissionDecision {
        return options.decision ?? "allow";
      },
      async confirm(): Promise<boolean> {
        return options.confirmed ?? false;
      },
    },
    clock: {
      now: () => AT,
      async sleep(ms: number): Promise<void> {
        sleeps.push(ms);
      },
    },
    retry: {
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: 100,
      factor: 2,
      maxDelayMs: 1_000,
      shouldRetry: (error) =>
        error instanceof Error && error.name === "TransientError",
    },
    emit: (event) => events.push(event),
    nextMessageId: (role) => `${role}_${++ids}`,
  };

  return {
    deps,
    events,
    executed,
    sleeps,
    get calls() {
      return calls;
    },
    set calls(value: number) {
      calls = value;
    },
  };
}

function transient(): Error {
  const error = new Error("temporary");
  error.name = "TransientError";
  return error;
}

test("a text-only response completes in one turn and streams its text", async () => {
  const test_harness = harness(() => [
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "done" },
  ]);

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("hi")],
    maxTurns: 4,
  });

  assert.equal(outcome.reason, "completed");
  assert.equal(outcome.messages.length, 2);
  const assistant = outcome.messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.deepEqual(assistant?.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(
    test_harness.events.map((event) => event.type),
    [
      "turn_start",
      "text_delta",
      "text_delta",
      "assistant_message",
      "turn_complete",
    ],
  );
});

test("a tool call settles once and is fed back as one tool message", async () => {
  const test_harness = harness((call) =>
    call === 0
      ? [
          { type: "tool_use_start", name: "read_file", slot: 0 },
          { type: "tool_use_input", slot: 0, json: '{"path":"a.txt"}' },
          { type: "done" },
        ]
      : [{ type: "text", text: "done" }, { type: "done" }],
  );

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("read a.txt")],
    maxTurns: 4,
  });

  assert.equal(outcome.reason, "completed");
  assert.deepEqual(test_harness.executed, [
    { name: "read_file", input: { path: "a.txt" } },
  ]);

  const assistant = outcome.messages[1];
  const callBlock = assistant?.content[0];
  assert.equal(callBlock?.type, "tool_use");
  assert.equal(
    callBlock?.type === "tool_use" ? callBlock.id : null,
    toolCallId(assistant?.id ?? "", 0),
  );

  const toolMessage = outcome.messages[2];
  assert.equal(toolMessage?.role, "tool");
  const result = toolMessage?.content[0];
  assert.equal(result?.type, "tool_result");
  assert.equal(
    result?.type === "tool_result" ? result.content : null,
    "read_file ok",
  );
});

test("a denied tool call becomes an error result and the turn continues", async () => {
  const test_harness = harness(
    (call) =>
      call === 0
        ? [{ type: "tool_use_start", name: "shell", slot: 0 }, { type: "done" }]
        : [{ type: "done" }],
    { decision: "deny" },
  );

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("run it")],
    maxTurns: 4,
  });

  assert.equal(test_harness.executed.length, 0);
  const result = outcome.messages[2]?.content[0];
  assert.equal(result?.type === "tool_result" ? result.isError : null, true);
  assert.match(
    result?.type === "tool_result" ? String(result.content) : "",
    /denied/,
  );
});

test("an unconfirmed ask cancels only that call", async () => {
  const test_harness = harness(
    (call) =>
      call === 0
        ? [
            { type: "tool_use_start", name: "write_file", slot: 0 },
            { type: "done" },
          ]
        : [{ type: "done" }],
    { decision: "ask", confirmed: false },
  );

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("write")],
    maxTurns: 4,
  });

  const result = outcome.messages[2]?.content[0];
  assert.equal(
    result?.type === "tool_result" ? result.content : null,
    "Error: Tool execution cancelled by user",
  );
  assert.equal(test_harness.executed.length, 0);
});

test("invalid tool JSON never reaches the tool", async () => {
  const test_harness = harness((call) =>
    call === 0
      ? [
          { type: "tool_use_start", name: "edit", slot: 0 },
          { type: "tool_use_input", slot: 0, json: '{"path":' },
          { type: "done" },
        ]
      : [{ type: "done" }],
  );

  await runTurn(test_harness.deps, { messages: [user("edit")], maxTurns: 4 });

  assert.equal(test_harness.executed.length, 0);
  const result = test_harness.events.find(
    (event) => event.type === "tool_result",
  );
  assert.equal(result?.type === "tool_result" ? result.isError : null, true);
});

test("a transient provider error is retried with backoff before succeeding", async () => {
  const test_harness = harness((call) =>
    call === 0 ? transient() : [{ type: "text", text: "ok" }, { type: "done" }],
  );

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("hi")],
    maxTurns: 2,
  });

  assert.equal(outcome.reason, "completed");
  assert.equal(test_harness.calls, 2);
  assert.deepEqual(test_harness.sleeps, [100]);
  assert.equal(
    test_harness.events.some((event) => event.type === "retry"),
    true,
  );
});

test("a non-retryable error ends the turn with reason error", async () => {
  const test_harness = harness(() => new Error("boom"));

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("hi")],
    maxTurns: 2,
  });

  assert.equal(outcome.reason, "error");
  assert.equal(outcome.error, "boom");
  assert.deepEqual(test_harness.sleeps, []);
});

test("an aborted signal ends the turn as cancelled", async () => {
  const controller = new AbortController();
  const test_harness = harness(() => {
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
  });

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("hi")],
    maxTurns: 2,
    signal: controller.signal,
  });

  assert.equal(outcome.reason, "cancelled");
  assert.equal(outcome.messages.length, 1);
});

test("user_only history is never sent to the provider", async () => {
  let seen: readonly Message[] = [];
  const test_harness = harness((_call, messages) => {
    seen = messages;
    return [{ type: "done" }];
  });

  await runTurn(test_harness.deps, {
    messages: [user("visible"), user("secret", { visibility: "user_only" })],
    maxTurns: 1,
  });

  assert.deepEqual(
    seen.map((message) => message.id),
    ["u_visible"],
  );
});

test("the loop stops at maxTurns when the model keeps calling tools", async () => {
  const test_harness = harness(() => [
    { type: "tool_use_start", name: "noop", slot: 0 },
    { type: "done" },
  ]);

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("loop")],
    maxTurns: 3,
  });

  assert.equal(outcome.reason, "max_turns");
  assert.equal(test_harness.executed.length, 3);
});

test("tool ordering follows the model's slot order, not completion order", async () => {
  const test_harness = harness((call) =>
    call === 0
      ? [
          { type: "tool_use_start", name: "second", slot: 1 },
          { type: "tool_use_start", name: "first", slot: 0 },
          { type: "done" },
        ]
      : [{ type: "done" }],
  );

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("two")],
    maxTurns: 2,
  });

  assert.deepEqual(
    test_harness.executed.map((entry) => entry.name),
    ["first", "second"],
  );
  const toolMessage = outcome.messages[2];
  assert.equal(toolMessage?.content.length, 2);
});

test("a tool result with media becomes a content array carrying the image", async () => {
  const image = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      mediaType: "image/png" as const,
      data: "AAAA",
    },
  };
  const test_harness = harness(
    (call) =>
      call === 0
        ? [
            { type: "tool_use_start", name: "Read", slot: 0 },
            { type: "tool_use_input", slot: 0, json: '{"file_path":"a.png"}' },
            { type: "done" },
          ]
        : [{ type: "text", text: "seen" }, { type: "done" }],
    {
      toolResult: {
        content: "Read of a.png: image/png, 3 bytes",
        media: [image],
      },
    },
  );

  const outcome = await runTurn(test_harness.deps, {
    messages: [user("read the png")],
    maxTurns: 4,
  });

  const result = outcome.messages[2]?.content[0];
  assert.equal(result?.type, "tool_result");
  assert.deepEqual(
    result?.type === "tool_result" ? result.content : undefined,
    [{ type: "text", text: "Read of a.png: image/png, 3 bytes" }, image],
  );
});

test("a real PNG read reaches the tool message as an image block", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("pixel.png");
    writeFileSync(file, Buffer.concat([PNG_SIGNATURE, Buffer.from("pixel")]));
    const registry = new ToolRegistry();
    registry.register(readTool);
    const tools = createExecToolRunner({
      registry,
      root: fixture.root,
      environment: fixture.environment,
      permission: {
        autonomy: "off",
        interactionMode: "auto",
        interactive: false,
      },
    });
    const test_harness = harness((call) =>
      call === 0
        ? [
            { type: "tool_use_start", name: "Read", slot: 0 },
            {
              type: "tool_use_input",
              slot: 0,
              json: JSON.stringify({ file_path: file }),
            },
            { type: "done" },
          ]
        : [{ type: "text", text: "seen" }, { type: "done" }],
    );

    const outcome = await runTurn(
      { ...test_harness.deps, tools },
      { messages: [user("read the png")], maxTurns: 4 },
    );

    const result = outcome.messages[2]?.content[0];
    assert.equal(result?.type, "tool_result");
    if (result?.type !== "tool_result") return;
    assert.equal(Array.isArray(result.content), true);
    if (!Array.isArray(result.content)) return;
    assert.deepEqual(result.content[0], {
      type: "text",
      text: `Read of ${file}: image/png, 13 bytes`,
    });
    assert.deepEqual(result.content[1], {
      type: "image",
      source: {
        type: "base64",
        mediaType: "image/png",
        data: Buffer.concat([PNG_SIGNATURE, Buffer.from("pixel")]).toString(
          "base64",
        ),
      },
    });
  } finally {
    fixture.cleanup();
  }
});
