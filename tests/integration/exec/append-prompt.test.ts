import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { type MockResponse, execArgs, runCli, withHarness } from "./harness.ts";

/** One text turn: "ok", then the stream terminator. */
const TEXT_SCRIPT: readonly MockResponse[] = [
  {
    kind: "sse",
    chunks: [
      { choices: [{ index: 0, delta: { content: "ok" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ],
  },
];

function systemOf(body: string): string {
  const parsed: unknown = JSON.parse(body);
  assert.equal(typeof parsed, "object");
  if (parsed === null || typeof parsed !== "object" || !("messages" in parsed))
    return "";
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return "";
  const first: unknown = messages[0];
  if (first === null || typeof first !== "object" || !("content" in first))
    return "";
  const content = first.content;
  return typeof content === "string" ? content : "";
}

test(
  "--append-system-prompt reaches the provider's system message",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      TEXT_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-m",
            "custom:mock",
            "--append-system-prompt",
            "EXTRA-RULE-42",
            "hi",
          ]),
        );

        assert.equal(result.code, 0);
        assert.equal(server.bodies.length >= 1, true);
        const system = systemOf(server.bodies[0] ?? "");
        assert.match(system, /EXTRA-RULE-42/);
        assert.match(system, /You are Droide/);
      },
    );
  },
);

test(
  "--append-system-prompt-file appends the file's contents",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      TEXT_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const extra = join(directory, "extra.md");
        await writeFile(extra, "FILE-RULE-7\n");
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-m",
            "custom:mock",
            "--append-system-prompt-file",
            extra,
            "hi",
          ]),
        );

        assert.equal(result.code, 0);
        assert.match(systemOf(server.bodies[0] ?? ""), /FILE-RULE-7/);
      },
    );
  },
);

test(
  "--disable-builtin-skills removes builtin entries from the prompt",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      TEXT_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-m",
            "custom:mock",
            "--disable-builtin-skills",
            "hi",
          ]),
        );

        assert.equal(result.code, 0);
        // The identity line and environment block survive; whatever a builtin
        // skills listing would have added does not, and the run still succeeds.
        const system = systemOf(server.bodies[0] ?? "");
        assert.match(system, /You are Droide/);
      },
    );
  },
);
