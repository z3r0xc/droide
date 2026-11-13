/**
 * Tooling assembly: the core registry plus every MCP server that is configured
 * and allowed.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B1–B24 (config, identity,
 * discovery) and `specs/30-tools-and-sandbox.md` §B1 (one registry, one
 * catalogue order). A broken server is a diagnostic, not a crash: a run must
 * still start with the servers that work.
 */
import { nativeHelperFile } from "../config/paths.ts";
import { McpClient } from "../extensions/mcp/client.ts";
import {
  type McpConfigDiagnostic,
  type McpServerConfig,
  enabledMcpServers,
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../extensions/mcp/config.ts";
import { createMcpToolDefinitions } from "../extensions/mcp/tools.ts";
import type { McpToolInfo } from "../extensions/mcp/client.ts";
import { createCoreRegistry } from "../tools/index.ts";
import {
  createSearchBackend,
  type NativeBackendKind,
  type SearchBackend,
} from "../tools/native-backend.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { AppContext } from "./context.ts";

export interface ConnectedMcpServer {
  readonly name: string;
  readonly tools: readonly McpToolInfo[];
}

export interface SessionTooling {
  readonly registry: ToolRegistry;
  readonly servers: readonly ConnectedMcpServer[];
  readonly diagnostics: readonly McpConfigDiagnostic[];
  /**
   * The `Glob`/`Grep` discovery backend. `local` unless the helper is
   * configured and installed; either way it degrades rather than fails.
   */
  readonly searchBackend: SearchBackend;
  /** Closes every client and the helper; safe to call twice. */
  close(): Promise<void>;
}

export interface CreateToolingOptions {
  readonly context: AppContext;
  /** Injected in tests; defaults to a real client per server. */
  readonly clientFor?: (server: string, config: McpServerConfig) => McpClient;
  /** Skip connecting servers (doctor, list-only commands). */
  readonly connect?: boolean;
  /**
   * `"helper"` opts `Glob`/`Grep` into `crates/droide-native`; a binary that
   * does not exist means the local walk, and a broken one degrades to it.
   * Defaults to `"helper"`: the app asks, the binary's presence decides.
   */
  readonly nativeBackend?: NativeBackendKind;
  /** Absolute helper path; overrides `DROIDE_NATIVE_BIN` and the helper on PATH. */
  readonly nativeBinaryPath?: string;
}

interface OpenClient {
  readonly client: McpClient;
  readonly close: () => Promise<void>;
}

/**
 * Build the registry a run uses.
 *
 * Ordering: core tools first (registration order is the catalogue order), then
 * MCP tools per server in config order, so `--list-tools` and the model's tool
 * list are stable across runs.
 */
export async function createSessionTooling(
  options: CreateToolingOptions,
): Promise<SessionTooling> {
  const registry = createCoreRegistry();
  const configuredBinary =
    options.nativeBinaryPath ??
    options.context.environment.env["DROIDE_NATIVE_BIN"];
  const searchBackend = await createSearchBackend({
    kind: options.nativeBackend ?? "helper",
    helperPath:
      configuredBinary === undefined || configuredBinary.length === 0
        ? nativeHelperFile(options.context.environment)
        : configuredBinary,
  });
  const sources = mcpConfigFileSources(
    options.context.paths.stateDir,
    options.context.environment.cwd,
  );
  const configuration = loadMcpConfiguration(sources);
  const diagnostics: McpConfigDiagnostic[] = [...configuration.diagnostics];
  const servers: ConnectedMcpServer[] = [];
  const open: OpenClient[] = [];

  if (options.connect !== false) {
    for (const entry of enabledMcpServers(configuration)) {
      const client =
        options.clientFor?.(entry.name, entry.config) ??
        new McpClient({ server: entry.name, config: entry.config });
      try {
        await client.connect();
        const listing = await client.listTools();
        servers.push({ name: entry.name, tools: listing.tools });
        const definitions = createMcpToolDefinitions([
          {
            name: entry.name,
            config: entry.config,
            tools: listing.tools,
            callTool: (tool, args, callOptions) =>
              client.callTool(tool, args, callOptions),
          },
        ]);
        for (const definition of definitions) registry.register(definition);
        open.push({ client, close: () => client.close() });
      } catch (error) {
        diagnostics.push({
          code: "server-unavailable",
          level: entry.level,
          path: entry.rawName,
          message: error instanceof Error ? error.message : String(error),
        });
        await client.close().catch(() => undefined);
      }
    }
  }

  let closed = false;
  return {
    registry,
    servers,
    diagnostics,
    searchBackend,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        ...open.map((entry) => entry.close()),
        searchBackend.close(),
      ]);
    },
  };
}
