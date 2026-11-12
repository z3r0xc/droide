import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createAppContext } from "../../../src/app/context.ts";
import { createSessionTooling } from "../../../src/app/tooling.ts";
import type { Environment } from "../../../src/config/paths.ts";

const FIXTURE = fileURLToPath(
  new URL("../../fixtures/mcp-server.mjs", import.meta.url),
);

async function sandbox(
  mcpServers: Record<string, unknown>,
): Promise<{ root: string; environment: Environment }> {
  const root = await mkdtemp(join(tmpdir(), "droide-tooling-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".factory"), { recursive: true });
  await mkdir(join(project, ".factory"), { recursive: true });
  await writeFile(
    join(home, ".factory", "mcp.json"),
    JSON.stringify({ mcpServers }, null, 2),
  );
  return {
    root,
    environment: { env: {}, home, platform: process.platform, cwd: project },
  };
}

test("a configured MCP server contributes its tools to the registry", async () => {
  const { root, environment } = await sandbox({
    demo: { command: process.execPath, args: [FIXTURE] },
  });
  try {
    const context = await createAppContext({ environment });
    const tooling = await createSessionTooling({ context });

    try {
      assert.equal(tooling.servers.length, 1);
      assert.equal(tooling.servers[0]?.name, "demo");
      assert.equal((tooling.servers[0]?.tools.length ?? 0) > 0, true);

      const ids = tooling.registry.all().map((definition) => definition.id);
      assert.equal(
        ids.some((id) => id.startsWith("mcp_demo_")),
        true,
        `ids: ${ids.join(", ")}`,
      );
      assert.equal(
        ids.some((id) => id === "execute-cli"),
        true,
        "core tools stay registered",
      );
    } finally {
      await tooling.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server that cannot start becomes a diagnostic, not a crash", async () => {
  const { root, environment } = await sandbox({
    broken: { command: join(tmpdir(), "definitely-not-a-command-xyz") },
  });
  try {
    const context = await createAppContext({ environment });
    const tooling = await createSessionTooling({ context });

    try {
      assert.equal(tooling.servers.length, 0);
      assert.equal(
        tooling.diagnostics.some(
          (diagnostic) => diagnostic.code === "server-unavailable",
        ),
        true,
      );
      assert.equal(
        tooling.registry
          .all()
          .some((definition) => definition.id.startsWith("mcp_")),
        false,
      );
    } finally {
      await tooling.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabling a server keeps it out of the registry", async () => {
  const { root, environment } = await sandbox({
    demo: { command: process.execPath, args: [FIXTURE], disabled: true },
  });
  try {
    const context = await createAppContext({ environment });
    const tooling = await createSessionTooling({ context });

    try {
      assert.equal(tooling.servers.length, 0);
      assert.equal(
        tooling.registry
          .all()
          .some((definition) => definition.id.startsWith("mcp_")),
        false,
      );
    } finally {
      await tooling.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connect: false builds the registry without spawning servers", async () => {
  const { root, environment } = await sandbox({
    demo: { command: process.execPath, args: [FIXTURE] },
  });
  try {
    const context = await createAppContext({ environment });
    const tooling = await createSessionTooling({ context, connect: false });

    assert.equal(tooling.servers.length, 0);
    assert.equal(
      tooling.registry
        .all()
        .some((definition) => definition.id === "execute-cli"),
      true,
    );
    await tooling.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("close is idempotent and leaves no child process", async () => {
  const { root, environment } = await sandbox({
    demo: { command: process.execPath, args: [FIXTURE] },
  });
  try {
    const pidFile = join(root, "pid.txt");
    const previous = process.env["FAKE_MCP_SERVER_PID_FILE"];
    process.env["FAKE_MCP_SERVER_PID_FILE"] = pidFile;
    const context = await createAppContext({ environment });
    const tooling = await createSessionTooling({ context });

    await tooling.close();
    await tooling.close();

    const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.equal(Number.isInteger(pid), true);
    assert.throws(() => process.kill(pid, 0), /ESRCH|not found/i);
    if (previous === undefined) delete process.env["FAKE_MCP_SERVER_PID_FILE"];
    else process.env["FAKE_MCP_SERVER_PID_FILE"] = previous;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
