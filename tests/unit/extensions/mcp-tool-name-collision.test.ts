/**
 * Tool-name sanitization, truncation, collision suffixes and the Claude Code
 * alias. Contract: `specs/60-extensions-mcp-and-skills.md` B5, B16, B17.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  claudeCodeToolName,
  joinedLlmToolName,
  MAX_LLM_TOOL_NAME_LENGTH,
  McpNamingError,
  mcpToolDisplayName,
  mcpToolId,
  mcpToolkitName,
  normalizeServerName,
  resolveLlmToolNames,
  sanitizeLlmId,
} from "../../../src/extensions/mcp/naming.ts";

function sha8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

test("test_mcp_name_canonicalization: punctuation collapses, unsupported characters drop", () => {
  assert.equal(normalizeServerName("My Server / v1!!"), "My-Server-v1");
  assert.equal(normalizeServerName("a---b"), "a-b");
  assert.equal(normalizeServerName("-+trim+-"), "trim");
  assert.equal(normalizeServerName("emoji😀name"), "emoji-name");
  assert.equal(normalizeServerName("keep_underscore"), "keep_underscore");
});

test("test_mcp_name_canonicalization: an empty result is invalid-server-name", () => {
  assert.throws(
    () => normalizeServerName("   "),
    (error: unknown) =>
      error instanceof McpNamingError && error.code === "invalid-server-name",
  );
  assert.throws(
    () => normalizeServerName("😀"),
    (error: unknown) =>
      error instanceof McpNamingError && error.code === "invalid-server-name",
  );
});

test("test_mcp_name_canonicalization: names cap at 32 characters", () => {
  const thirtyTwo = "a".repeat(32);
  assert.equal(normalizeServerName(thirtyTwo), thirtyTwo);
  assert.equal(normalizeServerName("b".repeat(33)), "b".repeat(32));
  assert.equal(normalizeServerName(`${"c".repeat(31)}-tail`), "c".repeat(31));
});

test("test_mcp_tool_name_collision: sanitization keeps provider-safe characters and is idempotent", () => {
  const sanitized = sanitizeLlmId("github.create_issue/one");
  assert.equal(sanitized, "github_create_issue_one");
  assert.equal(sanitizeLlmId(sanitized), sanitized);

  const unicode = sanitizeLlmId("café_😀_tool");
  assert.match(unicode, /^[A-Za-z0-9_-]+$/);
  assert.equal(sanitizeLlmId(unicode), unicode);
});

test("test_mcp_tool_name_collision: a 64-character name is untouched and 65 gets a hash suffix", () => {
  const exactly = "a".repeat(MAX_LLM_TOOL_NAME_LENGTH);
  assert.equal(sanitizeLlmId(exactly), exactly);

  const longer = "b".repeat(65);
  const sanitized = sanitizeLlmId(longer);
  assert.equal(sanitized.length, 64);
  assert.equal(sanitized, `${"b".repeat(55)}_${sha8(longer)}`);
});

test("test_mcp_tool_name_collision: unicode truncation never splits a surrogate pair", () => {
  const name = `${"a".repeat(70)}😀`;
  const sanitized = sanitizeLlmId(name);
  assert.equal(sanitized.length, 64);
  assert.equal(sanitized.slice(0, 55), "a".repeat(55));
  assert.ok(
    [...sanitized].every(
      (character) =>
        (character.codePointAt(0) ?? 0) < 0xd800 ||
        (character.codePointAt(0) ?? 0) > 0xdfff,
    ),
  );
  assert.equal(sanitizeLlmId(sanitized), sanitized);
});

test("test_mcp_tool_name_collision: the provider-safe sibling keeps the clean name", () => {
  const resolved = resolveLlmToolNames(["plugin.tool", "plugin_tool"]);
  const mapped = new Map(resolved.map((entry) => [entry.rawName, entry]));

  const clean = mapped.get("plugin_tool");
  const mutated = mapped.get("plugin.tool");
  assert.ok(clean);
  assert.ok(mutated);
  assert.equal(clean.llmId, "plugin_tool");
  assert.equal(clean.collided, true);
  assert.equal(mutated.llmId, `plugin_tool_${sha8("plugin.tool")}`);
  assert.equal(mutated.llmId.length <= 64, true);
  assert.notEqual(clean.llmId, mutated.llmId);
});

test("test_mcp_tool_name_collision: suffixes are stable across input order", () => {
  const forward = resolveLlmToolNames(["a.b", "a_b", "a b"]);
  const backward = resolveLlmToolNames(["a b", "a_b", "a.b"]);

  const byName = (entries: typeof forward): ReadonlyMap<string, string> =>
    new Map(entries.map((entry) => [entry.rawName, entry.llmId]));
  assert.deepEqual(byName(forward), byName(backward));
  assert.equal(new Set(forward.map((entry) => entry.llmId)).size, 3);
});

test("test_mcp_tool_name_collision: distinct raw names never share an llmId", () => {
  const resolved = resolveLlmToolNames([
    "one",
    "one",
    "plugin.tool",
    "plugin_tool",
    "x".repeat(70),
  ]);
  const uniqueRaw = new Set(resolved.map((entry) => entry.rawName));
  const ids = new Set(resolved.map((entry) => entry.llmId));
  assert.equal(resolved.length, uniqueRaw.size);
  assert.equal(ids.size, uniqueRaw.size);
});

test("test_mcp_tool_name_collision: identity helpers follow the registered shape", () => {
  assert.equal(joinedLlmToolName("github", "issue"), "github___issue");
  assert.equal(mcpToolId("github", "issue"), "mcp_github_issue");
  assert.equal(mcpToolDisplayName("github", "issue"), "[MCP] github:issue");
  assert.equal(mcpToolkitName("github"), "MCP:github");
});

test("test_mcp_tool_name_collision: the Claude Code alias is emitted only when unambiguous", () => {
  assert.equal(
    claudeCodeToolName("github", "create_issue"),
    "mcp__github__create_issue",
  );
  assert.equal(claudeCodeToolName("github", "a___b"), undefined);
  assert.equal(claudeCodeToolName("a__b", "issue"), undefined);
  assert.equal(claudeCodeToolName("a_b", "issue"), "mcp__a_b__issue");
});
