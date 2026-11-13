/**
 * Typed failures for the MCP client boundary. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B10, B13, B20-B23 and the Errors
 * table.
 *
 * Everything a server sends is untrusted, so a failure is a class the caller
 * can switch on rather than a bare string: a tool that reported its own
 * failure (`McpToolError`) is not a broken frame (`McpProtocolError`), a slow
 * server (`McpTimeoutError`) is not a request the caller cancelled
 * (`McpCancelledError`), and a server that never started (`McpConnectError`)
 * is none of those.
 */

/** Which transport produced the failure; part of the spec's error identity. */
export type McpTransportLabel = "stdio" | "http";

export interface McpErrorOptions {
  /** Canonical (normalized) server name: every identity carries it. */
  readonly server: string;
  /** JSON-RPC method the failing request was made under, when there was one. */
  readonly method?: string;
  /** Tool name for a `tools/call` failure. */
  readonly tool?: string;
  readonly cause?: unknown;
}

/** Base class: no MCP failure reaches a caller without its server's name. */
export class McpError extends Error {
  readonly server: string;
  readonly method: string | undefined;
  readonly tool: string | undefined;

  constructor(message: string, options: McpErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "McpError";
    this.server = options.server;
    this.method = options.method;
    this.tool = options.tool;
  }
}

/**
 * No conversation was possible: the command could not be started, the process
 * died before the handshake completed, or the remote endpoint refused the
 * `initialize` request. The concrete transport error is kept as `cause`.
 */
export class McpConnectError extends McpError {
  constructor(message: string, options: McpErrorOptions) {
    super(message, options);
    this.name = "McpConnectError";
  }
}

/**
 * The stream violated JSON-RPC or the MCP result shape: an unreadable frame, an
 * answer for an id that was never sent, an error the server could not
 * attribute, a JSON-RPC error response, or a result whose documented shape is
 * missing. `code` is the server's JSON-RPC number when it sent one.
 */
export class McpProtocolError extends McpError {
  readonly code: number | undefined;
  /** The HTTP status a remote transport answered with, when it was not ok. */
  readonly status: number | undefined;
  /** Why a result was refused, when the spec asks for a separate reason. */
  readonly reason: string | undefined;

  constructor(
    message: string,
    options: McpErrorOptions & {
      readonly code?: number;
      readonly status?: number;
      readonly reason?: string;
    },
  ) {
    super(message, options);
    this.name = "McpProtocolError";
    this.code = options.code;
    this.status = options.status;
    this.reason = options.reason;
  }
}

/**
 * The server answered `tools/call` with `isError: true`. `text` is the
 * rendered result text the model would see (`Error: ...`, B22).
 */
export class McpToolError extends McpError {
  readonly text: string;

  constructor(
    message: string,
    options: McpErrorOptions & { readonly text: string },
  ) {
    super(message, options);
    this.name = "McpToolError";
    this.text = options.text;
  }
}

/** Which lifecycle phase ran out of budget (B10, B13, B20). */
export type McpTimeoutPhase = "connect" | "list" | "call";

/** Seconds as the spec writes them: `10`, `1.5`, `0.2`. */
function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)));
}

/**
 * `initialize`, `tools/list` or `tools/call` got no answer inside its budget.
 * The message for the connect phase is the spec's wording verbatim.
 */
export class McpTimeoutError extends McpError {
  readonly phase: McpTimeoutPhase;
  readonly timeoutMs: number;

  constructor(
    phase: McpTimeoutPhase,
    timeoutMs: number,
    options: McpErrorOptions,
  ) {
    super(timeoutMessage(phase, timeoutMs, options), options);
    this.name = "McpTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

function timeoutMessage(
  phase: McpTimeoutPhase,
  timeoutMs: number,
  options: McpErrorOptions,
): string {
  switch (phase) {
    case "connect":
      return `MCP server connection timed out after ${seconds(timeoutMs)} seconds`;
    case "list":
      return `MCP server "${options.server}" did not answer tools/list within ${seconds(timeoutMs)} seconds`;
    case "call":
      return `MCP tool ${options.server}/${options.tool ?? "unknown"} timed out after ${seconds(timeoutMs)} seconds`;
  }
}

/** Whether the request had already reached the server when it settled. */
export type McpCancelStage = "not_sent" | "in_flight";

/** Why a request settled early. */
export type McpCancelTrigger = "aborted" | "transport_closed" | "client_closed";

/**
 * A request settled before its answer arrived. `stage` is the spec's
 * distinction (B21): `not_sent` means the server cannot have acted on it,
 * `in_flight` means it may have.
 */
export class McpCancelledError extends McpError {
  readonly stage: McpCancelStage;
  readonly trigger: McpCancelTrigger;
  readonly transport: McpTransportLabel;

  constructor(
    stage: McpCancelStage,
    trigger: McpCancelTrigger,
    options: McpErrorOptions & {
      readonly transport: McpTransportLabel;
      readonly reason?: unknown;
    },
  ) {
    super(cancelMessage(stage, trigger, options), options);
    this.name = "McpCancelledError";
    this.stage = stage;
    this.trigger = trigger;
    this.transport = options.transport;
  }
}

function cancelMessage(
  stage: McpCancelStage,
  trigger: McpCancelTrigger,
  options: McpErrorOptions & { readonly transport: McpTransportLabel },
): string {
  const method = options.method ?? "request";
  if (trigger === "transport_closed") {
    if (options.transport === "stdio") {
      // The spec's identity for a stdio call whose transport closed (B21).
      return "Stdio MCP server transport closed";
    }
    return `MCP server "${options.server}" HTTP transport closed before answering ${method}`;
  }
  if (trigger === "client_closed") {
    return `MCP client for "${options.server}" was closed before answering ${method}`;
  }
  return stage === "not_sent"
    ? `MCP server "${options.server}" cancelled ${method} before it was sent`
    : `MCP server "${options.server}" cancelled ${method} after it was sent; the server may already have acted`;
}
