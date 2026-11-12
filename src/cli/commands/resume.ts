/** `resume` command. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import { addRuntimeOptions } from "../help.ts";
import { notImplemented } from "../not-implemented.ts";

export function makeResumeCommand(): Command {
  const command = new Command("resume")
    .description("Resume a session (shows a session picker without an id)")
    .argument("[sessionId]", "Session id or session link to resume directly")
    .argument("[prompt...]", "Prompt to send to the resumed session")
    .option("--fork", "Fork the selected session and resume the fork")
    .option("--last", "Skip the picker and resume the most recent session in the current folder");

  addRuntimeOptions(command);
  command.action(() => notImplemented("resume"));
  return command;
}