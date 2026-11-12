/**
 * Agent Client Protocol wire types, envelopes and validating parsers.
 * Contract: `specs/60-extensions-mcp-and-skills.md` §ACP B60-B71.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited JSON. Everything that arrives
 * from the client is untrusted: every frame is validated as an envelope, and
 * every method's params are parsed into a typed value before the server uses
 * them. Envelope shapes mirror the reference SDK's guards (`jsonrpc`,
 * `id`/`method`/`result`/`error`), including the error text and codes it puts
 * on the wire, so a client written against the SDK reads the same refusals.
 *
 * Outbound payloads (notifications and the `initialize` result) are built here
 * too, so the shapes the agent emits live next to the shapes it accepts.
 */

import { isUtf8 } from "node:buffer";

import { isRecord } from "../transport/schema.ts";

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

/** The only `jsonrpc` value ACP accepts. */
export const ACP_JSONRPC_VERSION = "2.0";
/** The protocol version this agent speaks (ACP bumps it only for breaks). */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Ceiling for one NDJSON line.
 *
 * TODO(spec B60): the ACP clause pins no frame ceiling, so this mirrors the
 * daemon's 8 MiB `MAX_FRAME_BYTES`; a client that sends more is answered with
 * a parse error and the rest of the line is discarded.
 */
export const ACP_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** The JSON-RPC codes this surface uses, with the SDK's meanings. */
export const ACP_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

/** Method names the agent serves or receives (B61). */
export const ACP_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  logout: "logout",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionFork: "session/fork",
  sessionList: "session/list",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  sessionSetModel: "session/set_model",
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  cancelRequest: "$/cancel_request",
} as const;

export type AcpRequestId = string | number;

export interface AcpErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface AcpRequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: AcpRequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpNotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpSuccessMessage {
  readonly jsonrpc: "2.0";
  readonly id: AcpRequestId;
  readonly result: unknown;
}

export interface AcpFailureMessage {
  readonly jsonrpc: "2.0";
  /** `null` when the frame could not be parsed, so it has no request. */
  readonly id: AcpRequestId | null;
  readonly error: AcpErrorObject;
}

export type AcpResponseMessage = AcpSuccessMessage | AcpFailureMessage;

export type AcpInboundMessage =
  AcpRequestMessage | AcpNotificationMessage | AcpResponseMessage;

/**
 * A frame that broke the protocol. `code` and `message` are what the client is
 * answered with; `data` is the structured detail the SDK would send.
 */
export class AcpProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpProtocolError";
    this.code = code;
    this.data = data;
  }
}

function invalidParams(detail: string, data?: unknown): AcpProtocolError {
  const error = new AcpProtocolError(
    ACP_ERROR_CODES.invalidParams,
    `Invalid params: ${detail}`,
    data,
  );
  return error;
}

function invalidRequest(detail: string, data?: unknown): AcpProtocolError {
  return new AcpProtocolError(
    ACP_ERROR_CODES.invalidRequest,
    `Invalid request: ${detail}`,
    data,
  );
}

function parseError(detail?: string): AcpProtocolError {
  return new AcpProtocolError(
    ACP_ERROR_CODES.parse,
    detail === undefined ? "Parse error" : `Parse error: ${detail}`,
  );
}

/** Build one `{code, message, data?}` object; `data` is omitted when absent. */
export function createErrorObject(
  code: number,
  message: string,
  data?: unknown,
): AcpErrorObject {
  return { code, message, ...(data === undefined ? {} : { data }) };
}

/* -------------------------------------------------------------------------- */
/* Envelope parsing                                                           */
/* -------------------------------------------------------------------------- */

function isRequestId(value: unknown): value is AcpRequestId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidParams(`${field} must be a string`, { field });
  }
  return value;
}

function optionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidParams(`${field} must be an object`, { field });
  }
  return value;
}

function parseErrorObject(value: unknown): AcpErrorObject {
  if (!isRecord(value)) {
    throw invalidRequest("error must be an object");
  }
  if (typeof value["code"] !== "number" || !Number.isInteger(value["code"])) {
    throw invalidRequest("error.code must be an integer");
  }
  if (typeof value["message"] !== "string") {
    throw invalidRequest("error.message must be a string");
  }
  return {
    code: value["code"],
    message: value["message"],
    ...(value["data"] === undefined ? {} : { data: value["data"] }),
  };
}

/**
 * Validate an already-decoded JSON value as an ACP message. Container or
 * envelope failures are `invalidRequest`; only the JSON text itself produces
 * a `parse` error.
 */
