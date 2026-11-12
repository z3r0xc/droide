/**
 * The CLI observed as a process: `--version` and the help pages.
 * Contract: `specs/10-cli-surface.md` B1–B6, B43, B69.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DOCS_URL, PROGRAM, VERSION } from "../../../src/cli/brand.ts";
import { runCli } from "./cli-process.ts";

/** Terms of the help block introduced by `heading`, up to the next blank line. */
function blockTerms(stdout: string, heading: string): string[] {
  const lines = stdout.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `help page has no "${heading}" heading`);

  const terms: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const row = line.trim();
    const term = row.split(/\s{2,}/)[0] ?? "";
    terms.push(term.split(" ")[0] ?? "");
  }
  return terms;
}

test("--version prints one semver line on stdout and nothing on stderr", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${VERSION}\n`);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("--help exits 0 with the usage line, the section headings and the docs link", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");

  const lines = result.stdout.split("\n");
  assert.equal(lines[0], `Usage: ${PROGRAM} [options] [command] [prompt...]`);

  const options = lines.indexOf("Options:");
  const commands = lines.indexOf("Commands:");
  const examples = lines.indexOf("Examples:");
  assert.ok(options > 0, "Options: heading is missing");
  assert.ok(commands > options, "Commands: heading is missing or out of order");
  assert.ok(
    examples > commands,
    "Examples: heading is missing or out of order",
  );

  const docsLine = `For more details, see: ${DOCS_URL}`;
  assert.ok(result.stdout.endsWith(`${docsLine}\n`));
  assert.equal(result.stdout.endsWith("\n\n"), false);
});

test("--help lists the nine visible commands plus help in registration order", () => {
  const terms = blockTerms(runCli(["--help"]).stdout, "Commands:");

  assert.deepEqual(terms, [
    "resume",
    "exec",
    "daemon",
    "search|find",
    "update",
    "mcp",
    "plugin",
    "computer",
    "doctor",
    "help",
  ]);
});

test("mcp --help exits 0 and lists its subcommands", () => {
  const result = runCli(["mcp", "--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout.split("\n")[0],
    `Usage: ${PROGRAM} mcp [options] [command]`,
  );
  assert.deepEqual(blockTerms(result.stdout, "Commands:"), [
    "add",
    "remove",
    "list",
    "auth",
    "permissions",
    "help",
  ]);
});

test("exec --help exits 0 and prints its own usage line", () => {
  const result = runCli(["exec", "--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.ok(
    result.stdout.startsWith(`Usage: ${PROGRAM} exec [options] [prompt]\n`),
  );
});
