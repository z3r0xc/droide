#!/usr/bin/env node
/**
 * Declarative CLI parity harness (see docs/adr/0004-parity-harness-with-optional-oracle.md).
 *
 *   node tests/parity/run.mjs --check                 # ours vs recorded goldens
 *   node tests/parity/run.mjs --record --oracle PATH   # re-record goldens from the original
 *   node tests/parity/run.mjs --check --filter help   # subset by case name
 *
 * A case is JSON: {name, argv, stdin?, env?, files?, expect, oracle?, target?}.
 * Goldens live in tests/parity/expected/<name>.json and hold the raw exit code,
 * stdout and stderr after home-directory redaction.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.resolve(HERE, "../..");
const WORK_DIR = process.env.DROIDE_PARITY_DIR ?? path.join(ROOT, ".work", "parity");
const CASES_DIR = path.join(HERE, "cases");
const EXPECTED_DIR = path.join(WORK_DIR, "expected");
const OURS_ENTRY = path.join(ROOT, "src/main.ts");

function parseArgs(argv) {
  const options = { mode: "check", oracle: process.env.DROID_ORACLE || null, filter: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.mode = "check";
    else if (arg === "--record") options.mode = "record";
    else if (arg === "--target") {
      const value = argv[++i];
      if (value !== "ours" && value !== "oracle") throw new Error(`--target must be ours|oracle`);
      options.target = value;
    } else if (arg === "--oracle") options.oracle = argv[++i];
    else if (arg === "--filter") options.filter = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  options.target ??= options.mode === "record" ? "oracle" : "ours";
  return options;
}

function readCases(filter) {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, name), "utf8")))
    .filter((entry) => !filter || entry.name.includes(filter));
}

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-parity-"));
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

/**
 * Our binary is `droide`; the subject is `droid` (docs/adr/0005). Goldens hold
 * the subject's token, so ours is rewritten before comparison. Whole words only.
 */
const PROGRAM_TOKENS = [
  [/\bdroide\b/g, "droid"],
  [/\bDroide\b/g, "Droid"],
];

function normaliseProgram(text) {
  let out = text;
  for (const [pattern, replacement] of PROGRAM_TOKENS) out = out.replace(pattern, replacement);
  return out;
}

function redact(text, sandbox) {
  return text
    .split(sandbox.home).join("<HOME>")
    .split(sandbox.cwd).join("<CWD>")
    .split(sandbox.dir).join("<SANDBOX>")
    .replace(/\r\n/g, "\n");
}

function runTarget(options, entry, sandbox, argv, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, [...entry.prefix, ...argv], {
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
        ...entry.extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: entry.timeoutMs ?? 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
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
        out[relative] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(cwd);
  return out;
}

function pick(recorded, expect = {}) {
  const view = {};
  if (expect.exit_code !== undefined) view.exit_code = recorded.exit_code;
  if (expect.stdout_matches !== undefined || expect.stdout_lines !== undefined || expect.stdout_equals !== undefined) {
    view.stdout = recorded.stdout;
  }
  if (expect.stderr_empty || expect.stderr_matches !== undefined) view.stderr = recorded.stderr;
  if (expect.files) view.files = recorded.files;
  return view;
}

/** First index at which two line arrays differ, or -1. */
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
  for (let i = Math.max(0, index - 2); i <= index; i += 1) out.push(`    golden | ${expected[i] ?? "<eof>"}`);
  for (let i = Math.max(0, index - 2); i <= index; i += 1) out.push(`    ours   | ${got[i] ?? "<eof>"}`);
  if (expected.length !== got.length) out.push(`    line counts: golden ${expected.length}, ours ${got.length}`);
  return out;
}

