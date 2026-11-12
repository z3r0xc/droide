/**
 * Org MCP policy. Contract: `specs/60-extensions-mcp-and-skills.md` B7.
 *
 * Enabled policy + empty allowlist allows nothing. Remote entries match by
 * hostname (exact, dotted suffix, wildcard); stdio entries match a normalized
 * token inside the command or one of its args.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enabledMcpServers,
  isMcpServerAllowed,
  mergeMcpServers,
  type McpServerConfig,
  type McpPolicy,
} from "../../../src/extensions/mcp/config.ts";

function remote(url: string): McpServerConfig {
  return {
    type: "http",
    url,
    headers: {},
    disabled: false,
  };
}

function stdio(command: string, args: readonly string[] = []): McpServerConfig {
  return { type: "stdio", command, args, env: {}, disabled: false };
}

test("test_mcp_policy_allowlist: an empty allowlist allows nothing", () => {
  const policy: McpPolicy = { enabled: true, allowlist: [] };
  assert.equal(
    isMcpServerAllowed(remote("https://api.example.com/mcp"), policy),
    false,
  );
  assert.equal(isMcpServerAllowed(stdio("node"), policy), false);
  assert.equal(isMcpServerAllowed(stdio("node"), { enabled: true }), false);
});

test("test_mcp_policy_allowlist: a disabled policy allows everything", () => {
  const policy: McpPolicy = { enabled: false, allowlist: [] };
  assert.equal(
    isMcpServerAllowed(remote("https://api.example.com/mcp"), policy),
    true,
  );
  assert.equal(isMcpServerAllowed(stdio("node"), policy), true);
});

test("test_mcp_policy_allowlist: remote entries match exact, dotted-suffix and wildcard hostnames", () => {
  const exact: McpPolicy = { enabled: true, allowlist: ["api.example.com"] };
  assert.equal(
    isMcpServerAllowed(remote("https://api.example.com/mcp"), exact),
    true,
  );

  const suffix: McpPolicy = { enabled: true, allowlist: ["example.com"] };
  assert.equal(
    isMcpServerAllowed(remote("https://api.example.com/mcp"), suffix),
    true,
  );
  assert.equal(
    isMcpServerAllowed(remote("https://example.com/mcp"), suffix),
    true,
  );
  assert.equal(
    isMcpServerAllowed(remote("https://notexample.com/mcp"), suffix),
    false,
  );

  const wildcard: McpPolicy = { enabled: true, allowlist: ["*.example.com"] };
  assert.equal(
    isMcpServerAllowed(remote("https://api.example.com/mcp"), wildcard),
    true,
  );
  assert.equal(
    isMcpServerAllowed(remote("https://deep.api.example.com/mcp"), wildcard),
    true,
  );
  assert.equal(
    isMcpServerAllowed(remote("https://example.org/mcp"), wildcard),
    false,
  );

  const catchAll: McpPolicy = { enabled: true, allowlist: ["*"] };
  assert.equal(
    isMcpServerAllowed(remote("https://anything.test/mcp"), catchAll),
    true,
  );
});

test("test_mcp_policy_allowlist: allowlist entries may be URLs and are matched on decoded hostnames", () => {
  const urlToken: McpPolicy = {
    enabled: true,
    allowlist: ["https://api.example.com/some/path"],
  };
  assert.equal(
    isMcpServerAllowed(remote("https://api.example.com/mcp"), urlToken),
    true,
  );

  const decoded: McpPolicy = { enabled: true, allowlist: ["bücher.example"] };
  assert.equal(
    isMcpServerAllowed(remote("https://bücher.example/mcp"), decoded),
    true,
  );
});

test("test_mcp_policy_allowlist: stdio entries match a token inside command or args", () => {
  const byCommand: McpPolicy = { enabled: true, allowlist: ["node"] };
  assert.equal(
    isMcpServerAllowed(stdio("/usr/bin/node", ["server.js"]), byCommand),
    true,
  );

  const byArg: McpPolicy = { enabled: true, allowlist: ["server-js"] };
  assert.equal(
    isMcpServerAllowed(stdio("/usr/bin/python", ["/opt/server.js"]), byArg),
    true,
  );

  const denied: McpPolicy = { enabled: true, allowlist: ["python"] };
  assert.equal(
    isMcpServerAllowed(stdio("/usr/bin/node", ["server.js"]), denied),
    false,
  );
});

test("test_mcp_policy_allowlist: a disallowed server is filtered out of the enabled set", () => {
  const merged = mergeMcpServers(
    [
      {
        level: "user-settings",
        servers: {
          allowed: { type: "http", url: "https://api.example.com/mcp" },
          blocked: { type: "http", url: "https://evil.example.org/mcp" },
          disabled: { command: "node", disabled: true },
        },
      },
    ],
    { enabled: true, allowlist: ["example.com"] },
  );

  assert.deepEqual(
    enabledMcpServers(merged).map((entry) => entry.name),
    ["allowed"],
  );
  assert.equal(merged.servers.get("blocked")?.allowedByPolicy, false);
});
