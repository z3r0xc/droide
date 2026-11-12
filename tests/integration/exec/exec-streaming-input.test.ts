import assert from "node:assert/strict";
import { test } from "node:test";

import { STREAM_INTERRUPTED } from "../../../src/exec/streaming.ts";
import {
  execArgs,
  parseStream,
  runCli,
  spawnCli,
  withHarness,
  type MockResponse,
} from "./harness.ts";

/** One scripted assistant answer; the mock reuses it for every message. */
const DONE_SCRIPT: readonly MockResponse[] = [
  {
    kind: "sse",
    chunks: [
      { choices: [{ delta: { content: "Done." } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    ],
  },
];

const DEPRECATION =
  /Warning: --input-format stream-json is deprecated\. Use --input-format stream-jsonrpc for daemon-compatible JSON-RPC protocol\./;

function userLine(text: string): string {
  return `${JSON.stringify({ role: "user", content: text })}\n`;
}

test(
  "three piped messages produce one init and user/answer/completion per message",
  { timeout: 60_000 },
  async () => {
    await withHarness(DONE_SCRIPT, async ({ directory, settingsPath }) => {
      const child = spawnCli(
        directory,
        execArgs(settingsPath, [
          "-o",
          "stream-json",
          "--input-format",
          "stream-json",
          "-m",
          "custom:mock",
        ]),
      );
      child.write(userLine("one"));
      child.write(
        `${JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "two" }],
        })}\n`,
      );
      child.write("\n");
      child.write(userLine("three"));
      child.end();

      const result = await child.done;
      assert.equal(result.code, 0);
      assert.match(result.stderr, DEPRECATION);
      // The deprecation warning is the only diagnostic on a healthy stream.
      assert.equal(result.stderr.trim().split("\n").length, 1);

      const records = parseStream(result.stdout);
      assert.deepEqual(
        records.map(
          (record) =>
            `${String(record["type"])}:${String(record["role"] ?? record["subtype"] ?? "")}`,
        ),
        [
          "system:init",
          "message:user",
          "message:assistant",
          "completion:",
          "message:user",
          "message:assistant",
          "completion:",
          "message:user",
          "message:assistant",
          "completion:",
        ],
      );

      const init = records[0];
      assert.ok(init !== undefined);
      const sessionId = init["session_id"];
      assert.equal(typeof sessionId, "string");
      assert.notEqual(sessionId, "");
      for (const record of records) {
        assert.equal(record["session_id"], sessionId);
      }

      const users = records.filter((record) => record["role"] === "user");
      assert.deepEqual(
        users.map((record) => record["text"]),
        ["one", "two", "three"],
      );

      const completions = records.filter(
        (record) => record["type"] === "completion",
      );
      assert.deepEqual(
        completions.map((record) => record["numTurns"]),
        [1, 2, 3],
      );
      for (const completion of completions) {
        assert.equal(completion["finalText"], "Done.");
      }
    });
  },
);

test(
  "a malformed or non-user line yields one error record and the stream continues",
  { timeout: 60_000 },
  async () => {
    await withHarness(DONE_SCRIPT, async ({ directory, settingsPath }) => {
      const child = spawnCli(
        directory,
        execArgs(settingsPath, [
          "-o",
          "stream-json",
          "--input-format",
          "stream-json",
          "-m",
          "custom:mock",
        ]),
      );
      child.write(userLine("first"));
      child.write("{not json\n");
      child.write(
        `${JSON.stringify({ role: "assistant", content: "nope" })}\n`,
      );
      child.write(`${JSON.stringify({ role: "user" })}\n`);
      child.write("\n");
      child.write(userLine("second"));
      child.end();

      const result = await child.done;
      assert.equal(result.code, 0);

      const records = parseStream(result.stdout);
      assert.deepEqual(
        records.map((record) => record["type"]),
        [
          "system",
          "message",
          "message",
          "completion",
          "error",
          "error",
          "error",
          "message",
          "message",
          "completion",
        ],
      );

      const errors = records.filter((record) => record["type"] === "error");
      assert.deepEqual(
        errors.map((record) => record["message"]),
        [
          "Invalid JSON",
          "Only 'user' messages are accepted via stdin.",
          "Message must contain text content",
        ],
      );
      const sessionId = records[0]?.["session_id"];
      for (const error of errors) {
        assert.equal(error["source"], "cli");
        assert.equal(error["session_id"], sessionId);
      }

      // The later message is processed normally after every failed line.
      const last = records.at(-1);
      assert.equal(last?.["type"], "completion");
      assert.equal(last?.["finalText"], "Done.");
      assert.equal(last?.["numTurns"], 2);
    });
  },
);

test(
  "stdin EOF drains the unanswered turn and exits 0",
  { timeout: 60_000 },
  async () => {
    await withHarness(DONE_SCRIPT, async ({ directory, settingsPath }) => {
      const child = spawnCli(
        directory,
        execArgs(settingsPath, [
          "-o",
          "stream-json",
          "--input-format",
          "stream-json",
          "-m",
          "custom:mock",
        ]),
      );
      child.write(userLine("only message"));
      child.end();

      const result = await child.done;
      assert.equal(result.code, 0);
      const records = parseStream(result.stdout);
      const last = records.at(-1);
      assert.equal(last?.["type"], "completion");
      assert.equal(last?.["finalText"], "Done.");
      assert.equal(last?.["numTurns"], 1);
    });
  },
);

test(
  "an empty stream creates no session and writes nothing",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-o",
            "stream-json",
            "--input-format",
            "stream-json",
            "-m",
            "custom:mock",
          ]),
        );

        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, DEPRECATION);
        assert.equal(server.requests.length, 0);
      },
    );
  },
);

test(
  "SIGINT writes one final interrupted record and exits 0",
  { timeout: 60_000, skip: process.platform === "win32" },
  async () => {
    // A provider that never answers keeps the turn alive until the signal.
    await withHarness(
      [{ kind: "hang" }],
      async ({ directory, settingsPath }) => {
        const child = spawnCli(
          directory,
          execArgs(settingsPath, [
            "-o",
            "stream-json",
            "--input-format",
            "stream-json",
            "-m",
            "custom:mock",
          ]),
        );
        const echoed = Promise.withResolvers<void>();
        child.onStdout((chunk) => {
          if (chunk.includes('"role":"user"')) echoed.resolve();
        });
        child.write(userLine("hang on"));
        await echoed.promise;
        child.signal("SIGINT");

        const result = await child.done;
        assert.equal(result.code, 0);
        const records = parseStream(result.stdout);
        const last = records.at(-1);
        assert.equal(last?.["type"], "error");
        assert.equal(last?.["message"], STREAM_INTERRUPTED);
        assert.equal(
          records.filter((record) => record["message"] === STREAM_INTERRUPTED)
            .length,
          1,
        );
      },
    );
  },
);
