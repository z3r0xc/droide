/**
 * JSON-RPC envelopes and frame bounds for the daemon wire. Contract:
 * `specs/70-daemon-and-remote-control.md` B12–B14, B18 and the "Wire
 * constants" table.
 *
 * Every envelope is parsed before it is used: the transport hands this module
 * text or bytes from an untrusted peer, and the parser either returns a typed
 * envelope or a typed `DaemonProtocolError`. The envelope shape is frozen
 * (`jsonrpc`, `droideApiVersion`, optional `droideProtocolVersion`), ids are
 * UUID v4 strings, and a response carries `result` xor `error` — never both.
 */

import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { DaemonProtocolError } from "./errors.ts";

/** The only JSON-RPC version this protocol accepts. */
export const JSONRPC_VERSION = "2.0";
/** Frozen legacy field; never used for compatibility decisions (B13). */
export const LEGACY_DROIDE_API_VERSION = "1.0.0";
/** The protocol version the recorded build emits. */
export const DROIDE_PROTOCOL_VERSION = "1.321.0";
/** First byte of a compressed binary frame (B12). */
export const COMPRESSED_PAYLOAD_TAG = 0x01;
/** The only encoding a client may negotiate. */
export const DEFLATE_RAW_ENCODING = "deflate-raw";
/** Ceiling for one frame, matching `CLIENT_FRAME_TARGET_BYTES`. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Maximum requests folded into one `daemon.authenticate` (B16). */
export const MAX_PIPELINE_REQUESTS = 8;

/** Bind retries after the first attempt, and the first backoff (B7). */
export const DAEMON_SERVE_BIND_MAX_RETRIES = 5;
export const DAEMON_SERVE_BIND_INITIAL_DELAY_MS = 500;
/** 500 ms doubling: the five delays the retry loop waits (B7). */
export const DAEMON_BIND_RETRY_DELAYS_MS: readonly number[] = [
  500, 1000, 2000, 4000, 8000,
];

/** How long teardown may take before the daemon stops waiting (B8). */
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;

/** The JSON-RPC error codes this protocol uses (B18, error-code table). */
/** First-frame method every connection must call before anything else. */
export const AUTHENTICATE_METHOD = "daemon.authenticate";

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authentication: -32001,
  entityNotFound: -32004,
  sessionDisconnected: -32005,
  conflict: -32006,
  requestCancelled: -32800,
} as const;

/** One `{code, message, data?}` error object. */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface DaemonRequestEnvelope {
  readonly type: "request";
  readonly jsonrpc: "2.0";
  readonly droideApiVersion: string;
  readonly droideProtocolVersion?: string;
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
  readonly _meta?: unknown;
}

export interface DaemonSuccessResponse {
  readonly type: "response";
  readonly jsonrpc: "2.0";
  readonly droideApiVersion: string;
  readonly droideProtocolVersion?: string;
  readonly id: string;
  readonly result: unknown;
  readonly _meta?: unknown;
}

export interface DaemonErrorResponse {
  readonly type: "response";
  readonly jsonrpc: "2.0";
  readonly droideApiVersion: string;
  readonly droideProtocolVersion?: string;
  /** `null` only when the frame could not be parsed, so it has no request. */
  readonly id: string | null;
  readonly error: JsonRpcErrorObject;
  readonly _meta?: unknown;
}

export type DaemonResponseEnvelope =
  DaemonSuccessResponse | DaemonErrorResponse;

export interface DaemonNotificationEnvelope {
  readonly type: "notification";
  readonly jsonrpc: "2.0";
  readonly droideApiVersion: string;
  readonly droideProtocolVersion?: string;
  readonly method: string;
  readonly params?: unknown;
  readonly _meta?: unknown;
}

export type DaemonEnvelope =
  DaemonRequestEnvelope | DaemonResponseEnvelope | DaemonNotificationEnvelope;

/** Advisory comparison record attached to failures only (B14). */
export interface ProtocolVersionMismatch {
  readonly localFactoryProtocolVersion: string;
  readonly peerFactoryProtocolVersion: string;
  readonly messageType?: string;
  readonly method?: string;
  readonly requestId?: string;
}

