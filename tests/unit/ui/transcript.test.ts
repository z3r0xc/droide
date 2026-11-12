/**
 * Transcript normalisation and tool result budgets (R4, R5, B7).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_PREVIEW_MAX_LINES,
  clampParamValue,
  previewResult,
  toTranscriptItem,
} from "../../../src/ui/transcript.ts";

test("unknown and malformed entries normalise to nothing", () => {
  assert.equal(toTranscriptItem({ kind: "diff", patch: "@@" }), undefined);
  assert.equal(toTranscriptItem({ kind: "assistant" }), undefined);
  assert.equal(toTranscriptItem({ kind: "user", text: 42 }), undefined);
  assert.equal(toTranscriptItem({ kind: "tool" }), undefined);
  assert.equal(toTranscriptItem({ kind: "tool", name: "" }), undefined);
});

test("known entries normalise with defaults", () => {
  assert.deepEqual(toTranscriptItem({ kind: "user", text: "hi" }), {
    kind: "user",
    text: "hi",
    specMode: false,
  });
  assert.deepEqual(
    toTranscriptItem({ kind: "user", text: "hi", specMode: true }),
    { kind: "user", text: "hi", specMode: true },
  );
  assert.deepEqual(toTranscriptItem({ kind: "assistant", text: "ok" }), {
    kind: "assistant",
    text: "ok",
  });
  assert.deepEqual(
    toTranscriptItem({
      kind: "tool",
      name: "Read",
      params: [
        ["path", "src/a.ts"],
        ["bad"],
        [1, 2],
        ["flag", true],
      ],
      state: "weird",
      result: "done",
    }),
    {
      kind: "tool",
      name: "Read",
      params: [["path", "src/a.ts"]],
      suffix: undefined,
      state: "success",
      result: "done",
      interrupted: false,
    },
  );
});

test("parameter values clamp at 50 characters with an ellipsis", () => {
  const short = "a".repeat(50);
  assert.equal(clampParamValue(short), short);
  assert.equal(clampParamValue(`${short}b`), `${short}…`);
});

test("the collapsed preview caps at 4 lines and 1024 characters", () => {
  const four = previewResult("one\ntwo\nthree\nfour");
  assert.deepEqual(four.lines, ["one", "two", "three", "four"]);
  assert.equal(four.hidden, 0);

  const many = previewResult("1\n2\n3\n4\n5\n6");
  assert.equal(many.lines.length, TOOL_PREVIEW_MAX_LINES);
  assert.equal(many.hidden, 2);

  const long = previewResult("x".repeat(TOOL_PREVIEW_MAX_CHARS + 10));
  assert.equal(long.lines.length, 1);
  assert.equal(long.lines[0]?.length, TOOL_PREVIEW_MAX_CHARS);
  assert.equal(long.hidden, 0);
});