export function parseAcpMessage(value: unknown): AcpInboundMessage {
  if (!isRecord(value)) {
    throw invalidRequest("message must be a JSON object");
  }
  if (value["jsonrpc"] !== ACP_JSONRPC_VERSION) {
    throw invalidRequest(`jsonrpc must be "${ACP_JSONRPC_VERSION}"`);
  }

  const method = value["method"];
  if (method !== undefined) {
    if (typeof method !== "string" || method.length === 0) {
      throw invalidRequest("method must be a non-empty string");
    }
    const params = value["params"];
    if (!Object.hasOwn(value, "id")) {
      return {
        jsonrpc: ACP_JSONRPC_VERSION,
        method,
        ...(params === undefined ? {} : { params }),
      };
    }
    const id = value["id"];
    if (!isRequestId(id)) {
      throw invalidRequest("request id must be a string or a finite number");
    }
    return {
      jsonrpc: ACP_JSONRPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
  }

  if (!Object.hasOwn(value, "id")) {
    throw invalidRequest("a message without a method must be a response");
  }
  const id = value["id"];
  if (id !== null && !isRequestId(id)) {
    throw invalidRequest("response id must be a string, a number or null");
  }
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    throw invalidRequest(
      "a response must carry exactly one of result or error",
    );
  }
  if (hasResult) {
    if (id === null) {
      throw invalidRequest("a success response must carry a request id");
    }
    return {
      jsonrpc: ACP_JSONRPC_VERSION,
      id,
      result: value["result"],
    };
  }
  return {
    jsonrpc: ACP_JSONRPC_VERSION,
    id,
    error: parseErrorObject(value["error"]),
  };
}

/** Throw when a serialised frame is above the ceiling. */
export function assertAcpFrameWithinBounds(
  text: string,
  maxBytes: number = ACP_MAX_FRAME_BYTES,
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new AcpProtocolError(
      ACP_ERROR_CODES.parse,
      `Parse error: frame is ${bytes} bytes, above the ${maxBytes}-byte limit`,
    );
  }
}

/** Parse one NDJSON line: bounds, JSON, then the envelope shape. */
export function parseAcpFrame(
  text: string,
  maxBytes: number = ACP_MAX_FRAME_BYTES,
): AcpInboundMessage {
  assertAcpFrameWithinBounds(text, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : undefined);
  }
  return parseAcpMessage(value);
}

/** Serialise one message, refusing a frame above the ceiling. */
export function serializeAcpMessage(
  message: AcpInboundMessage,
  maxBytes: number = ACP_MAX_FRAME_BYTES,
): string {
  const text = JSON.stringify(message);
  assertAcpFrameWithinBounds(text, maxBytes);
  return text;
}

/* -------------------------------------------------------------------------- */
/* Envelope builders                                                          */
/* -------------------------------------------------------------------------- */

