import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CompactionError,
  PER_BLOCK_OVERHEAD_TOKENS,
  compact,
  estimateTokens,
  renderSummary,
  shouldCompact,
} from "../../../src/agent/compaction.ts";
import { runTurn } from "../../../src/agent/loop.ts";
import type {
  ContentBlock,
  Message,
  Role,
} from "../../../src/agent/messages.ts";
import type {
  CompactionConfig,
  Provider,
  ProviderDelta,
  Summarizer,
  TurnDependencies,
  TurnEvent,
} from "../../../src/agent/ports.ts";

const AT = 1_700_000_000_000;
const LIMIT = 3_000;

function message(
  role: Role,
  content: readonly ContentBlock[],
  id: string,
  extra: Partial<Message> = {},
): Message {
  return { id, role, content, createdAt: AT, updatedAt: AT, ...extra };
}

function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

function user(
  id: string,
  value: string,
  extra: Partial<Message> = {},
): Message {
  return message("user", [text(value)], id, extra);
}

function assistant(id: string, content: readonly ContentBlock[]): Message {
  return message("assistant", content, id);
}

function toolMessage(id: string, toolUseId: string, content: string): Message {
  return message("tool", [{ type: "tool_result", toolUseId, content }], id);
}

function toolUse(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input };
}

interface SummarySpy {
  readonly summarizer: Summarizer;
  readonly calls: Array<{ messages: readonly Message[]; maxTokens: number }>;
}

