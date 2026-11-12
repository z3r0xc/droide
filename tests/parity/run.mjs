#!/usr/bin/env node
/**
 * CLI snapshot harness (see docs/adr/0010-own-brand-and-snapshot-harness.md).
 *
 *   node tests/parity/run.mjs --check              # our build vs recorded snapshots
 *   node tests/parity/run.mjs --record             # re-record from our build
 *   node tests/parity/run.mjs --check --filter help
 *
 * A case is JSON: {name, argv, stdin?, env?, files?, expect}.
 * Snapshots live in .work/parity/expected/<name>.json and hold the exit code,
 * stdout and stderr after home-directory redaction. They are untracked: the
 * harness is a regression net for our own output, not a claim about anything
 * else.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HERE = path.dirname(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const ROOT = path.resolve(HERE, "../..");
const WORK_DIR =
  process.env.DROIDE_PARITY_DIR ?? path.join(ROOT, ".work", "parity");
const CASES_DIR = path.join(HERE, "cases");
const EXPECTED_DIR = path.join(WORK_DIR, "expected");
const ENTRY = path.join(ROOT, "src/main.ts");

function parseArgs(argv) {
  const options = { mode: "check", filter: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.mode = "check";
    else if (arg === "--record") options.mode = "record";
    else if (arg === "--filter") options.filter = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readCases(filter) {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(CASES_DIR, name), "utf8")),
    )
    .filter((entry) => !filter || entry.name.includes(filter));
}

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "droide-cli-"));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { dir, home, cwd };
}

function writeFixture(cwd, files = {}) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function redact(text, sandbox) {
  return text
    .split(sandbox.home)
    .join("<HOME>")
    .split(sandbox.cwd)
    .join("<CWD>")
    .split(sandbox.dir)
    .join("<SANDBOX>")
    .replace(/\r\n/g, "\n");
}

function runCli(sandbox, argv, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...argv], {
      cwd: sandbox.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: path.join(sandbox.home, ".config"),
        APPDATA: path.join(sandbox.home, "AppData"),
        LOCALAPPDATA: path.join(sandbox.home, "AppData", "Local"),
        TMPDIR: sandbox.dir,
        TEMP: sandbox.dir,
        TMP: sandbox.dir,
        TZ: "UTC",
        LANG: "C",
        LC_ALL: "C",
        TERM: "dumb",
        NO_COLOR: "1",
        CI: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

function digestFiles(cwd) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(cwd, full).split(path.sep).join("/");
        out[relative] = createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
      }
    }
  };
  walk(cwd);
  return out;
}

function firstDifference(a, b) {
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i += 1) if (a[i] !== b[i]) return i;
  return -1;
}

function describeDiff(kind, golden, actual) {
  const expected = (golden ?? "").split("\n");
  const got = actual.split("\n");
  const index = firstDifference(expected, got);
  if (index < 0) return [];
  const out = [`${kind}: first difference at line ${index + 1}`];
  for (let i = Math.max(0, index - 2); i <= index; i += 1)
    out.push(`    snapshot | ${expected[i] ?? "<eof>"}`);
  for (let i = Math.max(0, index - 2); i <= index; i += 1)
    out.push(`    ours     | ${got[i] ?? "<eof>"}`);
  if (expected.length !== got.length)
    out.push(
      `    line counts: snapshot ${expected.length}, ours ${got.length}`,
    );
  return out;
}

function verify(recorded, expect = {}, snapshot = null) {
  const problems = [];
  const stdout = recorded.stdout ?? "";
  const stderr = recorded.stderr ?? "";

  if (
    expect.exit_code !== undefined &&
    recorded.exit_code !== expect.exit_code
  ) {
    problems.push(
      `exit_code: want ${expect.exit_code}, got ${recorded.exit_code}`,
    );
  }
  if (expect.stdout_lines !== undefined) {
    const lines = stdout.trimEnd() === "" ? [] : stdout.trimEnd().split("\n");
    if (lines.length !== expect.stdout_lines)
      problems.push(
        `stdout lines: want ${expect.stdout_lines}, got ${lines.length}`,
      );
  }
  if (
    expect.stdout_matches !== undefined &&
    !new RegExp(expect.stdout_matches, "m").test(stdout)
  ) {
    problems.push(`stdout: /${expect.stdout_matches}/ did not match`);
  }
  if (expect.stderr_empty && stderr.trim() !== "")
    problems.push("stderr: expected empty");
  if (
    expect.stderr_matches !== undefined &&
    !new RegExp(expect.stderr_matches, "m").test(stderr)
  ) {
    problems.push(`stderr: /${expect.stderr_matches}/ did not match`);
  }
  if (snapshot !== null) {
    if ((snapshot.stdout ?? "") !== stdout)
      problems.push(...describeDiff("stdout", snapshot.stdout, stdout));
    if ((snapshot.stderr ?? "") !== stderr)
      problems.push(...describeDiff("stderr", snapshot.stderr, stderr));
  }
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cases = readCases(options.filter);
  if (cases.length === 0) {
    console.error("no cases matched");
    return 2;
  }
  if (!fs.existsSync(ENTRY)) {
    console.error(`entry point is missing: ${ENTRY}`);
    return 2;
  }

  fs.mkdirSync(EXPECTED_DIR, { recursive: true });
  const results = [];

  for (const testCase of cases) {
    const sandbox = buildSandbox();
    try {
      writeFixture(sandbox.cwd, testCase.files);
      const raw = await runCli(sandbox, testCase.argv ?? [], testCase.stdin);
      const recorded = {
        exit_code: raw.code ?? (raw.signal ? `signal:${raw.signal}` : null),
        stdout: redact(raw.stdout, sandbox),
        stderr: redact(raw.stderr, sandbox),
        files: testCase.expect?.files ? digestFiles(sandbox.cwd) : undefined,
      };

      if (options.mode === "record") {
        fs.writeFileSync(
          path.join(EXPECTED_DIR, `${testCase.name}.json`),
          `${JSON.stringify({ case: testCase.name, ...recorded }, null, 1)}\n`,
        );
        results.push({ name: testCase.name, status: "recorded" });
        continue;
      }

      const snapshotPath = path.join(EXPECTED_DIR, `${testCase.name}.json`);
      const problems = [];
      if (fs.existsSync(snapshotPath)) {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        problems.push(...verify(recorded, testCase.expect ?? {}, snapshot));
      } else {
        problems.push(...verify(recorded, testCase.expect ?? {}));
        problems.push("no snapshot recorded; run --record");
      }
      results.push({
        name: testCase.name,
        status: problems.length ? "failed" : "passed",
        problems,
      });
    } catch (error) {
      results.push({
        name: testCase.name,
        status: "failed",
        problems: [String(error)],
      });
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }

  const failed = results.filter((result) => result.status === "failed");
  for (const result of results) {
    const marker =
      result.status === "failed"
        ? "FAIL"
        : result.status === "recorded"
          ? "REC "
          : "ok  ";
    console.log(`${marker} ${result.name}`);
    for (const problem of result.problems ?? [])
      console.log(`     - ${problem}`);
  }
  const passed = results.filter(
    (result) => result.status === "passed" || result.status === "recorded",
  ).length;
  console.log(`\n${passed}/${results.length} ok, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code));
