/**
 * Exec option validation. Contract: `specs/80-exec-and-streaming.md` B7, B41,
 * B4-B5 and the option table.
 *
 * Validation happens before any session or prompt work and throws an
 * `ExecUsageError`; the CLI prints it on stderr and exits `1`. Nothing here
 * writes to a stream, so a caller can keep stdout pure.
 */

import { ExecUsageError } from "./errors.ts";

export const EXEC_OUTPUT_FORMATS = [
  "text",
  "json",
  "stream-json",
  "stream-jsonrpc",
  "acp",
  "acp-daemon",
  "debug",
] as const;

export type ExecOutputFormat = (typeof EXEC_OUTPUT_FORMATS)[number];

export const EXEC_INPUT_FORMATS = ["stream-json", "stream-jsonrpc"] as const;

export type ExecInputFormat = (typeof EXEC_INPUT_FORMATS)[number];

/** The deprecated spellings that still select the JSONL event stream (B24). */
export function isStreamJsonOutput(format: ExecOutputFormat): boolean {
  return format === "stream-json" || format === "debug";
}

const OUTPUT_FORMAT_SET: ReadonlySet<string> = new Set(EXEC_OUTPUT_FORMATS);
const INPUT_FORMAT_SET: ReadonlySet<string> = new Set(EXEC_INPUT_FORMATS);

export function isExecOutputFormat(value: string): value is ExecOutputFormat {
  return OUTPUT_FORMAT_SET.has(value);
}

export function isExecInputFormat(value: string): value is ExecInputFormat {
  return INPUT_FORMAT_SET.has(value);
}

export const INVALID_OUTPUT_FORMAT = "Invalid --output-format value";

export const FILE_PROMPT_CONFLICT =
  "Cannot specify both a file (-f/--file) and a prompt argument.";

export const STREAMING_PROMPT_REFUSED =
  "Cannot use prompt argument in streaming mode. Messages are read from stdin.";

export const STREAM_JSON_OUTPUT_REQUIRED =
  "Invalid flags: --input-format stream-json requires --output-format stream-json (or debug for backward compatibility) for proper event streaming.";

export const STREAM_JSONRPC_OUTPUT_REQUIRED =
  "Invalid flags: --input-format stream-jsonrpc requires --output-format stream-jsonrpc for proper JSON-RPC streaming.";

/** B37: the two session-selection flags cannot be combined. */
export const SESSION_FLAG_CONFLICT =
  "Invalid flags: --session-id and --fork cannot be used together.";

/** B38: spec mode owns its own session lifecycle. */
export const SESSION_SPEC_CONFLICT =
  "Invalid flags: --session-id and --use-spec/--spec-model cannot be used together.";

/** B37: fork is a whole-transcript copy, so these flags have no meaning. */
export const FORK_SPEC_CONFLICT =
  "Invalid flags: --fork and --use-spec/--spec-model cannot be used together.";

export const FORK_WORKTREE_CONFLICT =
  "Invalid flags: --fork and worktree options cannot be used together.";

export const FORK_MISSION_CONFLICT =
  "Invalid flags: --fork and --mission cannot be used together.";

export const FORK_STREAMING_JSONRPC_CONFLICT =
  "Invalid flags: --fork cannot be used with --input-format stream-jsonrpc.";

export const FORK_ACP_CONFLICT =
  "Invalid flags: --fork cannot be used with an ACP output format.";

/** B17: mission mode drives its own sessions. */
export const MISSION_SESSION_CONFLICT =
  "Invalid flags: --mission cannot be used with --session-id.";

/** B41: printed to stderr once when streaming input is selected. */
export const STREAM_JSON_INPUT_DEPRECATION_WARNING =
  "Warning: --input-format stream-json is deprecated. Use --input-format stream-jsonrpc for daemon-compatible JSON-RPC protocol.";

