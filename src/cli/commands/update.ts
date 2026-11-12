/** `update` command. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import { DISPLAY } from "../brand.ts";
import { notImplemented } from "../not-implemented.ts";

export function makeUpdateCommand(): Command {
  return new Command("update")
    .description(`Check for and install ${DISPLAY} updates`)
    .option("-c, --check", "Only check for updates without installing")
    .option(
      "-v, --version <version>",
      "Update to a specific version (e.g., 1.2.3)",
    )
    .action(() => notImplemented("update"));
}
