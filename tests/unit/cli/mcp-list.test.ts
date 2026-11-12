import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAppContext } from "../../../src/app/context.ts";
import { renderMcpList, runMcpList } from "../../../src/cli/mcp-commands.ts";
import {
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../../../src/extensions/mcp/config.ts";
import type { Environment } from "../../../src/config/paths.ts";

async function sandbox(
  mcpServers: Record<string, unknown> | null,
): Promise<{ root: string; environment: Environment }> {
  const root = await mkdtemp(join(tmpdir(), "droide-mcp-list-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".factory"), { recursive: true });
  await mkdir(join(project, ".factory"), { recursive: true });
  if (mcpServers !== null) {
    await writeFile(
      join(home, ".factory", "mcp.json"),
      JSON.stringify({ mcpServers }, null, 2),
    );
  }
  return {
    root,
    environment: { env: {}, home, platform: "linux", cwd: project },
  };
}

async function render(environment: Environment): Promise<string> {
  const context = await createAppContext({ environment });
  const configuration = loadMcpConfiguration(
    mcpConfigFileSources(context.paths.factoryDir, context.environment.cwd),
  );
  return renderMcpList(configuration);
}

test("an empty configuration says so", async () => {
  const { root, environment } = await sandbox(null);
  try {
    const text = await render(environment);
    assert.match(text, /^0 servers configured, 0 enabled$/m);
    assert.equal(text.includes("errors"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("servers are listed with transport and state, sorted by name", async () => {
  const { root, environment } = await sandbox({
    zeta: { command: "node", args: ["server.mjs"] },
    alpha: { type: "http", url: "https://example.test/mcp" },
    off: { command: "node", args: ["off.mjs"], disabled: true },
  });
  try {
    const text = await render(environment);

    assert.match(text, /3 servers configured, 2 enabled/);
    const lines = text.split("\n").filter((line) => line.startsWith("  "));
    assert.equal(lines.length, 3);
    assert.equal(lines[0]?.trimStart().startsWith("alpha"), true);
    assert.match(
      lines[0] ?? "",
      /http\s+https:\/\/example\.test\/mcp\s+enabled/,
    );
    assert.match(lines[1] ?? "", /off\s+stdio\s+node off\.mjs\s+disabled/);
    assert.match(lines[2] ?? "", /zeta\s+stdio\s+node server\.mjs\s+enabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken document is reported and exits 1", async () => {
  const { root, environment } = await sandbox(null);
  try {
    await writeFile(
      join(environment.home, ".factory", "mcp.json"),
      "{ not json",
    );
    const context = await createAppContext({ environment });

    let out = "";
    let code = 0;
    await runMcpList({
      context,
      write: (text) => (out += text),
      setExitCode: (value) => {
        code = value;
      },
    });

    assert.match(out, /problems:/);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a healthy configuration exits 0", async () => {
  const { root, environment } = await sandbox({
    demo: { command: "node", args: ["x.mjs"] },
  });
  try {
    const context = await createAppContext({ environment });
    let code = 0;
    await runMcpList({
      context,
      write: () => {},
      setExitCode: (value) => {
        code = value;
      },
    });
    assert.equal(code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing never starts a server", async () => {
  const { root, environment } = await sandbox({
    demo: { command: join(tmpdir(), "definitely-not-a-command-xyz"), args: [] },
  });
  try {
    // A command that cannot start proves nothing was spawned: the listing is
    // still rendered and no diagnostic about availability appears.
    const text = await render(environment);
    assert.match(text, /1 server configured, 1 enabled/);
    assert.equal(text.includes("problems:"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
