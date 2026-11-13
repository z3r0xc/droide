/**
 * `plugin` command group. Contract: `specs/60-extensions-mcp-and-skills.md`.
 *
 * Option shapes and defaults are the CLI contract; the behavioural half lives
 * in `plugin-commands.ts`. `--branch` on `marketplace add` is hidden: the
 * recorded `plugin --help` and every subcommand help page carry no such
 * option.
 */
import { Command, Help, Option, type HelpConfiguration } from "commander";

import { createAppContext } from "../../app/context.ts";
import { PROGRAM } from "../brand.ts";
import {
  runMarketplaceAdd,
  runMarketplaceList,
  runMarketplaceRemove,
  runMarketplaceUpdate,
  runPluginInstall,
  runPluginList,
  runPluginUninstall,
  runPluginUpdate,
  type PluginCommandDeps,
} from "../plugin-commands.ts";

const scopeOption = new Option(
  "-s, --scope <scope>",
  "Installation scope",
).choices(["user", "project"]);

const branchOption = new Option(
  "--branch <branch>",
  "Branch or tag to check out (defaults to the repository HEAD)",
).hideHelp();

const defaultHelp = new Help();

/**
 * The recorded `marketplace --help` lists `add <url>`, not `add [options]
 * <url>`; the hidden `--branch` option must not leak into that list.
 */
const marketplaceHelp: HelpConfiguration = {
  subcommandTerm(command) {
    const term = defaultHelp.subcommandTerm(command);
    return command.name() === "add" ? term.replace(" [options]", "") : term;
  },
};

/**
 * Build the context, run one command, and report a context failure without an
 * unhandled rejection. The command bodies never touch `process` directly.
 */
function runWithContext(
  action: (deps: PluginCommandDeps) => Promise<void> | void,
): void {
  void (async () => {
    try {
      const context = await createAppContext();
      await action({
        context,
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

export function makePluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage plugins");

  const marketplace = plugin
    .command("marketplace")
    .description("Manage plugin marketplaces")
    .configureHelp(marketplaceHelp);
  marketplace
    .command("add")
    .argument("<url>", "Git URL of the marketplace repository")
    .description("Add a marketplace repository")
    .addOption(branchOption)
    .action((url: string, options: { readonly branch?: string }) => {
      runWithContext((deps) => runMarketplaceAdd(url, options, deps));
    });
  marketplace
    .command("remove")
    .argument("<name>", "Name of the marketplace to remove")
    .description("Remove a marketplace")
    .action((name: string) => {
      runWithContext((deps) => runMarketplaceRemove(name, deps));
    });
  marketplace
    .command("list")
    .description("List registered marketplaces")
    .action(() => {
      runWithContext((deps) => runMarketplaceList(deps));
    });
  marketplace
    .command("update")
    .argument("[name]", "Name of the marketplace to update (all if omitted)")
    .description("Update marketplace(s)")
    .action((name: string | undefined) => {
      runWithContext((deps) => runMarketplaceUpdate(name, deps));
    });

  plugin
    .command("install")
    .alias("i")
    .description("Install a plugin")
    .argument(
      "<plugin>",
      "Plugin to install (format: plugin@marketplace, e.g., security-engineer@droide-plugins)",
    )
    .addOption(scopeOption)
    .action((pluginSpec: string, options: { readonly scope?: string }) => {
      runWithContext((deps) => runPluginInstall(pluginSpec, options, deps));
    });

  plugin
    .command("uninstall")
    .alias("remove")
    .description("Uninstall a plugin")
    .argument(
      "<plugin>",
      "Plugin ID to uninstall (e.g., security-engineer@droide-plugins)",
    )
    .addOption(scopeOption)
    .action((pluginSpec: string, options: { readonly scope?: string }) => {
      runWithContext((deps) => runPluginUninstall(pluginSpec, options, deps));
    });

  plugin
    .command("update")
    .description("Update plugins")
    .argument("[plugin]", "Plugin ID to update (all plugins if omitted)")
    .addOption(scopeOption)
    .action(
      (
        pluginSpec: string | undefined,
        options: { readonly scope?: string },
      ) => {
        runWithContext((deps) => runPluginUpdate(pluginSpec, options, deps));
      },
    );

  plugin
    .command("list")
    .description("List installed plugins")
    .addOption(scopeOption)
    .action((options: { readonly scope?: string }) => {
      runWithContext((deps) => runPluginList(options, deps));
    });

  return plugin;
}
