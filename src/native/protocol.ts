/**
 * Wire types and validating parsers for the native helper. Contract:
 * `specs/90-native-layer.md`; the implementing side is
 * `crates/droide-native/src/main.rs`.
 *
 * One request and one response per line, UTF-8:
 *
 * ```text
 * -> {"id":1,"method":"native.version","params":{}}
 * <- {"id":1,"result":{"protocol":1,"version":"0.0.0"}}
 * <- {"id":2,"error":{"code":-32601,"message":"unknown method: nope"}}
 * ```
 *
 * A response is untrusted input. Every parser here checks shape and rejects
 * with `NativeProtocolError` instead of returning a widened value, so callers
 * never need a cast. Unknown envelope fields are ignored: the helper may add
 * informational keys without breaking this build, exactly as the helper ignores
 * unknown request fields.
 */

import { NativeProtocolError } from "./errors.ts";

/** Version exchanged by the `native.version` handshake. */
export const PROTOCOL_VERSION = 1;

/** Ceiling for one response line, matching the helper's request ceiling. */
export const MAX_LINE_BYTES = 1 << 20;

/**
 * Ceiling for the serialised `params` of one request. The helper refuses a
 * whole line above 1 MiB; 512 KiB leaves room for the envelope (id, method,
 * JSON punctuation) and keeps a request from competing with a 5 MiB response
 * budget for the same pipe.
 */
export const MAX_PARAMS_BYTES = 512 * 1024;

/** The only method this build calls at startup. */
export const NATIVE_VERSION_METHOD = "native.version";

/** Error codes the helper is documented to use. */
export const NATIVE_ERROR_CODES = {
  /** The line was not valid JSON or lacked required fields. */
  parse: -32700,
  /** The method is not known to this build. */
  methodNotFound: -32601,
  /** The parameters were missing or did not match the method's schema. */
  invalidParams: -32602,
  /** The request line exceeded the helper's ceiling. */
  tooLarge: -32001,
} as const;

/** One request as it goes on the wire. */
export interface NativeRequest {
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** A successful response: `result` is method-defined and still unvalidated. */
export interface NativeResultResponse {
  readonly kind: "result";
  readonly id: number;
  readonly result: unknown;
}

/**
 * An error response. `id` is `null` when the helper could not parse the line
 * it was given, so the error cannot be attributed to a request.
 */
export interface NativeErrorResponse {
  readonly kind: "error";
  readonly id: number | null;
  readonly code: number;
  readonly message: string;
}

export type NativeResponse = NativeResultResponse | NativeErrorResponse;

/** The decoded `native.version` result. */
export interface NativeVersionResult {
  readonly protocol: number;
  readonly version: string;
}

export interface NativeProtocolContext {
  readonly helperPath?: string;
  readonly method?: string;
}

/**
 * Canonical guard for this boundary: a JSON value that is an object with named
 * members. Fields stay `unknown` and are narrowed individually below, so the
 * guard proves the container only, never a field's type.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function fail(detail: string, context: NativeProtocolContext): never {
  throw new NativeProtocolError(detail, context);
}

/**
 * Parse one response line. Rejects an empty line, non-JSON text, a non-object
 * payload, a missing or non-numeric `id`, an envelope carrying both or neither
 * of `result`/`error`, and an `error` whose `code` or `message` is not the
 * documented type.
 */
export function parseResponseLine(
  line: string,
  context: NativeProtocolContext = {},
): NativeResponse {
  if (line === "") fail("response line is empty", context);

  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    throw new NativeProtocolError("response line is not JSON", {
      ...context,
      cause: error,
    });
  }

  if (!isJsonObject(payload)) fail("response is not a JSON object", context);

  const rawId = payload["id"];
  if (rawId !== null && !isRequestId(rawId)) {
    fail("response id is neither a non-negative integer nor null", context);
  }

  const hasResult = Object.hasOwn(payload, "result");
  const hasError = Object.hasOwn(payload, "error");
  if (hasResult && hasError)
    fail("response carries both result and error", context);
  if (!hasResult && !hasError)
    fail("response carries neither result nor error", context);

  if (hasError) {
    const body = payload["error"];
    if (!isJsonObject(body))
      fail("response error is not a JSON object", context);
    const code = body["code"];
    if (typeof code !== "number" || !Number.isInteger(code)) {
      fail("response error code is not an integer", context);
    }
    const message = body["message"];
    if (typeof message !== "string") {
      fail("response error message is not a string", context);
    }
    return { kind: "error", id: rawId, code, message };
  }

  return { kind: "result", id: rawId as number, result: payload["result"] };
}

/**
 * Validate the result of `native.version`. The protocol number is what the
 * handshake compares; the version string is informational and only has to be a
 * string, because the helper owns its own versioning.
 */
export function parseVersionResult(
  result: unknown,
  context: NativeProtocolContext = {},
): NativeVersionResult {
  if (!isJsonObject(result))
    fail("native.version result is not a JSON object", context);
  const protocol = result["protocol"];
  if (
    typeof protocol !== "number" ||
    !Number.isInteger(protocol) ||
    protocol < 0
  ) {
    fail("native.version protocol is not a non-negative integer", context);
  }
  const version = result["version"];
  if (typeof version !== "string")
    fail("native.version version is not a string", context);
  return { protocol, version };
}
