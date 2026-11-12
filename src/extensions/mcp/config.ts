/**
 * MCP configuration. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B1-B5 (files, JSONC tolerance, server schema, merge order, canonical names)
 * and B7 (org allowlist policy).
 *
 * Reading files is the only impure part and is injectable; the merge itself is
 * pure so precedence can be tested without a filesystem.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { domainToUnicode } from "node:url";

import { isRecord } from "../guards.ts";
import { JsoncParseError, parseJsonc } from "../jsonc.ts";
import { normalizeServerName } from "./naming.ts";

/**
 * The settings hierarchy, highest precedence first (B4). `mcpServers` come from
 * the levels that carry settings documents; the others are listed so the order
 * can never drift from the spec.
 */
export const MCP_SETTINGS_LEVELS_HIGHEST_FIRST = [
  "org-settings",
  "org-plugins",
  "settings-overlay",
  "automation-skills",
  "ancestor-folder",
  "project-settings",
  "project-agent",
  "project-plugins",
  "user-settings",
  "user-agent",
  "user-plugins",
  "dynamic",
  "builtin-defaults",
] as const;

export type McpSettingsLevelId =
  (typeof MCP_SETTINGS_LEVELS_HIGHEST_FIRST)[number];

/** Combined connect timeout for HTTP/SSE and the fallback for `connectTimeout`. */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;

/** Combined connect timeout for stdio, which starts a child process (B10). */
export const DEFAULT_MCP_STDIO_CONNECT_TIMEOUT_MS = 30_000;

/** Default tool-call timeout (B20). */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 180_000;

/** Largest accepted value for both limits (B3). */
export const MAX_MCP_TIMEOUT_MS = 2_147_483_647;

/** Largest accepted callback port. TODO(spec): B26 states no bounds. */
const MAX_CALLBACK_PORT = 65_535;

export type McpTransportType = "stdio" | "http" | "sse";

export interface McpOAuthOptions {
  readonly resource?: string;
  readonly authorizationServerIssuer?: string;
  readonly clientMetadataUrl?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackPort?: number;
  readonly tokenEndpointAuthMethod?: string;
}

export interface McpServerCommonConfig {
  readonly disabled: boolean;
  readonly enabledTools?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly timeout?: number;
  readonly connectTimeout?: number;
}

export interface McpStdioServerConfig extends McpServerCommonConfig {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface McpRemoteServerConfig extends McpServerCommonConfig {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly oauth?: false | McpOAuthOptions;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type McpServerParseResult =
  | {
      readonly ok: true;
      readonly config: McpServerConfig;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly McpValidationIssue[] };

function fail(issues: readonly McpValidationIssue[]): McpServerParseResult {
  return { ok: false, issues };
}

function readTransportType(
  value: unknown,
  issues: McpValidationIssue[],
): McpTransportType | undefined {
  if (value === undefined) return "stdio";
  if (value === "stdio" || value === "http" || value === "sse") return value;
  issues.push({
    path: "type",
    message: 'MCP transport type must be "stdio", "http" or "sse".',
  });
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: McpValidationIssue[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  issues.push({ path, message: `"${key}" must be a string.` });
  return undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: McpValidationIssue[],
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, message: `"${key}" must be an array of strings.` });
    return undefined;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== "string") {
      issues.push({
        path: `${path}[${index}]`,
        message: `"${key}" entries must be strings.`,
      });
      continue;
    }
    result.push(entry);
  }
  return result;
}

function readStringMap(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: McpValidationIssue[],
): Readonly<Record<string, string>> {
  const value = record[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push({ path, message: `"${key}" must be an object of strings.` });
    return {};
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      issues.push({
        path: `${path}.${entryKey}`,
        message: `"${key}" values must be strings.`,
      });
      continue;
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string,
  issues: McpValidationIssue[],
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  issues.push({ path, message: `"${key}" must be a boolean.` });
  return fallback;
}

function readBoundedPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  path: string,
  issues: McpValidationIssue[],
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    issues.push({
      path,
      message: `"${key}" must be a positive integer no greater than ${maximum}.`,
    });
    return undefined;
  }
  return value;
}

