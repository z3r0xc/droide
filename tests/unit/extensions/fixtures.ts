/**
 * Fixture helpers for the extensions tests. Every fixture is synthesised in a
 * temporary directory: no repository, home-directory or network state.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempDirectory {
  readonly path: string;
  cleanup(): void;
}

export function createTempDirectory(): TempDirectory {
  const path = mkdtempSync(join(tmpdir(), "droide-ext-"));
  return {
    path,
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function writeFixture(
  root: string,
  relativePath: string,
  content: string,
): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

export function skillMarkdown(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}
