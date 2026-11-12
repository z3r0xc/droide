import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_INLINE_OUTPUT_BYTES,
  MODEL_RESULT_BUDGET_BYTES,
  MODEL_TEXT_BUDGET_BYTES,
  boundText,
  cutNotice,
} from "../../../src/tools/result.ts";

test("the budgets are 32 KiB and 64 KiB", () => {
  assert.equal(MODEL_RESULT_BUDGET_BYTES, 32 * 1024);
  assert.equal(MODEL_TEXT_BUDGET_BYTES, 64 * 1024);
  assert.equal(MAX_INLINE_OUTPUT_BYTES, 32 * 1024 * 1024);
});

test("a value within the budget is returned unchanged", () => {
  assert.deepEqual(boundText("short", 32, "file"), {
    text: "short",
    cutBytes: 0,
    totalBytes: 5,
  });
});

test("an over-budget value keeps head and tail around the notice", () => {
  const head = "HEAD".repeat(20);
  const tail = "TAIL".repeat(20);
  const text = `${head}${"m".repeat(400)}${tail}`;
  const bounded = boundText(text, 200, "the file");
  assert.match(bounded.text, /^HEAD/);
  assert.match(bounded.text, /TAIL$/);
  assert.match(
    bounded.text,
    /^HEAD[\s\S]*\n\n\[\.\.\. \d+ bytes cut from the middle of 560; whole output: the file\]\n\n[\s\S]*TAIL$/,
  );
  assert.equal(bounded.totalBytes, Buffer.byteLength(text));
  assert.ok(bounded.totalBytes - bounded.cutBytes > 0);
  assert.ok(Buffer.byteLength(bounded.text) <= 200);
});

test("the cut never splits a code point", () => {
  const text = "é".repeat(1000);
  const bounded = boundText(text, 120, "somewhere");
  assert.doesNotMatch(bounded.text, /\uFFFD/);
});

test("a budget too small for the notice keeps only the notice", () => {
  const text = "x".repeat(100);
  const bounded = boundText(text, 5, "somewhere");
  assert.match(bounded.text, /^\[\.\.\. \d+ bytes cut from the middle of 100; whole output: somewhere\]$/);
});

test("the notice names the cut, the total and where the whole output lives", () => {
  assert.equal(
    cutNotice(12, 34, "path.txt"),
    "[... 12 bytes cut from the middle of 34; whole output: path.txt]",
  );
});