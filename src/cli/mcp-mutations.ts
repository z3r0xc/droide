/**
 * Mutating `mcp` commands: `add`, `remove`, `auth` and
 * `permissions {list,revoke,clear}`. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B1-B7 (files, transport shape,
 * canonical names, the user-file write and its policy gate), B24 (persistent
 * permissions) and B25-B30 (CLI surface and OAuth).
 *
 * `add` and `remove` only ever touch the user `mcp.json` (B6); the project
 * file exists for reads and for {@link addMcpServer} callers, never for a CLI
 * write. Every write is atomic and refuses a document it cannot parse, so a
 * command cannot truncate someone's configuration.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { PROGRAM } from "./brand.ts";
import {
  enabledMcpServers,
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../extensions/mcp/config.ts";
import type { McpServerEntry } from "../extensions/mcp/config.ts";
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
} from "../extensions/mcp/edit.ts";
import type {
  McpConfigIo,
  McpEditTarget,
  McpPersistentPermissionEntry,
  McpPersistentPermissions,
} from "../extensions/mcp/edit.ts";
import { normalizeServerName } from "../extensions/mcp/naming.ts";
import { authorizeServer } from "../extensions/mcp/oauth/flow.ts";
import type { CallbackRunOptions } from "../extensions/mcp/oauth/flow.ts";
import { readCredentials } from "../extensions/mcp/oauth/store.ts";
import type {
  CredentialDocument,
  CredentialSealer,
} from "../extensions/mcp/oauth/store.ts";
import type { RandomSource } from "../extensions/mcp/oauth/pkce.ts";
import {
  SealerUnavailableError,
  createNativeSealer,
} from "../native/sealer.ts";
import type { ClosableCredentialSealer } from "../native/sealer.ts";

/** Where the command reads and writes; `io` is injected in tests. */
export interface McpMutationDeps {
  readonly factoryDir: string;
  readonly projectRoot: string;
  readonly io?: McpConfigIo;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

export interface McpAddOptions {
  readonly type?: string;
  readonly env?: readonly string[];
  readonly header?: readonly string[];
  readonly oauth?: boolean;
}

/** A refusal caused by the user's arguments, not by the filesystem. */
class McpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInputError";
  }
}

function ioFor(deps: McpMutationDeps): McpConfigIo {
  return deps.io ?? defaultMcpConfigIo;
}

/** The user scope is always `<factoryDir>/mcp.json` (B1, B6). */
function userTarget(deps: McpMutationDeps): McpEditTarget {
  return { path: join(deps.factoryDir, "mcp.json"), scope: "user" };
}

function report(deps: McpMutationDeps, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : `Unexpected error: ${String(error)}`;
  deps.writeError(`${PROGRAM}: ${message}\n`);
  deps.setExitCode(1);
}

function looksLikeHttpUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

/**
 * POSIX-style word splitting for a stdio command line: quotes group, and a
 * backslash escapes the next character outside single quotes. Empty quoted
 * arguments are preserved. No shell is ever involved in the eventual spawn.
 */
export function splitCommandLine(input: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let hasContent = false;
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (inSingle) {
      if (character === "'") {
        inSingle = false;
        hasContent = true;
      } else {
        current += character;
      }
      continue;
    }
    if (inDouble) {
      if (character === '"') {
        inDouble = false;
        hasContent = true;
        continue;
      }
      if (character === "\\") {
        const escaped = input[index + 1];
        if (
          escaped === '"' ||
          escaped === "\\" ||
          escaped === "$" ||
          escaped === "`"
        ) {
          current += escaped;
          index += 1;
          continue;
        }
      }
      current += character;
      continue;
    }
    if (character === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (character === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (character === "\\") {
      const escaped = input[index + 1];
      if (escaped !== undefined) {
        current += escaped;
        index += 1;
      } else {
        current += character;
      }
      hasContent = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (hasContent || current.length > 0) {
        words.push(current);
      }
      current = "";
      hasContent = false;
      continue;
    }
    current += character;
    hasContent = true;
  }

  if (inSingle || inDouble) {
    throw new McpInputError("The command contains an unterminated quote.");
  }
  if (hasContent || current.length > 0) words.push(current);
  return words;
}

function parseEnvironment(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new McpInputError(
        `Invalid environment variable "${value}"; expected KEY=VALUE.`,
      );
    }
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function parseHeaders(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    const key = separator === -1 ? "" : value.slice(0, separator).trim();
    const headerValue =
      separator === -1 ? "" : value.slice(separator + 1).trim();
    if (key === "" || headerValue === "") {
      throw new McpInputError(
        `Invalid header "${value}"; expected "KEY: VALUE".`,
      );
    }
    result[key] = headerValue;
  }
  return result;
}

