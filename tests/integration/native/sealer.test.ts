/**
 * The sealer adapter over a real child process (the fake helper), and the
 * envelope it produces through the credential store.
 *
 * Contract: `docs/adr/0008-oauth-credential-envelope.md` (seal via the helper,
 * no plaintext on disk, no fallback) and `crates/README.md` (base64 in/out).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import {
  CREDENTIAL_SEALED_FILE,
  putCredential,
  readCredentials,
} from "../../../src/extensions/mcp/oauth/store.ts";
import {
  SealerUnavailableError,
  createNativeSealer,
  type NativeSealerOptions,
} from "../../../src/native/sealer.ts";

const FAKE_HELPER = resolve(
  import.meta.dirname,
  "../../fixtures/fake-native-helper.mjs",
);

interface Fixture {
  readonly dir: string;
  readonly options: NativeSealerOptions;
}

async function fixture(t: TestContext, mode = "secrets"): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "droide-sealer-"));
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
    },
  };
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

test("bytes seal and open through the helper, and close kills the child", async (t) => {
  const { dir, options } = await fixture(t);
  const sealer = createNativeSealer(options);
  t.after(() => sealer.close());

  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const sealed = await sealer.seal(plaintext);
  assert.notDeepEqual(sealed, plaintext);
  assert.deepEqual(await sealer.open(sealed), plaintext);

  const pid = Number.parseInt(
    await readFile(join(dir, "helper.pid"), "utf8"),
    10,
  );
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(alive(pid), true);

  await sealer.close();
  assert.equal(alive(pid), false, `helper ${pid} survived close()`);
  await sealer.close();
});

test("the credential store writes ciphertext, never the token", async (t) => {
  const { dir, options } = await fixture(t);
  const sealer = createNativeSealer(options);
  t.after(() => sealer.close());

  const stored = await putCredential(
    { factoryDir: dir, sealer, now: () => Date.parse("2026-01-02T03:04:05Z") },
    {
      credential: {
        serverName: "linear",
        serverUrl: "https://mcp.example.test",
        issuer: "https://auth.example.test",
        client: { clientId: "client-1" },
        tokens: { accessToken: "access-token-1", tokenType: "Bearer" },
      },
    },
  );
  assert.equal(stored.revision, 1);

  const sealedBytes = await readFile(join(dir, CREDENTIAL_SEALED_FILE), "utf8");
  assert.equal(sealedBytes.includes("access-token-1"), false);
  assert.equal(sealedBytes.includes("auth.example.test"), false);

  const document = await readCredentials({ factoryDir: dir, sealer });
  assert.equal(document.servers["linear"]?.issuer, "https://auth.example.test");
  assert.equal(document.servers["linear"]?.revision, 1);
  assert.equal(
    document.servers["linear"]?.tokens.accessToken,
    "access-token-1",
  );
});

test("a missing helper is a typed refusal naming the platform", async (t) => {
  const { dir } = await fixture(t);
  const sealer = createNativeSealer({
    helperPath: join(dir, "no-such-helper"),
  });
  t.after(() => sealer.close());

  await assert.rejects(sealer.seal(new Uint8Array([1])), (error: unknown) => {
    assert.ok(
      error instanceof SealerUnavailableError,
      `expected a sealer refusal, got ${String(error)}`,
    );
    assert.equal(error.failure, "helper-unavailable");
    assert.equal(error.platform, process.platform);
    assert.match(error.message, new RegExp(process.platform));
    return true;
  });
});

test("a helper that refuses is a platform refusal, not a crash", async (t) => {
  const { options } = await fixture(t, "error");
  const sealer = createNativeSealer(options);
  t.after(() => sealer.close());

  await assert.rejects(sealer.seal(new Uint8Array([1])), (error: unknown) => {
    assert.ok(error instanceof SealerUnavailableError);
    assert.equal(error.failure, "platform-unsupported");
    return true;
  });
});

test("an empty helper path is refused before anything starts", () => {
  assert.throws(
    () => createNativeSealer({ helperPath: "   " }),
    (error: unknown) => {
      assert.ok(error instanceof SealerUnavailableError);
      assert.equal(error.failure, "helper-unavailable");
      return true;
    },
  );
});