/** Where a mismatch record came from, when the envelope can say. */
export interface ProtocolVersionContext {
  readonly messageType?: string;
  readonly method?: string;
  readonly requestId?: string;
}

/** Options shared by the envelope builders. */
export interface EnvelopeOptions {
  /** Defaults to {@link DROIDE_PROTOCOL_VERSION}. */
  readonly protocolVersion?: string;
  /** Defaults to {@link LEGACY_DROIDE_API_VERSION}. */
  readonly apiVersion?: string;
  readonly meta?: unknown;
}

export interface CreateRequestOptions extends EnvelopeOptions {
  /** Defaults to a fresh UUID v4. */
  readonly id?: string;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Canonical guard for this boundary: a JSON value that is an object with
 * named members. It proves the container only; every field is narrowed
 * individually below.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is the UUID v4 shape request ids use (B13). */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function parseFailure(detail: string, cause?: unknown): DaemonProtocolError {
  return new DaemonProtocolError(JSON_RPC_ERRORS.parse, detail, { cause });
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw parseFailure(`${field} must be a non-empty string`);
  }
  return value;
}

function envelopeBase(options: EnvelopeOptions): {
  readonly jsonrpc: "2.0";
  readonly droideApiVersion: string;
  readonly droideProtocolVersion: string;
} {
  return {
    jsonrpc: JSONRPC_VERSION,
    droideApiVersion: options.apiVersion ?? LEGACY_DROIDE_API_VERSION,
    droideProtocolVersion: options.protocolVersion ?? DROIDE_PROTOCOL_VERSION,
  };
}

/** Build one request envelope; `params` is omitted when absent (B13). */
export function createRequest(
  method: string,
  params?: unknown,
  options: CreateRequestOptions = {},
): DaemonRequestEnvelope {
  return {
    type: "request",
    ...envelopeBase(options),
    id: options.id ?? randomUUID(),
    method,
    ...(params === undefined ? {} : { params }),
    ...(options.meta === undefined ? {} : { _meta: options.meta }),
  };
}

/** Build one notification envelope; `params` is omitted when absent. */
export function createNotification(
  method: string,
  params?: unknown,
  options: EnvelopeOptions = {},
): DaemonNotificationEnvelope {
  return {
    type: "notification",
    ...envelopeBase(options),
    method,
    ...(params === undefined ? {} : { params }),
    ...(options.meta === undefined ? {} : { _meta: options.meta }),
  };
}

/** Build a success response. */
export function createSuccessResponse(
  id: string,
  result: unknown,
  options: EnvelopeOptions = {},
): DaemonSuccessResponse {
  return {
    type: "response",
    ...envelopeBase(options),
    id,
    result,
    ...(options.meta === undefined ? {} : { _meta: options.meta }),
  };
}

/** Build an `{code, message, data?}` object; `data` is omitted when absent. */
export function createErrorObject(
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorObject {
  return { code, message, ...(data === undefined ? {} : { data }) };
}

/** Build a failure response. `id` is `null` when the frame had none (B15). */
export function createErrorResponse(
  id: string | null,
  code: number,
  message: string,
  data?: unknown,
  options: EnvelopeOptions = {},
): DaemonErrorResponse {
  return {
    type: "response",
    ...envelopeBase(options),
    id,
    error: createErrorObject(code, message, data),
    ...(options.meta === undefined ? {} : { _meta: options.meta }),
  };
}

/**
 * Serialise one envelope, refusing a frame above {@link MAX_FRAME_BYTES}.
 * The daemon sends the same object it dispatches, so a response and its
 * request share this shape (B12).
 */
export function serializeEnvelope(envelope: DaemonEnvelope): string {
  const text = JSON.stringify(envelope);
  assertFrameWithinBounds(text);
  return text;
}

/** Throw a parse error when `text` is larger than one frame may be. */
export function assertFrameWithinBounds(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw parseFailure(
      `Frame is ${bytes} bytes, above the ${MAX_FRAME_BYTES}-byte limit`,
    );
  }
}

