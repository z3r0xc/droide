/**
 * The native helper boundary against a real child process. Contract:
 * `src/native/client.ts`, `src/native/protocol.ts`, `specs/90-native-layer.md`.
 *
 * Every case spawns `tests/fixtures/fake-native-helper.mjs` with Node itself as
 * the executable (the repo's helpers are not buildable on this workstation).
 * Each case asserts the typed failure, that every request promise settled, and
 * that `close()` left no process behind.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import {
  createNativeClient,
  type NativeClient,
  type NativeClientOptions,
} from "../../../src/native/client.ts";
import {
  NativeError,
  NativeProtocolError,
  NativeTimeoutError,
  NativeUnavailableError,
} from "../../../src/native/errors.ts";
import { MAX_PARAMS_BYTES } from "../../../src/native/protocol.ts";

const FAKE_HELPER = resolve(
  import.meta.dirname,
  "../../fixtures/fake-native-helper.mjs",
);
const SHA256_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

interface Fixture {
  readonly dir: string;
  readonly options: NativeClientOptions;
}

async function fixture(
  t: TestContext,
  mode: string,
  overrides: {
    requestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    closeGraceMs?: number;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "droide-native-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    options: {
      helperPath: process.execPath,
      helperArgs: [FAKE_HELPER, mode],
      env: {
        ...process.env,
        FAKE_NATIVE_HELPER_PID_FILE: join(dir, "helper.pid"),
      },
      ...overrides,
    },
  };
}

/** The pid the helper recorded about itself before doing any I/O. */
async function helperPid(dir: string): Promise<number> {
  const text = await readFile(join(dir, "helper.pid"), "utf8");
  const pid = Number.parseInt(text, 10);
  assert.ok(
    Number.isInteger(pid) && pid > 0,
    `pid file holds ${JSON.stringify(text)}`,
  );
  return pid;
}

