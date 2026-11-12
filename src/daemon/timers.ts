/**
 * Injected timers. Contract: `specs/70-daemon-and-remote-control.md` B7
 * (bind backoff) and B8 (the 10 s shutdown cap).
 *
 * Nothing in this area sleeps: retry delays, handshake budgets and shutdown
 * deadlines all go through this seam so tests can advance time without
 * waiting.
 */

/** Run `callback` after `ms`; the returned function cancels it. */
export interface DaemonTimers {
  set(callback: () => void, ms: number): () => void;
}

/** The production timers, backed by `setTimeout`. */
export const systemTimers: DaemonTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};