/** Parse one text frame: bounds, JSON, then the envelope shape (B12, B13). */
export function parseTextFrame(text: string): DaemonEnvelope {
  assertFrameWithinBounds(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw parseFailure("Parse error", error);
  }
  return parseEnvelopeValue(value);
}

/**
 * Parse one binary frame: a leading `0x01` tag followed by raw-deflate JSON
 * (B12). A payload without the tag is refused rather than guessed at.
 */
export function parseBinaryFrame(bytes: Uint8Array): DaemonEnvelope {
  if (bytes.length === 0) {
    throw parseFailure("Binary frame is empty");
  }
  if (bytes[0] !== COMPRESSED_PAYLOAD_TAG) {
    throw parseFailure("Binary frame is missing the compressed-payload tag");
  }
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(Buffer.from(bytes.subarray(1)), {
      maxOutputLength: MAX_FRAME_BYTES,
    });
  } catch (error) {
    throw parseFailure("Binary frame is not valid raw-deflate JSON", error);
  }
  return parseTextFrame(inflated.toString("utf8"));
}

/** Encode one envelope as a `0x01`-tagged raw-deflate binary frame. */
export function encodeBinaryFrame(envelope: DaemonEnvelope): Uint8Array {
  const serialized = Buffer.from(serializeEnvelope(envelope), "utf8");
  return Buffer.concat([
    Buffer.from([COMPRESSED_PAYLOAD_TAG]),
    deflateRawSync(serialized),
  ]);
}

/**
 * Parse one parent/child IPC frame. Each frame is one JSON string passed
 * through the channel; any other value is a protocol violation (B12).
 */
export function parseIpcFrame(value: unknown): DaemonEnvelope {
  if (typeof value !== "string") {
    throw parseFailure("IPC frame must be a JSON string");
  }
  return parseTextFrame(value);
}

/**
 * Validate an already-decoded JSON value as an envelope. Structure failures
 * are `PARSE_ERROR` because the frame is malformed, not merely an unknown
 * method (B15).
 */
export function parseEnvelopeValue(value: unknown): DaemonEnvelope {
  if (!isJsonObject(value)) {
    throw parseFailure("Envelope must be a JSON object");
  }
  if (value["jsonrpc"] !== JSONRPC_VERSION) {
    throw parseFailure(`jsonrpc must be "${JSONRPC_VERSION}"`);
  }
  const droideApiVersion = value["droideApiVersion"];
  if (typeof droideApiVersion !== "string") {
    throw parseFailure("droideApiVersion must be a string");
  }
  const droideProtocolVersion = value["droideProtocolVersion"];
  if (
    droideProtocolVersion !== undefined &&
    typeof droideProtocolVersion !== "string"
  ) {
    throw parseFailure("droideProtocolVersion must be a string");
  }
  const meta = value["_meta"];
  if (meta !== undefined && !isJsonObject(meta)) {
    throw parseFailure("_meta must be an object");
  }
  const fields: EnvelopeFields = {
    droideApiVersion,
    droideProtocolVersion,
    meta,
  };

  switch (value["type"]) {
    case "request":
      return parseRequest(value, fields);
    case "response":
      return parseResponse(value, fields);
    case "notification":
      return parseNotification(value, fields);
    default:
      throw parseFailure(
        'type must be "request", "response" or "notification"',
      );
  }
}

interface EnvelopeFields {
  readonly droideApiVersion: string;
  readonly droideProtocolVersion: string | undefined;
  readonly meta: unknown;
}

function withFields(fields: EnvelopeFields): {
  readonly jsonrpc: "2.0";
  readonly droideApiVersion: string;
  readonly droideProtocolVersion?: string;
  readonly _meta?: unknown;
} {
  return {
    jsonrpc: JSONRPC_VERSION,
    droideApiVersion: fields.droideApiVersion,
    ...(fields.droideProtocolVersion === undefined
      ? {}
      : { droideProtocolVersion: fields.droideProtocolVersion }),
    ...(fields.meta === undefined ? {} : { _meta: fields.meta }),
  };
}

