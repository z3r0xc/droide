import assert from "node:assert/strict";
import { test } from "node:test";

import { LlmStreamError } from "../../../src/transport/errors.ts";
import {
  clampMaxTokens,
  createStreamMapper,
  mapStream,
  parseStreamPayload,
  type LlmDialect,
  type LlmStreamDelta,
  type LlmStreamOptions,
} from "../../../src/transport/llm.ts";
import type { SseEvent } from "../../../src/transport/sse.ts";

function dataEvent(payload: unknown): SseEvent {
  return { kind: "data", event: null, data: JSON.stringify(payload) };
}

function run(
  dialect: LlmDialect,
  events: readonly SseEvent[],
  options: Partial<LlmStreamOptions> = {},
): LlmStreamDelta[] {
  const mapper = createStreamMapper(dialect, {
    operation: "llm",
    ...options,
  });
  const deltas: LlmStreamDelta[] = [];
  for (const event of events) {
    deltas.push(...mapper.push(event));
  }
  deltas.push(...mapper.finish());
  return deltas;
}

const ANTHROPIC_TEXT: readonly SseEvent[] = [
  dataEvent({
    type: "message_start",
    message: {
      id: "msg_1",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        output_tokens: 0,
      },
    },
  }),
  dataEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  dataEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  }),
  dataEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " world" },
  }),
  dataEvent({ type: "content_block_stop", index: 0 }),
  dataEvent({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5 },
  }),
  dataEvent({ type: "message_stop" }),
];

test("Anthropic text-only turn: text deltas, one usage, one completed", () => {
  assert.deepEqual(run("anthropic", ANTHROPIC_TEXT), [
    { kind: "text", text: "Hello" },
    { kind: "text", text: " world" },
    {
      kind: "usage",
      usage: {
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheCreationTokens: 0,
        outputTokens: 5,
      },
    },
    { kind: "completed", stopReason: "stop" },
  ]);
});

test("Anthropic message_stop after message_delta adds nothing (B115)", () => {
  const mapper = createStreamMapper("anthropic", { operation: "llm" });
  for (const event of ANTHROPIC_TEXT.slice(0, 6)) {
    mapper.push(event);
  }
  const afterTerminal = mapper.push(ANTHROPIC_TEXT[6] ?? { kind: "done" });
  assert.deepEqual(afterTerminal, []);
  assert.deepEqual(mapper.finish(), []);
});

const ANTHROPIC_TOOL: readonly SseEvent[] = [
  dataEvent({
    type: "message_start",
    message: { id: "msg_2", usage: { input_tokens: 12 } },
  }),
  dataEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  dataEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Let me check." },
  }),
  dataEvent({ type: "content_block_stop", index: 0 }),
  dataEvent({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_provider", name: "search" },
  }),
  dataEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"q":' },
  }),
  dataEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"x"}' },
  }),
  dataEvent({ type: "content_block_stop", index: 1 }),
  dataEvent({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 7 },
  }),
];

test("Anthropic tool-call turn: start, accumulated args and end", () => {
  assert.deepEqual(run("anthropic", ANTHROPIC_TOOL), [
    { kind: "text", text: "Let me check." },
    { kind: "tool-call-start", index: 1, id: "msg_2-1", name: "search" },
    { kind: "tool-call-args", index: 1, id: "msg_2-1", delta: '{"q":' },
    { kind: "tool-call-args", index: 1, id: "msg_2-1", delta: '"x"}' },
    { kind: "tool-call-end", index: 1, id: "msg_2-1", input: '{"q":"x"}' },
    {
      kind: "usage",
      usage: {
        inputTokens: 12,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 7,
      },
    },
    { kind: "completed", stopReason: "tool-use" },
  ]);
});

test("Anthropic: an unknown event type is ignored (B114)", () => {
  const mapper = createStreamMapper("anthropic", { operation: "llm" });
  assert.deepEqual(
    mapper.push(dataEvent({ type: "content_block_weird", index: 0 })),
    [],
  );
});

test("Chat Completions text-only turn: usage buckets are disjoint", () => {
  const deltas = run("chat", [
    dataEvent({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] }),
    dataEvent({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    }),
    { kind: "done" },
  ]);
  assert.deepEqual(deltas, [
    { kind: "text", text: "Hi" },
    {
      kind: "usage",
      usage: {
        inputTokens: 15,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        outputTokens: 3,
      },
    },
    { kind: "completed", stopReason: "stop" },
  ]);
});

