/** `update` command. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import { DISPLAY, VERSION } from "../brand.ts";
import { runUpdateCommand } from "../update-commands.ts";

export function makeUpdateCommand(): Command {
  return new Command("update")
    .description(`Check for and install ${DISPLAY} updates`)
    .option("-c, --check", "Only check for updates without installing")
    .option(
      "-v, --version <version>",
      "Update to a specific version (e.g., 1.2.3)",
    )
    .action(
      (options: { readonly check?: boolean; readonly version?: string }) => {
        void runUpdateCommand(options, {
          currentVersion: VERSION,
          repository: "z3r0xc/droide",
          fetch,
          write: (text) => process.stdout.write(text),
          writeError: (text) => process.stderr.write(text),
          setExitCode: (code) => {
            process.exitCode = code;
          },
        });
      },
    );
}
