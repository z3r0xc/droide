/**
 * Typed failures at the daemon boundary. Contract:
 * `specs/70-daemon-and-remote-control.md` B7, B14, B15, B19 and the error
 * tables ("Startup", "Connection and request").
 *
 * Everything on the wire is untrusted, so a failure is a class a caller can
 * switch on rather than a string it has to match: a startup refusal is not a
 * protocol violation, a remote JSON-RPC refusal is not a closed socket, and a
 * timeout is not an abort.
 */

/** Options every daemon failure accepts, mirroring `ErrorOptions`. */
export interface DaemonErrorOptions {
  readonly cause?: unknown;
}

function withCause(
  options: DaemonErrorOptions,
): { cause: unknown } | undefined {
  return options.cause === undefined ? undefined : { cause: options.cause };
}

/**
 * The daemon could not start (B7, B11, B32). `message` is the unadorned
 * detail the CLI prints after `Startup failed: `; `code` is the stable
 * identifier when the spec names one (`droide.daemon.*`).
 */
export class DaemonStartupError extends Error {
  readonly code: string | undefined;

  constructor(
    message: string,
    options: DaemonErrorOptions & { code?: string },
  ) {
    super(message, withCause(options));
    this.name = "DaemonStartupError";
    this.code = options.code;
  }
}

/**
 * An envelope violated the protocol (B12, B13, B15). `code` is the JSON-RPC
 * error code the peer must be answered with; `message` is the wire text.
 */
export class DaemonProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(
    code: number,
    message: string,
    options: DaemonErrorOptions & { data?: unknown } = {},
  ) {
    super(message, withCause(options));
    this.name = "DaemonProtocolError";
    this.code = code;
    this.data = options.data;
  }
}

/**
 * A credential was missing or rejected (B15, B31). `reason` is the
 * `error.data.reason` value when the daemon can classify the refusal; the
 * message is the fixed auth-gate sentence when the connection never
 * authenticated.
 */
export class DaemonAuthenticationError extends Error {
  readonly reason: string | undefined;

  constructor(
    message: string,
    options: DaemonErrorOptions & { reason?: string } = {},
  ) {
    super(message, withCause(options));
    this.name = "DaemonAuthenticationError";
    this.reason = options.reason;
  }
}

/**
 * B15: a credential the configured backend refused, or one that could not be
 * checked at all. `outcome` is the stable kind a caller switches on and is
 * also the `error.data.reason` the peer sees; `message` never contains the
 * credential itself.
 */
export type CredentialVerificationOutcome =
  "invalid_credential" | "verification_unavailable";

export class DaemonCredentialVerificationError extends DaemonAuthenticationError {
  readonly outcome: CredentialVerificationOutcome;

  constructor(
    outcome: CredentialVerificationOutcome,
    message: string,
    options: DaemonErrorOptions = {},
  ) {
    super(message, { ...options, reason: outcome });
    this.name = "DaemonCredentialVerificationError";
    this.outcome = outcome;
  }
}

/**
 * A remote JSON-RPC error response (B18). `data` is whatever the peer sent,
 * unvalidated beyond being JSON.
 */
export class DaemonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(
    code: number,
    message: string,
    method: string,
    data?: unknown,
    options: DaemonErrorOptions = {},
  ) {
    super(message, withCause(options));
    this.name = "DaemonRpcError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

/**
 * The transport closed with pending requests (B19). `code` and `reason` are
 * the WebSocket close values; a reconnect rejects with code 1000 and the
 * reason `Connection reopened`.
 */
export class DaemonConnectionClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string, options: DaemonErrorOptions = {}) {
    super(`daemon connection closed (${code}): ${reason}`, withCause(options));
    this.name = "DaemonConnectionClosedError";
    this.code = code;
    this.reason = reason;
  }
}

/** A request got no response within its own budget (B19). */
export class DaemonTimeoutError extends Error {
  readonly method: string;
  readonly id: string;
  readonly timeoutMs: number;

  constructor(method: string, id: string, timeoutMs: number) {
    super(`daemon request ${method} (${id}) timed out after ${timeoutMs}ms`);
    this.name = "DaemonTimeoutError";
    this.method = method;
    this.id = id;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The caller aborted a request (B19). The daemon is not told: an abort is
 * local and a late response is discarded.
 */
export class DaemonRequestAbortedError extends Error {
  readonly method: string;
  readonly id: string | undefined;

  constructor(method: string, id?: string) {
    super(
      id === undefined
        ? `daemon request ${method} was aborted before it was sent`
        : `daemon request ${method} (${id}) was aborted`,
    );
    this.name = "DaemonRequestAbortedError";
    this.method = method;
    this.id = id;
  }
}

/** A response arrived but its result did not match the method's contract. */
export class DaemonInvalidResponseError extends Error {
  readonly method: string;
  readonly id: string | undefined;

  constructor(
    method: string,
    id: string | undefined,
    detail: string,
    options: DaemonErrorOptions = {},
  ) {
    super(
      `daemon response for ${method}${id === undefined ? "" : ` (${id})`} is invalid: ${detail}`,
      withCause(options),
    );
    this.name = "DaemonInvalidResponseError";
    this.method = method;
    this.id = id;
  }
}

/**
 * `daemon.authenticate` was refused (B15, B31). The client maps this to an
 * authentication failure instead of a generic remote error so callers can
 * distinguish "wrong credential" from "the method failed".
 */
export class DaemonAuthRejectedError extends Error {
  readonly reason: string | undefined;

  constructor(
    message: string,
    options: DaemonErrorOptions & { reason?: string } = {},
  ) {
    super(message, withCause(options));
    this.name = "DaemonAuthRejectedError";
    this.reason = options.reason;
  }
}
