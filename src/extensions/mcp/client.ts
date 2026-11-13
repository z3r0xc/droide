/**
 * MCP client: the protocol lifecycle of one server. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B10 (connect budgets), B11 (era
 * negotiation and its legacy verdict cache), B13 (listing deadline, cursor
 * bounds, lenient tolerance and the 60 s negative cache), B14 (per-tool
 * tolerance), B20 (call budget), B21 (cancellation and its `not_sent` /
 * `in_flight` classification), B22 (result marshalling) and B23 (rewritten
 * output-schema validation errors).
 *
 * Lifecycle: `server/discover` when negotiating the modern era, else
 * `initialize` -> `notifications/initialized` -> `tools/list` (following
 * `nextCursor` pages inside one budget) -> `tools/call`. Neither `resources/*`
 * nor prompts are called: no clause of the spec requires them.
 *
 * Every budget is measured with an injected timer, every call takes an
 * `AbortSignal`, and a cancelled request reports whether it had already left
 * this process. Nothing a server sends is used before it is parsed.
 */

import { createHash } from "node:crypto";

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
  abortReason,
  createMcpTransport,
  isAborted,
  systemMcpTimers,
  type McpFetch,
  type McpServerNotification,
  type McpSseReconnectPolicy,
  type McpTimers,
  type McpTransport,
} from "./transport.ts";
import { PROGRAM, PRODUCT_VERSION } from "../../cli/brand.ts";
import { boundText, MODEL_RESULT_BUDGET_BYTES } from "../../tools/result.ts";

/**
 * The revision this build speaks in the 2025 `initialize` handshake.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The revision a modern server is probed for (B11). */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

/** The probe that settles a server's era without `initialize` (B11). */
export const MCP_DISCOVER_METHOD = "server/discover";

/** JSON-RPC `UnsupportedProtocolVersion`: the probed revision is refused. */
export const MCP_UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

/** JSON-RPC `MethodNotFound`: a 2025 server has no `server/discover` (B11). */
export const MCP_METHOD_NOT_FOUND_CODE = -32601;

/** HTTP answers a 2025 server gives an unknown method (B11). */
const MCP_PROBE_HTTP_REFUSALS: ReadonlySet<number> = new Set([400, 404, 405]);

/** How long a legacy verdict keeps the probe away (B11, B12). */
export const DEFAULT_MCP_ERA_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/** How one connect settles the protocol era (B11). */
export type McpEraNegotiation = "auto" | "legacy" | "pinned";

/**
 * Fresh legacy verdicts, keyed by {@link mcpEraCacheKey} (B11). Injected so a
 * test can drive the clock; a fresh verdict runs the 2025 handshake without
 * probing, and the record is never refreshed by the success it caused.
 */
export interface McpEraVerdicts {
  hasFresh(key: string, now: number): boolean;
  record(key: string, now: number): void;
  forget(key: string): void;
}

/** The in-memory verdict cache; the on-disk record is B12's. */
export class McpEraVerdictCache implements McpEraVerdicts {
  private readonly checkedAt = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_MCP_ERA_VERDICT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Whether `key` holds a verdict younger than the lifetime. */
  hasFresh(key: string, now: number): boolean {
    const at = this.checkedAt.get(key);
    if (at === undefined) return false;
    const age = now - at;
    // A verdict dated in the future is distrusted rather than trusted, and an
    // expired one is dropped: either way the next connect probes (B12).
    if (age < 0 || age >= this.ttlMs) {
      this.checkedAt.delete(key);
      return false;
    }
    return true;
  }

  record(key: string, now: number): void {
    this.checkedAt.set(key, now);
  }

  forget(key: string): void {
    this.checkedAt.delete(key);
  }
}

/** The cache one process shares when a caller injects none. */
const processMcpEraVerdicts = new McpEraVerdictCache();

/**
 * The cache key for one server's era (B11): the canonical name plus the
 * transport's identity, so changing a server's command or URL probes again.
 */
