import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { BUILTIN_CHECKS } from "../../../src/doctor/checks.ts";
import type { DoctorContext } from "../../../src/doctor/types.ts";

const FIXTURE = resolve(import.meta.dirname, "../../fixtures/mcp-server.mjs");

function context(factoryDir: string, timeoutMs = 5_000): DoctorContext {
  return {
    settings: {},
    paths: { factoryDir },
    environment: {
      platform: "linux",
      nodeVersion: "24.0.0",
      cwd: factoryDir,
      home: factoryDir,
      env: {},
    },
    timeoutMs,
    // No wall-clock timers in tests: the signal carries the budget, and the
    // runner's own per-test deadline catches a genuine hang.
    withTimeout: async (_label, run) => run(AbortSignal.timeout(timeoutMs)),
  };
}

function mcpCheck() {
  const found = BUILTIN_CHECKS.find((entry) => entry.name === "mcp");
  if (found === undefined) throw new Error("the mcp check is not registered");
  return found;
}

async function sandbox(
  document?: unknown,
): Promise<{ factoryDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "droide-doctor-mcp-"));
  const factoryDir = join(root, ".factory");
  await mkdir(factoryDir, { recursive: true });
  if (document !== undefined) {
    await writeFile(join(factoryDir, "mcp.json"), JSON.stringify(document));
  }
  return { factoryDir, root };
}

test("no configured servers is a skip, not a pass", async () => {
  const { factoryDir, root } = await sandbox();
  try {
    const result = await mcpCheck().run(context(factoryDir));
    assert.equal(result.status, "skip");
    assert.match(result.summary, /no enabled MCP servers/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reachable server reports its tool count", async () => {
  const { factoryDir, root } = await sandbox({
    mcpServers: { demo: { command: process.execPath, args: [FIXTURE] } },
  });
  try {
    const result = await mcpCheck().run(context(factoryDir));
    assert.equal(result.status, "ok");
    assert.match(result.summary, /1 MCP server answered/);
    assert.match((result.details ?? []).join("\n"), /demo: \d+ tools?/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server that cannot start fails and names the server", async () => {
  const { factoryDir, root } = await sandbox({
    mcpServers: {
      broken: { command: join(tmpdir(), "definitely-not-a-command-zzz") },
    },
  });
  try {
    const result = await mcpCheck().run(context(factoryDir));
    assert.equal(result.status, "fail");
    assert.match(result.summary, /1 of 1 MCP server did not answer/);
    assert.match((result.details ?? []).join("\n"), /broken:/);
    assert.equal(result.fixes?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unparseable configuration fails before any server is started", async () => {
  const { factoryDir, root } = await sandbox();
  try {
    await writeFile(join(factoryDir, "mcp.json"), "{ not json");
    const result = await mcpCheck().run(context(factoryDir));
    assert.equal(result.status, "fail");
    assert.match(result.summary, /could not be read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
