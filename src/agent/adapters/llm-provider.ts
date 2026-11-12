/**
 * Adapter: the agent loop's `Provider` port over the transport's LLM layer.
 *
 * `specs/20-agent-loop.md` §B12–B20 (request assembly, streaming) and
 * `specs/50-transport-and-auth.md` §B105–B123 (payloads, deltas, usage).
 *
 * The port stays deliberately narrow — `stream(messages, {signal})` — so the
 * loop is testable without knowing a dialect. Everything a provider needs but
 * the loop does not own (model id, system prompt, tool catalogue, endpoint and
 * headers) is supplied once, here.
 */
import type { Message } from "../messages.ts";
import type { Provider, ProviderDelta } from "../ports.ts";
import type {
  LlmContentBlock,
  LlmDialect,
  LlmMessage,
  LlmStreamDelta,
  LlmToolDefinition,
  LlmTurnRequest,
} from "../../transport/llm.ts";
import { mapStream } from "../../transport/llm.ts";
import { parseSse } from "../../transport/sse.ts";

export interface LlmProviderOptions {
  /** Absolute endpoint for the turn (already resolved per deployment). */
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly dialect: LlmDialect;
  readonly model: string;
  readonly system: string;
  readonly tools?: readonly LlmToolDefinition[];
  readonly maxTokens: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Label used in stream errors. */
  readonly operation?: string;
}

function toContentBlocks(content: Message["content"]): LlmContentBlock[] {
  const blocks: LlmContentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        blocks.push({ type: "text", text: block.text });
        break;
      case "image":
        blocks.push({
          type: "image",
          mediaType: block.source.mediaType,
          data: block.source.data,
        });
        break;
      case "document":
        blocks.push({
          type: "document",
          mediaType: block.source.mediaType,
          data: block.source.data,
        });
        break;
      case "tool_use":
        blocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case "tool_result": {
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.modelContent ??
              block.content
                ?.map((part) =>
                  part.type === "text" ? part.text : `[${part.type}]`,
                )
                .join("\n") ??
              "");
        blocks.push({
          type: "tool_result",
          toolUseId: block.toolUseId,
          content: text,
          ...(block.isError === true ? { isError: true } : {}),
        });
        break;
      }
      case "thinking":
      case "redacted_thinking":
        // Not replayed to the model: signatures are provider-private state.
        break;
    }
  }
  return blocks;
}

/**
 * Convert a transcript slice into provider messages.
 *
 * `system` messages are folded into the request's system prompt by the caller,
 * and `tool` messages become `user` messages carrying `tool_result` blocks,
 * which is what every supported dialect accepts.
 */
export function toLlmMessages(messages: readonly Message[]): LlmMessage[] {
  const converted: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const content = toContentBlocks(message.content);
    if (content.length === 0) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = converted[converted.length - 1];
    if (previous !== undefined && previous.role === role) {
      converted[converted.length - 1] = {
        role,
        content: [...previous.content, ...content],
      };
    } else {
      converted.push({ role, content });
    }
  }
  return converted;
}

/** Build the request payload the transport expects. */
export function buildTurnRequest(
  options: LlmProviderOptions,
  messages: readonly Message[],
): LlmTurnRequest {
  return {
    model: options.model,
    system: options.system,
    messages: toLlmMessages(messages),
    tools: options.tools ?? [],
    maxTokens: options.maxTokens,
  };
}

function toProviderDelta(delta: LlmStreamDelta): ProviderDelta | null {
  switch (delta.kind) {
    case "text":
      return { type: "text", text: delta.text };
    case "thinking":
      return { type: "thinking", text: delta.text };
    case "tool-call-start":
      return { type: "tool_use_start", name: delta.name, slot: delta.index };
    case "tool-call-args":
      return { type: "tool_use_input", slot: delta.index, json: delta.delta };
    case "usage":
      return {
        type: "usage",
        input:
          delta.usage.inputTokens +
          delta.usage.cacheReadTokens +
          delta.usage.cacheCreationTokens,
        output: delta.usage.outputTokens,
      };
    case "completed":
      return { type: "done" };
    case "signature":
    case "tool-call-end":
      // Signature state is provider-private and the end marker adds nothing:
      // the loop already holds the accumulated argument text.
      return null;
    case "failed":
      throw new Error(`${delta.reason}: ${delta.message}`);
  }
}

function statusError(status: number, body: string): Error {
  const detail = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  const error = new Error(`LLM request failed: ${status} ${detail}`.trim());
  error.name = "LlmHttpError";
  return error;
}

/** Create the provider the loop uses for one model and tool catalogue. */
export function createLlmProvider(options: LlmProviderOptions): Provider {
  const doFetch = options.fetch ?? fetch;
  const operation = options.operation ?? "llm-stream";

  return {
    async *stream(messages, streamOptions) {
      const body = JSON.stringify(buildTurnRequest(options, messages));
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body,
        signal: streamOptions.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw statusError(response.status, text);
      }
      if (response.body === null)
        throw new Error("LLM request returned no body");

      for await (const delta of mapStream(
        parseSse(response.body, { operation, signal: streamOptions.signal }),
        options.dialect,
        { operation },
      )) {
        const mapped = toProviderDelta(delta);
        if (mapped !== null) yield mapped;
      }
    },
  };
}
