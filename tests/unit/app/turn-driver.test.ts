/**
 * The interactive turn driver, headless: a scripted provider, a fake tool
 * runner, fake timers and a counting paint callback. No terminal, no network,
 * no wall clock, no sleeps — a provider that must stall holds on a gate the
 * test releases or aborts.
 *
 * Contract: `specs/20-agent-loop.md` §B1–B5/B20–B30 and
 * `specs/95-terminal-ui.md` §B12/R11/R12.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTurnDriver,
  type TurnDriver,
  type TurnTimers,
} from "../../../src/app/interactive-turn.ts";
import type { Message, ToolResultBlock } from "../../../src/agent/messages.ts";
import type {
  Provider,
  ProviderDelta,
  ToolRunner,
} from "../../../src/agent/ports.ts";
import type { Environment } from "../../../src/config/paths.ts";
import { createExecToolRunner } from "../../../src/exec/runner.ts";
import type { PermissionContext } from "../../../src/tools/permissions.ts";
import type { ToolContext } from "../../../src/tools/context.ts";
import { ToolRegistry, defineTool } from "../../../src/tools/registry.ts";

const ENVIRONMENT: Environment = {
  env: {},
  home: "/home/test",
  platform: "linux",
  cwd: "/work",
};

const TOOL_CONTEXT: PermissionContext = {
  autonomy: "off",
  interactionMode: "interactive",
  interactive: true,
};

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
}

interface FakeTimers extends TurnTimers {
  size(): number;
  advance(ms: number): void;
}

function fakeTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; run: () => void }>();
  return {
    setTimeout(callback, ms) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { at: now + ms, run: callback });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") scheduled.delete(handle);
    },
    size: () => scheduled.size,
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...scheduled]) {
        if (entry.at > now) continue;
        scheduled.delete(id);
        entry.run();
      }
    },
  };
}

/** Yield to the task queue, never to the clock. */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** What one provider call should emit. */
interface Script {
  readonly deltas: readonly ProviderDelta[];
  /** Wait for `release(call)` after this many deltas. */
  readonly holdAfter?: number;
  /** After the last delta, wait until the signal aborts. */
  readonly hold?: boolean;
}

interface FakeProvider {
  readonly provider: Provider;
  readonly calls: Array<readonly Message[]>;
  readonly releases: Map<number, () => void>;
  active: number;
  aborts: number;
  release(call: number): void;
}

function fakeProvider(
  script: (call: number, messages: readonly Message[]) => Script,
): FakeProvider {
  const state: FakeProvider = {
    provider: {
      async *stream(messages, { signal }) {
        const call = state.calls.length;
        state.calls.push([...messages]);
        const plan = script(call, messages);
        const release = gate();
        state.releases.set(call, release.open);
        state.active += 1;
        try {
          let yielded = 0;
          for (const delta of plan.deltas) {
            if (plan.holdAfter !== undefined && yielded === plan.holdAfter) {
              await release.promise;
            }
            if (signal.aborted) {
              state.aborts += 1;
              throw abortError();
            }
            yield delta;
            yielded += 1;
          }
          if (plan.hold === true) {
            if (signal.aborted) {
              state.aborts += 1;
              throw abortError();
            }
            const aborted = Promise.withResolvers<never>();
            const onAbort = (): void => {
              state.aborts += 1;
              aborted.reject(abortError());
            };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              await aborted.promise;
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          }
        } finally {
          state.active -= 1;
        }
      },
    },
    calls: [],
    releases: new Map(),
    active: 0,
    aborts: 0,
    release(call) {
      state.releases.get(call)?.();
    },
  };
  return state;
}

function silentTools(): ToolRunner {
  return {
    async execute() {
      return { content: "ok", isError: false };
    },
  };
}

interface Harness {
  readonly driver: TurnDriver;
  readonly timers: FakeTimers;
  readonly paints: { count: number };
}

function harness(
  provider: Provider,
  tools: ToolRunner = silentTools(),
): Harness {
  const timers = fakeTimers();
  const paints = { count: 0 };
  const driver = createTurnDriver({
    connect: async () => ({ provider, tools: () => tools }),
    clock: () => 1_700_000_000_000,
    timers,
    onChange: () => {
      paints.count += 1;
    },
  });
  return { driver, timers, paints };
}

