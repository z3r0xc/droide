/**
 * The transcript-to-shell mapping (`specs/10-cli-surface.md` B22): the rows a
 * resumed shell opens with, and the context its next request extends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { seedFromRecords } from "../../../src/app/session-seed.ts";
import type { JsonObject, JsonValue } from "../../../src/session/transcript.ts";

function message(
  role: string,
  content: readonly JsonValue[],
  at = 1_000,
): JsonObject {
  return {
    type: "message",
    message: { id: `${role}-${at}`, role, content },
    timestamp: at,
  };
}

function text(value: string): JsonObject {
  return { type: "text", text: value };
}

test("stored text turns become the shell's first rows", () => {
  const seed = seedFromRecords([
    message("user", [text("hello")], 1_000),
    message("assistant", [text("hi there")], 2_000),
  ]);

  assert.deepEqual(seed.entries, [
    { kind: "user", text: "hello", specMode: false },
    { kind: "assistant", text: "hi there" },
  ]);
  assert.deepEqual(
    seed.messages.map((entry) => [entry.role, entry.id]),
    [
      ["user", "user-1000"],
      ["assistant", "assistant-2000"],
    ],
  );
});

test("a tool call and its stored result become one settled tool row", () => {
  const seed = seedFromRecords([
    message(
      "assistant",
      [
        text("checking"),
        {
          type: "tool_use",
          id: "call-1",
          name: "read",
          input: { path: "a.ts" },
        },
      ],
      1_000,
    ),
    message(
      "tool",
      [{ type: "tool_result", toolUseId: "call-1", content: "file text" }],
      2_000,
    ),
  ]);

  assert.deepEqual(seed.entries, [
    { kind: "assistant", text: "checking" },
    {
      kind: "tool",
      name: "read",
      params: [["path", "a.ts"]],
      suffix: undefined,
      state: "success",
      result: "file text",
      interrupted: false,
    },
  ]);
  // The tool exchange is context too: three messages, in order.
  assert.deepEqual(
    seed.messages.map((entry) => entry.role),
    ["assistant", "tool"],
  );
});

test("a call whose result never landed is shown as an interrupted error", () => {
  const seed = seedFromRecords([
    message("assistant", [
      { type: "tool_use", id: "call-1", name: "shell", input: {} },
    ]),
  ]);

  assert.deepEqual(seed.entries, [
    {
      kind: "tool",
      name: "shell",
      params: [],
      suffix: undefined,
      state: "error",
      result: undefined,
      interrupted: true,
    },
  ]);
});

test("a failed call keeps its error state and rendered result", () => {
  const seed = seedFromRecords([
    message(
      "assistant",
      [{ type: "tool_use", id: "call-1", name: "shell", input: { cmd: "ls" } }],
      1_000,
    ),
    message(
      "tool",
      [
        {
          type: "tool_result",
          toolUseId: "call-1",
          content: [{ type: "text", text: "boom" }],
          isError: true,
        },
      ],
      2_000,
    ),
  ]);

  assert.deepEqual(seed.entries[0], {
    kind: "tool",
    name: "shell",
    params: [["cmd", "ls"]],
    suffix: undefined,
    state: "error",
    result: "boom",
    interrupted: false,
  });
});

test("non-message records add no rows; a stored error is a notice", () => {
  const seed = seedFromRecords([
    { type: "session_start", sessionId: "x" },
    { type: "completion", reason: "completed", finalText: "done" },
    { type: "error", source: "cli", message: "provider failed" },
  ]);

  assert.deepEqual(seed.entries, [
    { kind: "notice", text: "Error: provider failed" },
  ]);
  assert.deepEqual(seed.messages, []);
});

test("an unreadable message record is skipped without losing the rest", () => {
  const seed = seedFromRecords([
    { type: "message", message: { role: "user", content: [] } },
    message("user", [text("still here")], 5_000),
  ]);

  assert.deepEqual(seed.entries, [
    { kind: "user", text: "still here", specMode: false },
  ]);
  assert.equal(seed.messages.length, 1);
});
