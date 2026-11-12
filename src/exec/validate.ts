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

/** B41: printed to stderr once when streaming input is selected. */
export const STREAM_JSON_INPUT_DEPRECATION_WARNING =
  "Warning: --input-format stream-json is deprecated. Use --input-format stream-jsonrpc for daemon-compatible JSON-RPC protocol.";

/** `--output-format` defaults to `text` (B18); any other value is refused. */
export function parseOutputFormat(
  value: string | undefined,
): ExecOutputFormat {
  if (value === undefined) return "text";
  if (!isExecOutputFormat(value)) throw new ExecUsageError(INVALID_OUTPUT_FORMAT);
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
export function assertFilePromptConflict(
  options: PromptSourceOptions,
): void {
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