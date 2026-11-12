import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionClock } from "../../../src/session/ids.ts";

export interface SessionFixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly sessionsDir: string;
  cleanup(): void;
}

export function makeSessionFixture(prefix = "droide-session-"): SessionFixture {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    dbPath: join(dir, "cache", "session-index", "index.db"),
    sessionsDir: join(dir, "sessions"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function mutableClock(
  start: number,
): SessionClock & { set(value: number): void } {
  let value = start;
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
  };
}
