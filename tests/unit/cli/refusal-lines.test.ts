/**
 * The non-interactive refusal. Contract: `src/cli/tty.ts`,
 * `specs/10-cli-surface.md` B16–B20.
 *
 * Assertions pin the composition (which lines appear, in which order) rather
 * than the exact program token, which belongs to `src/cli/brand.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REQUIRES_TERMINAL,
  refusalLines,
  writeRefusal,
} from "../../../src/cli/tty.ts";

test("a bare refusal is the terminal block alone", () => {
  const lines = refusalLines({});

  assert.deepEqual(lines, [REQUIRES_TERMINAL]);
});

test("the terminal block carries the ssh and exec hints in that order", () => {
  const [block] = REQUIRES_TERMINAL.split("\n");

  assert.equal(REQUIRES_TERMINAL.split("\n").length, 3);
  assert.match(block ?? "", /requires a terminal for interactive mode/);
  assert.ok(
    REQUIRES_TERMINAL.indexOf("ssh -t <host>") <
      REQUIRES_TERMINAL.indexOf("exec"),
  );
});

test("a prompt word adds one final hint naming it", () => {
  const lines = refusalLines({ promptWord: "flibbertigibbet" });

  assert.equal(lines.length, 2);
  assert.equal(lines[0], REQUIRES_TERMINAL);
  assert.match(lines[1] ?? "", /"flibbertigibbet"/);
  assert.match(lines[1] ?? "", /--help/);
  assert.doesNotMatch(lines[1] ?? "", /mintty/);
});

test("mintty adds its hint when there is no prompt word", () => {
  const lines = refusalLines({ termProgram: "mintty" });

  assert.equal(lines.length, 2);
  assert.equal(lines[0], REQUIRES_TERMINAL);
  assert.match(lines[1] ?? "", /mintty/);
  assert.doesNotMatch(lines[1] ?? "", /--help/);
});

test("the mintty hint precedes the prompt-word hint", () => {
  const lines = refusalLines({ promptWord: "hi", termProgram: "mintty" });

  assert.equal(lines.length, 3);
  assert.match(lines[1] ?? "", /mintty/);
  assert.match(lines[2] ?? "", /"hi"/);
});

test("any other terminal program adds no hint", () => {
  assert.deepEqual(refusalLines({ termProgram: "Apple_Terminal" }), [
    REQUIRES_TERMINAL,
  ]);
});

test("writeRefusal writes the joined lines once, ending in exactly one newline", () => {
  const chunks: string[] = [];

  writeRefusal({ promptWord: "hi" }, (text) => chunks.push(text));

  assert.deepEqual(chunks, [
    `${refusalLines({ promptWord: "hi" }).join("\n")}\n`,
  ]);

  const written = chunks[0] ?? "";
  assert.ok(written.endsWith("\n"));
  assert.equal(written.endsWith("\n\n"), false);
  assert.equal(written.split("\n").at(-1), "");
  assert.notEqual(written.split("\n").at(-2), "");
});
