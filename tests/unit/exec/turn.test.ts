import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecAbortedError } from "../../../src/exec/errors.ts";
import type { JsonLineWriter } from "../../../src/exec/writer.ts";
import { createJsonLineWriter } from "../../../src/exec/writer.ts";
import { runOneShot, runOneShotSummary } from "../../../src/exec/turn.ts";
import {
  BrokenPipeStream,
  CollectingStream,
  oneShotOptions,
  scriptedRunner,
  TEST_USAGE,
} from "./helpers.ts";

const INIT =
  '{"type":"system","subtype":"init","cwd":"/work","session_id":"sid","tools":["Read","Execute"],"model":"custom:mock","reasoning_effort":"low"}';
const ECHO =
  '{"type":"message","role":"user","id":"u1","text":"read fixture.txt","timestamp":0,"session_id":"sid"}';
const COMPLETION =
  '{"type":"completion","finalText":"Done.","numTurns":2,"durationMs":0,"session_id":"sid","timestamp":0,"usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"factory_credits":0,"thinking_tokens":0}}';

test("one successful turn writes init, echo, blocks and one completion", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async (sink) => {
    await sink.assistant({
      id: "m1",
      blocks: [
        {
          kind: "tool_use",
          toolUseId: "t1",
          name: "Read",
          input: { file_path: "fixture.txt" },
        },
      ],
    });
    await sink.toolResult({
      toolUseId: "t1",
      messageId: "r1",
      isError: false,
      text: "hello fixture\n",
    });
    await sink.assistant({
      id: "m2",
      blocks: [{ kind: "text", text: "Done." }],
    });
    return {
      kind: "completed",
      finalText: "Done.",
      numTurns: 2,
      usage: TEST_USAGE,
    };
  });

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 0);
  assert.deepEqual(stream.lines, [
    INIT,
    ECHO,
    '{"type":"tool_call","id":"t1","messageId":"m1","toolId":"Read","toolName":"Read","parameters":{"file_path":"fixture.txt"},"timestamp":0,"session_id":"sid"}',
    '{"type":"tool_result","id":"t1","messageId":"r1","toolId":"Read","isError":false,"value":"hello fixture\\n","timestamp":0,"session_id":"sid"}',
    '{"type":"message","role":"assistant","id":"m2","text":"Done.","timestamp":0,"session_id":"sid"}',
    COMPLETION,
  ]);
});

test('a tool result whose call was never seen carries toolId ""', async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async (sink) => {
    await sink.toolResult({
      toolUseId: "ghost",
      messageId: "r1",
      isError: true,
      text: "unknown call",
    });
    return {
      kind: "completed",
      finalText: "",
      numTurns: 1,
      usage: TEST_USAGE,
    };
  });

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 0);
  const result = stream.lines[2];
  assert.ok(result !== undefined);
  const parsed: unknown = JSON.parse(result);
  assert.ok(
    typeof parsed === "object" && parsed !== null && "toolId" in parsed,
  );
  assert.equal(parsed.toolId, "");
});

test("an agent_loop diagnostic is written as an error record", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async (sink) => {
    await sink.agentError("provider said no");
    return {
      kind: "completed",
      finalText: "partial",
      numTurns: 1,
      usage: TEST_USAGE,
    };
  });

  await runOneShot(runner, oneShotOptions(), writer);
  const record = stream.lines[2];
  assert.ok(record !== undefined);
  assert.deepEqual(JSON.parse(record), {
    type: "error",
    source: "agent_loop",
    message: "provider said no",
    timestamp: 0,
    session_id: "sid",
  });
  assert.equal(stream.lines.length, 4);
});

test("a failed turn closes with one cli error and no completion", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => ({
    kind: "failed",
    message: "provider exploded",
  }));

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 1);
  assert.deepEqual(stream.lines, [
    INIT,
    ECHO,
    '{"type":"error","source":"cli","message":"provider exploded","timestamp":0,"session_id":"sid"}',
  ]);
});

test("a cancelled turn exits 1 with an error record", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => ({
    kind: "cancelled",
    message: "Turn cancelled",
  }));

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 1);
  assert.deepEqual(stream.lines.slice(2), [
    '{"type":"error","source":"cli","message":"Turn cancelled","timestamp":0,"session_id":"sid"}',
  ]);
});

