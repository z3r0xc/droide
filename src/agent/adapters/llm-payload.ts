/**
 * Provider request payloads.
 *
 * Contract: `specs/50-transport-and-auth.md` §B105–B110 (turn shape, `stream: true`,
 * clamped `max_tokens`, provider dialects) and `specs/20-agent-loop.md` §B12–B14.
 *
 * The transport maps *responses*; this module encodes *requests*, because the two
 * directions have different shapes per dialect. Keeping the encoder pure means a
 * payload can be asserted field by field in a test instead of being inferred from
 * a fake server that accepts anything.
 */
import type {
  LlmContentBlock,
  LlmDialect,
  LlmMessage,
  LlmToolDefinition,
} from "../../transport/llm.ts";

export interface PayloadOptions {
  readonly model: string;
  readonly system: string;
  readonly tools: readonly LlmToolDefinition[];
  /** Already clamped by the caller (`clampMaxTokens`). */
  readonly maxTokens: number;
}

/** Anthropic Messages API body. */
export function encodeAnthropicRequest(
  options: PayloadOptions,
  messages: readonly LlmMessage[],
): Record<string, unknown> {
  return {
    model: options.model,
    system: options.system,
    max_tokens: options.maxTokens,
    stream: true,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content.flatMap(anthropicBlock),
    })),
    ...(options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
  };
}

function anthropicBlock(block: LlmContentBlock): unknown[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "image":
      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mediaType,
            data: block.data,
          },
        },
      ];
    case "document":
      // Anthropic takes PDFs as base64 documents; plain text documents are text.
      return block.mediaType === "application/pdf"
        ? [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: block.mediaType,
                data: block.data,
              },
            },
          ]
        : [{ type: "text", text: block.data }];
    case "tool_use":
      return [
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        },
      ];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError === true ? { is_error: true } : {}),
        },
      ];
  }
}

/** OpenAI-compatible Chat Completions body. */
export function encodeChatRequest(
  options: PayloadOptions,
  messages: readonly LlmMessage[],
): Record<string, unknown> {
  const encoded: Record<string, unknown>[] = [
    { role: "system", content: options.system },
  ];

  for (const message of messages) {
    const toolCalls = message.content.filter(
      (block) => block.type === "tool_use",
    );
    const text = message.content
      .filter(
        (block): block is Extract<LlmContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");

    if (message.role === "assistant") {
      encoded.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length === 0
          ? {}
          : {
              tool_calls: toolCalls.map((block) => ({
                id: block.type === "tool_use" ? block.id : "",
                type: "function",
                function: {
                  name: block.type === "tool_use" ? block.name : "",
                  arguments:
                    block.type === "tool_use"
                      ? JSON.stringify(block.input ?? {})
                      : "{}",
                },
              })),
            }),
      });
      continue;
    }

    // A tool result is its own `tool` message in this dialect, one per call.
    const results = message.content.filter(
      (block): block is Extract<LlmContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result",
    );
    for (const result of results) {
      encoded.push({
        role: "tool",
        tool_call_id: result.toolUseId,
        content: result.content,
      });
    }

    const media = message.content.filter(
      (
        block,
      ): block is Extract<LlmContentBlock, { type: "image" | "document" }> =>
        block.type === "image" || block.type === "document",
    );
    if (media.length === 0) {
      if (text.length > 0) encoded.push({ role: "user", content: text });
    } else {
      const parts: Array<Record<string, unknown>> = [];
      if (text.length > 0) parts.push({ type: "text", text });
      for (const block of media) {
        if (block.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          });
        } else {
          parts.push({ type: "text", text: `[document ${block.mediaType}]` });
        }
      }
      encoded.push({ role: "user", content: parts });
    }
  }

  return {
    model: options.model,
    max_tokens: options.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: encoded,
    ...(options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
  };
}

/** Encode for the dialect the endpoint speaks. */
export function encodeRequest(
  dialect: LlmDialect,
  options: PayloadOptions,
  messages: readonly LlmMessage[],
): Record<string, unknown> {
  switch (dialect) {
    case "anthropic":
      return encodeAnthropicRequest(options, messages);
    case "chat":
      return encodeChatRequest(options, messages);
    case "responses":
      // The Responses dialect reuses the chat shape for now; the differences the
      // spec pins are recorded in docs/gaps.md until the Responses mapper lands.
      return encodeChatRequest(options, messages);
  }
}