function parseRequest(
  value: Record<string, unknown>,
  fields: EnvelopeFields,
): DaemonRequestEnvelope {
  const id = value["id"];
  if (!isUuidV4(id)) {
    throw parseFailure("request id must be a UUID v4 string");
  }
  const method = requireNonEmptyString(value["method"], "method");
  const params = value["params"];
  return {
    type: "request",
    ...withFields(fields),
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

function parseResponse(
  value: Record<string, unknown>,
  fields: EnvelopeFields,
): DaemonResponseEnvelope {
  const id = value["id"];
  if (id !== null && typeof id !== "string") {
    throw parseFailure("response id must be a string or null");
  }
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    throw parseFailure("response must carry exactly one of result or error");
  }
  const base = { type: "response" as const, ...withFields(fields) };
  if (hasResult) {
    if (id === null) {
      throw parseFailure("a success response must carry a request id");
    }
    return { ...base, id, result: value["result"] };
  }
  return { ...base, id, error: parseErrorObject(value["error"]) };
}

function parseNotification(
  value: Record<string, unknown>,
  fields: EnvelopeFields,
): DaemonNotificationEnvelope {
  const method = requireNonEmptyString(value["method"], "method");
  const params = value["params"];
  return {
    type: "notification",
    ...withFields(fields),
    method,
    ...(params === undefined ? {} : { params }),
  };
}

function parseErrorObject(value: unknown): JsonRpcErrorObject {
  if (!isJsonObject(value)) {
    throw parseFailure("error must be an object");
  }
  if (typeof value["code"] !== "number" || !Number.isInteger(value["code"])) {
    throw parseFailure("error.code must be an integer");
  }
  if (typeof value["message"] !== "string") {
    throw parseFailure("error.message must be a string");
  }
  return {
    code: value["code"],
    message: value["message"],
    ...(value["data"] === undefined ? {} : { data: value["data"] }),
  };
}

/**
 * Compare an inbound protocol version with the local one (B14). A missing or
 * empty field is not a mismatch, and equality is not one either.
 */
export function protocolVersionMismatch(
  localFactoryProtocolVersion: string,
  peerFactoryProtocolVersion: string | undefined,
  context: ProtocolVersionContext = {},
): ProtocolVersionMismatch | undefined {
  if (
    peerFactoryProtocolVersion === undefined ||
    peerFactoryProtocolVersion === ""
  ) {
    return undefined;
  }
  if (peerFactoryProtocolVersion === localFactoryProtocolVersion) {
    return undefined;
  }
  return {
    localFactoryProtocolVersion,
    peerFactoryProtocolVersion,
    ...(context.messageType === undefined
      ? {}
      : { messageType: context.messageType }),
    ...(context.method === undefined ? {} : { method: context.method }),
    ...(context.requestId === undefined
      ? {}
      : { requestId: context.requestId }),
  };
}

/** The mismatch record for one envelope, if it has one. */
export function envelopeVersionMismatch(
  envelope: DaemonEnvelope,
  localFactoryProtocolVersion: string,
): ProtocolVersionMismatch | undefined {
  return protocolVersionMismatch(
    localFactoryProtocolVersion,
    envelope.droideProtocolVersion,
    {
      messageType: envelope.type,
      ...(envelope.type === "request"
        ? { method: envelope.method, requestId: envelope.id }
        : envelope.type === "notification"
          ? { method: envelope.method }
          : {}),
    },
  );
}

/**
 * Attach a mismatch record to a failure's `data`, keeping whatever `data`
 * already carried. Successful envelopes are never decorated (B14).
 */
export function attachVersionMismatch(
  error: JsonRpcErrorObject,
  mismatch: ProtocolVersionMismatch,
): JsonRpcErrorObject {
  const data = isJsonObject(error.data) ? error.data : {};
  return {
    code: error.code,
    message: error.message,
    data: { ...data, protocolVersionMismatch: mismatch },
  };
}

/**
 * The encoding a client may be answered in. Only `deflate-raw` is offered,
 * and only when the client listed it (B12, B16).
 */
export function negotiateEncoding(accept: unknown): string | undefined {
  if (!Array.isArray(accept)) return undefined;
  return accept.includes(DEFLATE_RAW_ENCODING)
    ? DEFLATE_RAW_ENCODING
    : undefined;
}
