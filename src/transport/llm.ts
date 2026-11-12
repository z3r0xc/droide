/**
 * The provider-agnostic turn and the stream-delta mapping. Contract:
 * `specs/50-transport-and-auth.md` §J (B105–B122).
 *
 * The turn shape is one ordered message history of text, image, document,
 * tool-use and tool-result blocks plus a system prompt and a tool catalogue
 * (B105); adapters convert it to a wire dialect. This module owns the shape and
 * the *delta* vocabulary, not the wire conversion beyond what B106 states
 * (`stream: true`, `max_tokens` clamped).
 *
 * A mapper consumes the *parsed* SSE events from `sse.ts`, so framing errors
 * stay in the parser and payload-shape errors stay here. Terminality is
 * explicit: `message_delta.stop_reason` (Anthropic), `finish_reason` (Chat) and
 * `response.completed`/`response.incomplete` (Responses) finalize the stream
 * without waiting for EOF (B115/B116); `[DONE]` is never a payload (B112/B113).
 */

import {
  LLM_FAILURE_MESSAGES,
  LlmStreamError,
  type LlmFailureReason,
} from "./errors.ts";
import type { SseEvent } from "./sse.ts";

/* -------------------------------------------------------------------------- */
/* Provider-agnostic request (B105)                                           */
/* -------------------------------------------------------------------------- */

export interface LlmTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface LlmImageBlock {
  readonly type: "image";
  readonly mediaType: string;
  readonly data: string;
}

export interface LlmDocumentBlock {
  readonly type: "document";
  readonly mediaType: string;
  readonly data: string;
}

export interface LlmToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface LlmToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type LlmContentBlock =
  | LlmTextBlock
  | LlmImageBlock
  | LlmDocumentBlock
  | LlmToolUseBlock
  | LlmToolResultBlock;

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly LlmContentBlock[];
}

export interface LlmToolDefinition {
  /** Name the model calls; unique within the catalogue. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. */
  readonly inputSchema: unknown;
}

/** One turn as the loop hands it to an adapter (B105). */
export interface LlmTurnRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDefinition[];
  /** Requested ceiling; clamped by {@link clampMaxTokens} (B106). */
  readonly maxTokens: number;
  readonly toolChoice?: unknown;
  /** Custom-model passthrough arguments (B106). */
  readonly extraArgs?: Readonly<Record<string, unknown>>;
}

/**
 * B106: `max_tokens` is clamped to the model capability's ceiling. `null`
 * means the capability names no ceiling, so the request stands.
 */
export function clampMaxTokens(
  requested: number,
  ceiling: number | null,
): number {
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RangeError("maxTokens must be a positive integer");
  }
  if (ceiling === null) {
    return requested;
  }
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    throw new RangeError("the model ceiling must be a positive integer");
  }
  return Math.min(requested, ceiling);
}

/* -------------------------------------------------------------------------- */
/* Usage (B120–B123)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Disjoint buckets: `inputTokens` excludes both cache counts, which are
 * reported separately (B120). `thinkingTokens` is present only when the
 * provider reported a breakdown.
 */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens?: number;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
};

interface MutableUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  thinkingTokens: number | null;
  seen: boolean;
}

function emptyMutableUsage(): MutableUsage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    thinkingTokens: null,
    seen: false,
  };
}

function snapshotUsage(usage: MutableUsage): LlmUsage {
  const base = {
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
  };
  return usage.thinkingTokens === null
    ? base
    : { ...base, thinkingTokens: usage.thinkingTokens };
}

/* -------------------------------------------------------------------------- */
/* Stream deltas                                                              */
/* -------------------------------------------------------------------------- */

/** B125's stop-reason vocabulary, reused for every dialect. */
export type LlmStopReason =
  | "stop"
  | "tool-use"
  | "length"
  | "content-filter"
  | "unknown";