export function createAcpRequest(
  id: AcpRequestId,
  method: string,
  params?: unknown,
): AcpRequestMessage {
  return {
    jsonrpc: ACP_JSONRPC_VERSION,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

export function createAcpNotification(
  method: string,
  params?: unknown,
): AcpNotificationMessage {
  return {
    jsonrpc: ACP_JSONRPC_VERSION,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

export function createAcpSuccess(
  id: AcpRequestId,
  result: unknown,
): AcpSuccessMessage {
  return { jsonrpc: ACP_JSONRPC_VERSION, id, result };
}

export function createAcpFailure(
  id: AcpRequestId | null,
  code: number,
  message: string,
  data?: unknown,
): AcpFailureMessage {
  return {
    jsonrpc: ACP_JSONRPC_VERSION,
    id,
    error: createErrorObject(code, message, data),
  };
}

/* -------------------------------------------------------------------------- */
/* initialize (B62)                                                           */
/* -------------------------------------------------------------------------- */

export interface AcpImplementation {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

export interface AcpInitializeParams {
  readonly protocolVersion: number;
  readonly clientCapabilities?: Record<string, unknown>;
  readonly clientInfo?: AcpImplementation;
}

function parseImplementation(value: unknown, field: string): AcpImplementation {
  if (!isRecord(value)) {
    throw invalidParams(`${field} must be an object`, { field });
  }
  return {
    name: requireString(value["name"], `${field}.name`),
    version: requireString(value["version"], `${field}.version`),
    ...(value["title"] === undefined
      ? {}
      : { title: requireString(value["title"], `${field}.title`) }),
  };
}

export function parseInitializeParams(params: unknown): AcpInitializeParams {
  if (!isRecord(params)) {
    throw invalidParams("initialize params must be an object");
  }
  const version = params["protocolVersion"];
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 0 ||
    version > 65535
  ) {
    throw invalidParams("protocolVersion must be an integer from 0 to 65535");
  }
  const capabilities = optionalRecord(
    params["clientCapabilities"],
    "clientCapabilities",
  );
  const info = params["clientInfo"];
  return {
    protocolVersion: version,
    ...(capabilities === undefined ? {} : { clientCapabilities: capabilities }),
    ...(info === undefined
      ? {}
      : { clientInfo: parseImplementation(info, "clientInfo") }),
  };
}

export type AcpDeployment = "cloud" | "customer-prem";

export interface AcpAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface AcpSessionCapabilities {
  readonly list: Record<string, never>;
  readonly resume: Record<string, never>;
  readonly close: Record<string, never>;
  readonly fork: Record<string, never>;
}

export interface AcpAgentCapabilities {
  readonly loadSession: boolean;
  readonly sessionCapabilities: AcpSessionCapabilities;
  readonly promptCapabilities: {
    readonly image: boolean;
    readonly embeddedContext: boolean;
  };
  readonly mcpCapabilities: {
    readonly http: boolean;
    readonly sse: boolean;
  };
  readonly auth: { readonly logout: Record<string, never> };
  readonly _meta: { readonly "terminal-auth": true };
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: AcpAgentCapabilities;
  readonly agentInfo: AcpImplementation;
  readonly authMethods: readonly AcpAuthMethod[];
}

/** The auth methods `initialize` advertises for a deployment (B62). */
export function authMethodsFor(
  deployment: AcpDeployment,
): readonly AcpAuthMethod[] {
  if (deployment === "customer-prem") {
    return [
      {
        id: "customer-prem",
        name: "Customer Prem Login",
        description:
          "Authenticate with your customer-prem deployment's organization.",
      },
    ];
  }
  return [
    {
      id: "device-pairing",
      name: "Login",
      description:
        "Authenticate with Factory using a device pairing code in your browser.",
    },
    {
      id: "factory-api-key",
      name: "Factory API Key",
      description:
        "Authenticate using a Factory API key set in the DROIDE_API_KEY environment variable.",
    },
  ];
}

export interface BuildInitializeResultOptions {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly deployment?: AcpDeployment;
}

/** The `initialize` result with the capabilities B62 pins. */
export function buildInitializeResult(
  options: BuildInitializeResultOptions,
): AcpInitializeResult {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      auth: { logout: {} },
      // UNSTABLE: the Zed terminal-auth extension.
      _meta: { "terminal-auth": true },
    },
    agentInfo: {
      name: options.name,
      version: options.version,
      ...(options.title === undefined ? {} : { title: options.title }),
    },
    authMethods: authMethodsFor(options.deployment ?? "cloud"),
  };
}

export interface AcpAuthenticateParams {
  readonly methodId: string;
}

export function parseAuthenticateParams(
  params: unknown,
): AcpAuthenticateParams {
  if (!isRecord(params)) {
    throw invalidParams("authenticate params must be an object");
  }
  return { methodId: requireString(params["methodId"], "methodId") };
}

/* -------------------------------------------------------------------------- */
/* session/new: MCP servers (B63, B64)                                        */
/* -------------------------------------------------------------------------- */

export interface AcpWireEnvVariable {
  readonly name: string;
  readonly value: string;
}

export interface AcpWireHeader {
  readonly name: string;
  readonly value: string;
}

export type AcpWireMcpServer =
  | {
      readonly type: "stdio";
      readonly name: string;
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: readonly AcpWireEnvVariable[];
    }
  | {
      readonly type: "http" | "sse";
      readonly name: string;
      readonly url: string;
      readonly headers?: readonly AcpWireHeader[];
    }
  | {
      readonly type: "acp";
      readonly name: string;
      readonly serverId: string;
    };

/** The daemon-shaped server the session is initialized with (B64). */
export type AcpSessionMcpServer =
  | {
      readonly type: "stdio";
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "http" | "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

function parseNamedValue(
  value: unknown,
  field: string,
): { readonly name: string; readonly value: string } {
  if (!isRecord(value)) {
    throw invalidParams(`${field} entries must be objects`, { field });
  }
  return {
    name: requireString(value["name"], `${field}.name`),
    value: requireString(value["value"], `${field}.value`),
  };
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidParams(`${field} must be an array`, { field });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw invalidParams(`${field}[${index}] must be a string`, { field });
    }
    return entry;
  });
}

