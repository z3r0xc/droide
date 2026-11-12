/** `daemon` command. Contract: `specs/70-daemon-and-remote-control.md`. */
import { Command, Option } from "commander";

import { notImplemented } from "../not-implemented.ts";

export function makeDaemonCommand(): Command {
  return new Command("daemon")
    .description("Run the Factory daemon server")
    .option("-p, --port <number>", "TCP port to listen on")
    .option("--host <address>", "Host address to bind to", "127.0.0.1")
    .option("--unix <path>", "Unix socket path (alternative to TCP)")
    .option("-d, --debug", "Enable debug logging", false)
    .addOption(
      new Option("--listen <transport>", "Daemon transport to listen on")
        .choices(["websocket", "ipc"])
        .default("websocket"),
    )
    .option("--droid-path <path>", "Path to droid executable for spawning sessions")
    .option("--liveness-fd <fd>", "Monitor parent process liveness via inherited pipe")
    .option("--parent-pid <pid>", "Monitor parent process")
    .option("--remote-control", "Enable Remote Control")
    .option("--remote-access", "Alias for --remote-control", false)
    .option("--settings <path>", "Path to runtime settings file merged for this process only")
    .action(() => notImplemented("daemon"));
}