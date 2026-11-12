import { createHash } from "node:crypto";

/**
 * Session identity. Contract: `specs/40-sessions-and-storage.md` B17 — a session
 * id is a lowercase UUIDv4 string taken from the transcript file name.
 *
 * Ids must be reproducible in tests, so one is derived from an injected clock
 * and a monotonic counter rather than from the platform's random source. The
 * derivation still produces a well-formed v4 UUID: the clock and counter are
 * hashed, then the version and variant bits are forced, which is the only
 * difference from a random generator a reader can observe.
 */

export interface SessionClock {
  now(): number;
}

export interface SessionIdFactory {
  next(): string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isSessionId(value: string): boolean {
  return UUID_V4.test(value);
}

export function createSessionIdFactory(clock: SessionClock): SessionIdFactory {
  let counter = 0;
  return {
    next(): string {
      const seed = `${clock.now()}\u0000${counter}`;
      counter += 1;
      const bytes = createDigest(seed);
      return formatUuid(bytes);
    },
  };
}

function createDigest(seed: string): Uint8Array {
  // `node:crypto` without a key is a pure function of its input, which is what
  // makes the sequence replayable.
  const digest = createHash("sha256").update(seed).digest();
  const bytes = new Uint8Array(digest);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes.subarray(0, 16)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
