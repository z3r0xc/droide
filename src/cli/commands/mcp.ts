/** `mcp` command group. Contract: `specs/60-extensions-mcp-and-skills.md`. */
import { Command } from "commander";

import { createAppContext } from "../../app/context.ts";
import { PROGRAM } from "../brand.ts";
import { runMcpList } from "../mcp-commands.ts";
import {
  runMcpAdd,
  runMcpAuth,
  runMcpPermissionsClear,
  runMcpPermissionsList,
  runMcpPermissionsRevoke,
  runMcpRemove,
} from "../mcp-mutations.ts";
import type { McpAddOptions, McpMutationDeps } from "../mcp-mutations.ts";

function parseRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Build the context, run one command, and report a context failure without an
 * unhandled rejection. The command bodies never touch `process` directly.
 */
function runWithContext(
  action: (deps: McpMutationDeps) => Promise<void>,
): void {
  void (async () => {
    try {
      const context = await createAppContext();
      await action({
        factoryDir: context.paths.factoryDir,
        projectRoot: context.environment.cwd,
        write: (text) => process.stdout.write(text),
        writeError: (text) => process.stderr.write(text),
        setExitCode: (code) => {
          process.exitCode = code;
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${PROGRAM}: ${message}\n`);
      process.exitCode = 1;
    }
  })();
}

function makePermissionsCommand(): Command {
  const permissions = new Command("permissions").description(
    "Manage persistent MCP tool permissions",
  );
  permissions
    .command("list")
    .description("List all persistent MCP permissions")
    .action(() => {
      runWithContext((deps) => runMcpPermissionsList(deps));
    });
  permissions
    .command("revoke")
    .description(
      "Revoke MCP tool or server permission (revoking a server also revokes all per-tool permissions for that server)",
    )
    .argument("<server>", 'Server name (e.g., "linear")')
    .argument("[tool]", 'Optional tool name (e.g., "list_issues")')
    .action((server: string, tool: string | undefined) => {
      runWithContext((deps) => runMcpPermissionsRevoke(server, tool, deps));
    });
  permissions
    .command("clear")
    .description("Clear all persistent MCP permissions")
    .option("--confirm", "Confirm clearing all permissions")
    .action((options: { readonly confirm?: boolean }) => {
      runWithContext((deps) =>
        runMcpPermissionsClear(options.confirm === true, deps),
      );
    });
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
    .action(
      (
        name: string,
        urlOrCommand: string[],
        options: McpAddOptions & { readonly oauth?: boolean },
      ) => {
        runWithContext((deps) => runMcpAdd(name, urlOrCommand, options, deps));
      },
    );
  mcp
    .command("remove [name]")
    .description("Remove an MCP server")
    .action((name: string | undefined) => {
      runWithContext((deps) => runMcpRemove(name, deps));
    });
  mcp
    .command("list")
    .description(
      "List configured MCP servers with connection and authentication status",
    )
    .action(() => {
      void (async () => {
        const context = await createAppContext();
        await runMcpList({
          context,
          write: (text) => process.stdout.write(text),
          setExitCode: (code) => {
            process.exitCode = code;
          },
        });
      })();
    });
  mcp
    .command("auth")
    .description(
      "Authenticate every MCP server that needs authentication, one at a time",
    )
    .action(() => {
      runWithContext((deps) => runMcpAuth(deps));
    });
  mcp.addCommand(makePermissionsCommand());
  return mcp;
}
