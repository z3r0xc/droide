import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runOneShot, runOneShotSummary } from "../../../src/exec/turn.ts";
import { createJsonLineWriter } from "../../../src/exec/writer.ts";
import { oneShotOptions, scriptedRunner, TEST_USAGE } from "../../unit/exec/helpers.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PURITY_FIXTURE = resolve(import.meta.dirname, "fixture-purity.ts");
const FLOOD_FIXTURE = resolve(import.meta.dirname, "fixture-flood.ts");

/** Windows cannot start a child without its system directory. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {
    NO_COLOR: "1",
    TERM: "dumb",
    COLUMNS: "80",
    TZ: "UTC",
  };
  for (const name of ["SYSTEMROOT", "windir", "PATH", "Path"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const PURITY_STDOUT =
  [
    '{"type":"system","subtype":"init","cwd":"/work","session_id":"sid","tools":["Read"],"model":"custom:mock","reasoning_effort":"low"}',
    '{"type":"message","role":"user","id":"u1","text":"read fixture.txt","timestamp":0,"session_id":"sid"}',
    '{"type":"tool_call","id":"t1","messageId":"m1","toolId":"Read","toolName":"Read","parameters":{"file_path":"fixture.txt"},"timestamp":0,"session_id":"sid"}',
    '{"type":"tool_result","id":"t1","messageId":"r1","toolId":"Read","isError":false,"value":"hello fixture\\n","timestamp":0,"session_id":"sid"}',
    '{"type":"message","role":"assistant","id":"m2","text":"Done.","timestamp":0,"session_id":"sid"}',
    '{"type":"completion","finalText":"Done.","numTurns":2,"durationMs":0,"session_id":"sid","timestamp":0,"usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"factory_credits":0,"thinking_tokens":0}}',
  ].join("\n") + "\n";

test("a real process puts records and nothing else on stdout", () => {
  const result = spawnSync(process.execPath, [PURITY_FIXTURE], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: childEnv(),
    input: "",
    timeout: 60_000,
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, PURITY_STDOUT);
  assert.equal(result.stderr, "");
});

test(
  "a downstream that drops the pipe does not fail the run",
  { timeout: 60_000 },
  async () => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [FLOOD_FIXTURE], {
        cwd: REPO_ROOT,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderrChunks: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.stdout.once("data", () => child.stdout.destroy());
      child.on("error", rejectPromise);
      child.on("close", (code, signal) => {
        try {
          assert.equal(signal, null);
          assert.equal(code, 0);
          assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "");
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
  },
);

test("the writer flushes a real file as JSON lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-exec-"));
  try {
    const path = join(directory, "stream.jsonl");
    const stream = createWriteStream(path);
    const writer = createJsonLineWriter(stream);
    const runner = scriptedRunner(async (sink) => {
      await sink.assistant({ id: "m1", blocks: [{ kind: "text", text: "Done." }] });
      return {
        kind: "completed",
        finalText: "Done.",
        numTurns: 1,
        usage: TEST_USAGE,
      };
    });

    assert.equal(await runOneShot(runner, oneShotOptions(), writer), 0);
    const finished = Promise.withResolvers<void>();
    stream.end(() => finished.resolve());
    await finished.promise;

    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 4);
    assert.equal(text, `${lines.join("\n")}\n`);
    assert.deepEqual(
      lines.map((line) => {
        const parsed: unknown = JSON.parse(line);
        assert.ok(typeof parsed === "object" && parsed !== null && "type" in parsed);
        return parsed.type;
      }),
      ["system", "message", "message", "completion"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the json summary flushes one object to a real file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droid-exec-"));
  try {
    const path = join(directory, "summary.jsonl");
    const stream = createWriteStream(path);
    const writer = createJsonLineWriter(stream);
    const runner = scriptedRunner(async () => ({
      kind: "completed",
      finalText: "hi",
      numTurns: 1,
      usage: TEST_USAGE,
    }));

    assert.equal(await runOneShotSummary(runner, oneShotOptions(), writer), 0);
    const finished = Promise.withResolvers<void>();
    stream.end(() => finished.resolve());
    await finished.promise;

    const text = await readFile(path, "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 1);
    const parsed: unknown = JSON.parse(text);
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
      num_turns: 1,
      result: "hi",
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});