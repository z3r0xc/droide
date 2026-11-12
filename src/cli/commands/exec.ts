/**
 * `exec` command. Contract: `specs/80-exec-and-streaming.md`.
 *
 * The subject prints a curated help page for this command rather than
 * Commander's layout, so `-h, --help` is an ordinary option: Commander's
 * built-in help option would otherwise print the wrong page and exit before
 * the action runs. `droid help exec` deliberately keeps Commander's rendering
 * (specs/10-cli-surface.md B26).
 */
import { randomUUID } from "node:crypto";

import { Command, InvalidArgumentError, Option } from "commander";

import { processEnvironment } from "../../config/paths.ts";
import { runExecCommand, type ExecArgv } from "../../exec/command.ts";
import { renderExecHelp } from "../exec-help.ts";
import { execHelpModels } from "../models.ts";
import { PROGRAM } from "../brand.ts";

/** Reads stdin to EOF; only called when the prompt is not on the command line. */
async function readStdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * `--input-format stream-json` reads one message per line as it arrives, so a
 * long-lived writer is not forced to close stdin before the first answer.
 */
async function* readStdinLines(): AsyncGenerator<string> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

function parseToolList(value: string, previous: string[] = []): string[] {
  const parts = value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...previous, ...parts];
}

function collectTag(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseDepth(value: string): number {
  const depth = Number.parseInt(value, 10);
  if (!Number.isFinite(depth))
    throw new InvalidArgumentError("depth must be an integer");
  return depth;
}

export function makeExecCommand(): Command {
  return new Command("exec")
    .helpOption(false)
    .description("Run non-interactively (for scripts/automation)")
    .argument("[prompt]", "The prompt to execute")
    .option("-h, --help", "display help for command")
    .option("-o, --output-format <format>", "Output format", "text")
    .option(
      "--input-format <format>",
      "Input format: stream-json for multi-turn sessions; stream-jsonrpc is controlled via JSON-RPC requests",
    )
    .option("-f, --file <path>", "Read prompt from file")
    .option("--auto <level>", "Autonomy level: low|medium|high")
    .option(
      "--skip-permissions-unsafe",
      "Skip ALL permission checks - allows all permissions (unsafe)",
    )
    .addOption(
      new Option(
        "--tool-execution-mode <mode>",
        "Tool execution mode: direct-only|script-only",
      ).hideHelp(),
    )
    .addOption(
      new Option(
        "--allow-subagents-in-scripts",
        "Allow Task calls from Script for this new session",
      ).hideHelp(),
    )
    .addOption(
      new Option(
        "--no-allow-subagents-in-scripts",
        "Disallow Task calls from Script for this new session",
      )
        .default(undefined)
        .hideHelp(),
    )
    .option(
      "--disable-builtin-skills",
      "Disable Factory-provided builtin skills (not supported in ACP modes)",
    )
    .option(
      "-s, --session-id <id>",
      "Existing session to continue (requires a prompt)",
    )
    .option(
      "--fork <id>",
      "Fork an existing session into a new session (requires a prompt)",
    )
    .option("-m, --model <id>", "Model ID to use")
    .option(
      "-r, --reasoning-effort <level>",
      "Reasoning effort: one of low, medium, high (defaults per model)",
    )
    .option(
      "--spec-model <id>",
      "Model ID to use for spec mode (optional, defaults to main model)",
    )
    .option(
      "--spec-reasoning-effort <level>",
      "Reasoning effort for spec mode (defaults per spec model)",
    )
    .option("--use-spec", "Start in spec mode")
    .option(
      "--only-tools <ids>",
      "Use only tool IDs or MCP:<server>[/<tool>] selectors (comma or space separated list)",
      parseToolList,
      [],
    )
    .option(
      "--add-tools <ids>",
      "Add tool IDs or MCP:<server>[/<tool>] selectors to the selected set (comma or space separated list)",
      parseToolList,
      [],
    )
    .option(
      "--remove-tools <ids>",
      "Remove tool IDs or MCP:<server>[/<tool>] selectors from the allowed set (comma or space separated list)",
      parseToolList,
      [],
    )
    .addOption(
      new Option("--enabled-tools <ids>")
        .argParser(parseToolList)
        .default([])
        .hideHelp(),
    )
    .addOption(
      new Option("--additional-tools <ids>")
        .argParser(parseToolList)
        .default([])
        .hideHelp(),
    )
    .addOption(
      new Option("--disabled-tools <ids>")
        .argParser(parseToolList)
        .default([])
        .hideHelp(),
    )
    .addOption(
      new Option("--restrict-tools <ids>")
        .argParser(parseToolList)
        .default([])
        .hideHelp(),
    )
    .option("--cwd <path>", "Working directory path")
    .option("-w, --worktree [name]", "Run in a git worktree")
    .option(
      "--worktree-dir <path>",
      "Deprecated: set the worktree directory in the Factory desktop app instead",
    )
    .option("--log-group-id <id>", "Log group ID for filtering logs")
    .option(
      "--list-tools",
      "List available tools for the selected model and exit",
    )
    .option("--request-id <id>")
    .option(
      "--depth <number>",
      "Recursion depth for subagent spawning (internal use)",
      parseDepth,
    )
    .option(
      "--init-session-id <id>",
      "Create a new session with this specific ID (internal use, for subagent pre-generation)",
    )
    .option(
      "--calling-session-id <id>",
      "Parent session ID for linking child/subagent sessions (internal use)",
    )
    .option(
      "--calling-tool-use-id <id>",
      "Parent tool use ID that spawned this subagent session (internal use)",
    )
    .option("--session-title <title>", "Session title override (internal use)")
    .option(
      "--tag <spec>",
      "Session tag (name or JSON object, repeatable)",
      collectTag,
      [],
    )
    .option(
      "--mission",
      "Run in mission mode (orchestrate a multi-agent mission)",
    )
    .option(
      "--worker-model <id>",
      "Model ID used by mission workers (only valid with --mission)",
    )
    .option(
      "--worker-reasoning-effort <level>",
      "Reasoning effort for mission workers (only valid with --mission)",
    )
    .option(
      "--validator-model <id>",
      "Model ID used by mission validation workers (only valid with --mission)",
    )
    .option(
      "--validator-reasoning-effort <level>",
      "Reasoning effort for mission validation workers (only valid with --mission)",
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
      "--settings <path>",
      "Path to runtime settings file merged for this process only",
    )
    .action(
      async (
        prompt: string | undefined,
        _options: Readonly<Record<string, unknown>>,
        command: Command,
      ) => {
        // The root command declares `--cwd`, `--settings`, `--auto` and
        // `--use-spec` too, so Commander stores those on the parent; the merged
        // view is the only one that sees every flag wherever it was written.
        const options: Readonly<Record<string, unknown>> =
          command.optsWithGlobals();
        const text = (name: string): string | undefined => {
          const value = options[name];
          return typeof value === "string" ? value : undefined;
        };
        const flag = (name: string): boolean => options[name] === true;
        const optionValue = (name: string): string | boolean | undefined => {
          const value = options[name];
          return typeof value === "string" || typeof value === "boolean"
            ? value
            : undefined;
        };
        const names = (name: string): readonly string[] => {
          const value = options[name];
          return Array.isArray(value)
            ? value.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [];
        };
        if (flag("help")) {
          // The golden page carries the subject's own trailing blank line, so the
          // renderer ends with one newline and the write supplies the second.
          process.stdout.write(`${renderExecHelp(execHelpModels())}\n`);
          return;
        }
        const argv: ExecArgv = {
          prompt,
          file: text("file"),
          outputFormat: text("outputFormat"),
          inputFormat: text("inputFormat"),
          model: text("model"),
          reasoningEffort: text("reasoningEffort"),
          auto: text("auto"),
          skipPermissionsUnsafe: flag("skipPermissionsUnsafe"),
          cwd: text("cwd"),
          settings: text("settings"),
          sessionId: text("sessionId"),
          fork: text("fork"),
          mission: flag("mission"),
          useSpec: flag("useSpec"),
          specModel: text("specModel"),
          listTools: flag("listTools"),
          onlyTools: names("onlyTools"),
          addTools: names("addTools"),
          removeTools: names("removeTools"),
          appendSystemPrompt: text("appendSystemPrompt"),
          appendSystemPromptFile: text("appendSystemPromptFile"),
          worktree: optionValue("worktree"),
          worktreeDir: text("worktreeDir"),
          tags: names("tag"),
        };
        // B46/B57: a streaming input run ends on SIGINT with one final record
        // and exit 0; the signal is delivered to the run, not to the process.
        const streaming = argv.inputFormat === "stream-json";
        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        if (streaming) process.once("SIGINT", onSigint);
        try {
          process.exitCode = await runExecCommand(argv, {
            program: PROGRAM,
            environment: processEnvironment(),
            stdout: process.stdout,
            stderr: process.stderr,
            stdinIsTTY: process.stdin.isTTY === true,
            readStdin: readStdinText,
            readStdinLines,
            clock: Date.now,
            nextId: randomUUID,
            ...(streaming ? { signal: controller.signal } : {}),
          });
        } finally {
          if (streaming) process.off("SIGINT", onSigint);
        }
      },
    );
}
