/**
 * Path resolution for the filesystem tools.
 *
 * Contract: `specs/30-tools-and-sandbox.md` Terms (workspace root, relative
 * base), B14 (`file_path must be an absolute path`), B24 (a protected write is
 * checked on the path as given and on the resolved target; an unresolvable
 * symlink chain is itself a refusal), B48-B50 (the credential read floor and
 * the trusted-config write floor).
 *
 * The root is a base, not a jail: an absolute path outside it is allowed, as
 * the spec says. A *relative* path that climbs out of the root is refused, and
 * a path whose real location escapes through a symlink is refused.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import {
  expandTilde,
  factoryDir,
  isAbsolutePath,
  joinPath,
} from "../../config/paths.ts";
import type { Environment } from "../../config/paths.ts";
import { ToolFailure } from "../errors.ts";

export interface FsContext {
  /** Absolute workspace root, the base for relative paths. */
  readonly root: string;
  readonly environment: Environment;
}

export interface ResolveOptions {
  /**
   * Refuse a relative input with B14's wording. Tools whose schema says
   * "must be absolute" set this; the rest resolve against the root.
   */
  readonly requireAbsolute?: boolean;
}

/** Names under the Factory dir that are never writable (B48/B50 floor). */
const TRUSTED_CONFIG_FILES: Readonly<Record<string, true>> = {
  "settings.json": true,
  "settings.local.json": true,
  "hooks.json": true,
  "mcp.json": true,
  "update-policy.json": true,
  "org-managed-settings.json": true,
  "host.json": true,
  "computer.json": true,
};

const TRUSTED_CONFIG_DIRS: Readonly<Record<string, true>> = {
  certs: true,
  bin: true,
  tools: true,
  "sandbox-runtime": true,
  "exit-spool": true,
};

/** Credential files that are never readable (B48/B49 floor). */
const CREDENTIAL_FILES: Readonly<Record<string, true>> = {
  "auth.encrypted": true,
  "computer-identity": true,
  "prem-auth": true,
  "config.json": true,
};

const CREDENTIAL_PREFIXES = ["auth.v2.", "mcp-oauth."];

function pathApi(environment: Environment): typeof nodePath.posix {
  return environment.platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** Whether `child` is `parent` or lives below it. */
export function isInside(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !nodePath.isAbsolute(relative))
  );
}

/**
 * The absolute path a tool input names. Relative inputs resolve against the
 * workspace root; a relative input that climbs out of it is refused.
 */
export function resolveInputPath(
  context: FsContext,
  input: string,
  options: ResolveOptions = {},
): string {
  if (input.length === 0) {
    throw new ToolFailure(
      "file_path is required and must be a non-empty string",
    );
  }
  const path = pathApi(context.environment);
  const expanded = expandTilde(context.environment, input);
  if (!isAbsolutePath(context.environment.platform, expanded)) {
    if (options.requireAbsolute === true) {
      throw new ToolFailure(
        "file_path must be an absolute path, not a relative path",
      );
    }
    const resolved = path.resolve(context.root, expanded);
    if (!isInside(context.root, resolved)) {
      throw new ToolFailure(
        `Cannot access a path outside the workspace root: "${input}"`,
      );
    }
    return resolved;
  }
  return path.normalize(expanded);
}

/** The real path of `target`, or of its deepest existing ancestor. */
function realPathOfExistingAncestor(target: string): string {
  let current = target;
  for (;;) {
    try {
      return fs.realpathSync.native(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new ToolFailure(
          "Cannot access a path whose symlinks could not be resolved",
          { cause: error },
        );
      }
      const parent = nodePath.dirname(current);
      if (parent === current) {
        throw new ToolFailure(
          "Cannot access a path whose symlinks could not be resolved",
          { cause: error },
        );
      }
      current = parent;
    }
  }
}

/**
 * Refuses a path that was named inside the workspace root but whose real
 * location leaves it through a symlink (B24). A path named outside the root is
 * not a jail escape: the spec allows absolute paths anywhere.
 */
export function assertNoSymlinkEscape(
  context: FsContext,
  given: string,
  resolved: string,
): void {
  if (!isInside(context.root, resolved)) return;
  const rootReal = realPathOfExistingAncestor(context.root);
  const targetReal = realPathOfExistingAncestor(resolved);
  if (!isInside(rootReal, targetReal)) {
    throw new ToolFailure(
      `Cannot access a path whose symlinks could not be resolved: "${given}"`,
    );
  }
}

function protectedName(
  factory: string,
  candidate: string,
  names: Readonly<Record<string, true>>,
  prefixes: readonly string[],
): boolean {
  const relative = nodePath.relative(factory, candidate);
  if (relative === "" || relative.startsWith("..")) return false;
  const [first] = relative.split(nodePath.sep);
  if (first === undefined) return false;
  return (
    Object.hasOwn(names, first) ||
    prefixes.some((prefix) => first.startsWith(prefix))
  );
}

function protectedDirectory(
  factory: string,
  candidate: string,
  names: Readonly<Record<string, true>>,
): boolean {
  const relative = nodePath.relative(factory, candidate);
  if (relative === "" || relative.startsWith("..")) return false;
  const [first] = relative.split(nodePath.sep);
  return first !== undefined && Object.hasOwn(names, first);
}

/**
 * The write guard (B24, B50): checked on the path as given and on the resolved
 * target. `TODO(spec B24)`: the artifacts directory, mission system files,
 * automation state, `features.json` and shared-space guards are not added
 * because this spec does not pin their locations.
 */
export function assertWritablePath(
  context: FsContext,
  given: string,
  resolved: string,
): void {
  const factory = factoryDir(context.environment);
  for (const candidate of [given, resolved]) {
    const absolute = isAbsolutePath(context.environment.platform, candidate)
      ? nodePath.normalize(candidate)
      : resolved;
    if (
      protectedName(factory, absolute, TRUSTED_CONFIG_FILES, []) ||
      protectedDirectory(factory, absolute, TRUSTED_CONFIG_DIRS)
    ) {
      throw new ToolFailure(`Sandbox: write denied to ${absolute}`);
    }
  }
}

/** Whether `resolved` names a credential file (B48/B49 read floor). */
export function isCredentialFile(
  resolved: string,
  environment: Environment,
): boolean {
  const factory = factoryDir(environment);
  return (
    protectedName(factory, resolved, CREDENTIAL_FILES, []) ||
    protectedName(factory, resolved, {}, CREDENTIAL_PREFIXES)
  );
}

/** The read floor (B48/B49): credential files are never readable. */
export function assertReadablePath(
  resolved: string,
  environment: Environment,
): void {
  if (isCredentialFile(resolved, environment)) {
    throw new ToolFailure(`Sandbox: read denied to ${resolved}`);
  }
}

/** Joins a path under the injected root with the platform separator. */
export function joinUnderRoot(
  context: FsContext,
  ...segments: string[]
): string {
  return joinPath(context.environment.platform, context.root, ...segments);
}