test("a thrown error becomes a cli error record", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => {
    throw new Error("kaboom");
  });

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 1);
  assert.deepEqual(stream.lines.slice(2), [
    '{"type":"error","source":"cli","message":"kaboom","timestamp":0,"session_id":"sid"}',
  ]);
});

test("SIGINT exits 130 and adds no terminal record", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => {
    throw new ExecAbortedError("SIGINT");
  });

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 130);
  assert.deepEqual(stream.lines, [INIT, ECHO]);
});

test("a signal outranks a failed turn outcome", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const controller = new AbortController();
  controller.abort(new ExecAbortedError("SIGTERM"));
  const runner = scriptedRunner(async () => ({
    kind: "failed",
    message: "cancelled by the signal",
  }));

  assert.equal(
    await runOneShot(
      runner,
      oneShotOptions({ signal: controller.signal }),
      writer,
    ),
    143,
  );
  assert.deepEqual(stream.lines, [INIT, ECHO]);
});

test("a broken pipe exits 0 without running the turn", async () => {
  let invoked = false;
  const writer = createJsonLineWriter(new BrokenPipeStream());
  const runner = scriptedRunner(async () => {
    invoked = true;
    return {
      kind: "completed",
      finalText: "Done.",
      numTurns: 1,
      usage: TEST_USAGE,
    };
  });

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 0);
  assert.equal(invoked, false);
});

test("a pipe that closes mid-turn stops writes but keeps the result", async () => {
  let accepted = 0;
  const writer: JsonLineWriter = {
    get closed() {
      return accepted >= 2;
    },
    async write() {
      accepted += 1;
      return accepted <= 2;
    },
  };
  const runner = scriptedRunner(async (sink) => {
    await sink.assistant({
      id: "m1",
      blocks: [{ kind: "text", text: "Done." }],
    });
    return {
      kind: "completed",
      finalText: "Done.",
      numTurns: 1,
      usage: TEST_USAGE,
    };
  });

  assert.equal(await runOneShot(runner, oneShotOptions(), writer), 0);
  // init, echo, one assistant record: the rejected one is the last attempt,
  // and the completion is never attempted.
  assert.equal(accepted, 3);
});

test("-o json success is one object with the eight documented keys", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => ({
    kind: "completed",
    finalText: "Done.",
    numTurns: 2,
    usage: TEST_USAGE,
  }));

  assert.equal(await runOneShotSummary(runner, oneShotOptions(), writer), 0);
  assert.equal(stream.lines.length, 1);
  const line = stream.lines[0];
  assert.ok(line !== undefined);
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.deepEqual(Object.keys(parsed), [
    "type",
    "subtype",
    "is_error",
    "duration_ms",
    "num_turns",
    "result",
    "session_id",
    "usage",
  ]);
  assert.deepEqual(parsed, {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 0,
    num_turns: 2,
    result: "Done.",
    session_id: "sid",
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      factory_credits: 0,
      thinking_tokens: 0,
    },
  });
});

test("-o json failure is one object with subtype failure and zero turns", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => ({
    kind: "failed",
    message: "provider exploded",
  }));

  assert.equal(await runOneShotSummary(runner, oneShotOptions(), writer), 1);
  assert.equal(stream.lines.length, 1);
  const line = stream.lines[0];
  assert.ok(line !== undefined);
  assert.deepEqual(JSON.parse(line), {
    type: "result",
    subtype: "failure",
    is_error: true,
    duration_ms: 0,
    num_turns: 0,
    result: "provider exploded",
    session_id: "sid",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      factory_credits: 0,
      thinking_tokens: 0,
    },
  });
});

test("-o json does not write after a signal", async () => {
  const stream = new CollectingStream();
  const writer = createJsonLineWriter(stream);
  const runner = scriptedRunner(async () => {
    throw new ExecAbortedError("SIGINT");
  });

  assert.equal(await runOneShotSummary(runner, oneShotOptions(), writer), 130);
  assert.equal(stream.text, "");
});