function buildAddConfig(
  urlOrCommand: readonly string[],
  options: McpAddOptions,
): Readonly<Record<string, unknown>> {
  const type = options.type ?? "stdio";
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    throw new McpInputError(
      `Invalid server type "${type}"; expected "stdio", "http" or "sse".`,
    );
  }
  const envValues = options.env ?? [];
  const headerValues = options.header ?? [];
  if (type !== "stdio" && envValues.length > 0) {
    throw new McpInputError("--env is only valid for stdio servers.");
  }
  if (type === "stdio" && headerValues.length > 0) {
    throw new McpInputError("--header is only valid for http/sse servers.");
  }

  const joined = urlOrCommand.join(" ").trim();
  if (joined === "") {
    throw new McpInputError("A URL or command is required.");
  }

  if (type !== "stdio") {
    const url = stripOuterQuotes(joined);
    try {
      new URL(url);
    } catch {
      throw new McpInputError(`Invalid URL "${url}".`);
    }
    const headers = parseHeaders(headerValues);
    return {
      type,
      url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(options.oauth === false ? { oauth: false } : {}),
      disabled: false,
    };
  }

  if (options.type === undefined && looksLikeHttpUrl(joined)) {
    throw new McpInputError(
      `"${joined}" looks like a URL; pass --type http or --type sse.`,
    );
  }
  const parts = splitCommandLine(stripOuterQuotes(joined));
  const command = parts[0];
  if (command === undefined || command === "") {
    throw new McpInputError("The stdio command must not be empty.");
  }
  const env = parseEnvironment(envValues);
  return {
    type: "stdio",
    command,
    ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    disabled: false,
  };
}

function canonicalName(name: string): string {
  try {
    return normalizeServerName(name);
  } catch (error) {
    throw new McpInputError(
      error instanceof Error
        ? error.message
        : `MCP server name "${name}" is not valid.`,
    );
  }
}

