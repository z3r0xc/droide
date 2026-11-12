import assert from "node:assert/strict";
import { test } from "node:test";

import type { LoopClock, Provider } from "../../../src/agent/ports.ts";
import type { Environment } from "../../../src/config/paths.ts";
import {
  createExecToolRunner,
  createExecTurnRunner,
  type ExecToolRunner,
  selectExecTools,
} from "../../../src/exec/runner.ts";
import type { TurnEventSink } from "../../../src/exec/turn.ts";
import type { ToolContext } from "../../../src/tools/context.ts";
import { decide } from "../../../src/tools/permissions.ts";
import { ToolRegistry, defineTool } from "../../../src/tools/registry.ts";
import { MODEL_RESULT_BUDGET_BYTES } from "../../../src/tools/result.ts";

const ENVIRONMENT: Environment = {
  env: {},
  home: "/home",
  platform: "linux",
  cwd: "/work",
};
const SIGNAL = new AbortController().signal;

interface ReadInput {
  readonly file_path: string;
}
interface CreateInput {
  readonly file_path: string;
  readonly content: string;
}
interface ExecuteInput {
  readonly command: string;
  readonly riskLevel?: string;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool<ReadInput, ToolContext>({
      id: "read-test",
      llmId: "Read",
      displayName: "Read",
      description: "Read a file.",
      inputSchema: {
        kind: "object",
        properties: {
          file_path: { kind: "string", description: "Path to read." },
        },
      },
      sideEffects: ["filesystem-read"],
      run: (input) => `contents:${input.file_path}`,
    }),
  );
  registry.register(
    defineTool<CreateInput, ToolContext>({
      id: "create-test",
      llmId: "Create",
      displayName: "Create",
      description: "Create a file.",
      inputSchema: {
        kind: "object",
        properties: {
          file_path: { kind: "string", description: "Path to write." },
          content: { kind: "string", description: "File content." },
        },
      },
      sideEffects: ["filesystem-write"],
      run: (input) => ({ written: input.file_path }),
    }),
  );
  registry.register(
    defineTool<ExecuteInput, ToolContext>({
      id: "execute-test",
      llmId: "Execute",
      displayName: "Execute",
      description: "Run a command.",
      inputSchema: {
        kind: "object",
        properties: {
          command: { kind: "string", description: "Command line." },
          riskLevel: {
            kind: "enum",
            values: ["low", "medium", "high"],
            optional: true,
            description: "Impact.",
          },
        },
      },
      sideEffects: ["process"],
      run: (input) => `ran:${input.command}`,
    }),
  );
  return registry;
}

function makeRunner(
  overrides: Partial<Parameters<typeof createExecToolRunner>[0]> = {},
) {
  return createExecToolRunner({
    registry: makeRegistry(),
    root: "/work",
    environment: ENVIRONMENT,
    permission: {
      autonomy: "low",
      interactionMode: "auto",
      interactive: false,
    },
    ...overrides,
  });
}

test("the default tool set is read-only; --auto widens it to everything", () => {
  const registry = makeRegistry();
  assert.deepEqual(selectExecTools(registry), ["Read"]);
  assert.deepEqual(selectExecTools(registry, { autonomy: "low" }), [
    "Read",
    "Create",
    "Execute",
  ]);
  assert.deepEqual(selectExecTools(registry, { skipPermissionsUnsafe: true }), [
    "Read",
    "Create",
    "Execute",
  ]);
});

test("an allowed read dispatches through the registry and renders its value", async () => {
  const runner = makeRunner();
  const result = await runner.execute(
    "Read",
    { file_path: "fixture.txt" },
    { signal: SIGNAL },
  );

  assert.equal(result.isError, false);
  assert.equal(result.content, "contents:fixture.txt");
  assert.equal(runner.denials.length, 0);
});

test("a non-interactive file edit is auto-denied without ending the turn", async () => {
  const runner = makeRunner({
    permission: {
      autonomy: "low",
      interactionMode: "interactive",
      interactive: false,
    },
  });
  const result = await runner.execute(
    "Create",
    { file_path: "x.txt", content: "hello" },
    { signal: SIGNAL },
  );

  assert.equal(result.isError, true);
  assert.match(
    result.content ?? "",
    /^Error: Exec ended early: insufficient permission to proceed\./,
  );
  assert.equal(runner.denials.length, 1);
  assert.equal(runner.denials[0]?.immediate, false);
  assert.equal(runner.immediateDenial(), undefined);
});

