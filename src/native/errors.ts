/**
 * Typed failures for the native helper boundary. Contract:
 * `specs/90-native-layer.md`, protocol invariants in `crates/README.md`.
 *
 * Everything the helper sends is untrusted, so a failure is a class the caller
 * can switch on, never a bare string: a remote refusal (`NativeError`) is not a
 * broken boundary (`NativeProtocolError`), a missing helper
 * (`NativeUnavailableError`) is not a slow one (`NativeTimeoutError`).
 */

export interface NativeErrorContext {
  /** Absolute path of the helper binary, when it is known. */
  readonly helperPath?: string;
  /** Method the failing call was made under, when it is known. */
  readonly method?: string;
  readonly cause?: unknown;
}

function subject(context: NativeErrorContext): string {
  const parts: string[] = [];
  if (context.method !== undefined) parts.push(`method ${context.method}`);
  if (context.helperPath !== undefined)
    parts.push(`helper ${context.helperPath}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function withCause(
  context: NativeErrorContext,
): { cause: unknown } | undefined {
  return context.cause === undefined ? undefined : { cause: context.cause };
}

/**
 * The helper answered with an error record: the request was well formed, the
 * helper refused it (unknown method, bad parameters, its own failure). `code`
 * is the helper's JSON-RPC-style number, never a local classification.
 */
export class NativeError extends Error {
  readonly code: number;
  readonly method: string;
  readonly helperPath: string;

  constructor(
    code: number,
    message: string,
    method: string,
    helperPath: string,
  ) {
    super(
      `native helper ${helperPath} failed method ${method} with code ${code}: ${message}`,
    );
    this.name = "NativeError";
    this.code = code;
    this.method = method;
    this.helperPath = helperPath;
  }
}

/**
 * The stream violated the protocol: a malformed or out-of-order line, a
 * response line over `MAX_LINE_BYTES`, an answer to an id that was never sent,
 * a response whose shape cannot be trusted, or a startup version mismatch.
 */
export class NativeProtocolError extends Error {
  readonly helperPath: string | undefined;
  readonly method: string | undefined;

  constructor(detail: string, context: NativeErrorContext = {}) {
    super(
      `native protocol error${subject(context)}: ${detail}`,
      withCause(context),
    );
    this.name = "NativeProtocolError";
    this.helperPath = context.helperPath;
    this.method = context.method;
  }
}

/**
 * No conversation is possible: the helper could not be spawned (missing,
 * not executable), it exited before answering, or the client is closed.
 */
export class NativeUnavailableError extends Error {
  readonly helperPath: string;
  readonly method: string | undefined;

  constructor(
    detail: string,
    context: NativeErrorContext & { helperPath: string },
  ) {
    super(
      `native helper ${context.helperPath} is unavailable: ${detail}`,
      withCause(context),
    );
    this.name = "NativeUnavailableError";
    this.helperPath = context.helperPath;
    this.method = context.method;
  }
}

/** A request got no frame back within its own timeout. */
export class NativeTimeoutError extends Error {
  readonly helperPath: string;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number, helperPath: string) {
    super(
      `native helper ${helperPath} did not answer method ${method} within ${timeoutMs}ms`,
    );
    this.name = "NativeTimeoutError";
    this.helperPath = helperPath;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}
