/**
 * MCP client: the protocol lifecycle of one server. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B10 (connect budgets), B13 (listing
 * deadline, lenient tolerance and the 60 s negative cache), B14 (per-tool
 * tolerance), B20 (call budget), B21 (cancellation and its `not_sent` /
 * `in_flight` classification) and B22 (result marshalling).
 *
 * Lifecycle: `initialize` request -> `notifications/initialized` -> `tools/list`
 * (following `nextCursor` pages inside one budget) -> `tools/call`. Neither
 * `resources/*` nor prompts are called: no clause of the spec requires them.
 *
 * Every budget is measured with an injected timer, every call takes an
 * `AbortSignal`, and a cancelled request reports whether it had already left
 * this process. Nothing a server sends is used before it is parsed.
 */

import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_STDIO_CONNECT_TIMEOUT_MS,
  type McpServerConfig,
} from "./config.ts";
import {
  McpCancelledError,
  McpConnectError,
  McpError,
  McpProtocolError,
  McpTimeoutError,
  McpToolError,
  type McpCancelStage,
  type McpTimeoutPhase,
} from "./errors.ts";
import {
  createMcpTransport,
  systemMcpTimers,
  type McpFetch,
  type McpTimers,
  type McpTransport,
} from "./transport.ts";
import { boundText, MODEL_RESULT_BUDGET_BYTES } from "../../tools/result.ts";

/** The revision this build speaks in the 2025 `initialize` handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Client identity sent in `initialize`; a caller may replace it. */
export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

/** Default identity; the CLI passes its brand values through instead. */
export const DEFAULT_MCP_CLIENT_INFO: McpClientInfo = {
  name: "droide",
  version: "1.9.0",
};

/** Default `tools/list` budget (B13). */
export const DEFAULT_MCP_LIST_TIMEOUT_MS = 15_000;

/** How long a distinct listing failure is remembered (B13). */
export const DEFAULT_MCP_LISTING_FAILURE_TTL_MS = 60_000;

/** Page ceiling, so a cursor chain cannot run forever. */
export const MAX_TOOL_LIST_PAGES = 100;

/** Content-block ceiling for one result, so a response cannot flood a caller. */
export const MAX_RESULT_CONTENT_BLOCKS = 1_000;

/** The text the model sees for a result with nothing in it (B22). */
export const NO_CONTENT_TEXT = "[No content returned]";

/** The text the model sees for an `isError` result with nothing to report. */
export const UNKNOWN_TOOL_ERROR_TEXT = "Error: Unknown error occurred";

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason;
}

/** The `initialize` result, as far as this build reads it. */
export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo:
    | { readonly name: string; readonly version: string }
    | undefined;
}

/** One tool from a listing, with every field validated. */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>> | undefined;
}

/** A tool the listing carried but this client refuses to register (B14). */
export interface McpSkippedTool {
  readonly name: string | undefined;
  readonly reason: string;
}

export interface McpToolList {
  readonly tools: readonly McpToolInfo[];
  readonly skipped: readonly McpSkippedTool[];
}

/** One validated result content block. */
export type McpContentBlock =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly mimeType: string;
      /** Base64 bytes, kept for a caller that can render or re-encode them. */
      readonly data: string;
    }
  | { readonly kind: "other"; readonly blockType: string };

/** A `tools/call` result after validation, before rendering. */
export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError: boolean;
  readonly structuredContent: unknown;
}

/** What a caller receives from a successful `tools/call`. */
export interface McpToolCallResult {
  readonly text: string;
  readonly content: readonly McpContentBlock[];
  readonly structuredContent: unknown;
}