test("a denied Execute at low autonomy records the immediate exit", async () => {
  const runner = makeRunner();
  const result = await runner.execute(
    "Execute",
    { command: "rm -rf ./build" },
    { signal: SIGNAL },
  );

  assert.equal(result.isError, true);
  assert.match(
    result.content ?? "",
    /^Error: Exec ended early: insufficient permission to proceed\./,
  );
  const denial = runner.immediateDenial();
  assert.ok(denial !== undefined);
  assert.equal(denial.toolName, "Execute");
  assert.match(denial.message, /^Exec ended early/);
});

test("an interactive ask that is declined cancels only that call", async () => {
  let asked = 0;
  const runner = makeRunner({
    permission: {
      autonomy: "low",
      interactionMode: "interactive",
      interactive: true,
    },
    confirm: async () => {
      asked += 1;
      return false;
    },
  });
  const result = await runner.execute(
    "Create",
    { file_path: "x.txt", content: "hello" },
    { signal: SIGNAL },
  );

  assert.equal(asked, 1);
  assert.equal(result.isError, true);
  assert.equal(result.content, "Error: Tool execution cancelled by user");
  assert.equal(runner.denials.length, 0);
});

test("invalid input is refused by the registry before the executor runs", async () => {
  const runner = makeRunner();
  const result = await runner.execute("Read", {}, { signal: SIGNAL });

  assert.equal(result.isError, true);
  assert.match(
    result.content ?? "",
    /^Error: input\.file_path: expected string/,
  );
  assert.match(result.content ?? "", /Please retry with valid parameters\./);
});

test("a tool outside the advertised set is refused with the available list", async () => {
  const runner = makeRunner({ allowed: ["Read"] });
  const result = await runner.execute(
    "Execute",
    { command: "ls", riskLevel: "low" },
    { signal: SIGNAL },
  );

  assert.equal(result.isError, true);
  assert.match(
    result.content ?? "",
    /^Error: Tool Execute is not permitted in this exec session\. Available tools: Read\.$/,
  );
});

test("an over-budget result keeps its head and tail inside 32 KiB", async () => {
  const registry = new ToolRegistry();
  const head = "H".repeat(20 * 1024);
  const tail = "T".repeat(20 * 1024);
  registry.register(
    defineTool<Record<string, never>, ToolContext>({
      id: "big-test",
      llmId: "Big",
      displayName: "Big",
      description: "Return a large value.",
      inputSchema: { kind: "object", properties: {} },
      sideEffects: [],
      run: () => `${head}${"M".repeat(20 * 1024)}${tail}`,
    }),
  );
  const runner = createExecToolRunner({
    registry,
    root: "/work",
    environment: ENVIRONMENT,
    permission: {
      autonomy: "low",
      interactionMode: "auto",
      interactive: false,
    },
  });

  const result = await runner.execute("Big", {}, { signal: SIGNAL });
  const text = result.content ?? "";
  assert.equal(result.isError, false);
  assert.ok(Buffer.byteLength(text, "utf8") <= MODEL_RESULT_BUDGET_BYTES);
  assert.match(text, /bytes cut from the middle/);
  assert.ok(text.startsWith("H"));
  assert.ok(text.endsWith("T"));
});

test("the permission algebra still backs a skipped-confirmation context", async () => {
  assert.equal(
    decide(
      { toolId: "execute-test", toolClass: "execute" },
      {
        autonomy: "low",
        interactionMode: "auto",
        skipConfirmations: true,
        maxAutonomy: "high",
      },
    ),
    "allow",
  );
});

const CLOCK: LoopClock = { now: () => 0, sleep: async () => {} };

function idleTools(): ExecToolRunner {
  return {
    allowed: [],
    denials: [],
    immediateDenial: () => undefined,
    execute: async () => ({ content: "", isError: false }),
  };
}