/** `--output-format` defaults to `text` (B18); any other value is refused. */
export function parseOutputFormat(value: string | undefined): ExecOutputFormat {
  if (value === undefined) return "text";
  if (!isExecOutputFormat(value))
    throw new ExecUsageError(INVALID_OUTPUT_FORMAT);
  return value;
}

export function parseInputFormat(
  value: string | undefined,
): ExecInputFormat | undefined {
  if (value === undefined) return undefined;
  if (!isExecInputFormat(value)) {
    throw new ExecUsageError(
      `Invalid --input-format value "${value}". Allowed values: ${EXEC_INPUT_FORMATS.join(", ")}.`,
    );
  }
  return value;
}

export interface PromptSourceOptions {
  readonly promptArg: string | undefined;
  readonly file: string | undefined;
}

/** B4: `--file` and a positional prompt are mutually exclusive. */
export function assertFilePromptConflict(options: PromptSourceOptions): void {
  if (options.file !== undefined && options.promptArg !== undefined) {
    throw new ExecUsageError(FILE_PROMPT_CONFLICT);
  }
}

/** B7: streaming input reads every message from stdin, so argv/file is refused. */
export function assertNoPromptInStreamingInput(
  options: PromptSourceOptions,
  inputFormat: ExecInputFormat | undefined,
): void {
  if (inputFormat === undefined) return;
  if (options.promptArg !== undefined || options.file !== undefined) {
    throw new ExecUsageError(STREAMING_PROMPT_REFUSED);
  }
}

export interface SessionFlagOptions {
  readonly sessionId: string | undefined;
  readonly fork: string | undefined;
  readonly useSpec: boolean;
  readonly specModel: string | undefined;
  readonly mission: boolean;
  readonly worktree: string | boolean | undefined;
  readonly worktreeDir: string | undefined;
  readonly inputFormat: ExecInputFormat | undefined;
  readonly outputFormat: ExecOutputFormat;
}

/**
 * B37/B38 and B17: the session-selection flags and the modes that own session
 * creation instead. Checked before the generic unimplemented-flag refusals, so
 * the conflict's own message wins.
 */
export function assertSessionFlagConflicts(options: SessionFlagOptions): void {
  const specMode = options.useSpec || options.specModel !== undefined;
  if (options.sessionId !== undefined && options.fork !== undefined) {
    throw new ExecUsageError(SESSION_FLAG_CONFLICT);
  }
  if (options.sessionId !== undefined && specMode) {
    throw new ExecUsageError(SESSION_SPEC_CONFLICT);
  }
  if (options.sessionId !== undefined && options.mission) {
    throw new ExecUsageError(MISSION_SESSION_CONFLICT);
  }
  if (options.fork !== undefined) {
    if (specMode) throw new ExecUsageError(FORK_SPEC_CONFLICT);
    if (options.worktree !== undefined || options.worktreeDir !== undefined) {
      throw new ExecUsageError(FORK_WORKTREE_CONFLICT);
    }
    if (options.mission) throw new ExecUsageError(FORK_MISSION_CONFLICT);
    if (options.inputFormat === "stream-jsonrpc") {
      throw new ExecUsageError(FORK_STREAMING_JSONRPC_CONFLICT);
    }
    if (
      options.outputFormat === "acp" ||
      options.outputFormat === "acp-daemon"
    ) {
      throw new ExecUsageError(FORK_ACP_CONFLICT);
    }
  }
}

/** B41, B48: each streaming input format pairs with exactly one output format. */
export function assertInputOutputPair(
  inputFormat: ExecInputFormat | undefined,
  outputFormat: ExecOutputFormat,
): void {
  if (inputFormat === "stream-json" && !isStreamJsonOutput(outputFormat)) {
    throw new ExecUsageError(STREAM_JSON_OUTPUT_REQUIRED);
  }
  if (inputFormat === "stream-jsonrpc" && outputFormat !== "stream-jsonrpc") {
    throw new ExecUsageError(STREAM_JSONRPC_OUTPUT_REQUIRED);
  }
}
