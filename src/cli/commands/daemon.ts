/** `daemon` command. Contract: `specs/70-daemon-and-remote-control.md`. */
import { Command, InvalidArgumentError, Option } from "commander";

import { processEnvironment } from "../../config/paths.ts";
import {
  exportSettingsEnvironment,
  processParentChannel,
  runDaemonCommand,
  type DaemonArgv,
} from "../../daemon/command.ts";
import { PROGRAM } from "../brand.ts";

/** Commander keeps option values as strings; the flags are integers (B1). */
function parseInteger(value: string, what: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || `${parsed}` !== value.trim()) {
    throw new InvalidArgumentError(`${what} must be an integer`);
  }
  return parsed;
}

export function makeDaemonCommand(): Command {
  return new Command("daemon")
    .description("Run the daemon server")
    .option("-p, --port <number>", "TCP port to listen on")
    .option("--host <address>", "Host address to bind to", "127.0.0.1")
    .option("--unix <path>", "Unix socket path (alternative to TCP)")
    .option("-d, --debug", "Enable debug logging", false)
    .addOption(
      new Option("--listen <transport>", "Daemon transport to listen on")
        .choices(["websocket", "ipc"])
        .default("websocket"),
    )
    .option(
      "--droide-path <path>",
      `Path to ${PROGRAM} executable for spawning sessions`,
    )
    .option(
      "--liveness-fd <fd>",
      "Monitor parent process liveness via inherited pipe",
    )
    .option("--parent-pid <pid>", "Monitor parent process")
    .option("--remote-control", "Enable Remote Control")
    .option("--remote-access", "Alias for --remote-control", false)
    .option(
      "--settings <path>",
      "Path to runtime settings file merged for this process only",
    )
    .action(
      async (
        options: Readonly<Record<string, unknown>>,
        command: Command,
      ): Promise<void> => {
        // The root command declares `--settings` too, so the merged view is
        // the only one that sees the flag wherever it was written (B2).
        const merged: Readonly<Record<string, unknown>> =
          command.optsWithGlobals();
        const text = (name: string): string | undefined => {
          const value = merged[name];
          return typeof value === "string" ? value : undefined;
        };
        const flag = (name: string): boolean => merged[name] === true;
        const integer = (name: string): number | undefined => {
          const value = text(name);
          return value === undefined
            ? undefined
            : parseInteger(value, `--${name}`);
        };

        const settings = text("settings");
        // B2: the daemon's own process resolves runtime settings from this file.
        exportSettingsEnvironment(settings, process.env);

        const host = text("host");
        const unixPath = text("unix");
        const droidePath = text("droidePath");
        const port = integer("port");
        const livenessFd = integer("liveness-fd");
        const parentPid = integer("parent-pid");
        const argv: DaemonArgv = {
          ...(port === undefined ? {} : { port }),
          ...(host === undefined ? {} : { host }),
          ...(unixPath === undefined ? {} : { unixPath }),
          debug: flag("debug"),
          listen: text("listen") === "ipc" ? "ipc" : "websocket",
          ...(droidePath === undefined ? {} : { droidePath }),
          ...(livenessFd === undefined ? {} : { livenessFd }),
          ...(parentPid === undefined ? {} : { parentPid }),
          remoteControl: flag("remoteControl") || flag("remoteAccess"),
          ...(settings === undefined ? {} : { settings }),
        };
        const parentChannel = processParentChannel();
        process.exitCode = await runDaemonCommand(argv, {
          environment: processEnvironment(),
          stdout: (line) => {
            process.stdout.write(`${line}\n`);
          },
          stderr: (line) => {
            process.stderr.write(`${line}\n`);
          },
          ...(parentChannel === undefined ? {} : { parentChannel }),
        });
      },
    );
}
