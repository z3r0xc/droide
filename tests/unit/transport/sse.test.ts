import assert from "node:assert/strict";
import { test } from "node:test";

import { SseProtocolError } from "../../../src/transport/errors.ts";
import {
  MAX_SSE_EVENT_BYTES,
  chunkBytes,
  parseSse,
  parseSseText,
  type SseEvent,
} from "../../../src/transport/sse.ts";

async function collect(events: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const collected: SseEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

const TWO_EVENTS = 'event: message_start\ndata: {"a":1}\n\ndata: {"b":2}\n\n';

test("two events split across one-byte chunks parse identically", async () => {
  const bytes = Buffer.from(TWO_EVENTS, "utf8");
  const events = await collect(parseSse(streamOf(chunkBytes(bytes, 1))));
  assert.deepEqual(events, [
    { kind: "data", event: "message_start", data: '{"a":1}' },
    { kind: "data", event: null, data: '{"b":2}' },
  ]);
});

test("a chunk boundary inside a UTF-8 sequence is not observable", async () => {
  const bytes = Buffer.from('data: "héllo ✓"\n\n', "utf8");
  const events = await collect(parseSse(streamOf(chunkBytes(bytes, 1))));
  assert.deepEqual(events, [
    { kind: "data", event: null, data: '"héllo ✓"' },
  ]);
});

test("event names and comments are read but comments never become payloads", async () => {
  const text = [
    ": keep-alive",
    "event: ping",
    "id: 7",
    "retry: 1000",
    'data: {"x":1}',
    "",
    ": another comment",
    "data: next",
    "",
  ].join("\n");
  const events = await collect(parseSseText(text));
  assert.deepEqual(events, [
    { kind: "data", event: "ping", data: '{"x":1}' },
    { kind: "data", event: null, data: "next" },
  ]);
});

test("multi-line data is joined with a newline and one leading space stripped", async () => {
  const events = await collect(parseSseText("data: one\ndata:two\ndata:  three\n\n"));
  assert.deepEqual(events, [{ kind: "data", event: null, data: "one\ntwo\n three" }]);
});

test("CRLF framing is tolerated", async () => {
  const events = await collect(
    parseSseText("event: delta\r\ndata: a\r\n\r\ndata: b\r\n\r\n"),
  );
  assert.deepEqual(events, [
    { kind: "data", event: "delta", data: "a" },
    { kind: "data", event: null, data: "b" },
  ]);
});

test("[DONE] is a terminal marker, not a payload", async () => {
  const events = await collect(parseSseText("data: [DONE]\n\n"));
  assert.deepEqual(events, [{ kind: "done" }]);
});

test("an event without data is discarded", async () => {
  const events = await collect(parseSseText("event: ping\n\n"));
  assert.deepEqual(events, []);
});

test("a clean end at an event boundary completes", async () => {
  const events = await collect(parseSseText(TWO_EVENTS));
  assert.equal(events.length, 2);
});

test("a body ending inside an event is a truncation error", async () => {
  await assert.rejects(
    collect(parseSseText('data: {"a":1}\n')),
    (error: unknown) =>
      error instanceof SseProtocolError && error.failure === "truncated",
  );
});

test("a body ending inside a line is a truncation error", async () => {
  await assert.rejects(
    collect(parseSseText('data: {"a":1}')),
    (error: unknown) =>
      error instanceof SseProtocolError && error.failure === "truncated",
  );
});

test("an oversized event fails with the documented bound", async () => {
  await assert.rejects(
    collect(parseSseText(`data: ${"x".repeat(64)}\n\n`, { maxEventBytes: 16 })),
    (error: unknown) =>
      error instanceof SseProtocolError && error.failure === "oversized",
  );
  assert.equal(MAX_SSE_EVENT_BYTES, 1 << 20);
});

test("a single line over the bound fails before it is buffered whole", async () => {
  await assert.rejects(
    collect(parseSseText("data: " + "x".repeat(64), { maxEventBytes: 16 })),
    (error: unknown) =>
      error instanceof SseProtocolError && error.failure === "oversized",
  );
});

test("aborting propagates the reason and releases the reader lock", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("data: first\n\n", "utf8"));
      // The second read never resolves on its own; cancellation releases it.
    },
  });
  const controller = new AbortController();
  const reason = new Error("test abort");
  const iterator = parseSse(stream, { signal: controller.signal });

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(stream.locked, true);

  controller.abort(reason);
  await assert.rejects(iterator.next(), (error: unknown) => error === reason);
  assert.equal(stream.locked, false);
});