import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createNativeClient } from "../../../src/native/client.ts";
import {
  pathResolve,
  ptyClose,
  ptyKill,
  ptyRead,
  ptySpawn,
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

test(
  "the real helper runs a command in a pseudo-terminal",
  { skip: BINARY === undefined },
  async (t) => {
    const client = await createNativeClient({ helperPath: BINARY ?? "" });
    t.after(() => client.close());

    const windows = process.platform === "win32";
    const sessionId = await ptySpawn(client, {
      program: windows ? "cmd.exe" : "/bin/sh",
      args: windows ? ["/c", "echo PTY-MARKER"] : ["-c", "echo PTY-MARKER"],
      cols: 100,
      rows: 30,
    });

    let text = "";
    let exited = false;
    let exitCode: number | null = null;
    for (let attempt = 0; attempt < 40 && !exited; attempt += 1) {
      const chunk = await ptyRead(client, sessionId, { timeoutMs: 100 });
      text += Buffer.from(chunk.data, "base64").toString("utf8");
      exited = chunk.exited;
      if (chunk.exited) exitCode = chunk.exitCode;
    }

    assert.match(text, /PTY-MARKER/);
    assert.equal(exited, true);
    assert.equal(exitCode, 0);

    // A closed session must refuse further reads with a typed error, not hang.
    await ptyClose(client, sessionId);
    await assert.rejects(ptyRead(client, sessionId, { timeoutMs: 10 }));
  },
);

test(
  "the real helper kills a long-running child",
  { skip: BINARY === undefined },
  async (t) => {
    const client = await createNativeClient({ helperPath: BINARY ?? "" });
    t.after(() => client.close());

    const windows = process.platform === "win32";
    const sessionId = await ptySpawn(client, {
      program: windows ? "cmd.exe" : "/bin/sh",
      args: windows ? ["/c", "ping -n 30 127.0.0.1 > nul"] : ["-c", "sleep 30"],
      cols: 80,
      rows: 24,
    });

    const code = await ptyKill(client, sessionId);
    assert.equal(typeof code === "number" || code === null, true);
    await ptyClose(client, sessionId);
  },
);
