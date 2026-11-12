import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import {
  createNativeClient,
  type NativeClientOptions,
} from "../../../src/native/client.ts";
import { NativeProtocolError } from "../../../src/native/errors.ts";
import {
  pathResolve,
  ptyQuote,
  sandboxProfile,
  searchText,
  searchWalk,
  secretsProtect,
  secretsUnprotect,
} from "../../../src/native/methods.ts";

const FAKE_HELPER = resolve(
  import.meta.dirname,
  "../../fixtures/fake-native-helper.mjs",
);

async function client(t: TestContext, mode = "normal") {
  const dir = await mkdtemp(join(tmpdir(), "droide-methods-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const options: NativeClientOptions = {
    helperPath: process.execPath,
    helperArgs: [FAKE_HELPER, mode],
    env: {
      ...process.env,
      FAKE_NATIVE_HELPER_PID_FILE: join(dir, "helper.pid"),
    },
  };
  const instance = await createNativeClient(options);
  t.after(() => instance.close());
  return instance;
}

test("walk results are parsed into paths and truncation", async (t) => {
  const native = await client(t);
  assert.deepEqual(await searchWalk(native, { root: "/repo" }), {
    paths: ["src/a.ts", "README.md"],
    truncated: false,
  });
  assert.equal(
    (await searchWalk(native, { root: "/repo", maxResults: 1 })).truncated,
    true,
  );
});

test("text results keep hit order and line numbers", async (t) => {
  const native = await client(t);
  const result = await searchText(native, { root: "/repo", query: "needle" });
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0], {
    path: "src/a.ts",
    line: 2,
    text: "hit for needle",
  });
  assert.equal(result.filesScanned, 2);
});

test("a sandbox profile is narrowed by mechanism", async (t) => {
  const native = await client(t);
  const profile = await sandboxProfile(native, {
    target: "linux",
    readPaths: ["/repo"],
  });
  assert.equal(profile.mechanism, "bubblewrap");
  assert.deepEqual(profile.mechanism === "bubblewrap" ? profile.argv : [], [
    "--unshare-net",
    "--",
  ]);
});

test("pty quoting, path resolution and secrets round through the wrappers", async (t) => {
  const native = await client(t);
  assert.equal(await ptyQuote(native, { args: ["echo", "a b"] }), "echo 'a b'");
  assert.equal(
    await pathResolve(native, { root: "/repo", path: "src/a.ts" }),
    "/repo/src/a.ts",
  );
  assert.equal(
    await secretsProtect(native, { plaintext: "b3Blbg==" }),
    "c2VhbGVk",
  );
  assert.equal(
    await secretsUnprotect(native, { sealed: "c2VhbGVk" }),
    "b3Blbg==",
  );
});

test("a result with the wrong shape throws a protocol error naming the field", async (t) => {
  const native = await client(t, "bad-shape");
  await assert.rejects(
    searchWalk(native, { root: "/repo" }),
    (error: unknown) => {
      assert.equal(error instanceof NativeProtocolError, true);
      assert.match(error instanceof Error ? error.message : "", /paths/);
      return true;
    },
  );
});

test("a remote error propagates as a typed error, not a protocol error", async (t) => {
  const native = await client(t, "error");
  await assert.rejects(
    searchWalk(native, { root: "/repo" }),
    (error: unknown) => {
      assert.equal(error instanceof NativeProtocolError, false);
      assert.match(
        error instanceof Error ? error.message : "",
        /params rejected/,
      );
      return true;
    },
  );
});
