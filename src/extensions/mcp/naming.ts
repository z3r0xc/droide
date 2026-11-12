/**
 * MCP identity rules. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B5 (server-name canonicalization) and B17 (tool-name sanitization,
 * truncation and collision suffixes).
 *
 * Every function here is pure: the same inputs must produce the same names on
 * every platform and in every session, because the names reach the model and
 * are cached in transcripts.
 */

import { createHash } from "node:crypto";

/** Separator between server and tool in the provider-facing joined name. */
export const MCP_TOOL_NAME_SEPARATOR = "___";

/** Provider-facing tool names are capped at 64 characters (B17). */
export const MAX_LLM_TOOL_NAME_LENGTH = 64;

/** Characters kept when a name is shortened: `55 + "_" + 8` = 64. */
const TRUNCATED_PREFIX_LENGTH = 55;

/** Canonical server names are capped at 32 characters (B5). */
export const MCP_SERVER_NAME_MAX_LENGTH = 32;

export type McpNamingErrorCode = "invalid-server-name";

export class McpNamingError extends Error {
  readonly code: McpNamingErrorCode;

  constructor(code: McpNamingErrorCode, message: string) {
    super(message);
    this.name = "McpNamingError";
    this.code = code;
  }
}

const ALLOWED_SERVER_CHARACTER = /[A-Za-z0-9_-]/;
const WHITESPACE_OR_SLASH = /[\s/\\]/;
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;
const ALLOWED_LLM_CHARACTER = /[A-Za-z0-9_-]/;

function trimDashes(value: string): string {
  return value.replace(/^-+/, "").replace(/-+$/, "");
}

/**
 * Canonical server name (B5): whitespace, slashes and most punctuation become
 * `-`, characters outside `[A-Za-z0-9_-]` are dropped, repeats collapse, the
 * ends are trimmed and the result is capped at 32 characters. An empty result
 * is the `invalid-server-name` identity.
 */
export function normalizeServerName(raw: string): string {
  let collapsed = "";
  for (const character of raw) {
    if (ALLOWED_SERVER_CHARACTER.test(character)) {
      collapsed += character;
      continue;
    }
    if (
      WHITESPACE_OR_SLASH.test(character) ||
      PUNCTUATION_OR_SYMBOL.test(character)
    ) {
      collapsed += "-";
    }
  }

  let name = trimDashes(collapsed.replace(/-{2,}/g, "-"));
  if (name.length > MCP_SERVER_NAME_MAX_LENGTH) {
    name = trimDashes(name.slice(0, MCP_SERVER_NAME_MAX_LENGTH));
  }
  if (name === "") {
    throw new McpNamingError(
      "invalid-server-name",
      `MCP server name "${raw}" contains no usable characters.`,
    );
  }
  return name;
}

/** First eight hex characters of `sha256(value)`; the suffix identity (B17). */
export function llmIdHashSuffix(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

function truncateLlmId(value: string): string {
  if (value.length <= MAX_LLM_TOOL_NAME_LENGTH) return value;
  return `${value.slice(0, TRUNCATED_PREFIX_LENGTH)}_${llmIdHashSuffix(value)}`;
}

/**
 * Provider sanitization (B17): characters outside `[A-Za-z0-9_-]` become `_`,
 * then a name longer than 64 characters becomes `<first 55>_<hash8>`.
 *
 * Iteration is by code point, so a surrogate pair is replaced by one `_` and
 * can never be split. Idempotent: the output is already provider-safe.
 *
 * TODO(spec): B17 does not say whether the truncation hash covers the raw name
 * or the sanitized name. This implementation hashes the sanitized value, which
 * is what the function receives.
 */
export function sanitizeLlmId(name: string): string {
  let sanitized = "";
  for (const character of name) {
    sanitized += ALLOWED_LLM_CHARACTER.test(character) ? character : "_";
  }
  return truncateLlmId(sanitized);
}

/** The raw joined provider name: `<server>___<tool>` (B17). */
export function joinedLlmToolName(server: string, tool: string): string {
  return `${server}${MCP_TOOL_NAME_SEPARATOR}${tool}`;
}

/** The registered tool id: `mcp_<server>_<tool>` (B16). */
export function mcpToolId(server: string, tool: string): string {
  return `mcp_${server}_${tool}`;
}

/** Display name shown in lists: `[MCP] <server>:<tool>` (B16). */
export function mcpToolDisplayName(server: string, tool: string): string {
  return `[MCP] ${server}:${tool}`;
}

/** Tool catalog group: `MCP:<server>` (B16). */
export function mcpToolkitName(server: string): string {
  return `MCP:${server}`;
}

function withCollisionSuffix(rawName: string, base: string): string {
  const suffix = `_${llmIdHashSuffix(rawName)}`;
  const head =
    base.length + suffix.length > MAX_LLM_TOOL_NAME_LENGTH
      ? base.slice(0, MAX_LLM_TOOL_NAME_LENGTH - suffix.length)
      : base;
  return `${head}${suffix}`;
}

export interface ResolvedLlmToolName {
  readonly rawName: string;
  readonly llmId: string;
  readonly collided: boolean;
}

/**
 * Resolve one server's raw joined tool names to provider-safe llmIds (B17).
 *
 * Names that sanitize to the same string form a collision group. The member
 * that was already provider-safe (`sanitize(raw) === raw`) keeps the clean
 * llmId; every mutated sibling gets `_<hash8(rawName)>`. When no member was
 * already safe, every member gets a suffix. Identical raw names are one tool
 * and never collide with themselves, and the result does not depend on input
 * order beyond the returned ordering.
 */
export function resolveLlmToolNames(
  rawNames: readonly string[],
): readonly ResolvedLlmToolName[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawName of rawNames) {
    if (seen.has(rawName)) continue;
    seen.add(rawName);
    unique.push(rawName);
  }

  const groups = new Map<string, string[]>();
  for (const rawName of unique) {
    const base = sanitizeLlmId(rawName);
    const existing = groups.get(base);
    if (existing === undefined) {
      groups.set(base, [rawName]);
    } else {
      existing.push(rawName);
    }
  }

  const resolved = new Map<string, ResolvedLlmToolName>();
  for (const rawName of unique) {
    const base = sanitizeLlmId(rawName);
    const group = groups.get(base) ?? [];
    if (group.length === 1) {
      resolved.set(rawName, { rawName, llmId: base, collided: false });
      continue;
    }

    const safeMembers = group.filter(
      (member) => sanitizeLlmId(member) === member,
    );
    const keepClean = safeMembers.length === 1 && safeMembers[0] === rawName;
    const llmId = keepClean ? base : withCollisionSuffix(rawName, base);
    resolved.set(rawName, { rawName, llmId, collided: true });
  }

  return unique.map((rawName) => {
    const entry = resolved.get(rawName);
    if (entry === undefined) {
      throw new Error(`Tool name "${rawName}" was not resolved.`);
    }
    return entry;
  });
}

/**
 * Claude Code compatibility alias `mcp__<server>__<tool>` (B17), emitted only
 * when the name reads back unambiguously: it contains no `___` and splitting
 * on the first `__` after `mcp__` recovers the exact server and tool.
 */
export function claudeCodeToolName(
  server: string,
  tool: string,
): string | undefined {
  const alias = `mcp__${server}__${tool}`;
  if (alias.includes(MCP_TOOL_NAME_SEPARATOR)) return undefined;

  const rest = alias.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator === -1) return undefined;
  const recoveredServer = rest.slice(0, separator);
  const recoveredTool = rest.slice(separator + 2);
  if (recoveredServer !== server || recoveredTool !== tool) return undefined;
  return alias;
}
