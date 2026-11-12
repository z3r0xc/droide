import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { AUTHENTICATION_REQUIRED } from "../../../src/exec/command.ts";
import {
  execArgs,
  recordOf,
  runCli,
  withHarness,
  type MockResponse,
} from "./harness.ts";

/** `Read` requires an absolute path (30 B14), so the script is built per run. */
function toolScript(filePath: string): readonly MockResponse[] {
  return [
    {
      kind: "sse",
      chunks: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: { name: "Read", arguments: "" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: JSON.stringify({ file_path: filePath }),
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        },
      ],
    },
    {
      kind: "sse",
      chunks: [
        { choices: [{ delta: { content: "Done." } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 3 },
        },
      ],
    },
  ];
}

const DENIED_SCRIPT: readonly MockResponse[] = [
  {
    kind: "sse",
    chunks: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_denied_1",
                  type: "function",
                  function: {
                    name: "Execute",
                    arguments: '{"command":"rm -rf ./build"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ],
  },
];

const PROVIDER_ERROR_SCRIPT: readonly MockResponse[] = [
  {
    kind: "http",
    status: 500,
    body: '{"error":{"message":"mock provider exploded"}}',
  },
];

test(
  "-o text prints the final answer and one newline after a tool call",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      (directory) => toolScript(join(directory, "fixture.txt")),
      async ({ directory, settingsPath }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, ["-m", "custom:mock", "read fixture.txt"]),
        );
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "Done.\n");
        assert.equal(result.stderr, "");
      },
    );
  },
);

test(
  "-o json prints exactly one success object with the eight keys",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      (directory) => toolScript(join(directory, "fixture.txt")),
      async ({ directory, settingsPath }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-o",
            "json",
            "-m",
            "custom:mock",
            "read fixture.txt",
          ]),
        );
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.endsWith("\n"), true);
        assert.equal(result.stdout.trimEnd().includes("\n"), false);

        const record = recordOf(JSON.parse(result.stdout));
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
        assert.equal(record["type"], "result");
        assert.equal(record["subtype"], "success");
        assert.equal(record["is_error"], false);
        assert.equal(record["result"], "Done.");
        assert.equal(record["num_turns"], 2);
      },
    );
  },
);

test(
  "-o stream-json emits init, echo, tool records, the answer and one completion",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      (directory) => toolScript(join(directory, "fixture.txt")),
      async ({ directory, settingsPath }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-o",
            "stream-json",
            "-m",
            "custom:mock",
            "read fixture.txt",
          ]),
        );
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");

        const lines = result.stdout.split("\n").filter((line) => line !== "");
        const records = lines.map((line) => {
          const parsed: unknown = JSON.parse(line);
          assert.ok(typeof parsed === "object" && parsed !== null);
          return parsed as Readonly<Record<string, unknown>>;
        });
        assert.deepEqual(
          records.map((record) => record["type"]),
          [
            "system",
            "message",
            "tool_call",
            "tool_result",
            "message",
            "completion",
          ],
        );

        const init = records[0];
        assert.ok(init !== undefined);
        assert.equal(init["subtype"], "init");
        assert.equal(init["model"], "custom:mock");
        assert.ok(Array.isArray(init["tools"]));
        assert.ok((init["tools"] as readonly unknown[]).includes("Read"));
        assert.equal(typeof init["cwd"], "string");

        const echo = records[1];
        assert.ok(echo !== undefined);
        assert.equal(echo["role"], "user");
        assert.equal(echo["text"], "read fixture.txt");

        const call = records[2];
        assert.ok(call !== undefined);
        assert.equal(call["toolId"], "Read");
        assert.equal(call["toolName"], "Read");
        assert.deepEqual(call["parameters"], {
          file_path: join(directory, "fixture.txt"),
        });

        const toolResult = records[3];
        assert.ok(toolResult !== undefined);
        assert.equal(toolResult["id"], call["id"]);
        // The result lives in the tool-role message, a different id from the
        // assistant message that asked for the call (B25/B30).
        assert.equal(typeof toolResult["messageId"], "string");
        assert.notEqual(toolResult["messageId"], call["messageId"]);
        assert.equal(toolResult["toolId"], "Read");
        assert.equal(toolResult["isError"], false);
        assert.match(String(toolResult["value"]), /hello fixture/);

        const answer = records[4];
        assert.ok(answer !== undefined);
        assert.equal(answer["role"], "assistant");
        assert.equal(answer["text"], "Done.");

        const completion = records[5];
        assert.ok(completion !== undefined);
        assert.equal(completion["finalText"], "Done.");
        assert.equal(completion["numTurns"], 2);
        assert.equal(typeof completion["durationMs"], "number");

        const sessionId = init["session_id"];
        assert.equal(typeof sessionId, "string");
        for (const record of records) {
          assert.equal(record["session_id"], sessionId);
        }
      },
    );
  },
);

test(
  "a provider error exits 1 with the failure prefix and no stdout",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      PROVIDER_ERROR_SCRIPT,
      async ({ directory, settingsPath }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, ["-m", "custom:mock", "say hi"]),
        );
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(
          result.stderr,
          /^Error during droide execution: LLM request failed: 500/,
        );
      },
    );
  },
);

test(
  "a denied Execute exits 1 before a second model request",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DENIED_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "--auto",
            "low",
            "-m",
            "custom:mock",
            "delete it",
          ]),
        );
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.match(
          result.stderr,
          /^Error during droide execution: Exec ended early: insufficient permission to proceed\./,
        );
        assert.equal(server.requests.length, 1);
      },
    );
  },
);

test(
  "a missing managed credential prints the auth message and opens no socket",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      [],
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, ["-m", "gpt-6.1-sol", "say hi"]),
          { FACTORY_API_BASE_URL: server.url },
        );
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, `${AUTHENTICATION_REQUIRED}\n`);
        assert.equal(server.requests.length, 0);
      },
      () => ({}),
    );
  },
);
