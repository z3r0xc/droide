import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CREDENTIAL_SEALED_FILE,
  CredentialStoreError,
  clearCredentialStore,
  deleteCredential,
  putCredential,
  readCredentials,
  type CredentialSealer,
} from "../../../src/extensions/mcp/oauth/store.ts";

/** Reversible, deterministic stand-in for the OS sealer. */
const sealer: CredentialSealer = {
  async seal(plaintext) {
    return Uint8Array.from(plaintext, (byte) => byte ^ 0x5a);
  },
  async open(sealed) {
    return Uint8Array.from(sealed, (byte) => byte ^ 0x5a);
  },
};

const NOW = 1_700_000_000_000;

async function dir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "droide-mcp-creds-"));
  const factoryDir = join(root, ".factory");
  await mkdir(factoryDir, { recursive: true });
  return factoryDir;
}

function options(factoryDir: string, sealerImpl: CredentialSealer = sealer) {
  return { factoryDir, sealer: sealerImpl, now: () => NOW };
}

function credential(serverName = "linear") {
  return {
    serverName,
    serverUrl: "https://mcp.linear.test",
    issuer: "https://auth.linear.test",
    client: { clientId: "client-1" },
    tokens: {
      accessToken: "at-secret",
      refreshToken: "rt-secret",
      tokenType: "Bearer",
      expiresAt: NOW + 3_600_000,
    },
  };
}

test("a missing store reads as empty", async () => {
  const factoryDir = await dir();
  try {
    const document = await readCredentials(options(factoryDir));
    assert.deepEqual(document, {
      schemaVersion: 1,
      servers: {},
      tombstones: {},
    });
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("a credential round-trips and never appears in plaintext on disk", async () => {
  const factoryDir = await dir();
  try {
    const stored = await putCredential(options(factoryDir), {
      credential: credential(),
    });
    assert.equal(stored.revision, 1);
    assert.equal(stored.updatedAt, new Date(NOW).toISOString());

    const document = await readCredentials(options(factoryDir));
    assert.equal(document.servers["linear"]?.tokens.accessToken, "at-secret");

    const bytes = await readFile(join(factoryDir, CREDENTIAL_SEALED_FILE));
    assert.equal(bytes.includes(Buffer.from("at-secret")), false);
    assert.equal(bytes.includes(Buffer.from("accessToken")), false);
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("each write bumps the revision", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    const second = await putCredential(options(factoryDir), {
      credential: credential(),
    });
    assert.equal(second.revision, 2);
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("a write from a stale revision is refused", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    await putCredential(options(factoryDir), { credential: credential() });

    await assert.rejects(
      putCredential(options(factoryDir), {
        credential: credential(),
        expectedRevision: 1,
      }),
      (error: unknown) => {
        assert.equal(error instanceof CredentialStoreError, true);
        assert.equal(
          error instanceof CredentialStoreError ? error.code : "",
          "stale",
        );
        return true;
      },
    );
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("deleting writes a tombstone that outranks the stored revision", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    const tombstone = await deleteCredential(options(factoryDir), {
      serverName: "linear",
    });

    assert.equal(tombstone.revision, 2);
    const document = await readCredentials(options(factoryDir));
    assert.equal(document.servers["linear"], undefined);
    assert.equal(document.tombstones["linear"]?.revision, 2);
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("a tombstone prevents resurrection by an older writer", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    await deleteCredential(options(factoryDir), { serverName: "linear" });

    await assert.rejects(
      putCredential(options(factoryDir), {
        credential: credential(),
        expectedRevision: 1,
      }),
      /re-read before writing/,
    );
    const document = await readCredentials(options(factoryDir));
    assert.equal(document.servers["linear"], undefined);
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("a fresh write after a tombstone is allowed and clears it", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    await deleteCredential(options(factoryDir), { serverName: "linear" });
    const restored = await putCredential(options(factoryDir), {
      credential: credential(),
    });

    assert.equal(restored.revision, 3);
    const document = await readCredentials(options(factoryDir));
    assert.equal(document.tombstones["linear"], undefined);
    assert.equal(document.servers["linear"]?.revision, 3);
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("an unopenable blob is a typed error, never a plaintext fallback", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    const brokenSealer: CredentialSealer = {
      seal: sealer.seal,
      async open() {
        throw new Error("DPAPI refused");
      },
    };

    await assert.rejects(
      readCredentials(options(factoryDir, brokenSealer)),
      (error: unknown) => {
        assert.equal(error instanceof CredentialStoreError, true);
        assert.equal(
          error instanceof CredentialStoreError ? error.code : "",
          "not-sealed",
        );
        return true;
      },
    );
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("a sealed document with the wrong shape is refused", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    const sealed = await readFile(join(factoryDir, CREDENTIAL_SEALED_FILE));
    const plaintext = Buffer.from(
      sealer.open ? await sealer.open(sealed) : sealed,
    ).toString("utf8");
    const tampered = JSON.parse(plaintext) as {
      servers: Record<string, unknown>;
    };
    tampered.servers["linear"] = { tokens: {} };
    await writeFile(
      join(factoryDir, CREDENTIAL_SEALED_FILE),
      await sealer.seal(Buffer.from(JSON.stringify(tampered))),
    );

    await assert.rejects(
      readCredentials(options(factoryDir)),
      /has no access token/,
    );
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});

test("clearing removes both files", async () => {
  const factoryDir = await dir();
  try {
    await putCredential(options(factoryDir), { credential: credential() });
    await clearCredentialStore(options(factoryDir));
    const document = await readCredentials(options(factoryDir));
    assert.deepEqual(document.servers, {});
  } finally {
    await rm(factoryDir, { recursive: true, force: true });
  }
});
