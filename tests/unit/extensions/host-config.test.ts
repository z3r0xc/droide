import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readHostConfig,
  renderComputerList,
} from "../../../src/extensions/computer/host-config.ts";

async function factory(
  document?: unknown,
): Promise<{ dir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "droide-host-"));
  const dir = join(root, ".droide");
  await mkdir(dir, { recursive: true });
  if (document !== undefined) {
    await writeFile(
      join(dir, "host.json"),
      typeof document === "string" ? document : JSON.stringify(document),
    );
  }
  return { dir, root };
}

const valid = {
  schemaVersion: 1,
  hostId: "host-abc",
  createdAt: "2026-01-01T00:00:00.000Z",
  computerRegistration: {
    computerId: "cmp_123",
    firestoreOrgId: "org_1",
    userId: "user_1",
    registeredAt: "2026-02-02T00:00:00.000Z",
  },
};

test("a missing file means this machine is not registered", async () => {
  const { dir, root } = await factory();
  try {
    assert.equal(readHostConfig(dir), undefined);
    assert.match(
      renderComputerList([undefined]),
      /not registered for Remote Control/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid registration is read with its host id", async () => {
  const { dir, root } = await factory(valid);
  try {
    const result = readHostConfig(dir);
    assert.equal(result?.diagnostic, undefined);
    assert.equal(result?.config?.hostId, "host-abc");
    assert.equal(result?.config?.registration?.computerId, "cmp_123");

    const text = renderComputerList([result]);
    assert.match(text, /^computer cmp_123$/m);
    assert.match(text, /host id: host-abc/);
    assert.match(text, /registered: 2026-02-02/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file without a registration lists nothing but does not fail", async () => {
  const { dir, root } = await factory({ schemaVersion: 1, hostId: "host-abc" });
  try {
    const result = readHostConfig(dir);
    assert.equal(result?.diagnostic, undefined);
    assert.equal(result?.config?.registration, undefined);
    assert.match(renderComputerList([result]), /not registered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed file is a diagnostic, not a crash", async () => {
  const { dir, root } = await factory("{ not json");
  try {
    const result = readHostConfig(dir);
    assert.match(result?.diagnostic ?? "", /not valid JSON/);
    const text = renderComputerList([result]);
    assert.match(text, /not registered/);
    assert.match(text, /host\.json: not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsupported schema version is refused by name", async () => {
  const { dir, root } = await factory({ schemaVersion: 2, hostId: "h" });
  try {
    assert.match(
      readHostConfig(dir)?.diagnostic ?? "",
      /unsupported schemaVersion 2/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registration missing required fields names them", async () => {
  const { dir, root } = await factory({
    schemaVersion: 1,
    computerRegistration: { computerId: "cmp_1" },
  });
  try {
    assert.match(
      readHostConfig(dir)?.diagnostic ?? "",
      /missing firestoreOrgId, userId/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registration belonging to another user is reported as inert", async () => {
  const { dir, root } = await factory(valid);
  try {
    const result = readHostConfig(dir);
    const text = renderComputerList([result], { userId: "someone-else" });
    assert.match(text, /registered for a different user/);
    assert.equal(text.includes("remote control itself is not enabled"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registration belonging to another organization is reported as inert", async () => {
  const { dir, root } = await factory(valid);
  try {
    const text = renderComputerList([readHostConfig(dir)], {
      organizationId: "org_2",
    });
    assert.match(text, /registered for a different organization/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
