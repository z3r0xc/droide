/**
 * Server-sent-event framing. Contract: `specs/50-transport-and-auth.md`
 * B110–B112.
 *
 * Rules implemented:
 *
 * - only `data:` lines are payloads; `event:` names the event; `id:`/`retry:`
 *   and `:` comments are ignored;
 * - consecutive `data:` lines are joined with `\n`, and one leading space after
 *   the colon is stripped;
 * - a blank line terminates the event;
 * - a `\r` before `\n` is tolerated (CRLF);
 * - the body must end at an event boundary: ending inside a line or inside an
 *   event is a truncation error (B111);
 * - an event is bounded (`MAX_SSE_EVENT_BYTES`); a larger one fails before it
 *   can exhaust memory (B111);
 * - `[DONE]` is a terminal marker, not a payload (`SseEvent.kind === "done"`).
 *
 * A chunk boundary may fall inside a UTF-8 sequence, a line or an event; the
 * decoder is streaming and the line buffer survives reads, so none of those
 * boundaries is observable to a consumer.
 */

import { SseProtocolError } from "./errors.ts";

/** One event's payload, or the `[DONE]` terminator. */
export interface SseDataEvent {
  readonly kind: "data";
  /** The `event:` name, or `null` when the stream did not name it. */
  readonly event: string | null;
  /** Payload lines joined with `\n`. */
  readonly data: string;
}

export interface SseDoneEvent {
  readonly kind: "done";
}

export type SseEvent = SseDataEvent | SseDoneEvent;

/** The OpenAI-style terminator; never a JSON payload. */
export const SSE_DONE_PAYLOAD = "[DONE]";

/**
 * Ceiling for one event's bytes, including its comment and `event:` lines.
 * Chosen to admit a full tool-call argument fragment many times over while
 * keeping a hostile or broken stream from growing without bound.
 */
export const MAX_SSE_EVENT_BYTES = 1 << 20;

export interface SseReadOptions {
  /** Label for errors, e.g. `/api/llm/a/v1/messages`. */
  readonly operation?: string;
  /** Defaults to {@link MAX_SSE_EVENT_BYTES}. */
  readonly maxEventBytes?: number;
  /** Aborting cancels the body and releases the reader's lock (B111). */
  readonly signal?: AbortSignal;
}

interface SseState {
  readonly eventLines: string[];
  readonly dataLines: string[];
  eventBytes: number;
}

function payloadEvent(state: SseState): SseEvent | null {
  if (state.dataLines.length === 0) {
    return null;
  }
  const data = state.dataLines.join("\n");
  const name =
    state.eventLines.length === 0 ? null : state.eventLines.join("\n");
  return data === SSE_DONE_PAYLOAD
    ? { kind: "done" }
    : { kind: "data", event: name, data };
}

/**
 * Feed one line (without its terminator) and return the event it completes, if
 * any. The state is reset when a blank line closes a frame.
 */
function consumeLine(
  state: SseState,
  line: string,
  maxEventBytes: number,
  operation: string,
): SseEvent | null {
  if (line === "") {
    const event = payloadEvent(state);
    state.eventLines.length = 0;
    state.dataLines.length = 0;
    state.eventBytes = 0;
    return event;
  }

  state.eventBytes += Buffer.byteLength(line, "utf8") + 1;
  if (state.eventBytes > maxEventBytes) {
    throw new SseProtocolError(
      operation,
      "oversized",
      `the event exceeded the ${maxEventBytes}-byte limit`,
    );
  }

  if (line.startsWith(":")) {
    // A comment (including a keep-alive) never becomes a payload.
    return null;
  }

  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }

  if (field === "data") {
    state.dataLines.push(value);
  } else if (field === "event") {
    state.eventLines.push(value);
  }
  // `id:` and `retry:` are ignored (B110).
  return null;
}

/**
 * Parse a byte stream into typed SSE events. The generator completes only at
 * an event boundary; it throws {@link SseProtocolError} for truncation or an
 * oversized event, and propagates the abort reason when cancelled.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options: SseReadOptions = {},
): AsyncGenerator<SseEvent, void, void> {
  const operation = options.operation ?? "stream";
  const maxEventBytes = options.maxEventBytes ?? MAX_SSE_EVENT_BYTES;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const state: SseState = { eventLines: [], dataLines: [], eventBytes: 0 };

  let pending = "";
  let completed = false;

  const cancel = (reason: unknown): void => {
    void reader.cancel(reason).catch(() => {
      // Cancelling a closed or errored stream is not itself a failure.
    });
  };
  const onAbort = (): void => {
    cancel(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (options.signal?.aborted === true) {
        throw abortReason(options.signal, operation);
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });

      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        const event = consumeLine(state, line, maxEventBytes, operation);
        if (event !== null) {
          yield event;
        }
        newline = pending.indexOf("\n");
      }

      if (Buffer.byteLength(pending, "utf8") > maxEventBytes) {
        throw new SseProtocolError(
          operation,
          "oversized",
          `a line exceeded the ${maxEventBytes}-byte limit`,
        );
      }
    }

    pending += decoder.decode();
    const finalSignal: AbortSignal | undefined = options.signal;
    if (finalSignal?.aborted === true) {
      throw abortReason(finalSignal, operation);
    }
    if (pending !== "") {
      throw new SseProtocolError(
        operation,
        "truncated",
        "the body ended inside a line",
      );
    }
    if (state.dataLines.length > 0 || state.eventLines.length > 0) {
      throw new SseProtocolError(
        operation,
        "truncated",
        "the body ended inside an event",
      );
    }
    completed = true;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      await reader.cancel().catch(() => {
        // Already errored or closed.
      });
    }
    reader.releaseLock();
  }
}

function abortReason(
  signal: AbortSignal | undefined,
  operation: string,
): unknown {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new SseProtocolError(operation, "truncated", "aborted");
}

/** Convenience for tests and recorded fixtures; bytes are UTF-8. */
export function parseSseText(
  text: string,
  options: SseReadOptions = {},
): AsyncGenerator<SseEvent, void, void> {
  const bytes = Buffer.from(text, "utf8");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return parseSse(stream, options);
}

/** Frame a `fetch` response body. A response without a body is truncation. */
export function parseSseResponse(
  response: Response,
  options: SseReadOptions = {},
): AsyncGenerator<SseEvent, void, void> {
  if (response.body === null) {
    const operation = options.operation ?? "stream";
    throw new SseProtocolError(
      operation,
      "truncated",
      "the response has no body",
    );
  }
  return parseSse(response.body, options);
}

/** Split one byte buffer into fixed-size chunks; used to pin split handling. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("chunk size must be a positive integer");
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}