test("Chat Completions tool calls: id grouping, index replacement, no concatenation", () => {
  const deltas = run("chat", [
    dataEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                function: { name: "search", arguments: '{"q":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    dataEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_a", function: { arguments: '"x"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    dataEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: "call_b", function: { name: "fetch", arguments: "{}" } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    dataEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call_c",
                function: { name: "other", arguments: "2" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    dataEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ]);

  assert.deepEqual(deltas, [
    { kind: "tool-call-start", index: 0, id: "call_a", name: "search" },
    { kind: "tool-call-args", index: 0, id: "call_a", delta: '{"q":' },
    { kind: "tool-call-args", index: 0, id: "call_a", delta: '"x"}' },
    { kind: "tool-call-start", index: 1, id: "call_b", name: "fetch" },
    { kind: "tool-call-args", index: 1, id: "call_b", delta: "{}" },
    { kind: "tool-call-end", index: 1, id: "call_b", input: "{}" },
    { kind: "tool-call-start", index: 1, id: "call_c", name: "other" },
    { kind: "tool-call-args", index: 1, id: "call_c", delta: "2" },
    { kind: "tool-call-end", index: 0, id: "call_a", input: '{"q":"x"}' },
    { kind: "tool-call-end", index: 1, id: "call_c", input: "2" },
    { kind: "completed", stopReason: "tool-use" },
  ]);
});

test("Chat Completions: a reasoning-only chunk without choices is tolerated", () => {
  const mapper = createStreamMapper("chat", { operation: "llm" });
  assert.deepEqual(
    mapper.push(dataEvent({ usage: { completion_tokens: 1 } })),
    [
      {
        kind: "usage",
        usage: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
        },
      },
    ],
  );
});

test("Chat Completions: the cached-prompt header is the cache-read fallback", () => {
  const deltas = run(
    "chat",
    [
      dataEvent({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    ],
    { cachedPromptTokensHeader: 4 },
  );
  assert.deepEqual(deltas[0], {
    kind: "usage",
    usage: {
      inputTokens: 6,
      cacheReadTokens: 4,
      cacheCreationTokens: 0,
      outputTokens: 2,
    },
  });
});

test("Responses: text deltas and a completion", () => {
  const deltas = run("responses", [
    dataEvent({ type: "response.created" }),
    dataEvent({ type: "response.output_text.delta", delta: "Hi " }),
    dataEvent({ type: "response.output_text.delta", delta: "there" }),
    dataEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 9, output_tokens: 4 } },
    }),
  ]);
  assert.deepEqual(deltas, [
    { kind: "text", text: "Hi " },
    { kind: "text", text: "there" },
    {
      kind: "usage",
      usage: {
        inputTokens: 9,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 4,
      },
    },
    { kind: "completed", stopReason: "stop" },
  ]);
});

test("Responses: a non-empty arguments.done replaces the buffered deltas (B119)", () => {
  const deltas = run("responses", [
    dataEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "lookup" },
    }),
    dataEvent({
      type: "response.function_call_arguments.delta",
      item_id: "call_1",
      delta: '{"a"',
    }),
    dataEvent({
      type: "response.function_call_arguments.delta",
      item_id: "call_1",
      delta: ":1}",
    }),
    dataEvent({
      type: "response.function_call_arguments.done",
      item_id: "call_1",
      arguments: '{"a":2}',
    }),
    dataEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1" },
    }),
    dataEvent({
      type: "response.incomplete",
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ]);
  assert.deepEqual(deltas, [
    { kind: "tool-call-start", index: 0, id: "call_1", name: "lookup" },
    { kind: "tool-call-args", index: 0, id: "call_1", delta: '{"a"' },
    { kind: "tool-call-args", index: 0, id: "call_1", delta: ":1}" },
    { kind: "tool-call-end", index: 0, id: "call_1", input: '{"a":2}' },
    {
      kind: "usage",
      usage: {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
      },
    },
    { kind: "completed", stopReason: "length" },
  ]);
});

test("a stream that ends without a terminal event is finalized once", async () => {
  const events: SseEvent[] = [
    dataEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    }),
  ];
  async function* source(): AsyncGenerator<SseEvent> {
    for (const event of events) {
      yield event;
    }
  }
  const deltas: LlmStreamDelta[] = [];
  for await (const delta of mapStream(source(), "anthropic", {
    operation: "llm",
  })) {
    deltas.push(delta);
  }
  assert.deepEqual(deltas, [
    { kind: "text", text: "partial" },
    { kind: "completed", stopReason: "unknown" },
  ]);
});

test("an invalid JSON payload fails without quoting the payload", () => {
  const event: SseEvent = { kind: "data", event: null, data: "not json" };
  assert.throws(
    () => parseStreamPayload(event, "llm"),
    (error: unknown) =>
      error instanceof LlmStreamError &&
      error.message.includes("not valid JSON") &&
      !error.message.includes("not json"),
  );
});

test("a [DONE] marker is never a payload", () => {
  assert.deepEqual(run("chat", [{ kind: "done" }]), [
    { kind: "completed", stopReason: "unknown" },
  ]);
});

test("max_tokens is clamped to the capability ceiling", () => {
  assert.equal(clampMaxTokens(64_000, 32_000), 32_000);
  assert.equal(clampMaxTokens(1000, 32_000), 1000);
  assert.equal(clampMaxTokens(1000, null), 1000);
  assert.throws(() => clampMaxTokens(0, 10), RangeError);
  assert.throws(() => clampMaxTokens(10, -1), RangeError);
});