export async function runMcpAdd(
  name: string,
  urlOrCommand: readonly string[],
  options: McpAddOptions,
  deps: McpMutationDeps,
): Promise<void> {
  try {
    const config = buildAddConfig(urlOrCommand, options);
    const key = canonicalName(name);
    const merged = loadMcpConfiguration(
      mcpConfigFileSources(deps.factoryDir, deps.projectRoot),
    );
    if (merged.servers.has(key)) {
      throw new McpEditError(
        "duplicate-server",
        `MCP server "${key}" is already configured.`,
        userTarget(deps).path,
      );
    }
    // TODO(spec B7): org MCP policy is remote-only and this build does not
    // resolve it into AppContext, so a server the policy would block is not
    // refused here.
    const target = userTarget(deps);
    const result = addMcpServer(target, name, config, ioFor(deps));
    deps.write(`Added MCP server "${result.key}" to ${target.path}\n`);
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

function removableServerNames(deps: McpMutationDeps): readonly string[] {
  const document = readMcpConfigDocument(userTarget(deps), ioFor(deps));
  if (document === undefined) return [];
  const servers = document.root.members.find(
    (member) => member.key === "mcpServers",
  );
  if (servers === undefined || servers.value.kind !== "object") return [];
  const merged = loadMcpConfiguration(
    mcpConfigFileSources(deps.factoryDir, deps.projectRoot),
  );
  const names = new Set<string>();
  for (const member of servers.value.members) {
    try {
      const name = normalizeServerName(member.key);
      if (merged.servers.get(name)?.level === "user-settings") {
        names.add(name);
      }
    } catch {
      continue;
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export async function runMcpRemove(
  name: string | undefined,
  deps: McpMutationDeps,
): Promise<void> {
  try {
    if (name === undefined) {
      const names = removableServerNames(deps);
      if (names.length === 0) {
        deps.write("No removable MCP servers.\n");
        deps.setExitCode(0);
        return;
      }
      deps.write("Select an MCP server to remove:\n");
      for (const [index, serverName] of names.entries()) {
        deps.write(`  ${index + 1}. ${serverName}\n`);
      }
      deps.writeError(
        `${PROGRAM}: pass a server name: ${PROGRAM} mcp remove <name>\n`,
      );
      deps.setExitCode(1);
      return;
    }
    const key = canonicalName(name);
    const target = userTarget(deps);
    const merged = loadMcpConfiguration(
      mcpConfigFileSources(deps.factoryDir, deps.projectRoot),
    );
    const entry = merged.servers.get(key);
    if (entry !== undefined && entry.level !== "user-settings") {
      throw new McpEditError(
        "unknown-server",
        `MCP server "${key}" is not configured in ${target.path}.`,
        target.path,
      );
    }
    const result = removeMcpServer(target, name, ioFor(deps));
    deps.write(`Removed MCP server "${name}" from ${target.path}\n`);
    if (result.removed.length === 0) deps.setExitCode(1);
    else deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

/**
 * A remote server needs authentication when it has not opted out and has no
 * unexpired credential (§B26, §B29). A credential without `expiresAt` counts as
 * valid: the authority never said it lapses.
 */
function needsAuthentication(
  entry: McpServerEntry,
  credentials: CredentialDocument,
  now: number,
): boolean {
  if (entry.config.type === "stdio") return false;
  if (entry.config.oauth === false) return false;
  const credential = credentials.servers[entry.name];
  if (credential === undefined) return true;
  const expiresAt = credential.tokens.expiresAt;
  return expiresAt !== undefined && expiresAt <= now;
}

/** Injected seams for `mcp auth`; the CLI supplies none of them. */
export interface McpAuthInjection {
  /** Defaults to the deps' factory dir; tests point it at a temp directory. */
  readonly store?: { readonly factoryDir: string };
  readonly sealer?: CredentialSealer;
  /** Absolute helper path; defaults to `DROIDE_NATIVE_BIN`. */
  readonly nativeHelperPath?: string;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: RandomSource;
  readonly signal?: AbortSignal;
  readonly callbackPortStart?: number;
  readonly callbackAttempts?: number;
  readonly authorizationTimeoutMs?: number;
}

/**
 * The platform's URL opener, started detached from a fresh window. The child is
 * only a courier: its exit status says nothing about whether the user finished
 * the flow, which the callback server decides.
 */
function openInBrowser(url: string): Promise<void> {
  const launcher =
    process.platform === "win32"
      ? { command: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : { command: "xdg-open", args: [url] };

  const launched = Promise.withResolvers<void>();
  const child = spawn(launcher.command, launcher.args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.once("error", launched.reject);
  child.once("spawn", () => {
    child.unref();
    launched.resolve();
  });
  return launched.promise;
}

/**
 * The sealer `mcp auth` uses in production. There is no fallback: without the
 * helper the credential store cannot be opened or written, and the ADR forbids
 * a plaintext substitute.
 */
function resolveSealer(injection: McpAuthInjection): ClosableCredentialSealer {
  const helperPath =
    injection.nativeHelperPath ?? process.env["DROIDE_NATIVE_BIN"];
  if (helperPath === undefined || helperPath.trim() === "") {
    throw new SealerUnavailableError(
      "helper-unavailable",
      process.platform,
      "set DROIDE_NATIVE_BIN to the droide-native helper, which seals the credential store",
    );
  }
  return createNativeSealer({ helperPath });
}

export async function runMcpAuth(
  deps: McpMutationDeps,
  injection: McpAuthInjection = {},
): Promise<void> {
  const now = injection.now ?? (() => Date.now());
  const factoryDir = injection.store?.factoryDir ?? deps.factoryDir;
  let owned: ClosableCredentialSealer | undefined;
  try {
    const configuration = loadMcpConfiguration(
      mcpConfigFileSources(deps.factoryDir, deps.projectRoot),
    );
    // A server that opted out of OAuth, or a stdio server, is never a
    // candidate: deciding that needs no credential store, so a run with
    // nothing to do never asks for the sealer.
    const oauthServers = enabledMcpServers(configuration).filter(
      (entry) => entry.config.type !== "stdio" && entry.config.oauth !== false,
    );
    if (oauthServers.length === 0) {
      deps.write("No MCP servers require authentication.\n");
      deps.setExitCode(0);
      return;
    }

    const sealer = injection.sealer ?? (owned = resolveSealer(injection));
    const credentials = await readCredentials({
      factoryDir,
      sealer,
      now,
    });
    const candidates = oauthServers
      .filter((entry) => needsAuthentication(entry, credentials, now()))
      .sort((left, right) => left.name.localeCompare(right.name));

    if (candidates.length === 0) {
      deps.write("No MCP servers require authentication.\n");
      deps.setExitCode(0);
      return;
    }
    deps.write(
      `${candidates.length} MCP server${candidates.length === 1 ? "" : "s"} need${candidates.length === 1 ? "s" : ""} authentication:\n`,
    );
    for (const candidate of candidates) deps.write(`  • ${candidate.name}\n`);

    const callback: CallbackRunOptions = {
      ...(injection.callbackPortStart === undefined
        ? {}
        : { portStart: injection.callbackPortStart }),
      ...(injection.callbackAttempts === undefined
        ? {}
        : { attempts: injection.callbackAttempts }),
      ...(injection.authorizationTimeoutMs === undefined
        ? {}
        : { timeoutMs: injection.authorizationTimeoutMs }),
    };

    let failed = 0;
    for (const candidate of candidates) {
      const config = candidate.config;
      if (config.type === "stdio") continue;
      deps.write(`\nAuthenticating "${candidate.name}"\n`);
      try {
        const stored = await authorizeServer({
          server: {
            name: candidate.name,
            allowedByPolicy: candidate.allowedByPolicy,
          },
          config,
          store: { factoryDir },
          sealer,
          openBrowser: injection.openBrowser ?? openInBrowser,
          fetch: injection.fetch ?? globalThis.fetch,
          clock: now,
          ...(injection.signal === undefined
            ? {}
            : { signal: injection.signal }),
          onStatus: (message) => {
            deps.write(`${message}\n`);
          },
          ...(injection.random === undefined
            ? {}
            : { random: injection.random }),
          ...(Object.keys(callback).length === 0 ? {} : { callback }),
        });
        deps.write(
          `Authenticated "${candidate.name}" (revision ${stored.revision})\n`,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `Unexpected error: ${String(error)}`;
        deps.writeError(`${PROGRAM}: ${message}\n`);
        failed += 1;
      }
    }
    deps.setExitCode(failed === 0 ? 0 : 1);
  } catch (error) {
    report(deps, error);
  } finally {
    if (owned !== undefined) await owned.close();
  }
}

function renderPermissionEntry(entry: McpPersistentPermissionEntry): string {
  return `${entry.impactLevel.padEnd(6)} approved ${entry.approvedAt}`;
}

/** Render persisted approvals; the layout is this build's, the facts are B24's. */
export function renderPersistentPermissions(
  permissions: McpPersistentPermissions,
): string {
  const serverNames = Object.keys(permissions.servers).sort((left, right) =>
    left.localeCompare(right),
  );
  const toolRows: string[] = [];
  for (const serverName of Object.keys(permissions.tools).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const entries = permissions.tools[serverName] ?? {};
    for (const toolName of Object.keys(entries).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const entry = entries[toolName];
      if (entry === undefined) continue;
      toolRows.push(
        `  tool   ${serverName}/${toolName.padEnd(24)} ${renderPermissionEntry(entry)}`,
      );
    }
  }
  if (serverNames.length === 0 && toolRows.length === 0) {
    return "No persistent MCP permissions configured.\n";
  }
  const lines = ["MCP persistent permissions:"];
  for (const serverName of serverNames) {
    const entry = permissions.servers[serverName];
    if (entry === undefined) continue;
    lines.push(
      `  server ${serverName.padEnd(24)} ${renderPermissionEntry(entry)}`,
    );
  }
  lines.push(...toolRows);
  return `${lines.join("\n")}\n`;
}

export async function runMcpPermissionsList(
  deps: McpMutationDeps,
): Promise<void> {
  try {
    const permissions = readPersistentPermissions(
      userTarget(deps),
      ioFor(deps),
    );
    deps.write(renderPersistentPermissions(permissions));
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

export async function runMcpPermissionsRevoke(
  server: string,
  tool: string | undefined,
  deps: McpMutationDeps,
): Promise<void> {
  try {
    if (server === "") throw new McpInputError("A server name is required.");
    const target = userTarget(deps);
    if (tool === undefined) {
      const result = revokeServerPermission(target, server, ioFor(deps));
      if (!result.changed) {
        throw new McpEditError(
          "unknown-permission",
          `MCP server "${server}" has no persistent permissions.`,
          target.path,
        );
      }
      deps.write(`Revoked all permissions for server: ${server}\n`);
    } else {
      if (tool === "")
        throw new McpInputError("A tool name must not be empty.");
      const result = revokeToolPermission(target, server, tool, ioFor(deps));
      if (!result.changed) {
        throw new McpEditError(
          "unknown-permission",
          `MCP tool "${server}___${tool}" has no persistent permission.`,
          target.path,
        );
      }
      deps.write(`Revoked permission for tool: ${server}___${tool}\n`);
    }
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

export async function runMcpPermissionsClear(
  confirm: boolean,
  deps: McpMutationDeps,
): Promise<void> {
  try {
    const permissions = readPersistentPermissions(
      userTarget(deps),
      ioFor(deps),
    );
    const total = countPersistentPermissions(permissions);
    if (total === 0) {
      deps.write("No persistent MCP permissions to clear.\n");
      deps.setExitCode(0);
      return;
    }
    if (!confirm) {
      deps.writeError(
        `This will clear ${total} persistent permission(s).\nTo confirm, run: ${PROGRAM} mcp permissions clear --confirm\n`,
      );
      deps.setExitCode(1);
      return;
    }
    clearPersistentPermissions(userTarget(deps), ioFor(deps));
    deps.write(`Cleared ${total} persistent permission(s)\n`);
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}
