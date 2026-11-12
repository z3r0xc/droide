/** `computer` command group. Contract: `specs/70-daemon-and-remote-control.md`. */
import { Command } from "commander";

import { notImplemented } from "../not-implemented.ts";

export function makeComputerCommand(): Command {
  const computer = new Command("computer").description("Manage Remote Control registrations");

  computer
    .command("register")
    .description("Register this machine for Remote Control")
    .argument("[name]", "Computer name (defaults to hostname)")
    .option("-y, --yes", "Skip interactive prompts (auto-clear stale local config)")
    .action(() => notImplemented("computer register"));

  computer
    .command("remove")
    .description("Remove this machine from Remote Control")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(() => notImplemented("computer remove"));

  computer
    .command("list")
    .description("List computers registered for Remote Control")
    .action(() => notImplemented("computer list"));

  computer
    .command("ssh")
    .description("Open SSH connection to a Remote Control computer")
    .argument("<computer-name>", "Computer name to connect to")
    .argument("[command...]", "Command to run instead of an interactive shell (put -- before it)")
    .option("--debug", "Enable debug output")
    .option("--proxy", "Run as stdio proxy (for ProxyCommand)")
    .option("--port <port>", "Target port", "22")
    .action(() => notImplemented("computer ssh"));

  computer
    .command("port-forward")
    .description("Forward local ports to a Remote Control computer")
    .argument("<computer-name>", "Computer name to forward to")
    .argument(
      "<mappings...>",
      "Port mappings: LOCAL:REMOTE binds LOCAL locally (e.g. 8080:80); " +
        "REMOTE uses the same port on both sides (e.g. 5432); " +
        ":REMOTE picks a random free local port (e.g. :9000)",
    )
    .option("--address <addr>", "Local address to bind", "127.0.0.1")
    .option("--debug", "Enable debug output")
    .action(() => notImplemented("computer port-forward"));

  return computer;
}