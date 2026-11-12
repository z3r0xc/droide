import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../../../src/extensions/mcp/config.ts";
import {
  McpEditError,
  addMcpServer,
  clearPersistentPermissions,
  countPersistentPermissions,
  defaultMcpConfigIo,
  readMcpConfigDocument,
  readPersistentPermissions,
  removeMcpServer,
  revokeServerPermission,
  revokeToolPermission,
} from "../../../src/extensions/mcp/edit.ts";
import type {
  McpConfigIo,
  McpEditTarget,
} from "../../../src/extensions/mcp/edit.ts";
import { parseJsonc } from "../../../src/extensions/jsonc.ts";

interface Sandbox {
  readonly root: string;
  readonly factoryDir: string;
  readonly projectRoot: string;
  readonly userTarget: McpEditTarget;
  readonly projectTarget: McpEditTarget;
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "droide-mcp-edit-"));
  const home = join(root, "home");
  const projectRoot = join(root, "project");
  const factoryDir = join(home, ".factory");
  await mkdir(factoryDir, { recursive: true });
  await mkdir(join(projectRoot, ".factory"), { recursive: true });
  return {
    root,
    factoryDir,
    projectRoot,
    userTarget: { path: join(factoryDir, "mcp.json"), scope: "user" },
    projectTarget: {
      path: join(projectRoot, ".factory", "mcp.json"),
      scope: "project",
    },
  };
}

function stdioConfig(command = "node", args: readonly string[] = []) {
  return { type: "stdio", command, args: [...args], disabled: false };
}

function editErrorCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof McpEditError ? error.code === code : false;
}

