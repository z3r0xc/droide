/** `update` command. Contract: `specs/10-cli-surface.md`, ADR 0007, ADR 0009. */
import { Command } from "commander";

import { DISPLAY, PRODUCT_VERSION } from "../brand.ts";
import { stateDir, joinPath, processEnvironment } from "../../config/paths.ts";
import { defaultInstallProbe } from "../../update/install.ts";
import { runUpdateCommand } from "../update-commands.ts";

/**
 * The managed installation tree. It lives under the state directory so the
 * installer never guesses at (or overwrites) the directory of the running
 * script; staging is `<installDir>/update/<version>` (ADR 0009).
 */
function installDirectory(): string {
  const environment = processEnvironment();
  return joinPath(environment.platform, stateDir(environment), "install");
}

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
          currentVersion: PRODUCT_VERSION,
          repository: "z3r0xc/droide",
          fetch,
          installDir: installDirectory(),
          // `--version` prints `PRODUCT_VERSION`, so that is the text a
          // successful probe must see; the same constant is compared against
          // the release feed.
          probe: async (input) =>
            defaultInstallProbe({ ...input, version: PRODUCT_VERSION }),
          write: (text) => process.stdout.write(text),
          writeError: (text) => process.stderr.write(text),
          setExitCode: (code) => {
            process.exitCode = code;
          },
        });
      },
    );
}
