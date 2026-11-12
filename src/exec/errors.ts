/**
 * Typed failures for non-interactive exec. Contract:
 * `specs/80-exec-and-streaming.md` (Errors, B54-B57).
 *
 * The CLI is the only layer that decides how these are printed; exec code
 * throws them and `runOneShot` turns them into exit codes and, where the
 * protocol allows it, terminal records.
 */

export type ExecErrorCode = "usage" | "stream" | "aborted";

function errorOptions(cause: unknown): { cause: unknown } | undefined {
  return cause === undefined ? undefined : { cause };
}

export class ExecError extends Error {
  readonly code: ExecErrorCode;

  constructor(
    code: ExecErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExecError";
    this.code = code;
  }
}

/** A flag combination or value exec refuses before any session work (B1, B4, B7, B10, B41). */
export class ExecUsageError extends ExecError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("usage", message, options);
    this.name = "ExecUsageError";
  }
}

/** A stream protocol failure: input that is not a valid message, or a stdout write that cannot be honoured. */
export class ExecStreamError extends ExecError {
  constructor(message: string, cause?: unknown) {
    super("stream", message, errorOptions(cause));
    this.name = "ExecStreamError";
  }
}

/** The signals one-shot exec reports as `128 + signal number` (B56). */
export type ExecSignal = "SIGINT" | "SIGTERM";

const SIGNAL_EXIT_CODES: Readonly<Record<ExecSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * A run cancelled by a signal, or by the caller without one.
 *
 * B56 gives a signal precedence over every turn outcome, so the code is
 * carried on the error rather than inferred from the turn.
 */
export class ExecAbortedError extends ExecError {
  readonly signal: ExecSignal | undefined;

  constructor(
    signal?: ExecSignal,
    message: string = signal === undefined
      ? "Cancelled"
      : `Cancelled by ${signal}`,
  ) {
    super("aborted", message);
    this.name = "ExecAbortedError";
    this.signal = signal;
  }

  /** `130`/`143` for a signal, `1` for a cancellation without one. */
  get exitCode(): number {
    return this.signal === undefined ? 1 : SIGNAL_EXIT_CODES[this.signal];
  }
}