function readOAuthOptions(
  value: unknown,
  issues: McpValidationIssue[],
): false | McpOAuthOptions | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!isRecord(value)) {
    issues.push({
      path: "oauth",
      message: '"oauth" must be false or an object.',
    });
    return undefined;
  }

  const resource = readString(value, "resource", "oauth.resource", issues);
  const authorizationServerIssuer = readString(
    value,
    "authorizationServerIssuer",
    "oauth.authorizationServerIssuer",
    issues,
  );
  const clientMetadataUrl = readString(
    value,
    "clientMetadataUrl",
    "oauth.clientMetadataUrl",
    issues,
  );
  const clientId = readString(value, "clientId", "oauth.clientId", issues);
  const clientSecret = readString(
    value,
    "clientSecret",
    "oauth.clientSecret",
    issues,
  );
  const callbackPort = readBoundedPositiveInteger(
    value,
    "callbackPort",
    MAX_CALLBACK_PORT,
    "oauth.callbackPort",
    issues,
  );
  const tokenEndpointAuthMethod = readString(
    value,
    "tokenEndpointAuthMethod",
    "oauth.tokenEndpointAuthMethod",
    issues,
  );

  const hasClientCredentials =
    clientId !== undefined || clientSecret !== undefined;
  if (clientMetadataUrl !== undefined && hasClientCredentials) {
    issues.push({
      path: "oauth.clientMetadataUrl",
      message:
        "clientMetadataUrl cannot be combined with configured client credentials.",
    });
  }
  if (
    clientMetadataUrl !== undefined &&
    tokenEndpointAuthMethod !== undefined &&
    tokenEndpointAuthMethod !== "none"
  ) {
    issues.push({
      path: "oauth.tokenEndpointAuthMethod",
      message:
        'clientMetadataUrl requires public token-endpoint auth ("none").',
    });
  }
  if (hasClientCredentials && authorizationServerIssuer === undefined) {
    issues.push({
      path: "oauth.authorizationServerIssuer",
      message:
        "Configured client credentials require authorizationServerIssuer.",
    });
  }

  // TODO(spec): B26 lists the option keys but not the accepted
  // `tokenEndpointAuthMethod` values; only "none" is treated as public here.
  return {
    ...(resource !== undefined ? { resource } : {}),
    ...(authorizationServerIssuer !== undefined
      ? { authorizationServerIssuer }
      : {}),
    ...(clientMetadataUrl !== undefined ? { clientMetadataUrl } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(tokenEndpointAuthMethod !== undefined
      ? { tokenEndpointAuthMethod }
      : {}),
  };
}

/**
 * Validate one `mcpServers.<name>` entry (B3). `type` defaults to `stdio`;
 * stdio requires `command`, remote transports require `url`. Any issue makes
 * the whole entry unusable: a server is never started partially.
 */
