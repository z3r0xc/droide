import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createNativeClient } from "../../../src/native/client.ts";
import {
  pathResolve,
  ptyQuote,
  sandboxProfile,
  searchText,
  searchWalk,
  secretsProtect,
  secretsUnprotect,
} from "../../../src/native/methods.ts";

const BINARY = process.env["DROIDE_NATIVE_BIN"];

/**
 * Contract tests against the compiled Rust helper.
 *
 * Run with `node tools/run-native-tests.mjs` (builds first). Skipped when no
 * binary is supplied, so `npm test` stays hermetic.
 */
test(
  "the real helper answers every documented method",
  { skip: BINARY === undefined },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "droide-real-native-"));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "a.ts"),
      "export const a = 1;\n// needle here\n",
    );
    await writeFile(join(dir, "README.md"), "# demo\n");

    const client = await createNativeClient({ helperPath: BINARY ?? "" });
    t.after(() => client.close());

    const version = await client.request("native.version");
    assert.equal(typeof version, "object");
    assert.equal((version as { protocol?: unknown }).protocol, 1);

    const walked = await searchWalk(client, { root: dir, glob: "**/*.ts" });
    assert.deepEqual(walked.paths, ["src/a.ts"]);

    const found = await searchText(client, { root: dir, query: "needle" });
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0]?.line, 2);
    assert.equal(found.hits[0]?.path, "src/a.ts");

    const profile = await sandboxProfile(client, {
      target: "linux",
      readPaths: [dir],
    });
    assert.equal(profile.mechanism, "bubblewrap");

    assert.equal(
      await ptyQuote(client, {
        target: "linux",
        args: ["sh", "-c", "echo $x"],
      }),
      "sh -c 'echo $x'",
    );
    assert.equal(
      await ptyQuote(client, { target: "windows", args: ["cmd", "a b"] }),
      'cmd "a b"',
    );

    const resolved = await pathResolve(client, { root: dir, path: "src/a.ts" });
    assert.equal(resolved.endsWith("src/a.ts"), true);
    await assert.rejects(pathResolve(client, { root: dir, path: "../escape" }));

    if (process.platform === "win32") {
      const sealed = await secretsProtect(client, {
        plaintext: "aGVsbG8=",
        entropy: "ZQ==",
      });
      assert.notEqual(sealed, "aGVsbG8=");
      assert.equal(
        await secretsUnprotect(client, { sealed, entropy: "ZQ==" }),
        "aGVsbG8=",
      );
    }
  },
);