function parseNamedValueArray(
  value: unknown,
  field: string,
): readonly { readonly name: string; readonly value: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidParams(`${field} must be an array`, { field });
  }
  return value.map((entry, index) =>
    parseNamedValue(entry, `${field}[${index}]`),
  );
}

/** Parse one `McpServer` from `session/new` without converting it. */
export function parseAcpMcpServer(value: unknown): AcpWireMcpServer {
  if (!isRecord(value)) {
    throw invalidParams("mcpServers entries must be objects");
  }
  const name = requireString(value["name"], "mcpServers[].name");
  const type = value["type"];
  if (type !== undefined && typeof type !== "string") {
    throw invalidParams("mcpServers[].type must be a string");
  }
  if (type === "acp") {
    return {
      type: "acp",
      name,
      serverId: requireString(value["serverId"], "mcpServers[].serverId"),
    };
  }
  if (type === "http" || type === "sse") {
    return {
      type,
      name,
      url: requireString(value["url"], "mcpServers[].url"),
      headers: parseNamedValueArray(value["headers"], "mcpServers[].headers"),
    };
  }
  if (type !== undefined && type !== "stdio") {
    throw invalidParams(`mcpServers[].type "${type}" is not a transport`);
  }
  if (typeof value["command"] !== "string") {
    throw invalidParams(
      "mcpServers[].command is required for the stdio transport",
    );
  }
  return {
    type: "stdio",
    name,
    command: value["command"],
    args: parseStringArray(value["args"], "mcpServers[].args"),
    env: parseNamedValueArray(value["env"], "mcpServers[].env"),
  };
}

function namedValueMap(
  values: readonly { readonly name: string; readonly value: string }[],
): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const entry of values) map[entry.name] = entry.value;
  return map;
}

/**
 * Convert one ACP server to the session shape (B64). `type: 'acp'` is refused
 * here because this agent does not advertise `mcpCapabilities.acp`.
 */
export function convertAcpMcpServer(
  server: AcpWireMcpServer,
): AcpSessionMcpServer {
  if (server.type === "acp") {
    throw invalidParams(
      "MCP servers with the acp transport are not supported",
      { name: server.name },
    );
  }
  if (server.type === "stdio") {
    return {
      type: "stdio",
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: namedValueMap(server.env ?? []),
    };
  }
  return {
    type: server.type,
    name: server.name,
    url: server.url,
    headers: namedValueMap(server.headers ?? []),
  };
}

export interface AcpNewSessionParams {
  readonly cwd: string;
  readonly mcpServers: readonly AcpSessionMcpServer[];
}

export function parseNewSessionParams(params: unknown): AcpNewSessionParams {
  if (!isRecord(params)) {
    throw invalidParams("session/new params must be an object");
  }
  const cwd = requireString(params["cwd"], "cwd");
  const raw = params["mcpServers"];
  if (raw !== undefined && !Array.isArray(raw)) {
    throw invalidParams("mcpServers must be an array");
  }
  const servers: AcpSessionMcpServer[] = [];
  for (const entry of raw ?? []) {
    servers.push(convertAcpMcpServer(parseAcpMcpServer(entry)));
  }
  return { cwd, mcpServers: servers };
}

export interface AcpNewSessionResult {
  readonly sessionId: string;
}

/* -------------------------------------------------------------------------- */
/* Prompt content (B65, B68)                                                  */
/* -------------------------------------------------------------------------- */

export type AcpImageMediaType =
  "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface AcpTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AcpImageBlock {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface AcpAudioBlock {
  readonly type: "audio";
  readonly data: string;
  readonly mimeType: string;
}

export interface AcpResourceLinkBlock {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly description?: string;
  readonly size?: number;
}

