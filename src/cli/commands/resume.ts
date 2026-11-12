/** `resume` command. Contract: `specs/10-cli-surface.md` §B22–B25. */
import { randomUUID } from "node:crypto";

import { Command } from "commander";

import { createAppContext } from "../../app/context.ts";
import { runExecCommand } from "../../exec/command.ts";
import { openSessionStore } from "../../session/store.ts";
import { PROGRAM } from "../brand.ts";
import { addRuntimeOptions } from "../help.ts";
import { runResumeCommand } from "../resume-commands.ts";

/** Reads stdin to EOF; only the injected exec dependency would ever call it. */
async function readStdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export function makeResumeCommand(): Command {
  const command = new Command("resume")
    .description("Resume a session (shows a session picker without an id)")
    .argument("[sessionId]", "Session id or session link to resume directly")
    .argument("[prompt...]", "Prompt to send to the resumed session")
    .option("--fork", "Fork the selected session and resume the fork")
    .option(
      "--last",
      "Skip the picker and resume the most recent session in the current folder",
    );

  addRuntimeOptions(command);
  command.action(
    async (
      sessionId: string | undefined,
      promptParts: readonly string[],
      _options: Readonly<Record<string, unknown>>,
      dispatched: Command,
    ) => {
      // `--settings`, `--cwd`, `--fork` and `--last` also exist on the root
      // command; the merged view is the only one that sees every spelling.
      const options: Readonly<Record<string, unknown>> =
        dispatched.optsWithGlobals();
      const text = (name: string): string | undefined => {
        const value = options[name];
        return typeof value === "string" ? value : undefined;
      };
      await runResumeCommand(
        {
          sessionId,
          promptParts,
          fork: options["fork"] === true,
          last: options["last"] === true,
          settings: text("settings"),
          cwd: text("cwd"),
        },
        {
          program: PROGRAM,
          stdinIsTTY: process.stdin.isTTY === true,
          stdoutIsTTY: process.stdout.isTTY === true,
          streams: { stdin: process.stdin, stdout: process.stdout },
          stderr: process.stderr,
          createContext: createAppContext,
          openStore: openSessionStore,
          runExec: runExecCommand,
          launchInteractive: async (context, streams, resumed) => {
            // TODO(spec 10 B22): the interactive shell cannot adopt a stored
            // transcript yet, so the resumed session is named here but the
            // shell still opens empty.
            void resumed;
            // A static import would pull React and Ink into `--help`,
            // `--version` and every other subcommand (the same rule the root
            // dispatch follows), so the surface loads only at a terminal.
            const { runInteractiveShell } =
              await import("../../app/interactive.ts");
            return runInteractiveShell({
              context,
              stdin: streams.stdin,
              stdout: streams.stdout,
            });
          },
          readStdin: readStdinText,
          write: (output) => process.stdout.write(output),
          writeError: (output) => process.stderr.write(output),
          setExitCode: (code) => {
            process.exitCode = code;
          },
          clock: Date.now,
          nextId: randomUUID,
        },
      );
    },
  );
  return command;
}
