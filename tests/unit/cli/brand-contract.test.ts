/**
 * Brand contract: `docs/adr/0005-project-name-and-parity-normalisation.md`.
 *
 * Every user-facing occurrence of the program name comes from `src/cli/brand.ts`,
 * so our help pages never print the subject's name verbatim.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DISPLAY, PROGRAM, SUBJECT_PROGRAM } from "../../../src/cli/brand.ts";
import { runCli } from "./cli-process.ts";

/** Trimmed rows of the help block introduced by `heading`. */
function blockRows(stdout: string, heading: string): string[] {
  const lines = stdout.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `help page has no "${heading}" heading`);

  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    rows.push(line.trim());
  }
  return rows;
}

test("root help names the program through PROGRAM and DISPLAY only", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`Usage: ${PROGRAM} `));
  assert.ok(result.stdout.includes(`${DISPLAY} - Factory's AI coding agent in your terminal`));
  assert.equal(result.stdout.includes(`${SUBJECT_PROGRAM} `), false);
});

test("every Examples row starts with PROGRAM", () => {
  const rows = blockRows(runCli(["--help"]).stdout, "Examples:");

  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.ok(
      row === PROGRAM || row.startsWith(`${PROGRAM} `),
      `Examples row does not start with ${PROGRAM}: ${row}`,
    );
    assert.equal(row.startsWith(`${SUBJECT_PROGRAM} `), false);
  }
});