test(
  "a text turn coalesces deltas into one assistant row and finishes",
  { timeout: 8000 },
  async () => {
    const fake = fakeProvider((call) =>
      call === 0
        ? {
            deltas: [
              { type: "text", text: "Hel" },
              { type: "text", text: "lo" },
              { type: "text", text: "!" },
              { type: "done" },
            ],
            holdAfter: 2,
          }
        : { deltas: [{ type: "done" }] },
    );
    const { driver, timers, paints } = harness(fake.provider);

    driver.submit("hi");
    await tick();
    assert.equal(paints.count, 1, "the submit painted immediately");
    assert.equal(
      timers.size(),
      1,
      "two deltas share one frame, not one frame each",
    );
    assert.deepEqual(
      driver.entries.map((entry) => entry.kind),
      ["user", "assistant"],
    );
    assert.equal(driver.entries[1]?.["text"], "Hello");

    timers.advance(16);
    assert.equal(paints.count, 2, "the frame painted once");

    fake.release(0);
    await driver.settled();

    assert.equal(driver.status, "idle");
    assert.equal(driver.entries[1]?.["text"], "Hello!");
    assert.equal(paints.count, 3, "submit, one frame, one settlement");
    assert.equal(timers.size(), 0, "no timer survives the turn");
  },
);

test(
  "a tool turn appends the call row and then its result",
  { timeout: 8000 },
  async () => {
    const fake = fakeProvider((call) =>
      call === 0
        ? {
            deltas: [
              { type: "tool_use_start", name: "Read", slot: 0 },
              {
                type: "tool_use_input",
                slot: 0,
                json: '{"file_path":"a.txt"}',
              },
              { type: "done" },
            ],
          }
        : { deltas: [{ type: "text", text: "done" }, { type: "done" }] },
    );
    const executed: Array<{ name: string; input: unknown }> = [];
    const tools: ToolRunner = {
      async execute(name, input) {
        executed.push({ name, input });
        return { content: "file contents" };
      },
    };
    const { driver } = harness(fake.provider, tools);

    driver.submit("read it");
    await driver.settled();

    assert.deepEqual(executed, [
      { name: "Read", input: { file_path: "a.txt" } },
    ]);
    const kinds = driver.entries.map((entry) => entry.kind);
    assert.deepEqual(kinds, ["user", "tool", "assistant"]);
    const tool = driver.entries[1];
    assert.equal(tool?.["name"], "Read");
    assert.deepEqual(tool?.["params"], [["file_path", "a.txt"]]);
    assert.equal(tool?.["state"], "success");
    assert.equal(tool?.["result"], "file contents");
    assert.equal(driver.entries[2]?.["text"], "done");
  },
);

test(
  "an approval denial feeds the documented refusal back to the model",
  { timeout: 8000 },
  async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool<{ file_path: string }, ToolContext>({
        id: "write-test",
        llmId: "Write",
        displayName: "Write",
        description: "Write a file.",
        inputSchema: {
          kind: "object",
          properties: { file_path: { kind: "string" } },
        },
        sideEffects: ["filesystem-write"],
        run: () => "written",
      }),
    );
    const fake = fakeProvider((call) =>
      call === 0
        ? {
            deltas: [
              { type: "tool_use_start", name: "Write", slot: 0 },
              {
                type: "tool_use_input",
                slot: 0,
                json: '{"file_path":"a.txt"}',
              },
              { type: "done" },
            ],
          }
        : { deltas: [{ type: "text", text: "refused" }, { type: "done" }] },
    );
    const timers = fakeTimers();
    const driver = createTurnDriver({
      connect: async () => ({
        provider: fake.provider,
        tools: (confirm) =>
          createExecToolRunner({
            registry,
            root: "/work",
            environment: ENVIRONMENT,
            permission: TOOL_CONTEXT,
            allowed: ["Write"],
            confirm,
          }),
      }),
      clock: () => 1,
      timers,
      onChange: () => {},
    });

    driver.submit("write a.txt");
    await tick();

    assert.equal(driver.approvalOpen, true);
    assert.equal(driver.status, "awaiting_approval");
    const approval = driver.entries.find((entry) => entry.kind === "approval");
    assert.ok(approval, "an approval row is rendered");
    assert.equal(approval["toolName"], "Write");
    assert.deepEqual(
      (approval["options"] as Array<{ choice: string }>).map(
        (option) => option.choice,
      ),
      ["once", "session", "deny"],
    );

    // `n` is the documented deny key; return true means the approval consumed it.
    assert.equal(
      driver.handleApprovalAction({ kind: "insert", text: "n" }),
      true,
    );
    assert.equal(driver.approvalOpen, false);

    await driver.settled();

    const second = fake.calls[1];
    assert.ok(second, "the loop asked again after the tool result");
    const toolMessage = second.find((message) => message.role === "tool");
    assert.ok(toolMessage, "the refusal is a tool message");
    const block = toolMessage.content.find(
      (part): part is ToolResultBlock => part.type === "tool_result",
    );
    assert.equal(block?.content, "Error: Tool execution cancelled by user");
    assert.equal(block?.isError, true);

    const row = driver.entries.find((entry) => entry.kind === "tool");
    assert.equal(row?.["state"], "error");
    assert.equal(row?.["result"], "Error: Tool execution cancelled by user");
    assert.equal(driver.entries.at(-1)?.["text"], "refused");
  },
);

