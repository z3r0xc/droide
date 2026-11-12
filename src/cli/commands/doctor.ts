/** `doctor` command. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import { notImplemented } from "../not-implemented.ts";

const DEFAULT_NOTE = [
  "By default, doctor runs every check except inference, custom-models, mcp, and exec.",
  "MCP checks can start configured servers but call no tools.",
  "Model checks can use FSC or provider money. Exec also runs normal startup hooks.",
  "Example: droide doctor --checks config,connectivity,mcp",
].join("\n");

export function makeDoctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Diagnose configuration, connectivity, certificate, proxy, auth, and daemon issues",
    )
    .option("--json", "Output results as JSON")
    .option(
      "--verbose",
      "Expand all checks with details, fixes, timings, and metadata",
    )
    .option(
      "--timeout <ms>",
      "Per-probe timeout in milliseconds, cleanup included (default: 10000; MCP server: 36000; exec full turn: 60000)",
    )
    .option(
      "--checks <names>",
      "Run only these comma-separated checks: config, environment, system, binaries, updates, filesystem, git, custom-models, proxy, certs, connectivity, auth, daemon, inference, mcp, exec. Use all to include checks that start servers or cost FSC or provider money",
    )
    .addHelpText("after", `\n${DEFAULT_NOTE}\n`)
    .action(() => notImplemented("doctor"));
}
