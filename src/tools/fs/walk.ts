/**
 * Deterministic directory walking for `Glob` and `Grep`.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B19 (`--files --hidden`: hidden
 * entries are included, symlinks are not followed) and B20. Entries are visited
 * in sorted order so two runs over one tree return the same list.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

export interface WalkEntry {
  /** Absolute path with the platform separator. */
  readonly absolute: string;
  /** Path relative to the walk root, always with `/` separators. */
  readonly relative: string;
}

/**
 * Every regular file under `root`, hidden entries included, symlinks skipped.
 * An unreadable subdirectory is skipped; the root itself must be readable.
 */
export async function walkFiles(root: string): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  const pending: Array<{ directory: string; relative: string }> = [
    { directory: root, relative: "" },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const dirents = await fs.promises.readdir(current.directory, {
      withFileTypes: true,
    });
    dirents.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      const relative =
        current.relative === ""
          ? dirent.name
          : `${current.relative}/${dirent.name}`;
      const absolute = nodePath.join(current.directory, dirent.name);
      if (dirent.isDirectory()) {
        pending.push({ directory: absolute, relative });
      } else if (dirent.isFile()) {
        entries.push({ absolute, relative });
      }
    }
  }
  entries.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );
  return entries;
}