import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecStreamError } from "../../../src/exec/errors.ts";
import {
  createJsonLineWriter,
  isBrokenPipeError,
} from "../../../src/exec/writer.ts";
import {
  BrokenPipeStream,
  CollectingStream,
  FailingStream,
} from "./helpers.ts";

test("each write is exactly one JSON object followed by a newline", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);

  assert.equal(await writer.write({ type: "message", text: "one" }), true);
  assert.equal(await writer.write({ type: "message", text: "two" }), true);

  assert.equal(
    stream.text,
    '{"type":"message","text":"one"}\n{"type":"message","text":"two"}\n',
  );
  assert.equal(stream.lines.length, 2);
  assert.equal(writer.closed, false);
});

test("a broken pipe resolves as not accepted, never throws", async () => {
  const stream = new BrokenPipeStream();
  const writer = createJsonLineWriter(stream);

  assert.equal(await writer.write({ type: "message" }), false);
  assert.equal(writer.closed, true);

  // Later writes are skipped without serialising or touching the stream.
  assert.equal(await writer.write({ type: "completion" }), false);
});

test("a pipe that breaks after one line still reports the first write", async () => {
  let remaining = 1;
  class OnceThenBroken extends CollectingStream {
    override _write(
      chunk: unknown,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      if (remaining > 0) {
        remaining -= 1;
        super._write(chunk, encoding, callback);
        return;
      }
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    }
  }
  const stream = new OnceThenBroken();
  const writer = createJsonLineWriter(stream);

  assert.equal(await writer.write({ first: true }), true);
  assert.equal(await writer.write({ second: true }), false);
  assert.equal(writer.closed, true);
  assert.equal(stream.text, '{"first":true}\n');
});

test("a non-EPIPE write failure is an ExecStreamError", async () => {
  const writer = createJsonLineWriter(new FailingStream());
  await assert.rejects(
    writer.write({ type: "message" }),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === "stdout write failed",
  );
  assert.equal(writer.closed, false);
});

test("an unserialisable record is refused before any write", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;

  await assert.rejects(
    writer.write(circular),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === "record is not JSON-serialisable",
  );
  assert.equal(stream.text, "");

  await assert.rejects(
    writer.write(undefined),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === "record is not JSON-serialisable",
  );
});

test("a destroyed stream is treated as gone", async () => {
  const stream = new CollectingStream();
  stream.destroy();
  const writer = createJsonLineWriter(stream);

  assert.equal(await writer.write({ type: "message" }), false);
  assert.equal(writer.closed, true);
  assert.equal(stream.text, "");
});

test("only pipe-loss codes count as a broken pipe", () => {
  assert.equal(isBrokenPipeError({ code: "EPIPE" }), true);
  assert.equal(isBrokenPipeError({ code: "ERR_STREAM_DESTROYED" }), true);
  assert.equal(isBrokenPipeError({ code: "ENOSPC" }), false);
  assert.equal(isBrokenPipeError(new Error("EPIPE")), false);
  assert.equal(isBrokenPipeError(undefined), false);
});
