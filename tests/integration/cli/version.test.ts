import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));
const PACKAGE = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);

function run(
  home: string,
  argv: readonly string[],
): Promise<{ code: number | null; stdout: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
  }>();
  const child = spawn(process.execPath, [ENTRY, ...argv], {
    env: {
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: "1",
      TERM: "dumb",
      PATH: process.env.PATH ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout }));
  return promise;
}

test("--version prints the package version, not a borrowed one", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-version-"));
  try {
    const pkg = JSON.parse(await readFile(PACKAGE, "utf8")) as {
      version?: unknown;
    };
    const result = await run(home, ["--version"]);

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trimEnd(), String(pkg.version));
    assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the help footer points at this repository and nowhere else", async () => {
  const home = await mkdtemp(join(tmpdir(), "droide-version-"));
  try {
    const result = await run(home, ["--help"]);
    assert.equal(result.code, 0);

    const urls = result.stdout.match(/https?:\/\/[^\s]+/g) ?? [];
    assert.equal(urls.length > 0, true, "the help footer carries a docs link");
    for (const url of urls) {
      assert.match(
        url,
        /^https:\/\/github\.com\/z3r0xc\/droide/,
        `unexpected host in help: ${url}`,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
