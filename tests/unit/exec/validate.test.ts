import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecUsageError } from "../../../src/exec/errors.ts";
import {
  assertFilePromptConflict,
  assertInputOutputPair,
  assertNoPromptInStreamingInput,
  EXEC_OUTPUT_FORMATS,
  FILE_PROMPT_CONFLICT,
  INVALID_OUTPUT_FORMAT,
  isStreamJsonOutput,
  parseInputFormat,
  parseOutputFormat,
  STREAM_JSON_OUTPUT_REQUIRED,
  STREAM_JSONRPC_OUTPUT_REQUIRED,
  STREAMING_PROMPT_REFUSED,
} from "../../../src/exec/validate.ts";

test("output format defaults to text and accepts every documented value", () => {
  assert.equal(parseOutputFormat(undefined), "text");
  for (const format of EXEC_OUTPUT_FORMATS) {
    assert.equal(parseOutputFormat(format), format);
  }
  assert.equal(isStreamJsonOutput("debug"), true);
  assert.equal(isStreamJsonOutput("stream-json"), true);
  assert.equal(isStreamJsonOutput("json"), false);
});

test("an unknown output format is a usage error", () => {
  assert.throws(
    () => parseOutputFormat("yaml"),
    (error: unknown) =>
      error instanceof ExecUsageError && error.message === INVALID_OUTPUT_FORMAT,
  );
  assert.throws(() => parseOutputFormat(""), ExecUsageError);
});

test("input format is optional and validated", () => {
  assert.equal(parseInputFormat(undefined), undefined);
  assert.equal(parseInputFormat("stream-json"), "stream-json");
  assert.equal(parseInputFormat("stream-jsonrpc"), "stream-jsonrpc");
  assert.throws(
    () => parseInputFormat("text"),
    (error: unknown) =>
      error instanceof ExecUsageError &&
      error.message ===
        'Invalid --input-format value "text". Allowed values: stream-json, stream-jsonrpc.',
  );
});

test("--file and a positional prompt conflict", () => {
  assert.throws(
    () =>
      assertFilePromptConflict({
        promptArg: "say hi",
        file: "prompt.md",
      }),
    (error: unknown) =>
      error instanceof ExecUsageError && error.message === FILE_PROMPT_CONFLICT,
  );
  assert.doesNotThrow(() =>
    assertFilePromptConflict({ promptArg: undefined, file: "prompt.md" }),
  );
  assert.doesNotThrow(() =>
    assertFilePromptConflict({ promptArg: "say hi", file: undefined }),
  );
});

test("streaming input refuses a prompt argument or file", () => {
  for (const options of [
    { promptArg: "say hi", file: undefined },
    { promptArg: undefined, file: "prompt.md" },
  ]) {
    assert.throws(
      () => assertNoPromptInStreamingInput(options, "stream-json"),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message === STREAMING_PROMPT_REFUSED,
    );
  }
  assert.doesNotThrow(() =>
    assertNoPromptInStreamingInput(
      { promptArg: undefined, file: undefined },
      "stream-json",
    ),
  );
  assert.doesNotThrow(() =>
    assertNoPromptInStreamingInput(
      { promptArg: "say hi", file: undefined },
      undefined,
    ),
  );
});

test("streaming input formats require their matching output format", () => {
  assert.doesNotThrow(() => assertInputOutputPair("stream-json", "stream-json"));
  assert.doesNotThrow(() => assertInputOutputPair("stream-json", "debug"));
  assert.throws(
    () => assertInputOutputPair("stream-json", "json"),
    (error: unknown) =>
      error instanceof ExecUsageError &&
      error.message === STREAM_JSON_OUTPUT_REQUIRED,
  );
  assert.doesNotThrow(() =>
    assertInputOutputPair("stream-jsonrpc", "stream-jsonrpc"),
  );
  assert.throws(
    () => assertInputOutputPair("stream-jsonrpc", "stream-json"),
    (error: unknown) =>
      error instanceof ExecUsageError &&
      error.message === STREAM_JSONRPC_OUTPUT_REQUIRED,
  );
});