function summarySpy(answer = "the earlier work"): SummarySpy {
  const calls: SummarySpy["calls"] = [];
  return {
    calls,
    summarizer: {
      async summarize(messages, options): Promise<string> {
        calls.push({ messages, maxTokens: options.maxTokens });
        return answer;
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Token estimate                                                             */
/* -------------------------------------------------------------------------- */

test("the estimate is zero for no messages and monotonic in blocks", () => {
  assert.equal(estimateTokens([]), 0);
  assert.equal(
    estimateTokens([message("user", [text("")], "u")]),
    PER_BLOCK_OVERHEAD_TOKENS,
  );

  const one = estimateTokens([user("u1", "hello")]);
  const twoBlocks = estimateTokens([
    message("user", [text("hello"), text("hello")], "u1"),
  ]);
  assert.ok(twoBlocks > one);

  const twoMessages = estimateTokens([user("u1", "hello"), user("u2", "hi")]);
  assert.ok(twoMessages > one);
});

test("the estimate weights multi-byte text above code-unit length", () => {
  const ascii = estimateTokens([user("u1", "a".repeat(100))]);
  const cjk = estimateTokens([user("u1", "汉".repeat(100))]);
  assert.ok(cjk > ascii * 3);
});

test("tool input, tool results and thinking contribute; media payloads do not", () => {
  const call = estimateTokens([
    message("assistant", [toolUse("t1", "read_file", { path: "a.txt" })], "a1"),
  ]);
  assert.ok(call > PER_BLOCK_OVERHEAD_TOKENS);

  const result = estimateTokens([toolMessage("m1", "t1", "x".repeat(400))]);
  const image = estimateTokens([
    message(
      "user",
      [
        {
          type: "image",
          source: {
            type: "base64",
            mediaType: "image/png",
            data: "a".repeat(10_000),
          },
        },
      ],
      "u1",
    ),
  ]);
  assert.equal(image, PER_BLOCK_OVERHEAD_TOKENS);
  assert.ok(result > image);
});

/* -------------------------------------------------------------------------- */
/* Threshold                                                                  */
/* -------------------------------------------------------------------------- */

test("the predicate fires strictly above the limit and not at it", () => {
  const history = [user("u1", "a".repeat(400))];
  const exact = estimateTokens(history);

  assert.equal(shouldCompact(history, exact + 100), false);
  assert.equal(shouldCompact(history, exact), false);
  assert.equal(shouldCompact(history, exact - 1), true);
});

test("a lower ratio fires before the ceiling is reached", () => {
  const history = [user("u1", "a".repeat(400))];
  const exact = estimateTokens(history);
  const limit = exact * 2;

  assert.equal(shouldCompact(history, limit, { ratio: 0.5 }), false);
  assert.equal(shouldCompact(history, limit, { ratio: 0.4 }), true);
  assert.equal(shouldCompact(history, limit, { ratio: 0.51 }), false);
});

test("an invalid limit or ratio is a typed range error", () => {
  assert.throws(() => shouldCompact([], -1), RangeError);
  assert.throws(() => shouldCompact([], Number.NaN), RangeError);
  assert.throws(() => shouldCompact([], 10, { ratio: 0 }), RangeError);
  assert.throws(() => shouldCompact([], 10, { ratio: 1.5 }), RangeError);
});

/* -------------------------------------------------------------------------- */
/* Replacement                                                                */
/* -------------------------------------------------------------------------- */

test("compaction keeps the system prompt and the last turn, summary in between", async () => {
  const system = message("system", [text("You are Droide.")], "s0");
  const messages = [
    system,
    user("u1", "first".repeat(80)),
    assistant("a1", [text("second".repeat(80))]),
    user("u2", "third".repeat(80)),
    assistant("a2", [text("fourth".repeat(80))]),
    user("u3", "fifth"),
    assistant("a3", [text("sixth")]),
  ];
  const spy = summarySpy("the first exchange");

  const result = await compact(messages, {
    summarizer: spy.summarizer,
    keepRecent: 1,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summarizedCount, 4);
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(
    spy.calls[0]?.messages.map((entry) => entry.id),
    ["u1", "a1", "u2", "a2"],
  );
  assert.equal(spy.calls[0]?.maxTokens, 4_000);
  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["s0", "injected-summary-1", "u3", "a3"],
  );

  const summary = result.summary;
  assert.equal(summary?.role, "user");
  assert.equal(summary?.visibility, "llm_only");
  const summaryText = summary?.content[0];
  assert.equal(summaryText?.type, "text");
  if (summaryText?.type === "text") {
    assert.match(summaryText.text, /You summarized the conversation/);
    assert.match(
      summaryText.text,
      /<summary>\nthe first exchange\n<\/summary>/,
    );
  }
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.equal(messages.length, 7, "the input transcript is not mutated");
});

test("nothing between the system prompt and the last turn means no summary", async () => {
  const messages = [
    message("system", [text("You are Droide.")], "s0"),
    user("u1", "only prompt"),
    assistant("a1", [text("answer")]),
  ];
  const spy = summarySpy();

  const result = await compact(messages, {
    summarizer: spy.summarizer,
    keepRecent: 1,
  });

  assert.equal(result.compacted, false);
  assert.equal(result.summary, null);
  assert.equal(result.summarizedCount, 0);
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.afterTokens, result.beforeTokens);
});

test("a tool call whose result would be cut stays with its result", async () => {
  const messages = [
    user("u1", "first".repeat(200)),
    assistant("a1", [toolUse("t1", "read", { path: "a.txt" })]),
    user("u2", "second"),
    toolMessage("m1", "t1", "file contents"),
  ];
  const spy = summarySpy();

  const result = await compact(messages, {
    summarizer: spy.summarizer,
    keepRecent: 1,
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["injected-summary-0", "a1", "u2", "m1"],
  );
  // The retained region answers every result it carries.
  const calls = new Set(
    result.messages
      .flatMap((entry) => entry.content)
      .filter(
        (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
          block.type === "tool_use",
      )
      .map((block) => block.id),
  );
  for (const block of result.messages.flatMap((entry) => entry.content)) {
    if (block.type === "tool_result") assert.ok(calls.has(block.toolUseId));
  }
});

test("user_only rows are held out of the provider view and the summary input", async () => {
  const secret = user("secret", "do not send this", {
    visibility: "user_only",
  });
  const messages = [
    user("u1", "first".repeat(200)),
    secret,
    assistant("a1", [text("answer")]),
    user("u2", "second"),
  ];
  const spy = summarySpy();

  const result = await compact(messages, {
    summarizer: spy.summarizer,
    keepRecent: 1,
  });

  assert.deepEqual(
    result.userOnly.map((entry) => entry.id),
    ["secret"],
  );
  assert.deepEqual(
    spy.calls[0]?.messages.map((entry) => entry.id),
    ["u1", "a1"],
  );
  assert.equal(
    result.messages.some((entry) => entry.id === "secret"),
    false,
  );
  assert.equal(
    result.beforeTokens,
    estimateTokens(messages.filter((entry) => entry.id !== "secret")),
  );
});

test("a summarizer failure propagates and an empty summary is a typed error", async () => {
  const messages = [
    user("u1", "first".repeat(200)),
    assistant("a1", [text("answer")]),
    user("u2", "second"),
  ];

  await assert.rejects(
    compact(messages, {
      summarizer: {
        async summarize(): Promise<string> {
          throw new Error("provider down");
        },
      },
      keepRecent: 1,
    }),
    /provider down/,
  );

  await assert.rejects(
    compact(messages, {
      summarizer: {
        async summarize(): Promise<string> {
          return "   \n";
        },
      },
      keepRecent: 1,
    }),
    (error: unknown) =>
      error instanceof CompactionError && /empty summary/.test(error.message),
  );
});

test("keepRecent and maxTokens are validated", async () => {
  const spy = summarySpy();
  await assert.rejects(
    compact([], { summarizer: spy.summarizer, keepRecent: -1 }),
    RangeError,
  );
  await assert.rejects(
    compact([], { summarizer: spy.summarizer, keepRecent: 1, maxTokens: 0 }),
    RangeError,
  );
  assert.match(renderSummary("x"), /<summary>\nx\n<\/summary>/);
});

/* -------------------------------------------------------------------------- */
/* Loop wiring                                                                */
/* -------------------------------------------------------------------------- */

interface LoopHarness {
  readonly deps: TurnDependencies;
  readonly events: TurnEvent[];
  readonly seen: Array<readonly Message[]>;
}

function loopHarness(
  script: (call: number) => readonly ProviderDelta[],
  compaction: CompactionConfig | undefined,
  toolContent: string,
): LoopHarness {
  const events: TurnEvent[] = [];
  const seen: Array<readonly Message[]> = [];
  let calls = 0;
  let ids = 0;

  const provider: Provider = {
    async *stream(messages) {
      seen.push([...messages]);
      const deltas = script(calls);
      calls += 1;
      for (const delta of deltas) yield delta;
    },
  };

  const deps: TurnDependencies = {
    provider,
    tools: {
      async execute() {
        return { content: toolContent };
      },
    },
    permissions: {
      decide: () => "allow",
      confirm: async () => true,
    },
    clock: { now: () => AT, sleep: async () => undefined },
    retry: {
      maxAttempts: 1,
      baseDelayMs: 1,
      factor: 2,
      shouldRetry: () => false,
    },
    emit: (event) => events.push(event),
    nextMessageId: (role) => `${role}_${++ids}`,
    ...(compaction === undefined ? {} : { compaction }),
  };

  return { deps, events, seen };
}

function priorHistory(): Message[] {
  return [
    user("u0", "y".repeat(4_000)),
    assistant("a0", [text("z".repeat(4_000))]),
    user("u1", "go"),
  ];
}

test("a turn compacts once at the threshold and does not loop", async () => {
  const spy = summarySpy("worked on it");
  const harness = loopHarness(
    (call) =>
      call === 0
        ? [
            { type: "tool_use_start", name: "read", slot: 0 },
            { type: "tool_use_input", slot: 0, json: '{"path":"a.txt"}' },
            { type: "done" },
          ]
        : [{ type: "text", text: "done" }, { type: "done" }],
    { limit: LIMIT, summarizer: spy.summarizer, keepRecent: 1 },
    "x".repeat(20_000),
  );

  const outcome = await runTurn(harness.deps, {
    messages: priorHistory(),
    maxTurns: 4,
  });

  assert.equal(outcome.reason, "completed");
  const compactionEvents = harness.events.filter(
    (event) => event.type === "compaction",
  );
  assert.equal(compactionEvents.length, 1);
  const [event] = compactionEvents;
  assert.equal(event?.type, "compaction");
  if (event?.type === "compaction") {
    assert.equal(event.compacted, true);
    assert.equal(event.summarized, 2);
    assert.ok(event.before > LIMIT);
    assert.equal(event.error, undefined);
  }
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(
    spy.calls[0]?.messages.map((entry) => entry.id),
    ["u0", "a0"],
  );

  // The first request carries the whole history; the second carries the
  // request-only summary row instead of the summarized turns.
  assert.deepEqual(
    harness.seen[0]?.map((entry) => entry.id),
    ["u0", "a0", "u1"],
  );
  assert.deepEqual(
    harness.seen[1]?.map((entry) => entry.id),
    ["injected-summary-0", "u1", "assistant_1", "tool_2"],
  );
  assert.match(renderSummary("x"), /summary/);
});

test("a summarizer failure leaves the turn running with the uncompacted view", async () => {
  const harness = loopHarness(
    () => [{ type: "text", text: "ok" }, { type: "done" }],
    {
      limit: 1_000,
      summarizer: {
        async summarize(): Promise<string> {
          throw new Error("summarizer unavailable");
        },
      },
      keepRecent: 1,
    },
    "",
  );

  const outcome = await runTurn(harness.deps, {
    messages: priorHistory(),
    maxTurns: 2,
  });

  assert.equal(outcome.reason, "completed");
  const compactionEvents = harness.events.filter(
    (event) => event.type === "compaction",
  );
  assert.equal(compactionEvents.length, 1);
  const [event] = compactionEvents;
  if (event?.type === "compaction") {
    assert.equal(event.compacted, false);
    assert.equal(event.summarized, 0);
    assert.equal(event.error, "summarizer unavailable");
    assert.equal(event.after, event.before);
  }
  assert.deepEqual(
    harness.seen[0]?.map((entry) => entry.id),
    ["u0", "a0", "u1"],
  );
});

test("no compaction config means no compaction event and the same history", async () => {
  const harness = loopHarness(
    () => [{ type: "text", text: "ok" }, { type: "done" }],
    undefined,
    "",
  );

  const outcome = await runTurn(harness.deps, {
    messages: priorHistory(),
    maxTurns: 2,
  });

  assert.equal(outcome.reason, "completed");
  assert.equal(
    harness.events.some((event) => event.type === "compaction"),
    false,
  );
  assert.deepEqual(
    harness.seen[0]?.map((entry) => entry.id),
    ["u0", "a0", "u1"],
  );
});
