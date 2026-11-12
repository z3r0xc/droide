/**
 * Brand contract: `docs/adr/0005-project-name-and-parity-normalisation.md`.
 *
 * Every user-facing occurrence of the program name comes from `src/cli/brand.ts`,
 * so no help page prints the subject's name verbatim.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DISPLAY, PROGRAM, SUBJECT_PROGRAM } from "../../../src/cli/brand.ts";
import { runCli } from "./cli-process.ts";

/** The subject's prose form; only tests and documentation may mention it. */
const SUBJECT_DISPLAY = "Droid";

interface HelpPage {
  readonly label: string;
  readonly args: readonly string[];
  /** Text that must appear, with the product name already substituted. */
  readonly expected: readonly string[];
}

const PAGES: readonly HelpPage[] = [
  {
    label: "root",
    args: [],
    expected: [
      `Usage: ${PROGRAM} `,
      `${DISPLAY} - Factory's AI coding agent in your terminal`,
    ],
  },
  {
    label: "update",
    args: ["update"],
    expected: [`Check for and install ${DISPLAY} updates`],
  },
  {
    label: "daemon",
    args: ["daemon"],
    expected: [`Path to ${PROGRAM} executable for spawning sessions`],
  },
];

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

for (const page of PAGES) {
  test(`${page.label} --help uses the brand constants and never the subject token`, () => {
    const result = runCli([...page.args, "--help"]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    for (const expected of page.expected) {
      assert.ok(result.stdout.includes(expected), `help page is missing: ${expected}`);
    }
    assert.equal(result.stdout.includes(`${SUBJECT_PROGRAM} `), false);
    assert.equal(result.stdout.includes(`${SUBJECT_DISPLAY} `), false);
  });
}

test("every Examples row starts with PROGRAM", () => {
  const rows = blockRows(runCli(["--help"]).stdout, "Examples:");

  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.ok(
      row === PROGRAM || row.startsWith(`${PROGRAM} `),
      `Examples row does not start with ${PROGRAM}: ${row}`,
    );
  }
});

test("the Examples block is the only place the bare program name starts a line", () => {
  const stdout = runCli(["--help"]).stdout;
  const exampleRows = blockRows(stdout, "Examples:");

  const bareProgramRows = stdout
    .split("\n")
    .filter((line) => (line.trim().split(/\s+/)[0] ?? "") === PROGRAM)
    .map((line) => line.trim());

  assert.deepEqual(bareProgramRows, exampleRows);
});