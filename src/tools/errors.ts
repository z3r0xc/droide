/**
 * Typed failures of the tool layer.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B1, B8, B24, B43-B46, and the
 * "Errors" table. A tool refusal is a {@link ToolFailure} whose `message` is
 * model-visible text, so the registry can turn it into an error result without
 * guessing at wording.
 */

/** A refusal that is already phrased for the model; never reworded by callers. */
export class ToolFailure extends Error {
  readonly toolId: string | undefined;

  constructor(
    message: string,
    options: {
      readonly toolId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ToolFailure";
    this.toolId = options.toolId;
  }
}

/**
 * A tool input that failed validation (B8). `schemaError` is the issue list
 * without the parameter guide; `message` is what the model receives.
 */
export class ToolInputError extends ToolFailure {
  readonly schemaError: string;

  constructor(toolId: string, schemaError: string, message: string) {
    super(message, { toolId });
    this.name = "ToolInputError";
    this.schemaError = schemaError;
  }
}

/**
 * A broken tool definition (B1). Thrown at registration, before the tool is
 * reachable, with the wording `specs/30-tools-and-sandbox.md` pins.
 */
export class ToolRegistrationError extends Error {
  readonly toolId: string | undefined;

  constructor(message: string, toolId: string | undefined) {
    super(message);
    this.name = "ToolRegistrationError";
    this.toolId = toolId;
  }
}

/** A command produced more output than the inline cap allows (B13, B27). */
export class OutputLimitError extends ToolFailure {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(
      `Command output exceeded the ${Math.round(limit / (1024 * 1024))} MiB inline cap ` +
        `(${bytes} bytes written); refuse further output, redirect it to a file, ` +
        "or narrow the command before retrying.",
    );
    this.name = "OutputLimitError";
    this.bytes = bytes;
    this.limit = limit;
  }
}
