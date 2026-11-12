/**
 * `plugin` command group. Contract: `specs/60-extensions-mcp-and-skills.md`.
 *
 * Option shapes and defaults mirror the subject's command factory; the
 * behavioural half lives in the same spec's install/update lifecycle section.
 */
import { Command, Option } from "commander";

import { createAppContext } from "../../app/context.ts";
import { notImplemented } from "../not-implemented.ts";
import { runPluginList } from "../plugin-commands.ts";

const scopeOption = new Option(
  "-s, --scope <scope>",
  "Installation scope",
).choices(["user", "project"]);

export function makePluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage plugins");

  const marketplace = plugin
    .command("marketplace")
    .description("Manage plugin marketplaces");
  marketplace
    .command("add")
    .argument("<url>", "Git URL of the marketplace repository")
    .description("Add a marketplace repository")
    .action(() => notImplemented("plugin marketplace add"));
  marketplace
    .command("remove")
    .argument("<name>", "Name of the marketplace to remove")
    .description("Remove a marketplace")
    .action(() => notImplemented("plugin marketplace remove"));
  marketplace
    .command("list")
    .description("List registered marketplaces")
    .action(() => notImplemented("plugin marketplace list"));
  marketplace
    .command("update")
    .argument("[name]", "Name of the marketplace to update (all if omitted)")
    .description("Update marketplace(s)")
    .action(() => notImplemented("plugin marketplace update"));

  plugin
    .command("install")
    .alias("i")
    .description("Install a plugin")
    .argument(
      "<plugin>",
      "Plugin to install (format: plugin@marketplace, e.g., security-engineer@factory-plugins)",
    )
    .addOption(scopeOption)
    .action(() => notImplemented("plugin install"));

  plugin
    .command("uninstall")
    .alias("remove")
    .description("Uninstall a plugin")
    .argument(
      "<plugin>",
      "Plugin ID to uninstall (e.g., security-engineer@factory-plugins)",
    )
    .addOption(scopeOption)
    .action(() => notImplemented("plugin uninstall"));

  plugin
    .command("update")
    .description("Update plugins")
    .argument("[plugin]", "Plugin ID to update (all plugins if omitted)")
    .addOption(scopeOption)
    .action(() => notImplemented("plugin update"));

  plugin
    .command("list")
    .description("List installed plugins")
    .addOption(scopeOption)
    .action((options: { readonly scope?: string }) => {
      void (async () => {
        const context = await createAppContext();
        await runPluginList(options, {
          context,
          write: (text) => process.stdout.write(text),
          writeError: (text) => process.stderr.write(text),
          setExitCode: (code) => {
            process.exitCode = code;
          },
        });
      })();
    });

  return plugin;
}