function collectingSink(): {
  readonly sink: TurnEventSink;
  readonly events: readonly string[];
} {
  const events: string[] = [];
  return {
    events,
    sink: {
      async assistant(message) {
        events.push(`assistant:${message.id}`);
      },
      async toolResult(result) {
        events.push(`result:${result.toolUseId}:${result.text}`);
      },
      async agentError(message) {
        events.push(`error:${message}`);
      },
    },
  };
}

test("the turn runner reports the last assistant text and summed usage", async () => {
  const provider: Provider = {
    async *stream() {
      yield { type: "text", text: "hi" };
      yield { type: "usage", input: 3, output: 2 };
      yield { type: "done" };
    },
  };
  const { sink, events } = collectingSink();
  const runner = createExecTurnRunner({
    provider,
    tools: idleTools(),
    clock: CLOCK,
    maxTurns: 4,
    nextMessageId: (role) => `${role}-1`,
  });

  const outcome = await runner.run(
    {
      prompt: "say hi",
      cwd: "/work",
      sessionId: "sid",
      model: "custom:mock",
      reasoningEffort: "low",
      tools: [],
    },
    sink,
  );

  assert.deepEqual(events, ["assistant:assistant-1"]);
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.equal(outcome.finalText, "hi");
  assert.equal(outcome.numTurns, 1);
  assert.equal(outcome.usage.input_tokens, 3);
  assert.equal(outcome.usage.output_tokens, 2);
});

test("a tool call produces one result record and a second assistant turn", async () => {
  let call = 0;
  const provider: Provider = {
    async *stream() {
      call += 1;
      if (call === 1) {
        yield { type: "tool_use_start", name: "Read", slot: 0 };
        yield {
          type: "tool_use_input",
          slot: 0,
          json: '{"file_path":"a.txt"}',
        };
        yield { type: "done" };
        return;
      }
      yield { type: "text", text: "Done." };
      yield { type: "done" };
    },
  };
  const tools: ExecToolRunner = {
    ...idleTools(),
    execute: async () => ({ content: "file body", isError: false }),
  };
  const { sink, events } = collectingSink();
  const runner = createExecTurnRunner({
    provider,
    tools,
    clock: CLOCK,
    maxTurns: 4,
    nextMessageId: (role) => `${role}-${role === "assistant" ? "a" : "t"}`,
  });

  const outcome = await runner.run(
    {
      prompt: "read a.txt",
      cwd: "/work",
      sessionId: "sid",
      model: "custom:mock",
      reasoningEffort: "low",
      tools: ["Read"],
    },
    sink,
  );

  assert.deepEqual(events, [
    "assistant:assistant-a",
    "result:call_8614944ab6244969_0:file body",
    "assistant:assistant-a",
  ]);
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.equal(outcome.finalText, "Done.");
  assert.equal(outcome.numTurns, 2);
});

test("an immediate denial aborts the loop and ends the turn as failed", async () => {
  let call = 0;
  const provider: Provider = {
    async *stream() {
      call += 1;
      yield { type: "tool_use_start", name: "Execute", slot: 0 };
      yield { type: "tool_use_input", slot: 0, json: '{"command":"rm"}' };
      yield { type: "done" };
    },
  };
  let recorded = false;
  const tools: ExecToolRunner = {
    allowed: ["Execute"],
    denials: [],
    immediateDenial: () =>
      recorded
        ? {
            toolName: "Execute",
            message: "Exec ended early: no",
            immediate: true,
          }
        : undefined,
    execute: async () => {
      recorded = true;
      return { content: "Error: Exec ended early: no", isError: true };
    },
  };
  const { sink, events } = collectingSink();
  const runner = createExecTurnRunner({
    provider,
    tools,
    clock: CLOCK,
    maxTurns: 8,
    nextMessageId: (role) => `${role}-${String(events.length)}`,
  });

  const outcome = await runner.run(
    {
      prompt: "delete it",
      cwd: "/work",
      sessionId: "sid",
      model: "custom:mock",
      reasoningEffort: "low",
      tools: ["Execute"],
    },
    sink,
  );

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.message, "Exec ended early: no");
  }
  assert.equal(call, 1);
  assert.match(events.join("|"), /assistant:/);
  assert.match(events.join("|"), /Exec ended early: no/);
});