export type LlmStreamDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "signature"; readonly signature: string }
  | {
      readonly kind: "tool-call-start";
      readonly index: number;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly kind: "tool-call-args";
      readonly index: number;
      readonly id: string;
      readonly delta: string;
    }
  | {
      readonly kind: "tool-call-end";
      readonly index: number;
      readonly id: string;
      /** Accumulated JSON text; `""` when the call carried no arguments. */
      readonly input: string;
    }
  | { readonly kind: "usage"; readonly usage: LlmUsage }
  | { readonly kind: "completed"; readonly stopReason: LlmStopReason }
  | {
      readonly kind: "failed";
      readonly reason: LlmFailureReason;
      readonly message: string;
    };

/** B108/B109 dialect selection; only the dialects this module maps. */
export type LlmDialect = "anthropic" | "responses" | "chat";

export interface LlmStreamOptions {
  /** Operation label used in stream errors, e.g. `anthropic-messages`. */
  readonly operation: string;
  /** B123: the `fireworks-cached-prompt-tokens` response header, when read. */
  readonly cachedPromptTokensHeader?: number | null;
}

export interface LlmStreamMapper {
  /** Zero or more deltas for one parsed SSE event. */
  push(event: SseEvent): LlmStreamDelta[];
  /** End-of-transport: finalize a stream that never reached a terminal event. */
  finish(): LlmStreamDelta[];
}

/* -------------------------------------------------------------------------- */
/* Untrusted payload parsing                                                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readNumber(
  source: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(
  source: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

/**
 * Decode one `data:` payload. A payload that is not JSON, or not a JSON
 * object, fails without quoting the payload (B111's rule).
 */
export function parseStreamPayload(
  event: SseEvent,
  operation: string,
): Readonly<Record<string, unknown>> | null {
  if (event.kind === "done") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    throw new LlmStreamError(operation, "the stream payload was not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new LlmStreamError(operation, "the stream payload was not a JSON object");
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Anthropic (B114–B117, B121)                                                */
/* -------------------------------------------------------------------------- */

const ANTHROPIC_STOP_REASONS: Readonly<Record<string, LlmStopReason>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-use",
  max_tokens: "length",
};

interface AnthropicToolBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  input: string;
  ended: boolean;
}

interface AnthropicOtherBlock {
  readonly type: "text" | "thinking";
}

type AnthropicBlock = AnthropicToolBlock | AnthropicOtherBlock;

function applyAnthropicUsage(
  usage: MutableUsage,
  source: Readonly<Record<string, unknown>>,
): void {
  const input = readNumber(source, "input_tokens");
  if (input !== null) {
    usage.inputTokens = input;
  }
  const cacheRead = readNumber(source, "cache_read_input_tokens");
  if (cacheRead !== null) {
    usage.cacheReadTokens = cacheRead;
  }
  const cacheCreation = readNumber(source, "cache_creation_input_tokens");
  if (cacheCreation !== null) {
    usage.cacheCreationTokens = cacheCreation;
  }
  const output = readNumber(source, "output_tokens");
  if (output !== null) {
    usage.outputTokens = output;
  }
  const thinking = readNumber(source, "thinking_tokens");
  if (thinking !== null) {
    usage.thinkingTokens = thinking;
  }
  usage.seen = true;
}