export function mcpEraCacheKey(
  server: string,
  config: McpServerConfig,
): string {
  const identity =
    config.type === "stdio"
      ? ["protocol-era", server, config.type, config.command, ...config.args]
      : ["protocol-era", server, config.type, config.url];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** The revision a `server/discover` answer offers, when it offers one (B11). */
function discoveredRevision(result: unknown): string | undefined {
  if (!isJsonObject(result)) return undefined;
  if (result["protocolVersion"] === MCP_MODERN_PROTOCOL_VERSION) {
    return MCP_MODERN_PROTOCOL_VERSION;
  }
  const supported = result["supportedVersions"];
  if (
    Array.isArray(supported) &&
    supported.includes(MCP_MODERN_PROTOCOL_VERSION)
  ) {
    return MCP_MODERN_PROTOCOL_VERSION;
  }
  return undefined;
}

/**
 * Whether a probe failure is a server saying it does not speak the revision
 * (B11) rather than a connect that never got an answer.
 */
function isEraRefusal(error: unknown): boolean {
  if (!(error instanceof McpProtocolError)) return false;
  if (
    error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION_CODE ||
    error.code === MCP_METHOD_NOT_FOUND_CODE
  ) {
    return true;
  }
  return (
    error.status !== undefined && MCP_PROBE_HTTP_REFUSALS.has(error.status)
  );
}

/** Whether a refused 2025 handshake asks for the modern revision (B11). */
function isModernRescue(error: unknown): boolean {
  return (
    error instanceof McpProtocolError &&
    error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION_CODE &&
    error.message.includes(MCP_MODERN_PROTOCOL_VERSION)
  );
}

/** Client identity sent in `initialize`; a caller may replace it. */
export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

/** Default identity; the CLI passes its brand values through instead. */
export const DEFAULT_MCP_CLIENT_INFO: McpClientInfo = {
  name: PROGRAM,
  version: PRODUCT_VERSION,
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

/** The `initialize` result, as far as this build reads it. */
export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo:
    { readonly name: string; readonly version: string } | undefined;
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
  /** How many `tools/list` pages the listing read (B13). */
  readonly pages: number;
}

/** One validated `tools/list` page, before the chain merges it (B13). */
export interface McpToolListPage {
  readonly tools: readonly McpToolInfo[];
  readonly skipped: readonly McpSkippedTool[];
  readonly nextCursor: string | undefined;
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
    throw new McpProtocolError(
      "returned an initialize result that is not an object",
      {
        server,
        method: "initialize",
      },
    );
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
      throw new McpProtocolError("returned serverInfo that is not an object", {
        server,
        method: "initialize",
      });
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

const INVALID_TOOLS_LIST =
  "The MCP server returned an invalid tools/list result";

/**
 * Validate one `tools/list` page (B14). The page is parsed strictly first; a
 * page that fails becomes a per-tool pass that keeps every conforming tool and
 * reports each refusal, so one bad tool never discards the listing.
 */
export function parseToolsListResult(
  result: unknown,
  server: string,
): McpToolListPage {
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

function parseToolInfo(entry: unknown): ParsedToolInfo {
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

/** The SDK's three structured-output validation markers (B23). */
export const OUTPUT_SCHEMA_VALIDATION_MARKERS = [
  "Structured content does not match the tool's output schema",
  "Failed to validate structured content",
  "has an output schema but did not return structured content",
] as const;

/** The sentence B23 puts in place of a validation error. */
export function outputSchemaRemediation(label: {
  readonly server?: string;
  readonly tool?: string;
}): string {
  const target =
    label.server !== undefined && label.tool !== undefined
      ? `MCP tool ${label.server}/${label.tool}`
      : "MCP tool";
  return `${target} returned structured output that does not match its output schema. Contact the MCP server owner to fix the schema or response.`;
}

/**
 * Render a validated result for the model (B22): text blocks are re-indented
 * JSON, an empty successful result renders `structuredContent` or
 * `[No content returned]`, and an `isError` result renders `Error: ...`. An
 * error text naming one of the three structured-output validation markers is
 * replaced by the remediation sentence instead (B23).
 *
 * TODO(spec B22): image blocks are reported by type and size instead of being
 * compressed; the two placeholders themselves are quoted by the clause.
 */
export function renderToolCallResult(
  result: McpCallToolResult,
  label: { readonly server?: string; readonly tool?: string } = {},
): McpToolCallResult {
  const bounded = (text: string): string =>
    boundText(text, MODEL_RESULT_BUDGET_BYTES, "the MCP server response").text;

  if (result.isError) {
    const firstText = result.content.find((block) => block.kind === "text");
    if (firstText !== undefined && firstText.kind === "text") {
      if (
        OUTPUT_SCHEMA_VALIDATION_MARKERS.some((marker) =>
          firstText.text.includes(marker),
        )
      ) {
        return {
          text: bounded(outputSchemaRemediation(label)),
          content: result.content,
          structuredContent: result.structuredContent,
        };
      }
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

export interface McpClientOptions {
  /** Canonical (normalized) server name; every identity carries it. */
  readonly server: string;
  readonly config: McpServerConfig;
  /** Sent in `initialize`; the CLI passes its brand values. */
  readonly clientInfo?: McpClientInfo;
  readonly timers?: McpTimers;
  readonly fetch?: McpFetch;
  /** The session environment a stdio child starts from. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly closeGraceMs?: number;
  readonly maxFrameBytes?: number;
  /** Replaces the config's `connectTimeout` and the transport default (B10). */
  readonly connectTimeoutMs?: number;
  /** Replaces the 15 s listing budget (B13). */
  readonly listTimeoutMs?: number;
  /** Replaces the server's `timeout` and the 180 s call budget (B20). */
  readonly callTimeoutMs?: number;
  /** Replaces the 60 s negative-cache lifetime (B13). */
  readonly listingFailureTtlMs?: number;
  /** Injected clock for the listing deadline and the cache. */
  readonly now?: () => number;
  /** How this connect settles the era (B11); `auto` by default. */
  readonly eraNegotiation?: McpEraNegotiation;
  /** Replaces the process-wide legacy verdict cache (B11). */
  readonly eraVerdicts?: McpEraVerdicts;
  /** A prepared transport; the client owns it and closes it. */
  readonly transport?: McpTransport;
  /**
   * Observes the server notifications the client acts on, after its own
   * invalidation ran (B72). The `sse` inbound stream is opened by subscribing.
   */
  readonly onServerNotification?: (notification: McpServerNotification) => void;
  /** Replaces the `sse` inbound reconnect policy (B72). */
  readonly sseReconnect?: McpSseReconnectPolicy;
}

interface ListingFailure {
  readonly at: number;
  readonly error: McpError;
}

/**
 * One server's MCP session. Construct it through {@link createMcpClient}, which
 * also performs the handshake; a transport that fails mid-lifecycle settles
 * every pending request and can never accept another.
 */
export class McpClient {
  readonly server: string;
  readonly config: McpServerConfig;

  private readonly transport: McpTransport;
  private readonly transportLabel: "stdio" | "http";
  private readonly clientInfo: McpClientInfo;
  private readonly timers: McpTimers;
  private readonly now: () => number;
  private readonly connectTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly listingFailureTtlMs: number;
  private readonly eraNegotiation: McpEraNegotiation;
  private readonly eraVerdicts: McpEraVerdicts;
  private readonly onServerNotification:
    ((notification: McpServerNotification) => void) | undefined;
  private state: "new" | "connecting" | "open" | "closing" | "closed" = "new";
  private closePromise: Promise<void> | undefined;
  private listingFailure: ListingFailure | undefined;
  /** The last successful listing, until a `tools/list_changed` invalidates it. */
  private listing: McpToolList | undefined;
  private protocolVersionValue: string | undefined;
  private capabilitiesValue: Readonly<Record<string, unknown>> = {};
  private serverInfoValue: McpInitializeResult["serverInfo"];

  constructor(options: McpClientOptions) {
    this.server = options.server;
    this.config = options.config;
    this.transportLabel = options.config.type === "stdio" ? "stdio" : "http";
    this.clientInfo = options.clientInfo ?? DEFAULT_MCP_CLIENT_INFO;
    this.timers = options.timers ?? systemMcpTimers;
    this.now = options.now ?? Date.now;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS;
    this.callTimeoutMs =
      options.callTimeoutMs ??
      options.config.timeout ??
      DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.listingFailureTtlMs =
      options.listingFailureTtlMs ?? DEFAULT_MCP_LISTING_FAILURE_TTL_MS;
    this.eraNegotiation = options.eraNegotiation ?? "auto";
    this.eraVerdicts = options.eraVerdicts ?? processMcpEraVerdicts;
    this.onServerNotification = options.onServerNotification;
    this.connectTimeoutMs =
      options.connectTimeoutMs ??
      options.config.connectTimeout ??
      (options.config.type === "stdio"
        ? DEFAULT_MCP_STDIO_CONNECT_TIMEOUT_MS
        : DEFAULT_MCP_CONNECT_TIMEOUT_MS);
    this.transport = options.transport ?? this.buildTransport(options);
  }

  private buildTransport(options: McpClientOptions): McpTransport {
    return createMcpTransport(options.config, {
      server: options.server,
      timers: this.timers,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.closeGraceMs === undefined
        ? {}
        : { closeGraceMs: options.closeGraceMs }),
      ...(options.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: options.maxFrameBytes }),
      ...(options.sseReconnect === undefined
        ? {}
        : { sseReconnect: options.sseReconnect }),
    });
  }

  /** Whether the handshake completed and the transport is still open. */
  get connected(): boolean {
    return this.state === "open";
  }

  /** The revision the server chose; `undefined` before the handshake. */
  get protocolVersion(): string | undefined {
    return this.protocolVersionValue;
  }

  get serverInfo(): McpInitializeResult["serverInfo"] {
    return this.serverInfoValue;
  }

  get capabilities(): Readonly<Record<string, unknown>> {
    return this.capabilitiesValue;
  }

  /**
   * Settle the era, then complete the handshake, inside the connect budget
   * (B10, B11). A failure closes the transport, so a rejected connect leaves
   * no process behind.
   */
  async connect(): Promise<void> {
    if (this.state === "open") return;
    if (this.state !== "new") {
      throw new McpConnectError(
        `MCP server "${this.server}" is already closed`,
        { server: this.server, method: "initialize" },
      );
    }
    this.state = "connecting";

    const key = mcpEraCacheKey(this.server, this.config);
    // An `sse` transport predates the modern revision, and a caller that pins
    // `legacy` wants the 2025 client exactly: neither probes nor remembers.
    const negotiating =
      this.config.type !== "sse" && this.eraNegotiation !== "legacy";
    const cached = negotiating && this.eraVerdicts.hasFresh(key, this.now());
    let verdictFromProbe = false;
    let modern = false;

    try {
      if (negotiating && !cached) {
        const revision = await this.probeEra();
        modern = revision !== undefined;
        verdictFromProbe = !modern;
      }
      if (!modern) {
        // A cached verdict is the one path that can still be wrong when the
        // handshake is refused as a 2025 client, so only it rescues (B11).
        modern = await this.runLegacyHandshake(cached);
      }
    } catch (error) {
      if (cached) this.eraVerdicts.forget(key);
      await this.transport.close();
      this.state = "closed";
      if (
        error instanceof McpTimeoutError ||
        error instanceof McpProtocolError ||
        error instanceof McpConnectError
      ) {
        throw error;
      }
      // An exit carries its code and stderr tail in the cause; surface both so a
      // failing handshake is diagnosable without inspecting the chain.
      const detail =
        error instanceof McpError && error.cause instanceof Error
          ? `${messageOf(error)} (${error.cause.message})`
          : messageOf(error);
      throw new McpConnectError(
        `MCP server "${this.server}" could not complete the initialize handshake: ${detail}`,
        { server: this.server, method: "initialize", cause: error },
      );
    }

    // A modern server costs the same one probe whether or not it is known, so
    // its verdict is not stored; a legacy one came from a probe, and that is
    // the only verdict worth keeping — a cached one never refreshes itself.
    if (modern) this.eraVerdicts.forget(key);
    else if (verdictFromProbe) this.eraVerdicts.record(key, this.now());

    this.state = "open";
    this.transport.setNotificationHandler?.((notification) => {
      // B13/B72: a listing-changed notification invalidates both caches, so the
      // next listing re-reads once instead of reusing a stale answer.
      if (notification.method === "notifications/tools/list_changed") {
        this.listingFailure = undefined;
        this.listing = undefined;
      }
      this.onServerNotification?.(notification);
    });
  }

  /**
   * Ask a server which era it speaks (B11). Returns the modern revision when
   * the probe is accepted and `undefined` when this connect must run the 2025
   * handshake; an answer without the revision is a 2025-era server under
   * `auto` and a protocol error under `pinned`, while any failure other than
   * a refusal propagates.
   */
  private async probeEra(): Promise<string | undefined> {
    let result: unknown;
    try {
      result = await this.connectRequest(MCP_DISCOVER_METHOD, {});
    } catch (error) {
      if (this.eraNegotiation !== "pinned" && isEraRefusal(error)) {
        return undefined;
      }
      throw error;
    }
    const revision = discoveredRevision(result);
    if (revision !== undefined) {
      this.applyModernEra(result);
      return revision;
    }
    if (this.eraNegotiation === "pinned") {
      throw new McpProtocolError(
        `answered ${MCP_DISCOVER_METHOD} without the ${MCP_MODERN_PROTOCOL_VERSION} revision`,
        { server: this.server, method: MCP_DISCOVER_METHOD },
      );
    }
    return undefined;
  }

  /**
   * The 2025 `initialize` handshake; `true` when a refusal carrying `-32022`
   * that names the modern revision was rescued by a probe. With `rescue`, that
   * refusal is answered once by that probe rather than surfaced, and a rescue
   * that is not accepted surfaces the refusal (B11).
   */
  private async runLegacyHandshake(rescue: boolean): Promise<boolean> {
    try {
      const result = await this.connectRequest("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo,
      });
      const initialized = parseInitializeResult(result, this.server);
      this.protocolVersionValue = initialized.protocolVersion;
      this.capabilitiesValue = initialized.capabilities;
      this.serverInfoValue = initialized.serverInfo;

      await this.withinBudget(
        (signal) =>
          this.transport.notify("notifications/initialized", undefined, {
            signal,
          }),
        this.connectTimeoutMs,
        "connect",
        "notifications/initialized",
        undefined,
        undefined,
      );
      return false;
    } catch (error) {
      if (!rescue || this.eraNegotiation !== "auto" || !isModernRescue(error)) {
        throw error;
      }
      let revision: string | undefined;
      try {
        revision = await this.probeEra();
      } catch {
        revision = undefined;
      }
      if (revision === undefined) throw error;
      return true;
    }
  }

  /** One connect-phase request, inside the connect budget (B10). */
  private async connectRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    return await this.withinBudget(
      (signal) => this.transport.request(method, params, { signal }),
      this.connectTimeoutMs,
      "connect",
      method,
      undefined,
      undefined,
    );
  }

  /**
   * Read what a `server/discover` answer offers. The revision is what the
   * connect adopts; an unreadable `serverInfo` is simply not reported.
   */
  private applyModernEra(result: unknown): void {
    this.protocolVersionValue = MCP_MODERN_PROTOCOL_VERSION;
    if (!isJsonObject(result)) {
      this.capabilitiesValue = {};
      return;
    }
    const capabilities = result["capabilities"];
    this.capabilitiesValue = isJsonObject(capabilities) ? capabilities : {};
    const info = result["serverInfo"];
    this.serverInfoValue =
      isJsonObject(info) &&
      typeof info["name"] === "string" &&
      typeof info["version"] === "string"
        ? { name: info["name"], version: info["version"] }
        : undefined;
  }

  /** Forget the cached listing and the negative-cached failure (B13, B72). */
  clearListingFailure(): void {
    this.listingFailure = undefined;
    this.listing = undefined;
  }

  /**
   * `tools/list`, following `nextCursor` inside one budget (B13). At most
   * `MAX_TOOL_LIST_PAGES` pages are read and a cursor the chain has already
   * seen is refused, so a server cannot make the listing loop; the result
   * reports how many pages it read. A distinct failure is remembered for
   * `listingFailureTtlMs`; `refresh` clears it first.
   */
  async listTools(
    options: {
      readonly signal?: AbortSignal;
      readonly refresh?: boolean;
    } = {},
  ): Promise<McpToolList> {
    this.requireOpen("tools/list");
    if (options.refresh === true) {
      this.listingFailure = undefined;
      this.listing = undefined;
    }
    const cached = this.listingFailure;
    if (cached !== undefined) {
      if (this.now() - cached.at < this.listingFailureTtlMs) throw cached.error;
      this.listingFailure = undefined;
    }
    // The cache exists so one notification costs one re-read, not one per
    // caller: a stale list is worse than a re-read, so nothing is reused after
    // `tools/list_changed` (B72).
    const remembered = this.listing;
    if (remembered !== undefined) return remembered;

    const budget = this.listTimeoutMs;
    const deadline = this.now() + budget;
    const tools: McpToolInfo[] = [];
    const skipped: McpSkippedTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let pages = 0;

    try {
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_TOOL_LIST_PAGES) {
          throw new McpProtocolError(
            `returned more than ${MAX_TOOL_LIST_PAGES} tools/list pages`,
            { server: this.server, method: "tools/list" },
          );
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          throw new McpTimeoutError("list", budget, {
            server: this.server,
            method: "tools/list",
          });
        }
        const result = await this.withinBudget(
          (signal) =>
            this.transport.request(
              "tools/list",
              cursor === undefined ? {} : { cursor },
              { signal },
            ),
          remaining,
          "list",
          "tools/list",
          undefined,
          options.signal,
        );
        const parsed = parseToolsListResult(result, this.server);
        pages += 1;
        skipped.push(...parsed.skipped);
        for (const tool of parsed.tools) {
          if (names.has(tool.name)) {
            skipped.push({ name: tool.name, reason: "duplicate tool name" });
            continue;
          }
          names.add(tool.name);
          tools.push(tool);
        }
        if (parsed.nextCursor === undefined) break;
        if (cursors.has(parsed.nextCursor)) {
          throw new McpProtocolError(
            `returned the tools/list cursor "${parsed.nextCursor}" twice`,
            { server: this.server, method: "tools/list" },
          );
        }
        cursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
    } catch (error) {
      // A cancel is the caller's, not a server failure: never cached (B13).
      if (error instanceof McpError && !(error instanceof McpCancelledError)) {
        this.listingFailure = { at: this.now(), error };
      }
      throw error;
    }

    this.listingFailure = undefined;
    const listing: McpToolList = { tools, skipped, pages };
    this.listing = listing;
    return listing;
  }

  /**
   * `tools/call` inside the server's budget (B20). A result with `isError`
   * becomes a `McpToolError` whose message is the rendered `Error: ...` text
   * (B22); a successful call returns that text and the validated blocks.
   */
  async callTool(
    tool: string,
    args: Readonly<Record<string, unknown>> = {},
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<McpToolCallResult> {
    this.requireOpen("tools/call", tool);
    const budget = options.timeoutMs ?? this.callTimeoutMs;
    const result = await this.withinBudget(
      (signal) =>
        this.transport.request(
          "tools/call",
          { name: tool, arguments: args },
          { signal },
        ),
      budget,
      "call",
      "tools/call",
      tool,
      options.signal,
    );
    const parsed = parseCallToolResult(result, this.server, tool);
    const rendered = renderToolCallResult(parsed, {
      server: this.server,
      tool,
    });
    if (parsed.isError) {
      throw new McpToolError(rendered.text, {
        server: this.server,
        method: "tools/call",
        tool,
        text: rendered.text,
      });
    }
    return rendered;
  }

  /** Close the transport and settle every pending request. Idempotent. */
  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.state = "closing";
    try {
      await this.transport.close();
    } finally {
      this.state = "closed";
    }
  }

  private requireOpen(method: string, tool?: string): void {
    if (this.state === "open") return;
    throw new McpCancelledError("not_sent", "client_closed", {
      server: this.server,
      method,
      ...(tool === undefined ? {} : { tool }),
      transport: this.transportLabel,
    });
  }

  /**
   * Run `start` inside `budgetMs`. The timer aborts the request and the timeout
   * wins the race, so a slow server is never reported as a cancellation; an
   * abort that came from the caller keeps the transport's `stage`.
   */
  private async withinBudget<T>(
    start: (signal: AbortSignal) => Promise<T>,
    budgetMs: number,
    phase: McpTimeoutPhase,
    method: string,
    tool: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (isAborted(signal)) {
      throw new McpCancelledError("not_sent", "aborted", {
        server: this.server,
        method,
        ...(tool === undefined ? {} : { tool }),
        transport: this.transportLabel,
        reason: abortReason(signal),
      });
    }

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const cancel = this.timers.set(() => {
      timedOut = true;
      controller.abort();
    }, budgetMs);

    try {
      return await start(controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new McpTimeoutError(phase, budgetMs, {
          server: this.server,
          method,
          ...(tool === undefined ? {} : { tool }),
          cause: error,
        });
      }
      if (error instanceof McpCancelledError && isAborted(signal)) {
        throw new McpCancelledError(error.stage, "aborted", {
          server: this.server,
          method,
          ...(tool === undefined ? {} : { tool }),
          transport: this.transportLabel,
          reason: abortReason(signal),
          cause: error,
        });
      }
      throw error;
    } finally {
      cancel();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Build a client and complete its handshake. Rejects with a typed MCP error
 * after closing the transport, so a failed connect leaves nothing running.
 */
export async function createMcpClient(
  options: McpClientOptions,
): Promise<McpClient> {
  const client = new McpClient(options);
  await client.connect();
  return client;
}
