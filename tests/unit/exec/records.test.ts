import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecStreamError } from "../../../src/exec/errors.ts";
import {
  buildAssistantRecords,
  buildCompletionRecord,
  buildErrorRecord,
  buildFailureSummaryRecord,
  buildMessageRecord,
  buildReasoningRecord,
  buildSummaryRecord,
  buildSystemInitRecord,
  buildToolCallRecord,
  buildToolResultRecord,
  buildUserEchoRecords,
  parseStreamInputLine,
  STREAM_INPUT_JSON_ERROR,
  STREAM_INPUT_ROLE_ERROR,
  STREAM_INPUT_TEXT_ERROR,
  SYSTEM_REMINDER_START,
  ZERO_USAGE,
  type ExecUsage,
} from "../../../src/exec/records.ts";

const USAGE: ExecUsage = {
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 1,
  cache_creation_input_tokens: 2,
  droide_credits: 3,
  thinking_tokens: 4,
};

test("system/init record keeps the documented key order", () => {
  const record = buildSystemInitRecord({
    cwd: "/work",
    sessionId: "sid",
    tools: ["Read", "Execute"],
    model: "custom:mock",
    reasoningEffort: "low",
  });
  assert.equal(
    JSON.stringify(record),
    '{"type":"system","subtype":"init","cwd":"/work","session_id":"sid","tools":["Read","Execute"],"model":"custom:mock","reasoning_effort":"low"}',
  );
});

test("message and reasoning records use snake_case session_id", () => {
  const message = buildMessageRecord({
    role: "assistant",
    id: "m1",
    text: "Done.",
    timestamp: 5,
    sessionId: "sid",
  });
  assert.equal(
    JSON.stringify(message),
    '{"type":"message","role":"assistant","id":"m1","text":"Done.","timestamp":5,"session_id":"sid"}',
  );

  const reasoning = buildReasoningRecord({
    id: "m1",
    text: "thinking",
    timestamp: 5,
    sessionId: "sid",
  });
  assert.equal(
    JSON.stringify(reasoning),
    '{"type":"reasoning","id":"m1","text":"thinking","timestamp":5,"session_id":"sid"}',
  );
});

test("tool_call mirrors the model-facing name into toolId and toolName", () => {
  const record = buildToolCallRecord({
    id: "t1",
    messageId: "m1",
    toolId: "Read",
    parameters: { file_path: "fixture.txt" },
    timestamp: 5,
    sessionId: "sid",
  });
  assert.equal(
    JSON.stringify(record),
    '{"type":"tool_call","id":"t1","messageId":"m1","toolId":"Read","toolName":"Read","parameters":{"file_path":"fixture.txt"},"timestamp":5,"session_id":"sid"}',
  );
});

test("a successful tool_result carries value and omits error", () => {
  const record = buildToolResultRecord({
    id: "t1",
    messageId: "m1",
    toolId: "Read",
    isError: false,
    text: "hello fixture\n",
    timestamp: 5,
    sessionId: "sid",
  });
  assert.equal(
    JSON.stringify(record),
    '{"type":"tool_result","id":"t1","messageId":"m1","toolId":"Read","isError":false,"value":"hello fixture\\n","timestamp":5,"session_id":"sid"}',
  );
  assert.equal("error" in record, false);
});

test("a failed tool_result carries the tool_error and omits value", () => {
  const record = buildToolResultRecord({
    id: "t1",
    messageId: "m1",
    toolId: "Read",
    isError: true,
    text: "no such file",
    timestamp: 5,
    sessionId: "sid",
  });
  assert.equal(
    JSON.stringify(record),
    '{"type":"tool_result","id":"t1","messageId":"m1","toolId":"Read","isError":true,"error":{"type":"tool_error","message":"no such file"},"timestamp":5,"session_id":"sid"}',
  );
  assert.equal("value" in record, false);
});

test("error and completion records keep their documented keys", () => {
  const error = buildErrorRecord({
    source: "cli",
    message: "boom",
    timestamp: 9,
    sessionId: "sid",
  });
  assert.equal(
    JSON.stringify(error),
    '{"type":"error","source":"cli","message":"boom","timestamp":9,"session_id":"sid"}',
  );

  const completion = buildCompletionRecord({
    finalText: "Done.",
    numTurns: 2,
    durationMs: 30,
    sessionId: "sid",
    timestamp: 9,
    usage: USAGE,
  });
  assert.equal(
    JSON.stringify(completion),
    '{"type":"completion","finalText":"Done.","numTurns":2,"durationMs":30,"session_id":"sid","timestamp":9,"usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":1,"cache_creation_input_tokens":2,"droide_credits":3,"thinking_tokens":4}}',
  );
});

test("ttft_ms is the only optional usage counter and comes last", () => {
  const record = buildCompletionRecord({
    finalText: "",
    numTurns: 1,
    durationMs: 0,
    sessionId: "sid",
    timestamp: 0,
    usage: { ...USAGE, ttft_ms: 12 },
  });
  assert.equal(
    JSON.stringify(record.usage),
    '{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":1,"cache_creation_input_tokens":2,"droide_credits":3,"thinking_tokens":4,"ttft_ms":12}',
  );
});