function createAnthropicMapper(options: LlmStreamOptions): LlmStreamMapper {
  const { operation } = options;
  const blocks = new Map<number, AnthropicBlock>();
  const usage = emptyMutableUsage();
  let messageId: string | null = null;
  let stopReason: LlmStopReason = "unknown";
  let usageEmitted = false;
  let finished = false;

  const emitUsage = (deltas: LlmStreamDelta[]): void => {
    if (!usageEmitted && usage.seen) {
      usageEmitted = true;
      deltas.push({ kind: "usage", usage: snapshotUsage(usage) });
    }
  };

  return {
    push(event: SseEvent): LlmStreamDelta[] {
      const payload = parseStreamPayload(event, operation);
      if (payload === null || finished) {
        return [];
      }
      const type = readString(payload, "type") ?? event.kind === "data" ? event.event : null;
      const deltas: LlmStreamDelta[] = [];

      switch (type) {
        case "message_start": {
          const message = readRecord(payload, "message");
          if (message !== null) {
            messageId = readString(message, "id") ?? messageId;
            const seed = readRecord(message, "usage");
            if (seed !== null) {
              applyAnthropicUsage(usage, seed);
            }
          }
          return deltas;
        }
        case "content_block_start": {
          const index = readNumber(payload, "index");
          const block = readRecord(payload, "content_block");
          if (index === null || block === null) {
            return deltas;
          }
          const blockType = readString(block, "type");
          if (blockType === "tool_use") {
            // B117: the client tool-call id is derived from the assistant
            // message id and the block index.
            // TODO(spec B117): the spec does not quote the separator used
            // between the two parts.
            const id = `${messageId ?? "message"}-${index}`;
            const call: AnthropicToolBlock = {
              type: "tool_use",
              id,
              name: readString(block, "name") ?? "",
              input: "",
              ended: false,
            };
            blocks.set(index, call);
            deltas.push({ kind: "tool-call-start", index, id, name: call.name });
          } else {
            blocks.set(index, { type: blockType === "thinking" ? "thinking" : "text" });
          }
          return deltas;
        }
        case "content_block_delta": {
          const index = readNumber(payload, "index");
          const delta = readRecord(payload, "delta");
          if (index === null || delta === null) {
            return deltas;
          }
          const deltaType = readString(delta, "type");
          if (deltaType === "text_delta") {
            const text = readString(delta, "text");
            if (text !== null && text !== "") {
              deltas.push({ kind: "text", text });
            }
          } else if (deltaType === "thinking_delta") {
            const text = readString(delta, "thinking");
            if (text !== null && text !== "") {
              deltas.push({ kind: "thinking", text });
            }
          } else if (deltaType === "signature_delta") {
            const signature = readString(delta, "signature");
            if (signature !== null) {
              deltas.push({ kind: "signature", signature });
            }
          } else if (deltaType === "input_json_delta") {
            const partial = readString(delta, "partial_json");
            const block = blocks.get(index);
            if (partial !== null && block?.type === "tool_use") {
              block.input += partial;
              deltas.push({
                kind: "tool-call-args",
                index,
                id: block.id,
                delta: partial,
              });
            }
          }
          return deltas;
        }
        case "content_block_stop": {
          const index = readNumber(payload, "index");
          const block = index === null ? undefined : blocks.get(index);
          if (index !== null && block?.type === "tool_use" && !block.ended) {
            block.ended = true;
            deltas.push({
              kind: "tool-call-end",
              index,
              id: block.id,
              input: block.input,
            });
          }
          return deltas;
        }
        case "message_delta": {
          const delta = readRecord(payload, "delta");
          const reason = delta === null ? null : readString(delta, "stop_reason");
          // B125's mapping applied to Anthropic's stop reasons.
          // TODO(spec B114): the spec states the handled event order only.
          stopReason =
            reason === null
              ? "unknown"
              : (ANTHROPIC_STOP_REASONS[reason] ?? "unknown");
          const next = readRecord(payload, "usage");
          if (next !== null) {
            applyAnthropicUsage(usage, next);
          }
          // B115: stop_reason finalizes the stream; usage once, then the end.
          emitUsage(deltas);
          deltas.push({ kind: "completed", stopReason });
          finished = true;
          return deltas;
        }
        case "message_stop": {
          emitUsage(deltas);
          deltas.push({ kind: "completed", stopReason });
          finished = true;
          return deltas;
        }
        case "error": {
          deltas.push({
            kind: "failed",
            reason: "unknown",
            message: LLM_FAILURE_MESSAGES.unknown,
          });
          finished = true;
          return deltas;
        }
        default:
          // B114: an unknown type is ignored.
          return deltas;
      }
    },
    finish(): LlmStreamDelta[] {
      if (finished) {
        return [];
      }
      const deltas: LlmStreamDelta[] = [];
      emitUsage(deltas);
      deltas.push({ kind: "completed", stopReason });
      finished = true;
      return deltas;
    },
  };
}
"