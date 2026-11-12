/**
 * `formatRows` / `examplesBlock` — the two-column block formatter behind the
 * root `Examples:` table. Contract: `src/cli/help.ts`, `specs/10-cli-surface.md` B4.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { examplesBlock, formatRows, type Row } from "../../../src/cli/help.ts";

test("an empty table renders as nothing", () => {
  assert.equal(formatRows([]), "");
});

test("a lone row pads its term and leaves the default gap of six", () => {
  const rows: readonly Row[] = [["exec", "Run non-interactively"]];

  // term "exec" (4) + gap 6 = description at column 2 + 10.
  assert.equal(formatRows(rows), "  exec      Run non-interactively");
});

test("a term longer than the others sets the description column for every row", () => {
  const rows: readonly Row[] = [
    ["a", "one"],
    ["longest", "two"],
  ];

  const [short, long] = formatRows(rows).split("\n");

  // Longest term is "longest" (7), so descriptions start at column 2 + 7 + 6.
  assert.equal(short, `  a${" ".repeat(12)}one`);
  assert.equal(long, `  longest${" ".repeat(6)}two`);
  assert.equal(short?.indexOf("one"), 15);
  assert.equal(long?.indexOf("two"), 15);
});

test("a row without a description renders as the term alone with no trailing spaces", () => {
  const rows: readonly Row[] = [
    ["term", ""],
    ["longer-term", "described"],
  ];

  const [blank, described] = formatRows(rows).split("\n");

  // The empty description never creates padding, and it still counts towards
  // the column width because "longer-term" is the longest term either way.
  assert.equal(blank, "  term");
  assert.equal(blank?.endsWith(" "), false);
  assert.equal(described?.indexOf("described"), 2 + "longer-term".length + 6);
});

test("the gap is configurable", () => {
  assert.equal(formatRows([["exec", "Run"]], 2), "  exec  Run");
});

test("examplesBlock puts its rows under the Examples heading", () => {
  const rows: readonly Row[] = [
    ["droide", "Start interactive mode"],
    ["droide exec", "Run non-interactively"],
  ];

  const [heading, first, second] = examplesBlock(rows).split("\n");

  assert.equal(heading, "Examples:");
  assert.equal(first, `  droide${" ".repeat(11)}Start interactive mode`);
  assert.equal(second, `  droide exec${" ".repeat(6)}Run non-interactively`);
});

test("examplesBlock with no rows is the heading and its newline", () => {
  assert.equal(examplesBlock([]), "Examples:\n");
});