for (const scope of ["user", "project"] as const) {
  test(`add and remove round-trip in the ${scope} file`, async () => {
    const box = await sandbox();
    try {
      const target = scope === "user" ? box.userTarget : box.projectTarget;
      addMcpServer(target, "docs-server", stdioConfig("node", ["server.mjs"]));

      const merged = loadMcpConfiguration(
        mcpConfigFileSources(box.factoryDir, box.projectRoot),
      );
      assert.equal(merged.servers.has("docs-server"), true);
      assert.equal(
        merged.servers.get("docs-server")?.level,
        scope === "user" ? "user-settings" : "project-settings",
      );

      const removed = removeMcpServer(target, "docs-server");
      assert.deepEqual(removed.removed, ["docs-server"]);
      const after = loadMcpConfiguration(
        mcpConfigFileSources(box.factoryDir, box.projectRoot),
      );
      assert.equal(after.servers.has("docs-server"), false);
      assert.equal(after.diagnostics.length, 0);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });
}

test("add canonicalizes the written key and refuses an alias", async () => {
  const box = await sandbox();
  try {
    addMcpServer(box.userTarget, "Docs Server", stdioConfig());
    const text = await readFile(box.userTarget.path, "utf8");
    assert.match(text, /"Docs-Server"/);

    assert.throws(
      () => addMcpServer(box.userTarget, "Docs-Server", stdioConfig()),
      editErrorCode("duplicate-server"),
    );
    assert.throws(
      () => addMcpServer(box.userTarget, "Docs/Server", stdioConfig()),
      editErrorCode("duplicate-server"),
    );
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("add refuses a server shape that does not parse", async () => {
  const box = await sandbox();
  try {
    assert.throws(
      () =>
        addMcpServer(box.userTarget, "broken", {
          type: "http",
          url: "",
          disabled: false,
        }),
      editErrorCode("invalid-server"),
    );
    assert.throws(
      () => addMcpServer(box.userTarget, "???", stdioConfig()),
      editErrorCode("invalid-name"),
    );
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("remove refuses an unknown server without touching the file", async () => {
  const box = await sandbox();
  try {
    addMcpServer(box.userTarget, "alpha", stdioConfig());
    const before = await readFile(box.userTarget.path, "utf8");
    assert.throws(
      () => removeMcpServer(box.userTarget, "beta"),
      editErrorCode("unknown-server"),
    );
    assert.equal(await readFile(box.userTarget.path, "utf8"), before);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a JSONC edit preserves every comment and the existing key order", async () => {
  const box = await sandbox();
  try {
    const source = [
      "{",
      "  // top-level comment",
      '  "mcpServers": {',
      "    // alpha comment",
      '    "alpha": {',
      '      "type": "stdio",',
      '      "command": "alpha"',
      "    }, // trailing alpha comment",
      "  },",
      '  "otherSetting": true,',
      "}",
      "",
    ].join("\n");
    await writeFile(box.userTarget.path, source);

    addMcpServer(box.userTarget, "beta", stdioConfig("beta"));
    const added = await readFile(box.userTarget.path, "utf8");
    assert.match(added, /\/\/ top-level comment/);
    assert.match(added, /\/\/ alpha comment/);
    assert.match(added, /\/\/ trailing alpha comment/);
    assert.match(added, /"otherSetting": true/);
    const parsed = parseJsonc(added);
    assert.deepEqual(Object.keys(parsed as Record<string, unknown>), [
      "mcpServers",
      "otherSetting",
    ]);
    const merged = loadMcpConfiguration(
      mcpConfigFileSources(box.factoryDir, box.projectRoot),
    );
    assert.deepEqual([...merged.servers.keys()].sort(), ["alpha", "beta"]);

    removeMcpServer(box.userTarget, "alpha");
    const removed = await readFile(box.userTarget.path, "utf8");
    assert.match(removed, /\/\/ top-level comment/);
    assert.match(removed, /\/\/ alpha comment/);
    assert.match(removed, /\/\/ trailing alpha comment/);
    assert.match(removed, /"otherSetting": true/);
    const after = loadMcpConfiguration(
      mcpConfigFileSources(box.factoryDir, box.projectRoot),
    );
    assert.deepEqual([...after.servers.keys()], ["beta"]);
    assert.equal(after.diagnostics.length, 0);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a BOM-prefixed document is read and preserved", async () => {
  const box = await sandbox();
  try {
    await writeFile(
      box.userTarget.path,
      `\ufeff${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    );
    addMcpServer(box.userTarget, "alpha", stdioConfig());
    const text = await readFile(box.userTarget.path, "utf8");
    assert.equal(text.charCodeAt(0), 0xfeff);
    const merged = loadMcpConfiguration(
      mcpConfigFileSources(box.factoryDir, box.projectRoot),
    );
    assert.equal(merged.servers.has("alpha"), true);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("add creates a missing file with the documented shape", async () => {
  const box = await sandbox();
  try {
    assert.equal(readMcpConfigDocument(box.userTarget), undefined);
    addMcpServer(box.userTarget, "alpha", stdioConfig());
    const text = await readFile(box.userTarget.path, "utf8");
    const parsed = parseJsonc(text) as {
      readonly mcpServers: Readonly<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(parsed.mcpServers), ["alpha"]);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("an unparseable file is refused by add and by remove", async () => {
  const box = await sandbox();
  try {
    const broken = '{ "mcpServers": { "alpha": ';
    await writeFile(box.userTarget.path, broken);
    assert.throws(
      () => addMcpServer(box.userTarget, "beta", stdioConfig()),
      editErrorCode("invalid-jsonc"),
    );
    assert.throws(
      () => removeMcpServer(box.userTarget, "alpha"),
      editErrorCode("invalid-jsonc"),
    );
    assert.equal(await readFile(box.userTarget.path, "utf8"), broken);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a failed atomic write leaves the old file byte-for-byte intact", async () => {
  const box = await sandbox();
  try {
    const original = `${JSON.stringify(
      { mcpServers: { alpha: stdioConfig() } },
      null,
      2,
    )}\n`;
    await writeFile(box.userTarget.path, original);
    const failing: McpConfigIo = {
      ...defaultMcpConfigIo,
      rename: () => {
        throw new Error("rename refused by the test");
      },
    };
    assert.throws(
      () => addMcpServer(box.userTarget, "beta", stdioConfig(), failing),
      editErrorCode("write-failed"),
    );
    assert.equal(await readFile(box.userTarget.path, "utf8"), original);
    const leftovers = (await readdir(join(box.factoryDir))).filter((name) =>
      name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

const PERMISSIONS_DOCUMENT = `${JSON.stringify(
  {
    mcpServers: {},
    persistentPermissions: {
      servers: {
        linear: {
          approvedAt: "2026-01-01T00:00:00.000Z",
          impactLevel: "medium",
          serverIdentity: "stdio:linear",
        },
      },
      tools: {
        linear: {
          list_issues: {
            approvedAt: "2026-01-02T00:00:00.000Z",
            impactLevel: "low",
          },
        },
        github: {
          search: {
            approvedAt: "2026-01-03T00:00:00.000Z",
            impactLevel: "high",
          },
        },
      },
    },
  },
  null,
  2,
)}\n`;

test("persistent permissions are read with the nested shape", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.userTarget.path, PERMISSIONS_DOCUMENT);
    const permissions = readPersistentPermissions(box.userTarget);
    assert.deepEqual(Object.keys(permissions.servers), ["linear"]);
    assert.equal(permissions.servers["linear"]?.impactLevel, "medium");
    assert.equal(permissions.servers["linear"]?.serverIdentity, "stdio:linear");
    assert.deepEqual(Object.keys(permissions.tools).sort(), [
      "github",
      "linear",
    ]);
    assert.equal(
      permissions.tools["linear"]?.["list_issues"]?.impactLevel,
      "low",
    );
    assert.equal(countPersistentPermissions(permissions), 3);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("legacy flat tool keys are migrated on read and revoked from the flat shape", async () => {
  const box = await sandbox();
  try {
    await writeFile(
      box.userTarget.path,
      `${JSON.stringify(
        {
          mcpServers: {},
          persistentPermissions: {
            tools: {
              linear___list_issues: {
                approvedAt: "2026-01-01T00:00:00.000Z",
                impactLevel: "low",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const permissions = readPersistentPermissions(box.userTarget);
    assert.equal(
      permissions.tools["linear"]?.["list_issues"]?.impactLevel,
      "low",
    );

    const result = revokeToolPermission(
      box.userTarget,
      "linear",
      "list_issues",
    );
    assert.equal(result.changed, true);
    const parsed = parseJsonc(await readFile(box.userTarget.path, "utf8")) as {
      readonly persistentPermissions: {
        readonly tools: Readonly<Record<string, unknown>>;
      };
    };
    assert.deepEqual(parsed.persistentPermissions.tools, {});
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("revoke tool keeps sibling tools and the server-level approval", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.userTarget.path, PERMISSIONS_DOCUMENT);
    const result = revokeToolPermission(
      box.userTarget,
      "linear",
      "list_issues",
    );
    assert.equal(result.changed, true);
    const permissions = readPersistentPermissions(box.userTarget);
    assert.deepEqual(Object.keys(permissions.servers), ["linear"]);
    assert.deepEqual(Object.keys(permissions.tools["linear"] ?? {}), []);
    assert.deepEqual(Object.keys(permissions.tools["github"] ?? {}), [
      "search",
    ]);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("revoke server cascades to its tools but leaves other servers alone", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.userTarget.path, PERMISSIONS_DOCUMENT);
    const result = revokeServerPermission(box.userTarget, "linear");
    assert.equal(result.changed, true);
    const permissions = readPersistentPermissions(box.userTarget);
    assert.deepEqual(permissions.servers, {});
    assert.equal(Object.hasOwn(permissions.tools, "linear"), false);
    assert.equal(Object.hasOwn(permissions.tools, "github"), true);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("revoke refuses an unknown permission and writes nothing", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.userTarget.path, PERMISSIONS_DOCUMENT);
    const before = await readFile(box.userTarget.path, "utf8");
    assert.throws(
      () => revokeServerPermission(box.userTarget, "nope"),
      editErrorCode("unknown-permission"),
    );
    assert.throws(
      () => revokeToolPermission(box.userTarget, "linear", "nope"),
      editErrorCode("unknown-permission"),
    );
    assert.throws(
      () => revokeToolPermission(box.userTarget, "nope", "list_issues"),
      editErrorCode("unknown-permission"),
    );
    assert.equal(await readFile(box.userTarget.path, "utf8"), before);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("clear removes the whole persistentPermissions member and preserves the rest", async () => {
  const box = await sandbox();
  try {
    const source = [
      "{",
      "  // keep me",
      '  "mcpServers": { "alpha": { "command": "node" } },',
      '  "persistentPermissions": {',
      '    "servers": { "linear": { "approvedAt": "x", "impactLevel": "low" } }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(box.userTarget.path, source);
    const result = clearPersistentPermissions(box.userTarget);
    assert.equal(result.changed, true);
    const text = await readFile(box.userTarget.path, "utf8");
    assert.doesNotMatch(text, /persistentPermissions/);
    assert.match(text, /\/\/ keep me/);
    assert.match(text, /"alpha"/);
    const parsed = parseJsonc(text);
    assert.ok(parsed !== null && typeof parsed === "object");
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

for (const [label, body] of [
  ["a non-object permissions value", '  "persistentPermissions": "nope"'],
  [
    "a non-object servers value",
    '  "persistentPermissions": { "servers": "nope" }',
  ],
  ["an unknown permissions key", '  "persistentPermissions": { "extra": {} }'],
] as const) {
  test(`an unknown permissions shape is refused rather than overwritten (${label})`, async () => {
    const box = await sandbox();
    try {
      const source = `{\n  "mcpServers": {},\n${body}\n}\n`;
      await writeFile(box.userTarget.path, source);
      assert.throws(
        () => readPersistentPermissions(box.userTarget),
        editErrorCode("invalid-permissions"),
      );
      assert.throws(
        () => revokeServerPermission(box.userTarget, "linear"),
        editErrorCode("invalid-permissions"),
      );
      assert.throws(
        () => clearPersistentPermissions(box.userTarget),
        editErrorCode("invalid-permissions"),
      );
      assert.equal(await readFile(box.userTarget.path, "utf8"), source);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });
}
