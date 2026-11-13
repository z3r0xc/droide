/**
 * Whole-output spill files for the cut notice.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B12 — an over-budget `Read` writes
 * its whole rendered output under `<stateDir>/tool-outputs`, content-addressed
 * by the SHA-256 of that output, mode `0600` inside a `0700` directory and
 * capped at `MAX_INLINE_OUTPUT_BYTES`; anything that fails (too large, an
 * unwritable directory, a failed rename) leaves the notice pointing back at the
 * file and its offset/limit remedy instead.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { joinPath, toolOutputsDir } from "../../config/paths.ts";
import type { Environment } from "../../config/paths.ts";
import { MAX_INLINE_OUTPUT_BYTES } from "../result.ts";

/** The largest whole output a spill file carries; past it the notice falls back. */
export const SPILL_MAX_BYTES = MAX_INLINE_OUTPUT_BYTES;

/** Hex digits of the content hash used as the file name. */
export const SPILL_NAME_HASH_LENGTH = 32;

const SPILL_EXTENSION = ".txt";
const SPILL_DIRECTORY_MODE = 0o700;
const SPILL_FILE_MODE = 0o600;

/**
 * The filesystem seam the spill writer uses. Tests inject a fake to prove the
 * fallback without provoking a real permission error on the host.
 */
export interface SpillFileSystem {
  /** Create the directory and its parents, mode `0700` for the leaf. */
  makedirs(directory: string): Promise<void>;
  /** Whether a spill of this name is already on disk. */
  exists(path: string): Promise<boolean>;
  /** Write a new file, mode `0600`, refusing to clobber an existing one. */
  write(path: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a partial temp file; absent is not an error. */
  remove(path: string): Promise<void>;
}

/** The real seam: `node:fs`, with the modes and the no-clobber write applied. */
export const nodeSpillFileSystem: SpillFileSystem = {
  async makedirs(directory: string): Promise<void> {
    await fs.promises.mkdir(directory, {
      recursive: true,
      mode: SPILL_DIRECTORY_MODE,
    });
  },
  async exists(path: string): Promise<boolean> {
    try {
      await fs.promises.stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async write(path: string, data: Buffer): Promise<void> {
    await fs.promises.writeFile(path, data, {
      mode: SPILL_FILE_MODE,
      flag: "wx",
    });
  },
  async rename(from: string, to: string): Promise<void> {
    await fs.promises.rename(from, to);
  },
  async remove(path: string): Promise<void> {
    await fs.promises.unlink(path).catch(() => undefined);
  },
};

/** The content-addressed name: the hash of the output, not a session id. */
export function spillFileName(text: string): string {
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return `${hash.slice(0, SPILL_NAME_HASH_LENGTH)}${SPILL_EXTENSION}`;
}

/**
 * Writes `text` to its spill file and returns the absolute path, or `null` when
 * nothing was written: an output past {@link SPILL_MAX_BYTES}, a directory that
 * cannot be created or written, or a rename that fails. A second identical
 * output finds the file already present and reuses it.
 */
export async function writeToolOutput(
  environment: Environment,
  text: string,
  fileSystem: SpillFileSystem = nodeSpillFileSystem,
): Promise<string | null> {
  const data = Buffer.from(text, "utf8");
  if (data.length > SPILL_MAX_BYTES) return null;
  const directory = toolOutputsDir(environment);
  const name = spillFileName(text);
  const target = joinPath(environment.platform, directory, name);
  const temporary = joinPath(
    environment.platform,
    directory,
    `.${name}.${randomUUID()}.tmp`,
  );
  try {
    await fileSystem.makedirs(directory);
    if (await fileSystem.exists(target)) return target;
    await fileSystem.write(temporary, data);
    await fileSystem.rename(temporary, target);
    return target;
  } catch {
    await fileSystem.remove(temporary).catch(() => undefined);
    return null;
  }
}
