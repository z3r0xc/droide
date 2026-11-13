/**
 * The server-sent-events parser an `sse` MCP server's inbound stream uses.
 * Contract: `specs/60-extensions-mcp-and-skills.md` B72 (the `GET` frame
 * grammar, the 4 MiB frame ceiling, and a truncated stream delivering nothing).
 *
 * The parser is pure: every case feeds decoded chunks and inspects the frames
 * that completed, so no socket and no clock is involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { McpProtocolError } from "../../../src/extensions/mcp/errors.ts";
import { McpSseParser } from "../../../src/extensions/mcp/transport.ts";

function parser(maxFrameBytes = 1024): McpSseParser {
  return new McpSseParser({ server: "unit", maxFrameBytes });
}

test("multi-line data is joined with newlines and dispatches once", () => {
  const events = parser().push(
    'event: message\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/tools/list_changed"}\n\n',
  );
  assert.deepEqual(events, [
    {
      type: "message",
      data: '{"jsonrpc":"2.0",\n"method":"notifications/tools/list_changed"}',
      id: undefined,
    },
  ]);
});

test("a frame dispatches only when its blank line arrives", () => {
  const subject = parser();
  assert.deepEqual(subject.push("data: first\n"), [], "the line is buffered");
  assert.deepEqual(subject.push("data: second\n"), []);
  const events = subject.push("\n");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, "first\nsecond");
});

test("a comment carries nothing, and a comment-only block dispatches nothing", () => {
  const subject = parser();
  assert.deepEqual(subject.push(": keepalive\n\n"), []);
  const events = subject.push(": another\ndata: kept\n: inline\n\n");
  assert.deepEqual(events, [{ type: "message", data: "kept", id: undefined }]);
});

test("an event type other than message is reported with its type", () => {
  const events = parser().push("event: ping\ndata: {}\n\n");
  assert.deepEqual(events, [{ type: "ping", data: "{}", id: undefined }]);
});

test("unknown fields and retry values are ignored", () => {
  const events = parser().push("retry: 5000\nunknown: x\ndata: kept\n\n");
  assert.deepEqual(events, [{ type: "message", data: "kept", id: undefined }]);
});

test("an id is remembered and applies to later frames that omit it", () => {
  const subject = parser();
  const [first] = subject.push("id: 7\ndata: one\n\n");
  assert.equal(first?.id, "7");
  assert.equal(subject.lastEventId, "7");
  const [second] = subject.push("data: two\n\n");
  assert.equal(second?.id, "7", "the resume id carries over");
});

test("line endings of CRLF, CR and a chunk split mid-CRLF all dispatch once", () => {
  const subject = parser();
  assert.deepEqual(
    subject.push("data: one\r"),
    [],
    "a lone CR may be half a CRLF",
  );
  assert.deepEqual(subject.push("\n\r\ndata: two\rdata: three\r"), [
    { type: "message", data: "one", id: undefined },
  ]);
  assert.deepEqual(subject.push("\r\r"), [
    { type: "message", data: "two\nthree", id: undefined },
  ]);
});

test("a truncated stream dispatches nothing", () => {
  const subject = parser();
  assert.deepEqual(subject.push("data: never finished\n"), []);
  subject.end();
  assert.deepEqual(subject.push("\n"), []);
  assert.equal(subject.lastEventId, undefined);
});

test("an oversized frame is refused before it is delivered", () => {
  const subject = parser(16);
  assert.deepEqual(subject.push("data: 0123456789ab\n"), []);
  assert.throws(
    () => subject.push("data: 0123456789cd\n\n"),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      /over the 16-byte cap/.test(error.message),
  );
});

test("a single line over the cap is refused without a frame terminator", () => {
  const subject = parser(16);
  assert.throws(
    () => subject.push(`data: ${"x".repeat(32)}`),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      /over the 16-byte cap/.test(error.message),
  );
});
