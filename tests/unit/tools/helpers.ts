import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Environment, Platform } from "../../../src/config/paths.ts";
import { FileReadTracker, type ToolContext } from "../../../src/tools/index.ts";

export interface ToolFixture {
  readonly dir: string;
  readonly root: string;
  readonly home: string;
  readonly environment: Environment;
  readonly context: ToolContext;
  path(...segments: string[]): string;
  cleanup(): void;
}

function currentPlatform(): Platform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported test platform: ${process.platform}`);
}

/** A workspace root and home inside one temporary directory, removed on cleanup. */
export function makeToolFixture(prefix = "droide-tools-"): ToolFixture {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, "workspace");
  const home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const environment: Environment = {
    env: {},
    home,
    platform: currentPlatform(),
    cwd: root,
  };
  return {
    dir,
    root,
    home,
    environment,
    context: { root, environment, reads: new FileReadTracker() },
    path: (...segments: string[]) => join(root, ...segments),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** An environment that also carries the real process environment (exec tests). */
export function makeExecEnvironment(fixture: ToolFixture): Environment {
  return { ...fixture.environment, env: { ...process.env } };
}
