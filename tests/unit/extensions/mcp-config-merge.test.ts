/**
 * MCP configuration merge and load. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B1, B2, B4, B5.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enabledMcpServers,
  loadMcpConfiguration,
  mcpConfigFileSources,
  mergeMcpServers,
  parseMcpDocument,
  type McpServerLevel,
} from "../../../src/extensions/mcp/config.ts";
import { createTempDirectory, writeFixture } from "./fixtures.ts";

test("test_mcp_config_merge_precedence: the higher level wins the whole entry", () => {
  const levels: readonly McpServerLevel[] = [
    {
      level: "project-settings",
      servers: { shared: { command: "high" } },
    },
    {
      level: "user-settings",
      servers: { shared: { command: "low", args: ["--low"], timeout: 5000 } },
    },
  ];

  const merged = mergeMcpServers(levels);
  const entry = merged.servers.get("shared");
  assert.ok(entry);
  assert.equal(entry.level, "project-settings");
  assert.equal(entry.rawName, "shared");
  assert.equal(entry.config.type, "stdio");
  assert.equal(entry.config.command, "high");
  // Whole-entry override: the lower level's args and timeout are not merged.
  assert.deepEqual(entry.config.args, []);
  assert.equal(entry.config.timeout, undefined);
});

test("test_mcp_config_merge_precedence: aliases canonicalize with the higher level winning", () => {
  const merged = mergeMcpServers([
    {
      level: "project-settings",
      servers: { "my server": { command: "project" } },
    },
    {
      level: "user-settings",
      servers: { "my.server": { command: "user" } },
    },
  ]);

  assert.deepEqual([...merged.servers.keys()], ["my-server"]);
  const entry = merged.servers.get("my-server");
  assert.equal(entry?.level, "project-settings");
  assert.equal(entry?.rawName, "my server");
  assert.equal(entry?.config.command, "project");
});

test("test_mcp_config_merge_precedence: an alias pair inside one level keeps the later spelling", () => {
  const merged = mergeMcpServers([
    {
      level: "user-settings",
      servers: {
        "a b": { command: "first" },
        "a.b": { command: "second" },
      },
    },
  ]);

  const entry = merged.servers.get("a-b");
  assert.equal(entry?.rawName, "a.b");
  assert.equal(entry?.config.command, "second");
});

test("test_mcp_config_merge_precedence: an invalid higher entry does not fall back", () => {
  const merged = mergeMcpServers([
    { level: "project-settings", servers: { shared: { args: [] } } },
    { level: "user-settings", servers: { shared: { command: "user" } } },
  ]);

  assert.equal(merged.servers.has("shared"), false);
  assert.ok(
    merged.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "invalid-server" &&
        diagnostic.serverName === "shared",
    ),
  );
});

test("test_mcp_config_merge_precedence: disabled servers are not in the enabled set", () => {
  const merged = mergeMcpServers([
    {
      level: "user-settings",
      servers: {
        on: { command: "on" },
        off: { command: "off", disabled: true },
      },
    },
  ]);

  assert.deepEqual(
    enabledMcpServers(merged).map((entry) => entry.name),
    ["on"],
  );
});

test("test_mcp_config_discovery_and_tolerance: two files merge project over user", () => {
  const temp = createTempDirectory();
  try {
    const factoryDir = temp.path + "/factory";
    const projectRoot = temp.path + "/project";
    writeFixture(
      factoryDir,
      "mcp.json",
      `{
        // user servers
        "mcpServers": {
          "shared": { "command": "user" },
          "user-only": { "command": "user-only" },
        },
      }`,
    );
    writeFixture(
      projectRoot,
      ".factory/mcp.json",
      `{ "mcpServers": { "shared": { "command": "project" } } }`,
    );

    const configuration = loadMcpConfiguration(
      mcpConfigFileSources(factoryDir, projectRoot),
    );
    assert.deepEqual([...configuration.servers.keys()].sort(), [
      "shared",
      "user-only",
    ]);
    assert.equal(
      configuration.servers.get("shared")?.config.command,
      "project",
    );
    assert.equal(
      configuration.servers.get("user-only")?.level,
      "user-settings",
    );
    assert.deepEqual(configuration.diagnostics, []);
  } finally {
    temp.cleanup();
  }
});

test("test_mcp_config_discovery_and_tolerance: a broken file contributes nothing and is reported", () => {
  const temp = createTempDirectory();
  try {
    const factoryDir = temp.path + "/factory";
    const projectRoot = temp.path + "/project";
    writeFixture(
      factoryDir,
      "mcp.json",
      `{ "mcpServers": { "ok": { "command": "ok" } } }`,
    );
    writeFixture(projectRoot, ".factory/mcp.json", `{ "mcpServers": { "bad": `);

    const configuration = loadMcpConfiguration(
      mcpConfigFileSources(factoryDir, projectRoot),
    );
    assert.deepEqual([...configuration.servers.keys()], ["ok"]);
    assert.ok(
      configuration.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "jsonc-parse-error" &&
          diagnostic.level === "project-settings",
      ),
    );
  } finally {
    temp.cleanup();
  }
});

test("test_mcp_config_discovery_and_tolerance: a missing file is not an error", () => {
  const temp = createTempDirectory();
  try {
    const configuration = loadMcpConfiguration(
      mcpConfigFileSources(temp.path + "/factory", temp.path + "/project"),
    );
    assert.equal(configuration.servers.size, 0);
    assert.deepEqual(configuration.diagnostics, []);
  } finally {
    temp.cleanup();
  }
});

test("test_mcp_config_discovery_and_tolerance: a non-object document contributes nothing", () => {
  const parsed = parseMcpDocument("[]");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "invalid-document");

  const document = parseMcpDocument(`{ "mcpServers": "nope" }`);
  assert.equal(document.ok, false);
});

test("test_mcp_config_discovery_and_tolerance: JSONC comments and trailing commas are accepted", () => {
  const parsed = parseMcpDocument(
    `{
      // a comment
      "mcpServers": {
        "a": { "command": "a", /* inline */ },
      },
    }`,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(Object.keys(parsed.servers), ["a"]);
});
