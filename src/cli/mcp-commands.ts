/**
 * `mcp` command bodies.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B1–B10 (locations, merge,
 * per-name override, policy) and §B56 for the listing. The listing layout is
 * ours (open question 4 of that spec), and every row carries only facts the
 * loader produced.
 *
 * `mcp list` is read-only on purpose: it never starts a server, so it cannot
 * hang, cost money or run a stranger's command just to answer "what is
 * configured".
 */
import {
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../extensions/mcp/config.ts";
import type {
  McpConfiguration,
  McpServerConfig,
  McpServerEntry,
} from "../extensions/mcp/config.ts";
import type { AppContext } from "../app/context.ts";

export interface McpListDeps {
  readonly context: AppContext;
  readonly write: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

function describeTransport(config: McpServerConfig): string {
  if (config.type === "stdio") {
    const args = config.args.length === 0 ? "" : ` ${config.args.join(" ")}`;
    return `stdio  ${config.command}${args}`;
  }
  return `${config.type.padEnd(6)} ${config.url}`;
}

function describeState(entry: McpServerEntry): string {
  if (!entry.allowedByPolicy) return "blocked by policy";
  if (entry.config.disabled) return "disabled";
  return "enabled";
}

/** Render the merged server list. Pure: the caller supplies the configuration. */
export function renderMcpList(configuration: McpConfiguration): string {
  const entries = [...configuration.servers.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const enabled = entries.filter(
    (entry) => entry.allowedByPolicy && !entry.config.disabled,
  ).length;

  const lines: string[] = [];
  lines.push(
    `${entries.length} server${entries.length === 1 ? "" : "s"} configured, ${enabled} enabled`,
  );

  if (entries.length > 0) {
    const nameWidth = Math.max(...entries.map((entry) => entry.name.length));
    const transportWidth = Math.max(
      ...entries.map((entry) => describeTransport(entry.config).length),
    );
    for (const entry of entries) {
      lines.push(
        `  ${entry.name.padEnd(nameWidth)}  ${describeTransport(entry.config).padEnd(transportWidth)}  ${describeState(entry)}`,
      );
    }
  }

  if (configuration.diagnostics.length > 0) {
    lines.push("", "problems:");
    for (const diagnostic of configuration.diagnostics) {
      lines.push(`  ${diagnostic.path}: ${diagnostic.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runMcpList(deps: McpListDeps): Promise<void> {
  const sources = mcpConfigFileSources(
    deps.context.paths.factoryDir,
    deps.context.environment.cwd,
  );
  const configuration = loadMcpConfiguration(sources);
  deps.write(renderMcpList(configuration));
  // Diagnostics mean a file could not be understood; that is a failure of the
  // command, not of the servers.
  deps.setExitCode(
    configuration.diagnostics.some(
      (diagnostic) => diagnostic.code !== "server-unavailable",
    )
      ? 1
      : 0,
  );
}

/** Parse the tool filters a user may have written, for the listing header. */
export function describeFilters(config: McpServerConfig): string {
  const parts: string[] = [];
  if (config.enabledTools !== undefined && config.enabledTools.length > 0) {
    parts.push(`only ${config.enabledTools.join(",")}`);
  }
  if (config.disabledTools !== undefined && config.disabledTools.length > 0) {
    parts.push(`without ${config.disabledTools.join(",")}`);
  }
  if (config.timeout !== undefined) parts.push(`timeout ${config.timeout}ms`);
  return parts.join("; ");
}
