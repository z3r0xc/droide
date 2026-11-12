/** `mcp` command group. Contract: `specs/60-extensions-mcp-and-skills.md`. */
import { Command } from "commander";

import { notImplemented } from "../not-implemented.ts";

function parseRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function makePermissionsCommand(): Command {
  const permissions = new Command("permissions").description(
    "Manage persistent MCP tool permissions",
  );
  permissions
    .command("list")
    .description("List all persistent MCP permissions")
    .action(() => notImplemented("mcp permissions list"));
  permissions
    .command("revoke")
    .description(
      "Revoke MCP tool or server permission (revoking a server also revokes all per-tool permissions for that server)",
    )
    .argument("<server>", 'Server name (e.g., "linear")')
    .argument("[tool]", 'Optional tool name (e.g., "list_issues")')
    .action(() => notImplemented("mcp permissions revoke"));
  permissions
    .command("clear")
    .description("Clear all persistent MCP permissions")
    .option("--confirm", "Confirm clearing all permissions")
    .action(() => notImplemented("mcp permissions clear"));
  return permissions;
}

export function makeMcpCommand(): Command {
  const mcp = new Command("mcp").description("Manage MCP servers");
  mcp
    .command("add")
    .description("Add a new MCP server")
    .argument("<name>", "Name of the MCP server")
    .argument(
      "<urlOrCommand...>",
      "URL for http/sse servers or command for stdio servers",
    )
    .option(
      "--type <type>",
      'Server type: "http" (streamable), "sse" (remote SSE), or "stdio" (local) (default: stdio)',
    )
    .option(
      "--env <KEY=VALUE>",
      "Environment variable for stdio servers (can be used multiple times)",
      parseRepeated,
      [],
    )
    .option(
      "--header <KEY: VALUE>",
      "HTTP header for remote servers (can be used multiple times)",
      parseRepeated,
      [],
    )
    .option("--no-oauth", "Disable OAuth for header/API-key remote servers")
    .action(() => notImplemented("mcp add"));
  mcp
    .command("remove [name]")
    .description("Remove an MCP server")
    .action(() => notImplemented("mcp remove"));
  mcp
    .command("list")
    .description(
      "List configured MCP servers with connection and authentication status",
    )
    .action(() => notImplemented("mcp list"));
  mcp
    .command("auth")
    .description(
      "Authenticate every MCP server that needs authentication, one at a time",
    )
    .action(() => notImplemented("mcp auth"));
  mcp.addCommand(makePermissionsCommand());
  return mcp;
}