/** Signal 0 asks the OS whether the process exists; EPERM still means alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function clientPid(client: NativeClient): number {
  const pid = client.pid;
  if (pid === undefined) assert.fail("the helper did not report a pid");
  return pid;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("a request round-trips and close leaves no process behind", async (t) => {
  const { options } = await fixture(t, "normal");
  const client = await createNativeClient(options);
  t.after(() => client.close());
  const pid = clientPid(client);

  assert.deepEqual(await client.request("hash.sha256", { text: "abc" }), {
    sha256: SHA256_ABC,
  });

  const closing = client.close();
  assert.equal(client.close(), closing, "close() is idempotent");
  await closing;
  assert.equal(client.finished, true);
  assert.equal(alive(pid), false, `helper ${pid} survived close()`);
  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    NativeUnavailableError,
  );
});

test("concurrent requests are matched by id, not by arrival order", async (t) => {
  const { options } = await fixture(t, "normal");
  const client = await createNativeClient(options);
  t.after(() => client.close());

  const [first, second] = await Promise.all([
    client.request("hash.sha256", { text: "one" }),
    client.request("hash.sha256", { text: "two" }),
  ]);

  assert.deepEqual(first, { sha256: sha256("one") });
  assert.deepEqual(second, { sha256: sha256("two") });
});

test("an error response becomes NativeError and the client stays usable", async (t) => {
  const { options } = await fixture(t, "error");
  const client = await createNativeClient(options);
  t.after(() => client.close());

  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    (error: unknown) => {
      assert.ok(error instanceof NativeError);
      assert.equal(error.code, -32602);
      assert.equal(error.method, "hash.sha256");
      assert.equal(error.helperPath, options.helperPath);
      assert.match(error.message, /params rejected by fake helper/);
      return true;
    },
  );

  assert.deepEqual(await client.request("native.version"), {
    protocol: 1,
    version: "0.0.0-fake",
  });
});

test("a malformed response line is fatal and names the boundary", async (t) => {
  const { options } = await fixture(t, "malformed");
  const client = await createNativeClient(options);
  t.after(() => client.close());
  const pid = clientPid(client);

  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    (error: unknown) => {
      assert.ok(error instanceof NativeProtocolError);
      assert.equal(error.helperPath, options.helperPath);
      assert.match(error.message, /not JSON/);
      return true;
    },
  );
  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    NativeUnavailableError,
  );
  await client.close();
  assert.equal(alive(pid), false, `helper ${pid} survived a protocol failure`);
});

test("an oversized response line is refused at the byte cap", async (t) => {
  const { options } = await fixture(t, "oversized");
  const client = await createNativeClient(options);
  t.after(() => client.close());
  const pid = clientPid(client);

  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    (error: unknown) => {
      assert.ok(error instanceof NativeProtocolError);
      assert.match(error.message, /over the 1048576-byte cap/);
      return true;
    },
  );

  await client.close();
  assert.equal(alive(pid), false, `helper ${pid} survived an oversized line`);
});

test("an answer for an id that was never sent is fatal", async (t) => {
  const { options } = await fixture(t, "stray");
  const client = await createNativeClient(options);
  t.after(() => client.close());
  const pid = clientPid(client);

  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    (error: unknown) => {
      assert.ok(error instanceof NativeProtocolError);
      assert.match(error.message, /which is not pending/);
      return true;
    },
  );

  await client.close();
  assert.equal(alive(pid), false);
});

test("a silent helper times out every request and close settles them", async (t) => {
  const { options } = await fixture(t, "silent", { requestTimeoutMs: 100 });
  const client = await createNativeClient(options);
  t.after(() => client.close());
  const pid = clientPid(client);

  const settled = await Promise.allSettled([
    client.request("hash.sha256", { text: "a" }),
    client.request("hash.sha256", { text: "b" }),
  ]);

  for (const outcome of settled) {
    assert.equal(outcome.status, "rejected");
    const error: unknown =
      outcome.status === "rejected" ? outcome.reason : undefined;
    assert.ok(error instanceof NativeTimeoutError);
    assert.equal(error.method, "hash.sha256");
    assert.equal(error.timeoutMs, 100);
    assert.equal(error.helperPath, options.helperPath);
  }

  await client.close();
  assert.equal(alive(pid), false, `helper ${pid} survived close()`);
});

test("a late answer to a timed-out request is dropped, not fatal", async (t) => {
  const { options } = await fixture(t, "late");
  const client = await createNativeClient(options);
  t.after(() => client.close());

  await assert.rejects(
    client.request("hash.sha256", { text: "late" }, { timeoutMs: 20 }),
    NativeTimeoutError,
  );

  // Answered at ~120 ms, after the abandoned frame at ~60 ms was discarded.
  assert.deepEqual(
    await client.request("hash.sha256", { text: "late" }, { timeoutMs: 1_000 }),
    { sha256: sha256("late") },
  );
});

test("close rejects a request still in flight", async (t) => {
  const { options } = await fixture(t, "silent", { requestTimeoutMs: 5_000 });
  const client = await createNativeClient(options);
  t.after(() => client.close());

  const pending = client.request("hash.sha256", { text: "x" });
  const rejection = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof NativeUnavailableError);
    assert.equal(error.method, "hash.sha256");
    assert.match(error.message, /closed before answering/);
    return true;
  });

  await client.close();
  await rejection;
});

test("a helper that exits before answering is unavailable", async (t) => {
  const { options } = await fixture(t, "exit-after-version");
  const client = await createNativeClient(options);
  t.after(() => client.close());
  const pid = clientPid(client);

  await assert.rejects(
    client.request("hash.sha256", { text: "abc" }),
    (error: unknown) => {
      assert.ok(error instanceof NativeUnavailableError);
      assert.equal(error.method, "hash.sha256");
      assert.match(error.message, /code 4/);
      return true;
    },
  );

  await client.close();
  assert.equal(alive(pid), false);
});

test("a helper that exits during the handshake is unavailable", async (t) => {
  const { dir, options } = await fixture(t, "exit", { closeGraceMs: 100 });

  await assert.rejects(createNativeClient(options), (error: unknown) => {
    assert.ok(error instanceof NativeUnavailableError);
    assert.equal(error.helperPath, options.helperPath);
    assert.match(error.message, /code 3/);
    return true;
  });

  const pid = await helperPid(dir);
  assert.equal(alive(pid), false, `helper ${pid} survived a failed handshake`);
});

test("a protocol version mismatch fails the handshake by name", async (t) => {
  const { dir, options } = await fixture(t, "wrong-version", {
    closeGraceMs: 100,
  });

  await assert.rejects(createNativeClient(options), (error: unknown) => {
    assert.ok(error instanceof NativeProtocolError);
    assert.equal(error.method, "native.version");
    assert.equal(error.helperPath, options.helperPath);
    assert.match(error.message, /speaks protocol 2/);
    assert.match(error.message, /requires 1/);
    return true;
  });

  const pid = await helperPid(dir);
  assert.equal(alive(pid), false, `helper ${pid} survived a version mismatch`);
});

test("params over the documented cap are refused before writing", async (t) => {
  const { options } = await fixture(t, "normal");
  const client = await createNativeClient(options);
  t.after(() => client.close());

  await assert.rejects(
    client.request("hash.sha256", { text: "x".repeat(MAX_PARAMS_BYTES) }),
    (error: unknown) => {
      assert.ok(error instanceof NativeProtocolError);
      assert.equal(error.method, "hash.sha256");
      assert.match(
        error.message,
        new RegExp(`over the ${MAX_PARAMS_BYTES}-byte cap`),
      );
      return true;
    },
  );

  assert.deepEqual(await client.request("native.version"), {
    protocol: 1,
    version: "0.0.0-fake",
  });
});

test("a missing helper is unavailable, not a protocol error", async (t) => {
  const { dir, options } = await fixture(t, "normal", { closeGraceMs: 100 });
  const helperPath = join(dir, "missing-helper");

  await assert.rejects(
    createNativeClient({ ...options, helperPath }),
    (error: unknown) => {
      assert.ok(error instanceof NativeUnavailableError);
      assert.equal(error.helperPath, helperPath);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
});