function verify(recorded, expect, golden = null) {
  const problems = [];
  const stdout = recorded.stdout ?? "";
  const stderr = recorded.stderr ?? "";

  if (expect.exit_code !== undefined && recorded.exit_code !== expect.exit_code) {
    problems.push(`exit_code: want ${expect.exit_code}, got ${recorded.exit_code}`);
  }
  if (expect.stdout_equals !== undefined && stdout.trimEnd() !== expect.stdout_equals.trimEnd()) {
    problems.push("stdout: does not equal the expected text");
  }
  if (golden && golden.stdout !== undefined && golden.stdout !== stdout) {
    problems.push(...describeDiff("stdout", golden.stdout, stdout));
  }
  if (golden && golden.stderr !== undefined && (golden.stderr ?? "") !== stderr) {
    problems.push(...describeDiff("stderr", golden.stderr, stderr));
  }
  if (expect.stdout_lines !== undefined) {
    const lines = stdout.trimEnd() === "" ? [] : stdout.trimEnd().split("\n");
    if (lines.length !== expect.stdout_lines) problems.push(`stdout lines: want ${expect.stdout_lines}, got ${lines.length}`);
  }
  if (expect.stdout_matches !== undefined && !new RegExp(expect.stdout_matches, "m").test(stdout)) {
    problems.push(`stdout: /${expect.stdout_matches}/ did not match`);
  }
  if (expect.stderr_empty && stderr.trim() !== "") problems.push("stderr: expected empty");
  if (expect.stderr_matches !== undefined && !new RegExp(expect.stderr_matches, "m").test(stderr)) {
    problems.push(`stderr: /${expect.stderr_matches}/ did not match`);
  }
  if (expect.files) {
    for (const wanted of expect.files) {
      if (!(wanted.path in (recorded.files ?? {}))) problems.push(`missing file: ${wanted.path}`);
    }
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

  if (options.oracle) options.oracle = path.resolve(options.oracle);

  if (options.mode === "record") {
    if (!options.oracle || !fs.existsSync(options.oracle)) {
      console.error("--record needs --oracle PATH (or DROID_ORACLE) pointing at the original binary");
      return 2;
    }
  }

  const entry =
    options.target === "oracle"
      ? { command: options.oracle, prefix: [] }
      : { command: process.execPath, prefix: ["--experimental-strip-types", OURS_ENTRY] };

  if (options.target === "ours" && !fs.existsSync(OURS_ENTRY)) {
    console.error(`our entry point is missing: ${OURS_ENTRY}`);
    return 2;
  }

  fs.mkdirSync(EXPECTED_DIR, { recursive: true });
  const results = [];

  for (const testCase of cases) {
    if (testCase.oracle === false && options.target === "oracle") {
      results.push({ name: testCase.name, status: "skipped", why: "case forbids the oracle" });
      continue;
    }
    const sandbox = buildSandbox();
    try {
      writeFixture(sandbox.cwd, testCase.files);
      const raw = await runTarget(options, entry, sandbox, testCase.argv ?? [], testCase.stdin);
      const recorded = {
        exit_code: raw.code ?? (raw.signal ? `signal:${raw.signal}` : null),
        stdout: normaliseProgram(redact(raw.stdout, sandbox)),
        stderr: normaliseProgram(redact(raw.stderr, sandbox)),
        files: testCase.expect?.files ? digestFiles(sandbox.cwd) : undefined,
      };
      recorded.stdout = recorded.stdout.replace(/\r\n/g, "\n");

      if (options.mode === "record") {
        const golden = { case: testCase.name, recorded_at_target: "oracle", ...recorded };
        fs.writeFileSync(
          path.join(EXPECTED_DIR, `${testCase.name}.json`),
          `${JSON.stringify(golden, null, 1)}\n`,
        );
        results.push({ name: testCase.name, status: "recorded" });
        continue;
      }

      const goldenPath = path.join(EXPECTED_DIR, `${testCase.name}.json`);
      let problems = [];
      if (fs.existsSync(goldenPath)) {
        const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
        problems.push(
          ...verify(
            { ...golden, ...recorded, stdout: recorded.stdout, stderr: recorded.stderr },
            testCase.expect ?? {},
            testCase.expect?.stdout_exact_golden ? golden : null,
          ),
        );
      } else {
        // A case that forbids the oracle is verified from its own expectations.
        problems.push(...verify(recorded, testCase.expect ?? {}));
        if (testCase.oracle !== false) {
          problems.push("no golden recorded (run --record with the oracle)");
        }
      }
      results.push({ name: testCase.name, status: problems.length ? "failed" : "passed", problems });
    } catch (error) {
      results.push({ name: testCase.name, status: "failed", problems: [String(error)] });
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  for (const result of results) {
    const marker = result.status === "failed" ? "FAIL" : result.status === "skipped" ? "SKIP" : "ok";
    console.log(`${marker.padEnd(4)} ${result.name}${result.why ? ` (${result.why})` : ""}`);
    for (const problem of result.problems ?? []) console.log(`     - ${problem}`);
  }
  const passed = results.filter((r) => r.status === "passed" || r.status === "recorded").length;
  console.log(`\n${passed}/${results.length} ok, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code));
