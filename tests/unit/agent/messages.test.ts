import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MEDIA_CAPS,
  isSendableToProvider,
  isVisibleToUser,
  limitMedia,
  toolCallId,
  type ContentBlock,
  type ImageBlock,
  type Message,
} from "../../../src/agent/messages.ts";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function image(data: string): ImageBlock {
  return {
    type: "image",
    source: { type: "base64", mediaType: "image/png", data },
  };
}

test("tool call ids are deterministic and shaped call_<16 hex>_<slot>", () => {
  const first = toolCallId("msg_abc", 0);
  const again = toolCallId("msg_abc", 0);
  assert.equal(first, again);
  assert.match(first, /^call_[0-9a-f]{16}_0$/);
  assert.equal(toolCallId("msg_abc", 3), `call_${first.slice(5, 21)}_3`);
});

test("different messages and slots produce different tool call ids", () => {
  assert.notEqual(toolCallId("msg_a", 0), toolCallId("msg_b", 0));
  assert.notEqual(toolCallId("msg_a", 0), toolCallId("msg_a", 1));
});

test("a negative or fractional slot is refused", () => {
  assert.throws(() => toolCallId("msg_a", -1), RangeError);
  assert.throws(() => toolCallId("msg_a", 1.5), RangeError);
});

test("user_only messages are never sent to a provider", () => {
  assert.equal(
    isSendableToProvider(message({ visibility: "user_only" })),
    false,
  );
  assert.equal(isSendableToProvider(message({ visibility: "llm_only" })), true);
  assert.equal(isSendableToProvider(message()), true);
});

test("llm_only messages are never shown to the user", () => {
  assert.equal(isVisibleToUser(message({ visibility: "llm_only" })), false);
  assert.equal(isVisibleToUser(message({ visibility: "user_only" })), true);
  assert.equal(isVisibleToUser(message({ visibility: "both" })), true);
});

test("media limits keep the newest images and count what was dropped", () => {
  const messages = [
    message({
      id: "m1",
      content: [image("oldest"), { type: "text", text: "one" }],
    }),
    message({ id: "m2", content: [image("middle")] }),
    message({
      id: "m3",
      content: [image("newest"), { type: "text", text: "three" }],
    }),
  ];

  const limited = limitMedia(messages, { images: 2, documents: 5 });
  assert.equal(limited.droppedImages, 1);
  assert.equal(limited.droppedDocuments, 0);

  const kept = limited.messages.flatMap((entry) =>
    entry.content
      .filter((block): block is ImageBlock => block.type === "image")
      .map((block) => block.source.data),
  );
  assert.deepEqual(kept, ["middle", "newest"]);
});

test("media nested inside a tool result counts towards the caps", () => {
  const nested: ContentBlock = {
    type: "tool_result",
    toolUseId: "call_x_0",
    content: [image("nested"), { type: "text", text: "ok" }],
  };
  const messages = [
    message({ id: "m1", content: [nested] }),
    message({ id: "m2", content: [image("new")] }),
  ];

  const limited = limitMedia(messages, { images: 1, documents: 5 });
  assert.equal(limited.droppedImages, 1);
  const firstBlock = limited.messages[0]?.content[0];
  assert.equal(firstBlock?.type, "tool_result");
  assert.deepEqual(
    firstBlock?.type === "tool_result" ? firstBlock.content : null,
    [{ type: "text", text: "ok" }],
  );
});

test("documents are capped independently of images", () => {
  const pdf = (data: string): ContentBlock => ({
    type: "document",
    source: { type: "base64", mediaType: "application/pdf", data },
  });
  const messages = [
    message({ id: "m1", content: [image("i1"), pdf("p1")] }),
    message({ id: "m2", content: [pdf("p2")] }),
  ];

  const limited = limitMedia(messages, { images: 1, documents: 1 });
  assert.equal(limited.droppedImages, 0);
  assert.equal(limited.droppedDocuments, 1);
  // The newest document survives; the older message keeps only its image.
  assert.deepEqual(
    limited.messages.map((entry) => entry.content.map((block) => block.type)),
    [["image"], ["document"]],
  );
});

test("limiting does not mutate the input and is idempotent", () => {
  const original = [message({ id: "m1", content: [image("a"), image("b")] })];
  const first = limitMedia(original, { images: 1, documents: 0 });
  const second = limitMedia(first.messages, { images: 1, documents: 0 });

  assert.equal(original[0]?.content.length, 2);
  assert.equal(first.droppedImages, 1);
  assert.equal(second.droppedImages, 0);
  assert.deepEqual(
    second.messages[0]?.content.map((block) => block.type),
    ["image"],
  );
});

test("default caps are the documented ten images and five documents", () => {
  assert.deepEqual(DEFAULT_MEDIA_CAPS, { images: 10, documents: 5 });
});
