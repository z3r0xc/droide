/**
 * Unimplemented-command failure. Contract: `src/cli/not-implemented.ts`,
 * `docs/plan.md` — an unimplemented command must fail loudly, never pretend.
 *
 * The module calls `process.exit`, so it is observed in a child process: the
 * separation between stdout and stderr and the exit status are the behaviour.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, runNode } from "./cli-process.ts";

const MODULE_URL = pathToFileURL(resolve(REPO_ROOT, "src/cli/not-implemented.ts")).href;

function invokeNotImplemented(command: string) {
  const source =
    `import { notImplemented } from ${JSON.stringify(MODULE_URL)};\n` +
    `notImplemented(${JSON.stringify(command)});`;
  return runNode(["--input-type=module", "-e", source]);
}

test("fails with exit code 64 and writes nothing to stdout", () => {
  const result = invokeNotImplemented("daemon");

  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.notEqual(result.stderr, "");
});

test("the message names the command it was given", () => {
  const result = invokeNotImplemented("computer register");

  assert.ok(result.stderr.startsWith("droide: "));
  assert.match(result.stderr, /"computer register"/);
  assert.ok(result.stderr.endsWith("\n"));
  assert.equal(result.stderr.endsWith("\n\n"), false);
});