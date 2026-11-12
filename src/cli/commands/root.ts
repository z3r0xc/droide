/** Root command. Contract: `specs/10-cli-surface.md`. */
import { Command } from "commander";

import {
  DISPLAY,
  DOCS_URL,
  PRODUCT_VERSION,
  PROGRAM,
  TAGLINE,
} from "../brand.ts";
import {
  createAppContext,
  type AppContext,
  type CreateAppContextOptions,
} from "../../app/context.ts";
import { ConfigError } from "../../config/errors.ts";
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

/** The two streams a terminal launch owns. */
export interface LaunchStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

/**
 * The interactive dispatch (`specs/95-terminal-ui.md`, `specs/10-cli-surface.md`
 * §B20). Kept as a type here so the Ink/React module graph loads only when a
 * launch actually reaches a terminal.
 */
export type LaunchInteractive = (
  context: AppContext,
  streams: LaunchStreams,
) => Promise<number>;

/**
 * Everything the default command needs from the outside. `process` is read
 * once, here, so the dispatch contract is testable without mocking it.
 */
export interface DefaultCommandRuntime {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createContext: (
    options: CreateAppContextOptions,
  ) => Promise<AppContext>;
  readonly launchInteractive: LaunchInteractive;
  readonly setExitCode: (code: number) => void;
  readonly exit: (code: number) => void;
  readonly unimplemented: (command: string) => void;
}

/** True when the launch owns a terminal on both ends (`95` §B18). */
export function isInteractiveTerminal(
  streams: Pick<DefaultCommandRuntime, "stdin" | "stdout">,
): boolean {
  return streams.stdin.isTTY === true && streams.stdout.isTTY === true;
}

const processRuntime: DefaultCommandRuntime = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  createContext: createAppContext,
  // Loaded lazily: `--help`, `--version` and every subcommand must not pay for
  // React and Ink, and must never write a terminal sequence.
  launchInteractive: async (context, streams) => {
    const { runInteractiveShell } = await import("../../app/interactive.ts");
    return runInteractiveShell({
      context,
      stdin: streams.stdin,
      stdout: streams.stdout,
    });
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => {
    process.exit(code);
  },
  unimplemented: notImplemented,
};

/**
 * The default command: the non-TTY refusal first, configuration resolution
 * second, then the interactive surface when — and only when — both streams are
 * terminals. Every other launch stays loudly unimplemented.
 */
export async function runDefaultCommand(
  promptParts: readonly string[],
  options: { readonly settings?: string; readonly cwd?: string },
  runtime: DefaultCommandRuntime,
): Promise<void> {
  // A prompt with no terminal would start a session nobody can steer.
  if (promptParts.length > 0 && runtime.stdin.isTTY !== true) {
    const promptWord = promptParts[0];
    const termProgram = runtime.env.TERM_PROGRAM;
    writeRefusal(
      {
        ...(promptWord === undefined ? {} : { promptWord }),
        ...(termProgram === undefined ? {} : { termProgram }),
      },
      (text) => runtime.stderr.write(text),
    );
    runtime.exit(1);
    return;
  }

  // Startup is where configuration becomes real: a malformed settings file
  // must fail the run before any command does work (spec 10 §B79).
  let context: AppContext;
  try {
    context = await runtime.createContext({
      ...(options.settings === undefined
        ? {}
        : { settingsFlag: options.settings }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    runtime.stderr.write(`${PROGRAM}: ${error.message}\n`);
    runtime.exit(1);
    return;
  }

  // `tui [prompt...]` starts the session with that prompt; the shell has no
  // agent loop to receive it yet, so that path stays loud instead of dropping
  // the user's words.
  if (promptParts.length > 0 || !isInteractiveTerminal(runtime)) {
    runtime.unimplemented("interactive");
    return;
  }

  try {
    runtime.setExitCode(
      await runtime.launchInteractive(context, {
        stdin: runtime.stdin,
        stdout: runtime.stdout,
      }),
    );
  } catch (error) {
    // The shell refuses a terminal that cannot host it (`95` §B18); the CLI
    // falls back to the same loud unfinished-mode exit rather than crashing.
    const { InteractiveUnavailableError } =
      await import("../../app/interactive.ts");
    if (!(error instanceof InteractiveUnavailableError)) throw error;
    runtime.unimplemented("interactive");
  }
}

export function makeRootCommand(
  program: Command,
  runtime: DefaultCommandRuntime = processRuntime,
): Command {
  program
    .name(PROGRAM)
    .usage("[options] [command] [prompt...]")
    .description(`${DISPLAY} - ${TAGLINE}`)
    .version(PRODUCT_VERSION, "-v, --version", "output the version number")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    // B11: root options are read only before the first operand; from the
    // command word onward the tokens belong to the dispatched command.
    .enablePositionalOptions()
    .option(
      "--settings <path>",
      "Path to runtime settings file merged for this process only",
    )
    .option(
      "--append-system-prompt <text>",
      "Append custom text to the end of the system prompt",
    )
    .option(
      "--append-system-prompt-file <path>",
      "Append file contents to the end of the system prompt",
    )
    .option(
      "-r, --resume [sessionId]",
      "Resume a session by id or session link (shows a session picker without one)",
    )
    .option(
      "--last",
      "With --resume: skip the picker and resume the most recent session in the current folder",
    )
    .option("--fork <sessionId>", "Fork and resume a session")
    .option("--cwd <path>", "Working directory path")
    .option("-w, --worktree [name]", "Run in a git worktree")
    .option(
      "--worktree-dir <path>",
      "Deprecated: set the worktree directory in the Factory desktop app instead",
    )
    .option("--auto <level>", "Autonomy level: low|medium|high")
    .option("--use-spec", "Start in spec mode")
    .option(
      "--disable-builtin-skills",
      "Disable Factory-provided builtin skills",
    );

  program.addHelpCommand("help [command]", "display help for command");
  program.addHelpText(
    "after",
    `\n${examplesBlock(EXAMPLES)}\n\nFor more details, see: ${DOCS_URL}`,
  );

  program.addCommand(makeResumeCommand());
  program.addCommand(makeExecCommand());
  program.addCommand(makeDaemonCommand());
  program.addCommand(makeSearchCommand());
  program.addCommand(makeUpdateCommand());
  program.addCommand(makeMcpCommand());
  program.addCommand(makePluginCommand());
  program.addCommand(makeComputerCommand());
  program.addCommand(makeDoctorCommand());

  program.action(
    async (
      options: { readonly settings?: string; readonly cwd?: string },
      command: Command,
    ) => {
      // The root declares no arguments on purpose: `[prompt...]` lives in the
      // usage string, and every operand stays available as excess arguments.
      await runDefaultCommand(command.args, options, runtime);
    },
  );

  return program;
}

/** Shared option group used by session-launching subcommands. */
export { addRuntimeOptions };
