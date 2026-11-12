/** Root command. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import { DISPLAY, DOCS_URL, PROGRAM, VERSION } from "../brand.ts";
import { addRuntimeOptions, examplesBlock } from "../help.ts";
import { notImplemented } from "../not-implemented.ts";
import { writeRefusal } from "../tty.ts";
import { makeComputerCommand } from "./computer.ts";
import { makeDaemonCommand } from "./daemon.ts";
import { makeDoctorCommand } from "./doctor.ts";
import { makeExecCommand } from "./exec.ts";
import { makeMcpCommand } from "./mcp.ts";
import { makePluginCommand } from "./plugin.ts";
import { makeResumeCommand } from "./resume.ts";
import { makeSearchCommand } from "./search.ts";
import { makeUpdateCommand } from "./update.ts";

const EXAMPLES = [
  [`${PROGRAM} "review app.tsx"`, "Start with an initial prompt"],
  [PROGRAM, "Start interactive mode (default)"],
  [`${PROGRAM} resume`, "Pick a previous session to resume"],
  [
    `${PROGRAM} exec "analyze this file"`,
    "Run non-interactively (for scripts/automation)",
  ],
  [`${PROGRAM} exec -f prompt.txt`, "Execute from file (non-interactive)"],
  [`${PROGRAM} update`, "Check for and install updates manually"],
] as const;

export function makeRootCommand(program: Command): Command {
  program
    .name(PROGRAM)
    .usage("[options] [command] [prompt...]")
    .description(`${DISPLAY} - Factory's AI coding agent in your terminal`)
    .version(VERSION, "-v, --version", "output the version number")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--settings <path>", "Path to runtime settings file merged for this process only")
    .option("--append-system-prompt <text>", "Append custom text to the end of the system prompt")
    .option(
      "--append-system-prompt-file <path>",
      "Append file contents to the end of the system prompt",
    )
    .option("-r, --resume [sessionId]", "Resume a session by id or session link (shows a session picker without one)")
    .option("--last", "With --resume: skip the picker and resume the most recent session in the current folder")
    .option("--fork <sessionId>", "Fork and resume a session")
    .option("--cwd <path>", "Working directory path")
    .option("-w, --worktree [name]", "Run in a git worktree")
    .option(
      "--worktree-dir <path>",
      "Deprecated: set the worktree directory in the Factory desktop app instead",
    )
    .option("--auto <level>", "Autonomy level: low|medium|high")
    .option("--use-spec", "Start in spec mode")
    .option("--disable-builtin-skills", "Disable Factory-provided builtin skills");

  program.addHelpCommand("help [command]", "display help for command");
  program.addHelpText("after", `\n${examplesBlock(EXAMPLES)}\n\nFor more details, see: ${DOCS_URL}`);

  program.addCommand(makeResumeCommand());
  program.addCommand(makeExecCommand());
  program.addCommand(makeDaemonCommand());
  program.addCommand(makeSearchCommand());
  program.addCommand(makeUpdateCommand());
  program.addCommand(makeMcpCommand());
  program.addCommand(makePluginCommand());
  program.addCommand(makeComputerCommand());
  program.addCommand(makeDoctorCommand());

  program.action((_options: unknown, command: Command) => {
    // The root declares no arguments on purpose: `[prompt...]` lives in the
    // usage string, and every operand stays available as excess arguments.
    const promptParts = command.args;
    // A prompt with no terminal would start a session nobody can steer.
    if (promptParts.length > 0 && !process.stdin.isTTY) {
      writeRefusal({
        ...(promptParts[0] === undefined ? {} : { promptWord: promptParts[0] }),
        ...(process.env.TERM_PROGRAM === undefined ? {} : { termProgram: process.env.TERM_PROGRAM }),
      }, (text) => process.stderr.write(text));
      process.exit(1);
    }
    notImplemented("interactive");
  });

  return program;
}

/** Shared option group used by session-launching subcommands. */
export { addRuntimeOptions };