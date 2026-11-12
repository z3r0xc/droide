#!/usr/bin/env node
/**
 * Build the Rust helper, then run the contract tests against the real binary.
 *
 *   node tools/run-native-tests.mjs
 *
 * The TypeScript suite normally exercises the helper through a fake; this is the
 * one place that proves the Rust side answers the same records. Kept out of
 * `npm test` because it needs a compiled artefact.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(
  path.dirname(
    new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  ),
  "..",
);
const BINARY = path.join(
  ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "droide-native.exe" : "droide-native",
);

const build = spawnSync("cargo", ["build", "-p", "droide-native"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("cargo build failed");
  process.exit(build.status ?? 1);
}
if (!fs.existsSync(BINARY)) {
  console.error(`helper binary not found at ${BINARY}`);
  process.exit(1);
}

const tests = spawnSync(
  process.execPath,
  ["--test", "tests/integration/native/real-helper.test.ts"],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DROIDE_NATIVE_BIN: BINARY },
  },
);
process.exit(tests.status ?? 1);
