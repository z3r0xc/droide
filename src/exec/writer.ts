/**
 * JSON-lines writer for exec stdout. Contract:
 * `specs/80-exec-and-streaming.md` B24, B33, B34.
 *
 * The writer is the only thing exec puts on stdout: one serialised JSON object
 * per `write`, never a banner, a wrapper or an array. A closed downstream pipe
 * (`… | head -1`) marks the writer closed and resolves the write as not
 * accepted, so a finished run can still exit `0` without a stack trace.
 */

import type { Writable } from "node:stream";

import { ExecStreamError } from "./errors.ts";

export interface JsonLineWriter {
  /** Resolves `true` when the line was flushed, `false` once the pipe is gone. */
  write(value: unknown): Promise<boolean>;
  /** True after a broken pipe: no further bytes will be attempted. */
  readonly closed: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

/** EPIPE, and the destroyed-stream code a closed pipe surfaces on Windows. */
export function isBrokenPipeError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function serialize(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new ExecStreamError("record is not JSON-serialisable", error);
  }
  if (text === undefined)
    throw new ExecStreamError("record is not JSON-serialisable");
  return `${text}\n`;
}

export function createJsonLineWriter(stream: Writable): JsonLineWriter {
  let closed = false;
  let pendingError: unknown;

  // A Writable with no `error` listener throws; swallowing here is also what
  // keeps a broken pipe from reaching the process as an uncaught exception.
  stream.on("error", (error: unknown) => {
    if (isBrokenPipeError(error)) {
      closed = true;
      return;
    }
    pendingError = error;
  });

  return {
    get closed(): boolean {
      return closed;
    },

    async write(value: unknown): Promise<boolean> {
      if (closed) return false;
      if (pendingError !== undefined) {
        throw new ExecStreamError("stdout write failed", pendingError);
      }
      if (stream.destroyed || stream.writableEnded) {
        closed = true;
        return false;
      }

      const line = serialize(value);
      const { promise, resolve, reject } = Promise.withResolvers<boolean>();
      const settle = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve(true);
          return;
        }
        if (isBrokenPipeError(error)) {
          closed = true;
          resolve(false);
          return;
        }
        reject(new ExecStreamError("stdout write failed", error));
      };
      try {
        stream.write(line, settle);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
      return await promise;
    },
  };
}