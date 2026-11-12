/**
 * An unknown word with piped stdin: `specs/10-cli-surface.md` B9, B10, B16–B17.
 * `runCli` pipes stdin, so the process always sees a non-TTY.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "./cli-process.ts";

test("an unknown word is refused on stderr with exit 1 and no stdout", () => {
  const result = runCli(["flibbertigibbet"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires a terminal for interactive mode/);
  assert.match(result.stderr, /--help to list commands/);
  assert.doesNotMatch(result.stderr, /mintty/);
});

test("the refusal hint names the first word as the prompt it read", () => {
  const result = runCli(["deploy", "everything"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /"deploy"/);
  assert.doesNotMatch(result.stderr, /"everything"/);
});