export function parseMcpServerConfig(raw: unknown): McpServerParseResult {
  if (!isRecord(raw)) {
    return fail([{ path: "", message: "MCP server entry must be an object." }]);
  }

  const issues: McpValidationIssue[] = [];
  const warnings: string[] = [];
  const type = readTransportType(raw["type"], issues);
  if (type === undefined) return fail(issues);

  const disabled = readBoolean(raw, "disabled", false, "disabled", issues);
  const enabledTools = readStringArray(
    raw,
    "enabledTools",
    "enabledTools",
    issues,
  );
  const disabledTools = readStringArray(
    raw,
    "disabledTools",
    "disabledTools",
    issues,
  );
  const timeout = readBoundedPositiveInteger(
    raw,
    "timeout",
    MAX_MCP_TIMEOUT_MS,
    "timeout",
    issues,
  );
  const connectTimeout = readBoundedPositiveInteger(
    raw,
    "connectTimeout",
    MAX_MCP_TIMEOUT_MS,
    "connectTimeout",
    issues,
  );

  const common = {
    disabled,
    ...(enabledTools !== undefined ? { enabledTools } : {}),
    ...(disabledTools !== undefined ? { disabledTools } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(connectTimeout !== undefined ? { connectTimeout } : {}),
  };

  if (type === "stdio") {
    const command = readString(raw, "command", "command", issues);
    if (command === undefined) {
      if (raw["command"] === undefined) {
        issues.push({ path: "command", message: '"command" is required.' });
      }
    } else if (command.trim() === "") {
      issues.push({ path: "command", message: '"command" must not be empty.' });
    }
    const args = readStringArray(raw, "args", "args", issues) ?? [];
    const env = readStringMap(raw, "env", "env", issues);
    if (issues.length > 0) return fail(issues);
    return {
      ok: true,
      warnings,
      config: {
        type: "stdio",
        command: command ?? "",
        args,
        env,
        ...common,
      },
    };
  }

  const url = readString(raw, "url", "url", issues);
  if (url === undefined) {
    if (raw["url"] === undefined) {
      issues.push({ path: "url", message: '"url" is required.' });
    }
  } else if (url.trim() === "") {
    issues.push({ path: "url", message: '"url" must not be empty.' });
  }
  const headers = readStringMap(raw, "headers", "headers", issues);
  const oauth = readOAuthOptions(raw["oauth"], issues);
  if (issues.length > 0) return fail(issues);
  return {
    ok: true,
    warnings,
    config: {
      type,
      url: url ?? "",
      headers,
      ...(oauth !== undefined ? { oauth } : {}),
      ...common,
    },
  };
}

/** The two MCP config files of a session, highest precedence first (B1). */
export interface McpConfigFileSource {
  readonly level: McpSettingsLevelId;
  readonly path: string;
}

export function mcpConfigFileSources(
  factoryDir: string,
  projectRoot: string,
): readonly McpConfigFileSource[] {
  return [
    {
      level: "project-settings",
      path: join(projectRoot, ".factory", "mcp.json"),
    },
    { level: "user-settings", path: join(factoryDir, "mcp.json") },
  ];
}

export type McpConfigDiagnosticCode =
  | "jsonc-parse-error"
  | "unreadable-file"
  | "invalid-document"
  | "invalid-server-name"
  | "invalid-server";

export interface McpConfigDiagnostic {
  readonly code: McpConfigDiagnosticCode;
  readonly level: McpSettingsLevelId;
  readonly path: string;
  readonly serverName?: string;
  readonly message: string;
}

export interface McpServerEntry {
  /** Canonical (normalized) name: the identity of the server (B5). */
  readonly name: string;
  /** The key the winning entry was written under. */
  readonly rawName: string;
  /** The level that won, and therefore owns the whole entry (B4). */
  readonly level: McpSettingsLevelId;
  readonly config: McpServerConfig;
  readonly allowedByPolicy: boolean;
}

export interface McpConfiguration {
  readonly servers: ReadonlyMap<string, McpServerEntry>;
  readonly diagnostics: readonly McpConfigDiagnostic[];
}

/** One level's raw `mcpServers` map; `levels` are highest precedence first. */
export interface McpServerLevel {
  readonly level: McpSettingsLevelId;
  readonly servers: Readonly<Record<string, unknown>>;
}

export interface McpPolicy {
  readonly enabled: boolean;
  readonly allowlist?: readonly string[];
}

function levelPrecedence(level: McpSettingsLevelId): number {
  const index = MCP_SETTINGS_LEVELS_HIGHEST_FIRST.indexOf(level);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Merge server maps (B4, B5): the first level in the highest-first list wins,
 * whole entry per raw name, then the surviving entries are re-keyed by
 * canonical name so an alias pair resolves to the higher-precedence spelling.
 */
export function mergeMcpServers(
  levels: readonly McpServerLevel[],
  policy?: McpPolicy,
): McpConfiguration {
  const diagnostics: McpConfigDiagnostic[] = [];

  // Whole-entry override on the raw key, lowest level first.
  const rawWinners = new Map<
    string,
    {
      readonly level: McpSettingsLevelId;
      readonly rawEntry: unknown;
      readonly order: number;
    }
  >();
  let order = 0;
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const source = levels[index];
    if (source === undefined) continue;
    for (const [rawName, rawEntry] of Object.entries(source.servers)) {
      rawWinners.set(rawName, {
        level: source.level,
        rawEntry,
        order,
      });
      order += 1;
    }
  }

  // Canonical identity: iterate ascending precedence so the later (higher)
  // alias wins and the earlier spelling is dropped from the canonical view.
  const ascending = [...rawWinners.entries()].sort((left, right) => {
    const leftRank = levelPrecedence(left[1].level);
    const rightRank = levelPrecedence(right[1].level);
    if (leftRank !== rightRank) return rightRank - leftRank;
    return left[1].order - right[1].order;
  });

  interface CanonicalWinner {
    readonly rawName: string;
    readonly level: McpSettingsLevelId;
    readonly rawEntry: unknown;
  }
  const canonical = new Map<string, CanonicalWinner>();
  for (const [rawName, winner] of ascending) {
    let name: string;
    try {
      name = normalizeServerName(rawName);
    } catch (error) {
      diagnostics.push({
        code: "invalid-server-name" as const,
        level: winner.level,
        path: "<mcpServers>",
        serverName: rawName,
        message:
          error instanceof Error
            ? error.message
            : `MCP server name "${rawName}" is not valid.`,
      });
      continue;
    }
    canonical.set(name, {
      rawName,
      level: winner.level,
      rawEntry: winner.rawEntry,
    });
  }

  const servers = new Map<string, McpServerEntry>();
  for (const [name, winner] of canonical) {
    const parsed = parseMcpServerConfig(winner.rawEntry);
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        diagnostics.push({
          code: "invalid-server" as const,
          level: winner.level,
          path: `<mcpServers>.${winner.rawName}${
            issue.path === "" ? "" : `.${issue.path}`
          }`,
          serverName: name,
          message: issue.message,
        });
      }
      continue;
    }
    servers.set(name, {
      name,
      rawName: winner.rawName,
      level: winner.level,
      config: parsed.config,
      allowedByPolicy: isMcpServerAllowed(parsed.config, policy),
    });
  }

  return { servers, diagnostics };
}