/** Validate an `initialize` result (untrusted). */
export function parseInitializeResult(
  result: unknown,
  server: string,
): McpInitializeResult {
  if (!isJsonObject(result)) {
    throw new McpProtocolError("returned an initialize result that is not an object", {
      server,
      method: "initialize",
    });
  }
  const protocolVersion = result["protocolVersion"];
  if (typeof protocolVersion !== "string" || protocolVersion === "") {
    throw new McpProtocolError(
      "returned an initialize result without a protocolVersion string",
      { server, method: "initialize" },
    );
  }
  const rawCapabilities = result["capabilities"];
  if (rawCapabilities !== undefined && !isJsonObject(rawCapabilities)) {
    throw new McpProtocolError(
      "returned initialize capabilities that are not an object",
      { server, method: "initialize" },
    );
  }
  const rawInfo = result["serverInfo"];
  let serverInfo: McpInitializeResult["serverInfo"];
  if (rawInfo !== undefined) {
    if (!isJsonObject(rawInfo)) {
      throw new McpProtocolError(
        "returned serverInfo that is not an object",
        { server, method: "initialize" },
      );
    }
    const name = rawInfo["name"];
    const version = rawInfo["version"];
    if (typeof name !== "string" || typeof version !== "string") {
      throw new McpProtocolError(
        "returned serverInfo without name and version strings",
        { server, method: "initialize" },
      );
    }
    serverInfo = { name, version };
  }
  return {
    protocolVersion,
    capabilities: rawCapabilities ?? {},
    serverInfo,
  };
}

const INVALID_TOOLS_LIST = "The MCP server returned an invalid tools/list result";

/**
 * Validate one `tools/list` page (B14). The page is parsed strictly first; a
 * page that fails becomes a per-tool pass that keeps every conforming tool and
 * reports each refusal, so one bad tool never discards the listing.
 */
export function parseToolsListResult(
  result: unknown,
  server: string,
): McpToolList & { readonly nextCursor: string | undefined } {
  if (!isJsonObject(result)) {
    throw new McpProtocolError(INVALID_TOOLS_LIST, {
      server,
      method: "tools/list",
      reason: "the result is not an object",
    });
  }
  const rawTools = result["tools"];
  if (!Array.isArray(rawTools)) {
    throw new McpProtocolError(INVALID_TOOLS_LIST, {
      server,
      method: "tools/list",
      reason: '"tools" is not an array',
    });
  }
  const rawCursor = result["nextCursor"];
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new McpProtocolError(INVALID_TOOLS_LIST, {
      server,
      method: "tools/list",
      reason: '"nextCursor" is not a string',
    });
  }

  const tools: McpToolInfo[] = [];
  const skipped: McpSkippedTool[] = [];
  for (const entry of rawTools) {
    const parsed = parseToolInfo(entry);
    if (parsed.ok) tools.push(parsed.tool);
    else skipped.push({ name: parsed.name, reason: parsed.reason });
  }
  return {
    tools,
    skipped,
    nextCursor: rawCursor === "" ? undefined : rawCursor,
  };
}

type ParsedToolInfo =
  | { readonly ok: true; readonly tool: McpToolInfo }
  | {
      readonly ok: false;
      readonly name: string | undefined;
      readonly reason: string;
    };

function parseToolInfo(entry: unknown, server: string): ParsedToolInfo {
  if (!isJsonObject(entry)) {
    return { ok: false, name: undefined, reason: "the tool is not an object" };
  }
  const name = entry["name"];
  if (typeof name !== "string" || name === "") {
    return { ok: false, name: undefined, reason: "the tool has no name" };
  }
  const description = entry["description"];
  if (description !== undefined && typeof description !== "string") {
    return { ok: false, name, reason: "the description is not a string" };
  }

  const rawInput = entry["inputSchema"];
  if (rawInput !== undefined && !isJsonObject(rawInput)) {
    return { ok: false, name, reason: "inputSchema is not an object" };
  }
  const inputType = rawInput?.["type"];
  if (inputType !== undefined && inputType !== "object") {
    return { ok: false, name, reason: "inputSchema is not an object schema" };
  }

  const rawOutput = entry["outputSchema"];
  if (rawOutput !== undefined && !isJsonObject(rawOutput)) {
    return { ok: false, name, reason: "outputSchema is not an object" };
  }
  // B14: on a 2025 server a non-object output schema is skipped and reported.
  const outputType = rawOutput?.["type"];
  if (outputType !== undefined && outputType !== "object") {
    return {
      ok: false,
      name,
      reason: "outputSchema is not an object schema",
    };
  }

  return {
    ok: true,
    tool: {
      name,
      description,
      inputSchema: rawInput ?? { type: "object" },
      outputSchema: rawOutput,
    },
  };
  void server;
}