export interface AcpEmbeddedResource {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface AcpResourceBlock {
  readonly type: "resource";
  readonly resource: AcpEmbeddedResource;
  readonly _meta?: Record<string, unknown>;
}

export type AcpContentBlock =
  | AcpTextBlock
  | AcpImageBlock
  | AcpAudioBlock
  | AcpResourceLinkBlock
  | AcpResourceBlock;

function parseOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

/** Parse one prompt content block; every unknown `type` is invalid params. */
export function parseAcpContentBlock(value: unknown): AcpContentBlock {
  if (!isRecord(value)) {
    throw invalidParams("prompt entries must be objects");
  }
  const type = value["type"];
  switch (type) {
    case "text":
      return { type: "text", text: requireString(value["text"], "text") };
    case "image":
      return {
        type: "image",
        data: requireString(value["data"], "image.data"),
        mimeType: requireString(value["mimeType"], "image.mimeType"),
      };
    case "audio":
      return {
        type: "audio",
        data: requireString(value["data"], "audio.data"),
        mimeType: requireString(value["mimeType"], "audio.mimeType"),
      };
    case "resource_link": {
      const name = parseOptionalString(value["name"], "resource_link.name");
      const mimeType = parseOptionalString(
        value["mimeType"],
        "resource_link.mimeType",
      );
      const description = parseOptionalString(
        value["description"],
        "resource_link.description",
      );
      return {
        type: "resource_link",
        uri: requireString(value["uri"], "resource_link.uri"),
        ...(name === undefined ? {} : { name }),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(description === undefined ? {} : { description }),
        ...parseOptionalSize(value["size"]),
      };
    }
    case "resource": {
      const resource = value["resource"];
      if (!isRecord(resource)) {
        throw invalidParams("resource.resource must be an object");
      }
      const uri = requireString(resource["uri"], "resource.uri");
      const mimeType = parseOptionalString(
        resource["mimeType"],
        "resource.mimeType",
      );
      const text = parseOptionalString(resource["text"], "resource.text");
      const blob = parseOptionalString(resource["blob"], "resource.blob");
      if (text === undefined && blob === undefined) {
        throw invalidParams("resource must carry text or blob");
      }
      return {
        type: "resource",
        resource: {
          uri,
          ...(mimeType === undefined ? {} : { mimeType }),
          ...(text === undefined ? {} : { text }),
          ...(blob === undefined ? {} : { blob }),
        },
      };
    }
    default:
      throw invalidParams(`prompt content type "${String(type)}" is unknown`);
  }
}

function parseOptionalSize(value: unknown): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidParams("resource_link.size must be a number");
  }
  return { size: value };
}

export interface AcpPromptParams {
  readonly sessionId: string;
  readonly prompt: readonly AcpContentBlock[];
}

export function parsePromptParams(params: unknown): AcpPromptParams {
  if (!isRecord(params)) {
    throw invalidParams("session/prompt params must be an object");
  }
  const sessionId = requireString(params["sessionId"], "sessionId");
  const prompt = params["prompt"];
  if (!Array.isArray(prompt)) {
    throw invalidParams("prompt must be an array");
  }
  return {
    sessionId,
    prompt: prompt.map((block) => parseAcpContentBlock(block)),
  };
}

function formatResourceLink(uri: string): string {
  if (uri.startsWith("file://")) {
    const name = uri.split("/").pop();
    return name === undefined || name === "" ? uri : `[@${name}](${uri})`;
  }
  if (uri.startsWith("zed://")) {
    const match = /zed:\/\/[^/]+\/(.+)$/.exec(uri);
    const name = match?.[1];
    return name === undefined || name === "" ? uri : `[@${name}](${uri})`;
  }
  return uri;
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return isUtf8(bytes);
}

/**
 * The prompt text one turn receives (B65). Text and resource links are the
 * primary message; embedded resources and unsupported blobs become context
 * blocks appended after it. An empty prompt yields `""`, and the caller
 * substitutes the literal `Process request`.
 */
export function formatPromptForExec(
  prompt: readonly AcpContentBlock[],
): string {
  const primary: string[] = [];
  const contextual: string[] = [];

  for (const block of prompt) {
    switch (block.type) {
      case "text":
        primary.push(block.text);
        break;
      case "resource_link":
        primary.push(formatResourceLink(block.uri));
        break;
      case "resource": {
        const { resource } = block;
        primary.push(formatResourceLink(resource.uri));
        if (resource.text !== undefined && resource.text !== "") {
          contextual.push(
            `<context ref="${resource.uri}">\n${resource.text}\n</context>`,
          );
        } else if (resource.blob !== undefined) {
          const mimeType = resource.mimeType ?? "application/octet-stream";
          if (mimeType.startsWith("image/")) {
            contextual.push(`[Embedded image (${mimeType})]`);
            break;
          }
          const bytes = Buffer.from(resource.blob, "base64");
          const text = isUtf8Text(bytes);
          const encoding = text ? "" : ' encoding="base64"';
          contextual.push(
            `<context ref="${resource.uri}" mimeType="${mimeType}"${encoding}>\n` +
              `${text ? bytes.toString("utf8") : resource.blob}\n</context>`,
          );
        }
        break;
      }
      case "image":
      case "audio":
        break;
    }
  }

  if (contextual.length > 0) primary.push(contextual.join("\n"));
  return primary.join("\n").trim();
}

export interface AcpPromptImage {
  readonly data: string;
  readonly mimeType: AcpImageMediaType;
}

