#!/usr/bin/env node
// Fails when a tracked file names another product, its release number or its
// vendor. Our identity is ours alone — see docs/adr/0010-own-brand-and-snapshot-harness.md.
//
// Deliberately narrow so it never trips on legitimate text:
//   * `droid` must not be preceded by a path/word character and must not be
//     followed by one, so `droide`, `droide-native` and `x-droide` pass;
//   * `Factory` is matched capitalised only — the lowercase word survives only
//     in ADR 0011, which explains what the layout used to be.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// `| head` closes the pipe early; that is not a failure.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

const RULES = [
  { name: "product name", re: /(?<![\w/.-])droid(?![\w-])/iu },
  { name: "release number", re: /(?<![\w.])1\.9\.0(?![\w.])/u },
  { name: "vendor", re: /\bFactory\b/u },
  { name: "vendor host", re: /\b(?:app|downloads)\.factory\.ai\b/iu },
  { name: "evidence vocabulary", re: /\bthe subject\b|\boracle\b/iu },
];

// Historical prose that must be allowed to speak plainly about the previous
// layout; the ADR exists to record it.
const ALLOWED = [/^docs\/adr\/0011-/u];

const TEXT =
  /\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|rs|sql|sh|txt|svg|html)$/u;
const SKIP_DIRS = /^(?:evidence|raw|\.work|node_modules|target)\//u;

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(
    (p) =>
      p !== "" &&
      TEXT.test(p) &&
      !SKIP_DIRS.test(p) &&
      !ALLOWED.some((a) => a.test(p)),
  );

const hits = [];
for (const path of tracked) {
  const text = readFileSync(path, "utf8");
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.re.test(line))
        hits.push(`${path}:${index + 1}: ${rule.name}: ${line.trim()}`);
    }
  });
}

if (hits.length > 0) {
  process.stdout.write(
    `brand check: ${hits.length} reference(s) to another product\n`,
  );
  for (const hit of hits.slice(0, 50)) process.stdout.write(`  ${hit}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`brand check: ${tracked.length} files, clean\n`);
}
