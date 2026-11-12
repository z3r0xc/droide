/**
 * MCP tools as registry definitions. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B15 (config filtering), B16
 * (registration identity and the `external-service` side effect) and B17
 * (provider-safe llmIds).
 *
 * The factory is pure: it takes each server's live listing and a `callTool`
 * seam, and returns definitions. It is deliberately not called by
 * `createCoreRegistry` — the orchestrator decides when MCP tools join the
 * catalog.
 */

import { ToolFailure } from "../../tools/errors.ts";
import { defineTool, type ToolDefinition } from "../../tools/registry.ts";
import type { ToolContext } from "../../tools/context.ts";
import type { Schema } from "../../tools/validate.ts";
import {
  isJsonObject,
  type McpToolCallResult,
  type McpToolInfo,
} from "./client.ts";
import type { McpServerConfig } from "./config.ts";
import { McpError } from "./errors.ts";
import {
  joinedLlmToolName,
  mcpToolDisplayName,
  mcpToolId,
  resolveLlmToolNames,
} from "./naming.ts";

/**
 * The local validator has no JSON-Schema kind, so a server's `inputSchema` is
 * passed to the server intact rather than approximated (B14 pins the listing
 * shape, not the argument grammar).
 *
 * TODO(spec 30 B7): arguments are not validated against the server's JSON
 * Schema before the call.
 */
export const MCP_TOOL_INPUT_SCHEMA: Schema = {
  kind: "any",
  description: "Arguments object as declared by the MCP server's inputSchema",
};

/** The slice of a connected server the factory needs. */
export interface McpServerTools {
  /** Canonical (normalized) server name. */
  readonly name: string;
  readonly config: McpServerConfig;
  readonly tools: readonly McpToolInfo[];
  callTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpToolCallResult>;
}

/**
 * Config filtering (B15): `enabledTools`, when present and non-empty, is a
 * restrictive allowlist; `disabledTools` always wins. An entry matches either
 * the bare tool name or the joined `<server>___<tool>` name.
 */
export function isMcpToolEnabled(
  config: McpServerConfig,
  server: string,
  tool: string,
): boolean {
  const joined = joinedLlmToolName(server, tool);
  const matches = (entry: string): boolean =>
    entry === tool || entry === joined;
  if (
    config.enabledTools !== undefined &&
    config.enabledTools.length > 0 &&
    !config.enabledTools.some(matches)
  ) {
    return false;
  }
  return !(config.disabledTools?.some(matches) ?? false);
}

function descriptionFor(server: string, tool: McpToolInfo): string {
  return tool.description ?? `MCP tool ${server}/${tool.name}`;
}

/**
 * Definitions for every listed, config-enabled tool, in listing order. ids and
 * llmIds come from `naming.ts`, so a registration is stable across sessions and
 * tool-list orderings.
 */
export function createMcpToolDefinitions(
  servers: readonly McpServerTools[],
): readonly ToolDefinition[] {
  const definitions: ToolDefinition[] = [];

  for (const server of servers) {
    const tools = server.tools.filter((tool) =>
      isMcpToolEnabled(server.config, server.name, tool.name),
    );
    const resolved = resolveLlmToolNames(
      tools.map((tool) => joinedLlmToolName(server.name, tool.name)),
    );
    const llmIds = new Map(
      resolved.map((entry) => [entry.rawName, entry.llmId]),
    );

    for (const tool of tools) {
      const id = mcpToolId(server.name, tool.name);
      const llmId =
        llmIds.get(joinedLlmToolName(server.name, tool.name)) ??
        joinedLlmToolName(server.name, tool.name);

      definitions.push(
        defineTool<unknown, ToolContext>({
          id,
          llmId,
          displayName: mcpToolDisplayName(server.name, tool.name),
          description: descriptionFor(server.name, tool),
          inputSchema: MCP_TOOL_INPUT_SCHEMA,
          sideEffects: ["external-service"],
          requiresConfirmation: true,
          run: async (input) => {
            const args = isJsonObject(input) ? input : {};
            try {
              const result = await server.callTool(tool.name, args);
              return result.text;
            } catch (error) {
              if (error instanceof McpError) {
                throw new ToolFailure(error.message, {
                  toolId: id,
                  cause: error,
                });
              }
              throw error;
            }
          },
        }),
      );
    }
  }

  return definitions;
}