const IMAGE_MEDIA_TYPES: Readonly<Record<AcpImageMediaType, true>> = {
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
};

function isImageMediaType(value: string): value is AcpImageMediaType {
  return Object.hasOwn(IMAGE_MEDIA_TYPES, value);
}

function asImage(
  data: string,
  mimeType: string | undefined,
): AcpPromptImage | undefined {
  if (mimeType === undefined || !isImageMediaType(mimeType)) {
    return undefined;
  }
  return { data, mimeType };
}

/** Images from `image` blocks and image blobs, in prompt order (B65). */
export function extractImagesFromPrompt(
  prompt: readonly AcpContentBlock[],
): readonly AcpPromptImage[] {
  const images: AcpPromptImage[] = [];
  for (const block of prompt) {
    const image =
      block.type === "image"
        ? asImage(block.data, block.mimeType)
        : block.type === "resource" && block.resource.blob !== undefined
          ? asImage(block.resource.blob, block.resource.mimeType)
          : undefined;
    if (image !== undefined) images.push(image);
  }
  return images;
}

/* -------------------------------------------------------------------------- */
/* session/cancel and $/cancel_request (B67)                                  */
/* -------------------------------------------------------------------------- */

export interface AcpCancelParams {
  readonly sessionId: string;
}

export function parseCancelParams(params: unknown): AcpCancelParams {
  if (!isRecord(params)) {
    throw invalidParams("session/cancel params must be an object");
  }
  return { sessionId: requireString(params["sessionId"], "sessionId") };
}

/** `{ sessionId }` params shared by session/close and the cancel notification. */
export function parseSessionIdParams(params: unknown): AcpCancelParams {
  if (!isRecord(params)) {
    throw invalidParams("params must be an object");
  }
  return { sessionId: requireString(params["sessionId"], "sessionId") };
}

export interface AcpCancelRequestParams {
  readonly requestId: AcpRequestId;
}

export function parseCancelRequestParams(
  params: unknown,
): AcpCancelRequestParams {
  if (!isRecord(params) || !isRequestId(params["requestId"])) {
    throw invalidParams("$/cancel_request requires a requestId");
  }
  return { requestId: params["requestId"] };
}

/* -------------------------------------------------------------------------- */
/* session/update payloads (B68)                                              */
/* -------------------------------------------------------------------------- */

export type AcpStopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type AcpPlanEntryPriority = "high" | "medium" | "low";
export type AcpPlanEntryStatus = "pending" | "in_progress" | "completed";

export interface AcpPlanEntry {
  readonly content: string;
  readonly priority: AcpPlanEntryPriority;
  readonly status: AcpPlanEntryStatus;
}

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AcpToolCallStatus =
  "pending" | "in_progress" | "completed" | "failed";

export type AcpToolCallContent =
  | { readonly type: "content"; readonly content: AcpContentBlock }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
    }
  | { readonly type: "terminal"; readonly terminalId: string };

export interface AcpToolCallLocation {
  readonly path: string;
  readonly line?: number | null;
}

export interface AcpToolCallUpdateFields {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: AcpToolKind;
  readonly status?: AcpToolCallStatus;
  readonly content?: readonly AcpToolCallContent[];
  readonly locations?: readonly AcpToolCallLocation[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: Record<string, unknown>;
}

export interface AcpToolCall extends AcpToolCallUpdateFields {
  readonly title: string;
}

interface AcpContentChunk {
  readonly content: AcpContentBlock;
  readonly messageId?: string;
  readonly _meta?: Record<string, unknown>;
}

/**
 * TODO(spec B68): the union covers every update the clause names, but this
 * slice's turn path emits only the two chunks, `plan`, `tool_call` and
 * `tool_call_update`; `session_info_update`, `available_commands_update`,
 * `current_mode_update`, `config_option_update` and `usage_update` have no
 * producer yet.
 */
export type AcpSessionUpdate =
  | ({ readonly sessionUpdate: "user_message_chunk" } & AcpContentChunk)
  | ({ readonly sessionUpdate: "agent_message_chunk" } & AcpContentChunk)
  | ({ readonly sessionUpdate: "agent_thought_chunk" } & AcpContentChunk)
  | ({ readonly sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ readonly sessionUpdate: "tool_call_update" } & AcpToolCallUpdateFields)
  | {
      readonly sessionUpdate: "plan";
      readonly entries: readonly AcpPlanEntry[];
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly sessionUpdate: "session_info_update";
      readonly title?: string | null;
      readonly updatedAt?: string | null;
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly sessionUpdate: "available_commands_update";
      readonly availableCommands: readonly {
        readonly name: string;
        readonly description: string;
        readonly input?: { readonly hint: string } | null;
      }[];
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly sessionUpdate: "current_mode_update";
      readonly currentModeId: string;
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly sessionUpdate: "config_option_update";
      readonly configOptions: readonly AcpSessionConfigOption[];
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly sessionUpdate: "usage_update";
      readonly used: number;
      readonly size: number;
      readonly _meta?: Record<string, unknown>;
    };

export type AcpSessionConfigCategory =
  "mode" | "model" | "model_config" | "thought_level" | (string & {});

export interface AcpSessionConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface AcpSessionConfigSelectGroup {
  readonly group: string;
  readonly name: string;
  readonly options: readonly AcpSessionConfigSelectOption[];
}

export interface AcpSessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: AcpSessionConfigCategory | null;
  readonly type: "select" | "boolean";
  readonly currentValue: string | boolean;
  readonly options?: readonly (
    AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup
  )[];
}