function normalizePolicyText(value: string): string {
  let normalized = "";
  for (const character of value.toLowerCase()) {
    normalized += /[a-z0-9]/.test(character) ? character : "-";
  }
  return normalized
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function hostnamePattern(token: string): string {
  const trimmed = token.trim().toLowerCase();
  if (trimmed.includes("://")) {
    try {
      return domainToUnicode(new URL(trimmed).hostname).toLowerCase();
    } catch {
      return trimmed;
    }
  }
  const host = trimmed.split("/")[0] ?? trimmed;
  return host.replace(/:\d+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostnameMatches(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const expression = new RegExp(
      `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
      "i",
    );
    return expression.test(hostname);
  }
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function remoteHostname(url: string): string | undefined {
  try {
    return domainToUnicode(new URL(url).hostname).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Org MCP policy (B7). With the policy off every server is allowed; with it on
 * an empty allowlist allows nothing, remote entries match the URL's hostname,
 * and stdio entries match a normalized token against the command and args.
 *
 * TODO(spec): B7 does not pin the normalization used for the stdio substring
 * comparison; this implementation lowercases and collapses non-alphanumerics.
 */
export function isMcpServerAllowed(
  config: McpServerConfig,
  policy: McpPolicy | undefined,
): boolean {
  if (policy === undefined || !policy.enabled) return true;
  const allowlist = policy.allowlist;
  if (allowlist === undefined || allowlist.length === 0) return false;

  if (config.type === "stdio") {
    const haystack = [config.command, ...config.args]
      .map(normalizePolicyText)
      .join("-");
    for (const token of allowlist) {
      const normalizedToken = normalizePolicyText(token);
      if (normalizedToken === "") continue;
      if (haystack.includes(normalizedToken)) return true;
    }
    return false;
  }

  const hostname = remoteHostname(config.url);
  if (hostname === undefined) return false;
  for (const token of allowlist) {
    const pattern = hostnamePattern(token);
    if (pattern !== "" && hostnameMatches(hostname, pattern)) return true;
  }
  return false;
}

/** Servers that may actually be connected: allowed by policy and not disabled. */
export function enabledMcpServers(
  configuration: McpConfiguration,
): readonly McpServerEntry[] {
  return [...configuration.servers.values()].filter(
    (entry) => entry.allowedByPolicy && !entry.config.disabled,
  );
}

export type McpDocumentParseResult =
  | {
      readonly ok: true;
      readonly servers: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly code: "jsonc-parse-error" | "invalid-document";
      readonly message: string;
    };

/**
 * Read an `mcp.json` document (B2). A parse error, a non-object document or a
 * non-object `mcpServers` contributes no servers; none of these throws.
 */
export function parseMcpDocument(text: string): McpDocumentParseResult {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    return {
      ok: false,
      code: "jsonc-parse-error",
      message:
        error instanceof JsoncParseError
          ? `mcp.json could not be parsed: ${error.message}`
          : "mcp.json could not be parsed.",
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      code: "invalid-document",
      message: "mcp.json must contain an object.",
    };
  }
  const servers = parsed["mcpServers"];
  if (servers === undefined) return { ok: true, servers: {} };
  if (!isRecord(servers)) {
    return {
      ok: false,
      code: "invalid-document",
      message: '"mcpServers" must be an object.',
    };
  }
  // TODO(spec): B2 lists `persistentPermissions` in the document shape; the
  // permission gate (B24) owns it and no reader here consumes it yet.
  return { ok: true, servers };
}

/** Reads a file's text; the default exists so callers need no filesystem. */
export type McpConfigFileReader = (path: string) => string;

export interface LoadMcpConfigurationOptions {
  readonly readFile?: McpConfigFileReader;
  readonly policy?: McpPolicy;
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Load the session's MCP config files (B1, B2) and merge them (B4, B5).
 * `sources` are highest precedence first. A missing file is not an error; an
 * unreadable or unparseable file contributes no servers and a diagnostic.
 */
export function loadMcpConfiguration(
  sources: readonly McpConfigFileSource[],
  options: LoadMcpConfigurationOptions = {},
): McpConfiguration {
  const readFile: McpConfigFileReader =
    options.readFile ?? ((path) => readFileSync(path, "utf8"));
  const levels: McpServerLevel[] = [];
  const diagnostics: McpConfigDiagnostic[] = [];

  for (const source of sources) {
    let text: string;
    try {
      text = readFile(source.path);
    } catch (error) {
      if (!isMissingFile(error)) {
        diagnostics.push({
          code: "unreadable-file" as const,
          level: source.level,
          path: source.path,
          message:
            error instanceof Error
              ? error.message
              : "mcp.json could not be read.",
        });
      }
      continue;
    }

    const document = parseMcpDocument(text);
    if (!document.ok) {
      diagnostics.push({
        code: document.code,
        level: source.level,
        path: source.path,
        message: document.message,
      });
      continue;
    }
    levels.push({ level: source.level, servers: document.servers });
  }

  const merged = mergeMcpServers(levels, options.policy);
  return {
    servers: merged.servers,
    diagnostics: [...diagnostics, ...merged.diagnostics],
  };
}
