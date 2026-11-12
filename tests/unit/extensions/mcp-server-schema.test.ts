/**
 * MCP server schema by transport. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B3 and B26.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_MCP_TIMEOUT_MS,
  parseMcpServerConfig,
} from "../../../src/extensions/mcp/config.ts";

test("test_mcp_server_schema_by_transport: type defaults to stdio", () => {
  const parsed = parseMcpServerConfig({ command: "node" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.type, "stdio");
  if (parsed.config.type !== "stdio") return;
  assert.equal(parsed.config.command, "node");
  assert.deepEqual(parsed.config.args, []);
  assert.deepEqual(parsed.config.env, {});
  assert.equal(parsed.config.disabled, false);
});

test("test_mcp_server_schema_by_transport: stdio accepts args, env and filters", () => {
  const parsed = parseMcpServerConfig({
    type: "stdio",
    command: "node",
    args: ["server.js"],
    env: { TOKEN: "${TOKEN}" },
    enabledTools: ["read"],
    disabledTools: ["write"],
    timeout: 5000,
    connectTimeout: 2000,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.enabledTools, ["read"]);
  assert.deepEqual(parsed.config.disabledTools, ["write"]);
  assert.equal(parsed.config.timeout, 5000);
  assert.equal(parsed.config.connectTimeout, 2000);
});

test("test_mcp_server_schema_by_transport: stdio requires a non-empty command", () => {
  assert.equal(parseMcpServerConfig({ args: [] }).ok, false);
  assert.equal(parseMcpServerConfig({ command: "  " }).ok, false);
  assert.equal(parseMcpServerConfig({ command: 4 }).ok, false);
});

test("test_mcp_server_schema_by_transport: http and sse require url and accept headers", () => {
  for (const type of ["http", "sse"] as const) {
    const parsed = parseMcpServerConfig({
      type,
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.config.type, type);
    if (parsed.config.type === "stdio") return;
    assert.equal(parsed.config.url, "https://example.com/mcp");
    assert.deepEqual(parsed.config.headers, {
      Authorization: "Bearer ${TOKEN}",
    });
  }
  assert.equal(parseMcpServerConfig({ type: "http" }).ok, false);
  assert.equal(parseMcpServerConfig({ type: "sse", url: "" }).ok, false);
});

test("test_mcp_server_schema_by_transport: unknown types and wrong field types are rejected", () => {
  assert.equal(parseMcpServerConfig({ type: "ws", url: "x" }).ok, false);
  assert.equal(parseMcpServerConfig({ command: "x", args: "a" }).ok, false);
  assert.equal(parseMcpServerConfig({ command: "x", env: { A: 1 } }).ok, false);
  assert.equal(parseMcpServerConfig({ command: "x", disabled: "no" }).ok, false);
  assert.equal(
    parseMcpServerConfig({ command: "x", enabledTools: [1] }).ok,
    false,
  );
});

test("test_mcp_server_schema_by_transport: limits are positive integers up to the int32 maximum", () => {
  assert.equal(
    parseMcpServerConfig({ command: "x", timeout: 0 }).ok,
    false,
  );
  assert.equal(
    parseMcpServerConfig({ command: "x", timeout: -1 }).ok,
    false,
  );
  assert.equal(
    parseMcpServerConfig({ command: "x", connectTimeout: 1.5 }).ok,
    false,
  );
  assert.equal(
    parseMcpServerConfig({
      command: "x",
      timeout: MAX_MCP_TIMEOUT_MS + 1,
    }).ok,
    false,
  );
  assert.equal(
    parseMcpServerConfig({
      command: "x",
      timeout: MAX_MCP_TIMEOUT_MS,
    }).ok,
    true,
  );
});

test("test_mcp_oauth_config_constraints: oauth false disables authentication", () => {
  const parsed = parseMcpServerConfig({
    type: "http",
    url: "https://example.com/mcp",
    oauth: false,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  if (parsed.config.type === "stdio") return;
  assert.equal(parsed.config.oauth, false);
});

test("test_mcp_oauth_config_constraints: client metadata and client credentials are mutually exclusive", () => {
  const conflict = parseMcpServerConfig({
    type: "http",
    url: "https://example.com/mcp",
    oauth: {
      clientMetadataUrl: "https://example.com/client.json",
      clientId: "abc",
      authorizationServerIssuer: "https://issuer.example.com",
    },
  });
  assert.equal(conflict.ok, false);

  const publicAuth = parseMcpServerConfig({
    type: "http",
    url: "https://example.com/mcp",
    oauth: {
      clientMetadataUrl: "https://example.com/client.json",
      tokenEndpointAuthMethod: "none",
    },
  });
  assert.equal(publicAuth.ok, true);

  const privateAuth = parseMcpServerConfig({
    type: "http",
    url: "https://example.com/mcp",
    oauth: {
      clientMetadataUrl: "https://example.com/client.json",
      tokenEndpointAuthMethod: "client_secret_basic",
    },
  });
  assert.equal(privateAuth.ok, false);
});

test("test_mcp_oauth_config_constraints: configured client credentials require an issuer", () => {
  const missingIssuer = parseMcpServerConfig({
    type: "sse",
    url: "https://example.com/mcp",
    oauth: { clientId: "abc", clientSecret: "secret" },
  });
  assert.equal(missingIssuer.ok, false);

  const complete = parseMcpServerConfig({
    type: "sse",
    url: "https://example.com/mcp",
    oauth: {
      clientId: "abc",
      clientSecret: "secret",
      authorizationServerIssuer: "https://issuer.example.com",
    },
  });
  assert.equal(complete.ok, true);
});