test("the json summary has exactly eight keys in order", () => {
  const record = buildSummaryRecord({
    isError: false,
    durationMs: 10,
    numTurns: 2,
    result: "Done.",
    sessionId: "sid",
    usage: USAGE,
  });
  assert.deepEqual(Object.keys(record), [
    "type",
    "subtype",
    "is_error",
    "duration_ms",
    "num_turns",
    "result",
    "session_id",
    "usage",
  ]);
  assert.equal(record.type, "result");
  assert.equal(record.subtype, "success");
  assert.equal(record.is_error, false);
  assert.equal(record.session_id, "sid");
  assert.deepEqual(Object.keys(record.usage), [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "droide_credits",
    "thinking_tokens",
  ]);
});

test("a failure summary reports zero turns and zero counters", () => {
  const record = buildFailureSummaryRecord({
    durationMs: 5,
    result: "provider exploded",
    sessionId: "sid",
  });
  assert.equal(record.subtype, "failure");
  assert.equal(record.is_error, true);
  assert.equal(record.num_turns, 0);
  assert.equal(record.result, "provider exploded");
  assert.equal(record.duration_ms, 5);
  assert.deepEqual(record.usage, ZERO_USAGE);
});

test("assistant blocks expand in transcript order with one timestamp", () => {
  const records = buildAssistantRecords(
    {
      id: "m1",
      reasoningContent: "provider reasoning",
      blocks: [
        { kind: "thinking", text: "thinking text" },
        { kind: "thinking", text: "progress note", progressUpdate: true },
        { kind: "thinking", text: "   " },
        { kind: "text", text: "visible answer" },
        { kind: "text", text: "\n\t" },
        {
          kind: "tool_use",
          toolUseId: "t1",
          name: "Read",
          input: { file_path: "fixture.txt" },
        },
      ],
    },
    "sid",
    77,
  );

  assert.deepEqual(
    records.map((record) => record.type),
    ["reasoning", "reasoning", "message", "message", "tool_call"],
  );
  assert.deepEqual(
    records.map((record) => ("role" in record ? record.role : undefined)),
    [undefined, undefined, "assistant", "assistant", undefined],
  );
  const texts = records.map((record) =>
    record.type === "message" || record.type === "reasoning" ? record.text : "",
  );
  assert.deepEqual(texts, [
    "provider reasoning",
    "thinking text",
    "progress note",
    "visible answer",
    "",
  ]);
  for (const record of records) {
    if (record.type === "system") continue;
    assert.equal(record.timestamp, 77);
    if (record.type === "tool_call") assert.equal(record.messageId, "m1");
    else if (record.type !== "completion" && record.type !== "error")
      assert.equal(record.id, "m1");
  }
});

test("the user echo is trimmed and skips system-reminder content", () => {
  const echoed = buildUserEchoRecords({
    id: "u1",
    text: "  read fixture.txt \n",
    timestamp: 3,
    sessionId: "sid",
  });
  assert.equal(echoed.length, 1);
  assert.equal(
    JSON.stringify(echoed[0]),
    '{"type":"message","role":"user","id":"u1","text":"read fixture.txt","timestamp":3,"session_id":"sid"}',
  );

  assert.deepEqual(
    buildUserEchoRecords({
      id: "u2",
      text: `${SYSTEM_REMINDER_START}\ninternal`,
      timestamp: 3,
      sessionId: "sid",
    }),
    [],
  );
  assert.deepEqual(
    buildUserEchoRecords({
      id: "u3",
      text: " \n ",
      timestamp: 3,
      sessionId: "sid",
    }),
    [],
  );
});

test("stream input accepts a string prompt and the first text block", () => {
  assert.deepEqual(parseStreamInputLine('{"role":"user","content":"one"}'), {
    prompt: "one",
  });
  assert.deepEqual(
    parseStreamInputLine(
      '{"role":"user","content":[{"type":"image"},{"type":"text","text":"two"}]}',
    ),
    { prompt: "two" },
  );
});

test("stream input ignores blank lines", () => {
  assert.equal(parseStreamInputLine(""), undefined);
  assert.equal(parseStreamInputLine("   "), undefined);
});

test("stream input refuses malformed and non-user lines with the documented text", () => {
  assert.throws(
    () => parseStreamInputLine("not json"),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === STREAM_INPUT_JSON_ERROR,
  );
  assert.throws(
    () => parseStreamInputLine("[]"),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === STREAM_INPUT_JSON_ERROR,
  );
  assert.throws(
    () => parseStreamInputLine('{"role":"assistant","content":"one"}'),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === STREAM_INPUT_ROLE_ERROR,
  );
  assert.throws(
    () =>
      parseStreamInputLine(
        '{"role":"user","content":[{"type":"image","source":{}}]}',
      ),
    (error: unknown) =>
      error instanceof ExecStreamError &&
      error.message === STREAM_INPUT_TEXT_ERROR,
  );
});