export interface AcpSessionUpdateParams {
  readonly sessionId: string;
  readonly update: AcpSessionUpdate;
}

/** The `session/update` notification for one update (B68). */
export function createSessionUpdateNotification(
  sessionId: string,
  update: AcpSessionUpdate,
): AcpNotificationMessage {
  return createAcpNotification(ACP_METHODS.sessionUpdate, {
    sessionId,
    update,
  } satisfies AcpSessionUpdateParams);
}

/** Text/thought chunk builders used by the turn adapter. */
export function agentMessageChunk(
  text: string,
  messageId?: string,
): AcpSessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  };
}

export function agentThoughtChunk(
  text: string,
  messageId?: string,
): AcpSessionUpdate {
  return {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  };
}

export function userMessageChunk(
  text: string,
  messageId?: string,
): AcpSessionUpdate {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  };
}

/* -------------------------------------------------------------------------- */
/* Permissions (B69)                                                          */
/* -------------------------------------------------------------------------- */

export type AcpPermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: AcpPermissionOptionKind;
  readonly _meta?: Record<string, unknown>;
}

/** Droid's confirmation outcomes, as they appear on the wire. */
export type AcpToolConfirmationOutcome =
  | "proceed_once"
  | "proceed_always"
  | "proceed_always_file"
  | "proceed_auto_run"
  | "proceed_auto_run_low"
  | "proceed_auto_run_medium"
  | "proceed_auto_run_high"
  | "proceed_new_session"
  | "proceed_new_session_low"
  | "proceed_new_session_medium"
  | "proceed_new_session_high"
  | "proceed_edit"
  | "proceed_always_tools"
  | "proceed_always_server"
  | "proceed_report_false_positive"
  | "cancel";

export interface AcpConfirmationOption {
  readonly value: AcpToolConfirmationOutcome;
  readonly label: string;
}

/** ACP kind for one confirmation outcome; unknown outcomes allow once (B69). */
export function mapOutcomeToKind(outcome: string): AcpPermissionOptionKind {
  switch (outcome) {
    case "proceed_once":
    case "proceed_edit":
      return "allow_once";
    case "proceed_auto_run_low":
    case "proceed_auto_run_medium":
    case "proceed_auto_run_high":
    case "proceed_auto_run":
    case "proceed_always":
    case "proceed_always_file":
    case "proceed_always_tools":
    case "proceed_always_server":
      return "allow_always";
    case "cancel":
      return "reject_once";
    default:
      return "allow_once";
  }
}

function batchQuantifier(toolCount: number): string {
  if (toolCount === 1) return "";
  if (toolCount === 2) return " both";
  return " all";
}

function shortenedLabel(
  option: AcpConfirmationOption,
  quantifier: string,
): string {
  switch (option.value) {
    case "proceed_once":
      return `Allow${quantifier}`;
    case "proceed_always": {
      const lower = option.label.toLowerCase();
      if (lower.includes("low impact")) {
        return `Allow${quantifier} & auto-run low risk commands`;
      }
      if (lower.includes("medium impact")) {
        return `Allow${quantifier} & auto-run medium risk commands`;
      }
      if (lower.includes("high impact")) {
        return `Allow${quantifier} & auto-run high risk commands`;
      }
      return `Allow${quantifier} always`;
    }
    case "proceed_auto_run_low":
      return `Allow${quantifier} & auto-run (low risk)`;
    case "proceed_auto_run_medium":
      return `Allow${quantifier} & auto-run (medium risk)`;
    case "proceed_auto_run_high":
      return `Allow${quantifier} & auto-run (high risk)`;
    case "proceed_always_tools":
      return option.label;
    case "proceed_always_server":
      return option.label === ""
        ? `Always allow${quantifier} server tools`
        : option.label;
    default:
      return option.label;
  }
}

