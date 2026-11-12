/**
 * Parent-death detection. Contract:
 * `specs/70-daemon-and-remote-control.md` B10.
 *
 * Two monitors, one shape: `--parent-pid` polls `process.kill(pid, 0)` every
 * 2000 ms, and `--liveness-fd` reads the inherited pipe and reports once when
 * it closes. Both are injectable (`timers`, `isAlive`, the pipe factory) so a
 * test can fire them without a real parent or a real pipe.
 */

import { Socket } from "node:net";
import type { Readable } from "node:stream";

import { systemTimers, type DaemonTimers } from "./timers.ts";

/** How often `--parent-pid` is polled, in milliseconds (B10). */
export const PARENT_PID_POLL_INTERVAL_MS = 2_000;

/** A running monitor; `stop` releases whatever it holds. */
export interface LivenessWatcher {
  stop(): void;
}

export interface ParentPidWatchOptions {
  readonly pid: number;
  readonly onDead: () => void;
  /** Defaults to {@link PARENT_PID_POLL_INTERVAL_MS}. */
  readonly intervalMs?: number;
  readonly timers?: DaemonTimers;
  /** Defaults to {@link isProcessAlive}. */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Poll `pid` until it is gone, then report once. A poll that throws for any
 * reason other than "no such process" counts as alive, so a permission error
 * never shuts a healthy daemon down.
 */
export function watchParentPid(
  options: ParentPidWatchOptions,
): LivenessWatcher {
  const timers = options.timers ?? systemTimers;
  const intervalMs = options.intervalMs ?? PARENT_PID_POLL_INTERVAL_MS;
  const isAlive = options.isAlive ?? isProcessAlive;
  let cancel: (() => void) | undefined;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (!isAlive(options.pid)) {
      stopped = true;
      cancel = undefined;
      options.onDead();
      return;
    }
    cancel = timers.set(tick, intervalMs);
  };
  cancel = timers.set(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      cancel?.();
      cancel = undefined;
    },
  };
}

/** Whether `pid` exists for this process. Only `ESRCH` means "gone". */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isErrnoException(error) && error.code === "ESRCH");
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}

/** Open one inherited pipe fd; resolves when the pipe reports EOF. */
export type LivenessPipeOpener = (
  fd: number,
  onClose: () => void,
) => LivenessWatcher;

/**
 * Report once when a readable ends, closes or errors; `stop` detaches and
 * destroys it, suppressing a late report.
 */
export function watchStreamClose(
  stream: Readable,
  onClose: () => void,
): LivenessWatcher {
  let stopped = false;
  const fire = (): void => {
    if (stopped) return;
    stopped = true;
    onClose();
  };
  stream.on("end", fire);
  stream.on("close", fire);
  stream.on("error", fire);
  return {
    stop() {
      stopped = true;
      stream.off("end", fire);
      stream.off("close", fire);
      stream.off("error", fire);
      stream.destroy();
    },
  };
}

/**
 * Read the inherited fd as a pipe and report once when it ends, closes or
 * errors (B10).
 */
export function watchLivenessPipe(
  fd: number,
  onClose: () => void,
): LivenessWatcher {
  return watchStreamClose(
    new Socket({ fd, readable: true, writable: false }),
    onClose,
  );
}
