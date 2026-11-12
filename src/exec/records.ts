/**
 * The stream-json wire records and the `-o json` summary.
 * Contract: `specs/80-exec-and-streaming.md` B21-B31.
 *
 * Builders exist so the key names, casing and insertion order live in one
 * place: `JSON.stringify` preserves that order, and a caller comparing whole
 * lines sees exactly the shape in the spec tables. Nothing here reads the
 * clock or performs I/O; the caller injects `timestamp`, ids and session id.
 */

import { ExecStreamError } from "./errors.ts";

/** Token usage in exec's snake_case shape (B23). `ttft_ms` only when known. */
export interface ExecUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly factory_credits: number;
  readonly thinking_tokens: number;
  readonly ttft_ms?: number;
}

export const ZERO_USAGE: ExecUsage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  factory_credits: 0,
  thinking_tokens: 0,
});

export type MessageRole = "user" | "assistant";
export type ErrorSource = "cli" | "agent_loop";

export interface SystemInitRecord {
  readonly type: "system";
  readonly subtype: "init";
  readonly cwd: string;
  readonly session_id: string;
  readonly tools: readonly string[];
  readonly model: string;
  readonly reasoning_effort: string;
}

export interface MessageRecord {
  readonly type: "message";
  readonly role: MessageRole;
  readonly id: string;
  readonly text: string;
  readonly timestamp: number;
  readonly session_id: string;
}

export interface ReasoningRecord {
  readonly type: "reasoning";
  readonly id: string;
  readonly text: string;
  readonly timestamp: number;
  readonly session_id: string;
}

/** The model's tool input, verbatim (B25). */
export type ToolParameters = Readonly<Record<string, unknown>>;

export interface ToolCallRecord {
  readonly type: "tool_call";
  readonly id: string;
  readonly messageId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly parameters: ToolParameters;
  readonly timestamp: number;
  readonly session_id: string;
}

export interface ToolError {
  readonly type: "tool_error";
  readonly message: string;
}

export interface ToolResultRecord {
  readonly type: "tool_result";
  readonly id: string;
  readonly messageId: string;
  readonly toolId: string;
  readonly isError: boolean;
  readonly value?: string;
  readonly error?: ToolError;
  readonly timestamp: number;
  readonly session_id: string;
}

export interface ErrorRecord {
  readonly type: "error";
  readonly source: ErrorSource;
  readonly message: string;
  readonly timestamp: number;
  readonly session_id: string;
}

export interface CompletionRecord {
  readonly type: "completion";
  readonly finalText: string;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly session_id: string;
  readonly timestamp: number;
  readonly usage: ExecUsage;
}

/** Exactly the seven record kinds, discriminated by `type` (B25). */
export type StreamRecord =
  | SystemInitRecord
  | MessageRecord
  | ReasoningRecord
  | ToolCallRecord
  | ToolResultRecord
  | ErrorRecord
  | CompletionRecord;

/** The single object `-o json` writes (B21-B23). */
export interface ExecSummaryRecord {
  readonly type: "result";
  readonly subtype: "success" | "failure";
  readonly is_error: boolean;
  readonly duration_ms: number;
  readonly num_turns: number;
  readonly result: string;
  readonly session_id: string;
  readonly usage: ExecUsage;
}

export function buildSystemInitRecord(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly tools: readonly string[];
  readonly model: string;
  readonly reasoningEffort: string;
}): SystemInitRecord {
  return {
    type: "system",
    subtype: "init",
    cwd: input.cwd,
    session_id: input.sessionId,
    tools: [...input.tools],
    model: input.model,
    reasoning_effort: input.reasoningEffort,
  };
}

export function buildMessageRecord(input: {
  readonly role: MessageRole;
  readonly id: string;
  readonly text: string;
  readonly timestamp: number;
  readonly sessionId: string;
}): MessageRecord {
  return {
    type: "message",
    role: input.role,
    id: input.id,
    text: input.text,
    timestamp: input.timestamp,
    session_id: input.sessionId,
  };
}

export function buildReasoningRecord(input: {
  readonly id: string;
  readonly text: string;
  readonly timestamp: number;
  readonly sessionId: string;
}): ReasoningRecord {
  return {
    type: "reasoning",
    id: input.id,
    text: input.text,
    timestamp: input.timestamp,
    session_id: input.sessionId,
  };
}

export function buildToolCallRecord(input: {
  readonly id: string;
  readonly messageId: string;
  readonly toolId: string;
  readonly parameters: ToolParameters;
  readonly timestamp: number;
  readonly sessionId: string;
}): ToolCallRecord {
  return {
    type: "tool_call",
    id: input.id,
    messageId: input.messageId,
    toolId: input.toolId,
    toolName: input.toolId,
    parameters: input.parameters,
    timestamp: input.timestamp,
    session_id: input.sessionId,
  };
}

/** Success carries `value`; failure carries `error` and omits `value` (B25, B31). */
export function buildToolResultRecord(input: {
  readonly id: string;
  readonly messageId: string;
  readonly toolId: string;
  readonly isError: boolean;
  readonly text: string;
  readonly timestamp: number;
  readonly sessionId: string;
}): ToolResultRecord {
  if (input.isError) {
    return {
      type: "tool_result",
      id: input.id,
      messageId: input.messageId,
      toolId: input.toolId,
      isError: true,
      error: { type: "tool_error", message: input.text },
      timestamp: input.timestamp,
      session_id: input.sessionId,
    };
  }
  return {
    type: "tool_result",
    id: input.id,
    messageId: input.messageId,
    toolId: input.toolId,
    isError: false,
    value: input.text,
    timestamp: input.timestamp,
    session_id: input.sessionId,
  };
}

