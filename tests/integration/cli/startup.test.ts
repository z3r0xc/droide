import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(home: string, argv: readonly string[]): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
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

test("a malformed user settings file fails the run before any command acts", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-startup-"));
  try {
    await mkdir(join(home, ".factory"), { recursive: true });
    await writeFile(join(home, ".factory", "settings.json"), "{ broken");

    const result = await runCli(home, []);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /settings\.json/);
    assert.match(result.stderr, /^droide: /);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a valid settings file lets the unimplemented interactive mode fail loudly", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-startup-"));
  try {
    await mkdir(join(home, ".factory"), { recursive: true });
    await writeFile(
      join(home, ".factory", "settings.json"),
      JSON.stringify({ locale: "en" }),
    );

    const result = await runCli(home, []);

    assert.equal(result.code, 64);
    assert.match(result.stderr, /not implemented in this build/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("help and version never load settings, so they survive a broken file", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-startup-"));
  try {
    await mkdir(join(home, ".factory"), { recursive: true });
    await writeFile(join(home, ".factory", "settings.json"), "{ broken");

    const version = await runCli(home, ["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);

    const help = await runCli(home, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: droide /);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
