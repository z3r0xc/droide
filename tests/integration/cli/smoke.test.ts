import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(home: string, argv: readonly string[]): Promise<Run> {
  const { promise, resolve, reject } = Promise.withResolvers<Run>();
  const child = spawn(process.execPath, [ENTRY, ...argv], {
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData"),
      NO_COLOR: "1",
      TERM: "dumb",
      PATH: process.env.PATH ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

/**
 * Every command group in the tree must be able to describe itself.
 *
 * The recorded snapshots pin the exact help text for the main pages; this
 * test is the broad net: a broken registration, a missing description or a
 * command that throws while building its help fails here, for every group, not
 * just the recorded ones.
 */
const GROUPS: readonly (readonly string[])[] = [
  ["resume"],
  ["exec"],
  ["daemon"],
  ["search"],
  ["update"],
  ["mcp"],
  ["plugin"],
  ["computer"],
  ["doctor"],
  ["mcp", "permissions"],
  ["plugin", "marketplace"],
];

test("every command group answers --help with usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-smoke-"));
  try {
    for (const group of GROUPS) {
      const result = await runCli(home, [...group, "--help"]);
      assert.equal(
        result.code,
        0,
        `${group.join(" ")} exited ${String(result.code)}: ${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /^Usage: /m,
        `${group.join(" ")} printed no usage line`,
      );
      assert.equal(result.stderr, "", `${group.join(" ")} wrote to stderr`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the help subcommand renders the page it is given", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-smoke-"));
  try {
    const help = await runCli(home, ["help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: droide /m);

    const exec = await runCli(home, ["help", "exec"]);
    assert.equal(exec.code, 0);
    assert.match(exec.stdout, /^Usage: droide exec /m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an unknown command is refused as a prompt, not as a crash", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-smoke-"));
  try {
    const result = await runCli(home, ["definitely-not-a-command"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not a droide command/);
    assert.equal(result.stdout, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a mode that is declared but unbuilt fails loudly", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-smoke-"));
  try {
    const result = await runCli(home, ["exec", "--mission", "hi"]);
    // `exec` reports a usage-level refusal with 1 (spec 80 §B9); 64 is the root
    // command's "this mode is not built" signal, kept for the interactive path.
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not implemented/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
