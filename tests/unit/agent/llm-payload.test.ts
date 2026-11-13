import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encodeAnthropicRequest,
  encodeChatRequest,
  encodeRequest,
} from "../../../src/agent/adapters/llm-payload.ts";
import type { LlmMessage } from "../../../src/transport/llm.ts";

const options = {
  model: "model-x",
  system: "be brief",
  tools: [
    {
      name: "read_file",
      description: "read a file",
      inputSchema: { type: "object" },
    },
  ],
  maxTokens: 1024,
} as const;

const conversation: LlmMessage[] = [
  { role: "user", content: [{ type: "text", text: "read a.txt" }] },
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
];

test("the anthropic body streams, clamps tokens and keeps tools in input_schema", () => {
  const body = encodeAnthropicRequest(options, conversation);

  assert.equal(body["model"], "model-x");
  assert.equal(body["system"], "be brief");
  assert.equal(body["max_tokens"], 1024);
  assert.equal(body["stream"], true);
  assert.deepEqual(body["tools"], [
    {
      name: "read_file",
      description: "read a file",
      input_schema: { type: "object" },
    },
  ]);

  const messages = body["messages"] as Array<{
    role: string;
    content: unknown[];
  }>;
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  assert.deepEqual(messages[1]?.content, [
    {
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "a.txt" },
    },
  ]);
  assert.deepEqual(messages[2]?.content, [
    { type: "tool_result", tool_use_id: "call_1", content: "hello" },
  ]);
});

test("the anthropic body omits an empty tool list", () => {
  const body = encodeAnthropicRequest({ ...options, tools: [] }, conversation);
  assert.equal("tools" in body, false);
});

test("tool errors are marked with is_error", () => {
  const body = encodeAnthropicRequest(options, [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_9",
          content: "boom",
          isError: true,
        },
      ],
    },
  ]);
  const messages = body["messages"] as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.equal(messages[0]?.content[0]?.["is_error"], true);
});

test("the chat body puts the system prompt first and streams with usage", () => {
  const body = encodeChatRequest(options, conversation);

  assert.equal(body["stream"], true);
  assert.deepEqual(body["stream_options"], { include_usage: true });
  assert.equal(body["max_tokens"], 1024);
  assert.deepEqual(body["tools"], [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "read a file",
        parameters: { type: "object" },
      },
    },
  ]);

  const messages = body["messages"] as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], { role: "system", content: "be brief" });
  assert.equal(messages[1]?.["role"], "user");
  assert.equal(messages[2]?.["role"], "assistant");
  const calls = messages[2]?.["tool_calls"] as Array<Record<string, unknown>>;
  assert.deepEqual(calls[0], {
    id: "call_1",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"a.txt"}' },
  });
  assert.deepEqual(messages[3], {
    role: "tool",
    tool_call_id: "call_1",
    content: "hello",
  });
});

test("images become data URLs in the chat dialect", () => {
  const body = encodeChatRequest(options, [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ],
    },
  ]);
  const messages = body["messages"] as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  const parts = messages[1]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(parts[0], { type: "text", text: "look" });
  assert.deepEqual(parts[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  });
});

test("an anthropic tool result carries its image block in the content array", () => {
  const body = encodeAnthropicRequest(options, [
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
  const messages = body["messages"] as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(messages[0]?.content[0], {
    type: "tool_result",
    tool_use_id: "call_1",
    content: [
      { type: "text", text: "Read of a.png: image/png, 3 bytes" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ],
  });
});

test("a chat tool result keeps the text summary and drops the image", () => {
  const body = encodeChatRequest(options, [
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
  const messages = body["messages"] as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1], {
    role: "tool",
    tool_call_id: "call_1",
    content: "Read of a.png: image/png, 3 bytes",
  });
});

test("encodeRequest routes by dialect", () => {
  const anthropic = encodeRequest("anthropic", options, conversation);
  assert.equal("system" in anthropic, true);
  const chat = encodeRequest("chat", options, conversation);
  assert.equal("stream_options" in chat, true);
  const responses = encodeRequest("responses", options, conversation);
  assert.equal(responses["model"], "model-x");
});
