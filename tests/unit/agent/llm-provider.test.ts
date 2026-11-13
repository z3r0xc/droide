import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTurnRequest,
  createLlmProvider,
  toLlmMessages,
} from "../../../src/agent/adapters/llm-provider.ts";
import type { Message } from "../../../src/agent/messages.ts";
import type { ProviderDelta } from "../../../src/agent/ports.ts";

const AT = 1_700_000_000_000;

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  deltas: AsyncIterable<ProviderDelta>,
): Promise<ProviderDelta[]> {
  const collected: ProviderDelta[] = [];
  for await (const delta of deltas) collected.push(delta);
  return collected;
}

test("a text-only chat stream maps to text deltas and a done marker", async () => {
  const provider = createLlmProvider({
    url: new URL("https://api.example.test/v1/chat/completions"),
    headers: { authorization: "Bearer test" },
    dialect: "chat",
    model: "test-model",
    system: "You are a test.",
    maxTokens: 128,
    fetch: async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });

  const deltas = await collect(
    provider.stream([], { signal: new AbortController().signal }),
  );

  assert.deepEqual(
    deltas.filter((delta) => delta.type !== "usage"),
    [
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "done" },
    ],
  );
});

test("a tool-call chat stream maps to start plus argument deltas", async () => {
  const provider = createLlmProvider({
    url: new URL("https://api.example.test/v1/chat/completions"),
    headers: {},
    dialect: "chat",
    model: "test-model",
    system: "s",
    maxTokens: 128,
    fetch: async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
  });

  const deltas = await collect(
    provider.stream([], { signal: new AbortController().signal }),
  );
  const start = deltas.find((delta) => delta.type === "tool_use_start");
  assert.deepEqual(start, {
    type: "tool_use_start",
    name: "read_file",
    slot: 0,
  });

  const args = deltas
    .filter((delta) => delta.type === "tool_use_input")
    .map((delta) => (delta.type === "tool_use_input" ? delta.json : ""));
  assert.equal(args.join(""), '{"path":"a.txt"}');
});

test("a non-2xx response throws with the status and a bounded body", async () => {
  const provider = createLlmProvider({
    url: new URL("https://api.example.test/v1/chat/completions"),
    headers: {},
    dialect: "chat",
    model: "m",
    system: "s",
    maxTokens: 1,
    fetch: async () => new Response("nope", { status: 503 }),
  });

  await assert.rejects(
    collect(provider.stream([], { signal: new AbortController().signal })),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error instanceof Error ? error.name : "", "LlmHttpError");
      assert.match(error instanceof Error ? error.message : "", /503/);
      return true;
    },
  );
});

test("tool messages become user messages carrying tool_result blocks", () => {
  const messages: Message[] = [
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "read it" }],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "a.txt" },
        },
      ],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "t1",
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "call_1", content: "hello" }],
      createdAt: AT,
      updatedAt: AT,
    },
  ];

  const converted = toLlmMessages(messages);

  assert.deepEqual(converted, [
    { role: "user", content: [{ type: "text", text: "read it" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "a.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call_1", content: "hello" }],
    },
  ]);
});

test("a tool result's image blocks become adapter media", () => {
  const messages: Message[] = [
    {
      id: "t1",
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: [
            { type: "text", text: "Read of a.png: image/png, 3 bytes" },
            {
              type: "image",
              source: {
                type: "base64",
                mediaType: "image/png",
                data: "AAAA",
              },
            },
          ],
        },
      ],
      createdAt: AT,
      updatedAt: AT,
    },
  ];

  assert.deepEqual(toLlmMessages(messages), [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: "Read of a.png: image/png, 3 bytes",
          media: [{ type: "image", mediaType: "image/png", data: "AAAA" }],
        },
      ],
    },
  ]);
});

test("consecutive user messages merge and system messages are omitted", () => {
  const messages: Message[] = [
    {
      id: "s1",
      role: "system",
      content: [{ type: "text", text: "rules" }],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "one" }],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "u2",
      role: "user",
      content: [{ type: "text", text: "two" }],
      createdAt: AT,
      updatedAt: AT,
    },
  ];

  const converted = toLlmMessages(messages);

  assert.equal(converted.length, 1);
  assert.deepEqual(converted[0]?.content, [
    { type: "text", text: "one" },
    { type: "text", text: "two" },
  ]);
});

test("the request carries the model, system prompt, tools and token ceiling", () => {
  const request = buildTurnRequest(
    {
      url: new URL("https://api.example.test/v1/chat/completions"),
      headers: {},
      dialect: "chat",
      model: "model-x",
      system: "be brief",
      tools: [
        {
          name: "read_file",
          description: "read",
          inputSchema: { type: "object" },
        },
      ],
      maxTokens: 4096,
    },
    [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  );

  assert.equal(request.model, "model-x");
  assert.equal(request.system, "be brief");
  assert.equal(request.maxTokens, 4096);
  assert.deepEqual(request.tools, [
    { name: "read_file", description: "read", inputSchema: { type: "object" } },
  ]);
});