test(
  "cancel aborts a streaming turn and leaves the driver idle",
  { timeout: 8000 },
  async () => {
    const fake = fakeProvider((call) =>
      call === 0
        ? { deltas: [{ type: "text", text: "part" }], hold: true }
        : { deltas: [{ type: "text", text: "second" }, { type: "done" }] },
    );
    const { driver, timers } = harness(fake.provider);

    driver.submit("first");
    await tick();
    assert.equal(driver.running, true);
    assert.equal(fake.active, 1);

    driver.cancel();
    await driver.settled();

    assert.equal(driver.status, "idle");
    assert.equal(fake.active, 0, "the provider stream closed");
    assert.equal(fake.aborts, 1);
    const notice = driver.entries.at(-1);
    assert.equal(notice?.kind, "notice");
    assert.equal(notice?.["text"], "Cancelled");
    assert.equal(timers.size(), 0);

    // The next turn starts from the history that survived the cancellation.
    driver.submit("second");
    await driver.settled();
    assert.equal(driver.status, "idle");
    assert.equal(
      driver.entries.some((entry) => entry["text"] === "second"),
      true,
    );
    assert.equal(fake.calls.length, 2);
    const resumed = fake.calls[1] ?? [];
    assert.equal(
      resumed.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) => part.type === "text" && part.text === "second",
          ),
      ),
      true,
    );
  },
);

test(
  "a failed wiring is a notice and leaves the shell usable",
  { timeout: 8000 },
  async () => {
    const timers = fakeTimers();
    let attempts = 0;
    const driver = createTurnDriver({
      connect: async () => {
        attempts += 1;
        throw new Error("Authentication failed.");
      },
      clock: () => 0,
      timers,
      onChange: () => {},
    });

    driver.submit("hello");
    await driver.settled();

    assert.equal(attempts, 1, "the wiring is attempted once");
    assert.equal(driver.status, "idle");
    assert.deepEqual(
      driver.entries.map((entry) => entry.kind),
      ["user", "notice"],
    );
    assert.equal(driver.entries[1]?.["text"], "Error: Authentication failed.");
    assert.equal(timers.size(), 0);
  },
);

test(
  "approve for the session skips the prompt for later calls of that tool",
  { timeout: 8000 },
  async () => {
    let written = 0;
    const registry = new ToolRegistry();
    registry.register(
      defineTool<{ file_path: string }, ToolContext>({
        id: "write-test",
        llmId: "Write",
        displayName: "Write",
        description: "Write a file.",
        inputSchema: {
          kind: "object",
          properties: { file_path: { kind: "string" } },
        },
        sideEffects: ["filesystem-write"],
        run: () => {
          written += 1;
          return "written";
        },
      }),
    );
    const fake = fakeProvider((call) =>
      call < 2
        ? {
            deltas: [
              { type: "tool_use_start", name: "Write", slot: 0 },
              {
                type: "tool_use_input",
                slot: 0,
                json: `{"file_path":"${String(call)}.txt"}`,
              },
              { type: "done" },
            ],
          }
        : { deltas: [{ type: "text", text: "both" }, { type: "done" }] },
    );
    const driver = createTurnDriver({
      connect: async () => ({
        provider: fake.provider,
        tools: (confirm) =>
          createExecToolRunner({
            registry,
            root: "/work",
            environment: ENVIRONMENT,
            permission: TOOL_CONTEXT,
            allowed: ["Write"],
            confirm,
          }),
      }),
      clock: () => 1,
      timers: fakeTimers(),
      onChange: () => {},
    });

    driver.submit("write two files");
    await tick();
    assert.equal(driver.approvalOpen, true);
    assert.equal(
      driver.handleApprovalAction({ kind: "insert", text: "a" }),
      true,
    );
    await driver.settled();

    assert.equal(written, 2, "both calls ran");
    assert.equal(
      driver.entries.filter((entry) => entry.kind === "approval").length,
      1,
      "the second call did not prompt again",
    );
    assert.equal(
      driver.entries.find((entry) => entry.kind === "approval")?.["decision"],
      "session",
    );
    assert.equal(driver.entries.at(-1)?.["text"], "both");
  },
);