export function buildErrorRecord(input: {
  readonly source: ErrorSource;
  readonly message: string;
  readonly timestamp: number;
  readonly sessionId: string;
}): ErrorRecord {
  return {
    type: "error",
    source: input.source,
    message: input.message,
    timestamp: input.timestamp,
    session_id: input.sessionId,
  };
}

export function buildCompletionRecord(input: {
  readonly finalText: string;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly usage: ExecUsage;
}): CompletionRecord {
  return {
    type: "completion",
    finalText: input.finalText,
    numTurns: input.numTurns,
    durationMs: input.durationMs,
    session_id: input.sessionId,
    timestamp: input.timestamp,
    usage: input.usage,
  };
}

export function buildSummaryRecord(input: {
  readonly isError: boolean;
  readonly durationMs: number;
  readonly numTurns: number;
  readonly result: string;
  readonly sessionId: string;
  readonly usage: ExecUsage;
}): ExecSummaryRecord {
  return {
    type: "result",
    subtype: input.isError ? "failure" : "success",
    is_error: input.isError,
    duration_ms: input.durationMs,
    num_turns: input.numTurns,
    result: input.result,
    session_id: input.sessionId,
    usage: input.usage,
  };
}

/** B22: a failed run reports no turns and no counters of its own. */
export function buildFailureSummaryRecord(input: {
  readonly durationMs: number;
  readonly result: string;
  readonly sessionId: string;
  readonly usage?: ExecUsage;
}): ExecSummaryRecord {
  return buildSummaryRecord({
    isError: true,
    durationMs: input.durationMs,
    numTurns: 0,
    result: input.result,
    sessionId: input.sessionId,
    usage: input.usage ?? ZERO_USAGE,
  });
}

/** Assistant content blocks, in transcript order (B27). */
export type AssistantBlock =
  | {
      readonly kind: "thinking";
      readonly text: string;
      /** B28: a thinking block written for the user is an assistant message. */
      readonly progressUpdate?: boolean;
    }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_use";
      readonly toolUseId: string;
      readonly name: string;
      readonly input: ToolParameters;
    };

export interface AssistantMessageEvent {
  readonly id: string;
  /** Generic-provider reasoning content; emitted before the blocks (B27). */
  readonly reasoningContent?: string;
  readonly blocks: readonly AssistantBlock[];
}

/** One record per non-empty block; all share the message id and timestamp (B27). */
export function buildAssistantRecords(
  message: AssistantMessageEvent,
  sessionId: string,
  timestamp: number,
): StreamRecord[] {
  const records: StreamRecord[] = [];
  if (message.reasoningContent !== undefined && message.reasoningContent.trim()) {
    records.push(
      buildReasoningRecord({
        id: message.id,
        text: message.reasoningContent,
        timestamp,
        sessionId,
      }),
    );
  }
  for (const block of message.blocks) {
    if (block.kind === "thinking") {
      if (!block.text.trim()) continue;
      records.push(
        block.progressUpdate === true
          ? buildMessageRecord({
              role: "assistant",
              id: message.id,
              text: block.text,
              timestamp,
              sessionId,
            })
          : buildReasoningRecord({
              id: message.id,
              text: block.text,
              timestamp,
              sessionId,
            }),
      );
    } else if (block.kind === "text") {
      if (!block.text.trim()) continue;
      records.push(
        buildMessageRecord({
          role: "assistant",
          id: message.id,
          text: block.text,
          timestamp,
          sessionId,
        }),
      );
    } else {
      records.push(
        buildToolCallRecord({
          id: block.toolUseId,
          messageId: message.id,
          toolId: block.name,
          parameters: block.input,
          timestamp,
          sessionId,
        }),
      );
    }
  }
  return records;
}

/** B29: the echo is trimmed text only and never system-reminder content. */
export const SYSTEM_REMINDER_START = "<system-reminder>";

export function buildUserEchoRecords(input: {
  readonly id: string;
  readonly text: string;
  readonly timestamp: number;
  readonly sessionId: string;
}): MessageRecord[] {
  const text = input.text.trim();
  if (!text || text.startsWith(SYSTEM_REMINDER_START)) return [];
  return [
    buildMessageRecord({
      role: "user",
      id: input.id,
      text,
      timestamp: input.timestamp,
      sessionId: input.sessionId,
    }),
  ];
}

/** A prompt message read from `--input-format stream-json` (B42). */
export interface StreamInputMessage {
  readonly prompt: string;
}

export const STREAM_INPUT_ROLE_ERROR =
  "Only 'user' messages are accepted via stdin.";
export const STREAM_INPUT_TEXT_ERROR = "Message must contain text content";
export const STREAM_INPUT_JSON_ERROR = "Invalid JSON";

export function isStreamInputJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstTextBlock(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isStreamInputJsonObject(block)) continue;
    if (block["type"] !== "text") continue;
    const text = block["text"];
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

/**
 * Validates one stdin line. Blank lines are ignored (`undefined`); every other
 * line must be a user `MessageParam` carrying text (B42). Failures are
 * `ExecStreamError`s so a streaming loop can emit one `error` record and
 * continue with the next line (B43).
 */
export function parseStreamInputLine(
  line: string,
): StreamInputMessage | undefined {
  if (!line.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new ExecStreamError(STREAM_INPUT_JSON_ERROR, error);
  }
  if (!isStreamInputJsonObject(parsed)) {
    throw new ExecStreamError(STREAM_INPUT_JSON_ERROR);
  }

  if (parsed["role"] !== "user") {
    throw new ExecStreamError(STREAM_INPUT_ROLE_ERROR);
  }
  const prompt = firstTextBlock(parsed["content"]);
  if (prompt === undefined) {
    throw new ExecStreamError(STREAM_INPUT_TEXT_ERROR);
  }
  return { prompt };
}