/** Convert confirmation options to ACP's short labels and kinds (B69). */
export function mapOptionsToAcp(
  options: readonly AcpConfirmationOption[],
  toolCount: number = 1,
): readonly AcpPermissionOption[] {
  const quantifier = batchQuantifier(toolCount);
  return options.map((option) => ({
    optionId: option.value,
    name: shortenedLabel(option, quantifier),
    kind: mapOutcomeToKind(option.value),
  }));
}

export interface AcpRequestPermissionParams {
  readonly sessionId: string;
  readonly toolCall: AcpToolCallUpdateFields & { readonly title?: string };
  readonly options: readonly AcpPermissionOption[];
  readonly _meta?: Record<string, unknown>;
}

const PERMISSION_KINDS: Readonly<Record<AcpPermissionOptionKind, true>> = {
  allow_once: true,
  allow_always: true,
  reject_once: true,
  reject_always: true,
};

function isPermissionKind(value: string): value is AcpPermissionOptionKind {
  return Object.hasOwn(PERMISSION_KINDS, value);
}

function parsePermissionOption(value: unknown): AcpPermissionOption {
  if (!isRecord(value)) {
    throw invalidParams("permission options must be objects");
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !isPermissionKind(kind)) {
    throw invalidParams("permission option kind is not a known kind");
  }
  return {
    optionId: requireString(value["optionId"], "optionId"),
    name: requireString(value["name"], "name"),
    kind,
  };
}

export function parseRequestPermissionParams(
  params: unknown,
): AcpRequestPermissionParams {
  if (!isRecord(params)) {
    throw invalidParams("session/request_permission params must be an object");
  }
  const sessionId = requireString(params["sessionId"], "sessionId");
  const toolCall = params["toolCall"];
  if (!isRecord(toolCall)) {
    throw invalidParams("toolCall must be an object");
  }
  const options = params["options"];
  if (!Array.isArray(options)) {
    throw invalidParams("options must be an array");
  }
  return {
    sessionId,
    toolCall: {
      toolCallId: requireString(toolCall["toolCallId"], "toolCallId"),
      ...(typeof toolCall["title"] === "string"
        ? { title: toolCall["title"] }
        : {}),
    },
    options: options.map(parsePermissionOption),
  };
}

export type AcpPermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

/** The response to a permission request; anything malformed is cancelled. */
export function parsePermissionResponse(value: unknown): AcpPermissionOutcome {
  if (!isRecord(value)) {
    throw invalidParams("permission response must be an object");
  }
  const outcome = value["outcome"];
  if (!isRecord(outcome)) {
    throw invalidParams("permission response.outcome must be an object");
  }
  if (outcome["outcome"] === "cancelled") {
    return { outcome: "cancelled" };
  }
  if (outcome["outcome"] === "selected") {
    return {
      outcome: "selected",
      optionId: requireString(outcome["optionId"], "optionId"),
    };
  }
  throw invalidParams("permission response.outcome is not a known outcome");
}

/** SDK parity: a cancelled or unrecognised response means Cancel (B69). */
export function permissionResponseToOutcome(
  response: AcpPermissionOutcome,
  offeredOptionIds?: readonly string[],
): AcpToolConfirmationOutcome {
  if (response.outcome !== "selected") return "cancel";
  const optionId = response.optionId;
  const known = CONFIRMATION_OUTCOMES.find((value) => value === optionId);
  if (known === undefined) return "cancel";
  if (offeredOptionIds !== undefined && !offeredOptionIds.includes(known)) {
    return "cancel";
  }
  if (known.startsWith("proceed_new_session")) return "cancel";
  return known;
}

const CONFIRMATION_OUTCOMES: readonly AcpToolConfirmationOutcome[] = [
  "proceed_once",
  "proceed_always",
  "proceed_always_file",
  "proceed_auto_run",
  "proceed_auto_run_low",
  "proceed_auto_run_medium",
  "proceed_auto_run_high",
  "proceed_new_session",
  "proceed_new_session_low",
  "proceed_new_session_medium",
  "proceed_new_session_high",
  "proceed_edit",
  "proceed_always_tools",
  "proceed_always_server",
  "proceed_report_false_positive",
  "cancel",
];

/** Whether an ACP option kind authorizes the call. */
export function isAllowKind(kind: AcpPermissionOptionKind): boolean {
  return kind === "allow_once" || kind === "allow_always";
}