/** Validate a `tools/call` result envelope (untrusted). */
export function parseCallToolResult(
  result: unknown,
  server: string,
  tool: string,
): McpCallToolResult {
  if (!isJsonObject(result)) {
    throw new McpProtocolError(
      `returned a tools/call result for ${tool} that is not an object`,
      { server, tool },
    );
  }
  const isError = result["isError"];
  if (isError !== undefined && typeof isError !== "boolean") {
    throw new McpProtocolError(
      `returned a tools/call result for ${tool} whose isError is not a boolean`,
      { server, tool },
    );
  }
  const rawContent = result["content"];
  if (rawContent !== undefined && !Array.isArray(rawContent)) {
    throw new McpProtocolError(
      `returned a tools/call result for ${tool} whose content is not an array`,
      { server, tool },
    );
  }
  const entries = rawContent ?? [];
  if (entries.length > MAX_RESULT_CONTENT_BLOCKS) {
    throw new McpProtocolError(
      `returned ${entries.length} content blocks for ${tool}, over the ${MAX_RESULT_CONTENT_BLOCKS}-block cap`,
      { server, tool },
    );
  }

  const content: McpContentBlock[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      throw new McpProtocolError(
        `returned a content block for ${tool} that is not an object`,
        { server, tool },
      );
    }
    const type = entry["type"];
    if (typeof type !== "string" || type === "") {
      throw new McpProtocolError(
        `returned a content block for ${tool} without a type`,
        { server, tool },
      );
    }
    if (type === "text") {
      const text = entry["text"];
      if (typeof text !== "string") {
        throw new McpProtocolError(
          `returned a text block for ${tool} without text`,
          { server, tool },
        );
      }
      content.push({ kind: "text", text });
      continue;
    }
    if (type === "image") {
      const data = entry["data"];
      const mimeType = entry["mimeType"];
      if (typeof data !== "string" || typeof mimeType !== "string") {
        throw new McpProtocolError(
          `returned an image block for ${tool} without data and mimeType`,
          { server, tool },
        );
      }
      content.push({ kind: "image", data, mimeType });
      continue;
    }
    content.push({ kind: "other", blockType: type });
  }

  return {
    content,
    isError: isError === true,
    structuredContent: result["structuredContent"],
  };
}

/** JSON text with two-space indentation, whatever the value's type. */
function jsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** Re-indent a text block that is JSON, and pass anything else through. */
function reindentJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function renderBlock(block: McpContentBlock): string {
  switch (block.kind) {
    case "text":
      return reindentJsonText(block.text);
    case "image":
      return `[Image: ${block.mimeType}, ${block.data.length} base64 bytes]`;
    case "other":
      return `[Unsupported content block: ${block.blockType}]`;
  }
}

/**
 * Render a validated result for the model (B22): text blocks are re-indented
 * JSON, an empty successful result renders `structuredContent` or
 * `[No content returned]`, and an `isError` result renders `Error: ...`.
 *
 * TODO(spec B22): image blocks are reported by type and size instead of being
 * compressed, and an unsupported image MIME type keeps the same marker.
 */
export function renderToolCallResult(
  result: McpCallToolResult,
): McpToolCallResult {
  const bounded = (text: string): string =>
    boundText(text, MODEL_RESULT_BUDGET_BYTES, "the MCP server response").text;

  if (result.isError) {
    const firstText = result.content.find((block) => block.kind === "text");
    if (firstText !== undefined && firstText.kind === "text") {
      return {
        text: bounded(`Error: ${firstText.text}`),
        content: result.content,
        structuredContent: result.structuredContent,
      };
    }
    if (result.content.length === 0 && result.structuredContent !== undefined) {
      return {
        text: bounded(`Error: ${jsonText(result.structuredContent)}`),
        content: result.content,
        structuredContent: result.structuredContent,
      };
    }
    return {
      text: UNKNOWN_TOOL_ERROR_TEXT,
      content: result.content,
      structuredContent: result.structuredContent,
    };
  }

  if (result.content.length > 0) {
    return {
      text: bounded(result.content.map(renderBlock).join("\n")),
      content: result.content,
      structuredContent: result.structuredContent,
    };
  }
  if (result.structuredContent !== undefined) {
    return {
      text: bounded(jsonText(result.structuredContent)),
      content: result.content,
      structuredContent: result.structuredContent,
    };
  }
  return {
    text: NO_CONTENT_TEXT,
    content: result.content,
    structuredContent: result.structuredContent,
  };
}

// __MCP_CLIENT_PART2__