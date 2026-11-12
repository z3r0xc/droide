/**
 * Settings resolution: the four-level chain, its documented order, and the
 * runtime overlay's two sources.
 *
 * Contract: `specs/10-cli-surface.md` B77-B79 (the overlay is
 * `options.settings ?? FACTORY_RUNTIME_SETTINGS_PATH`, and a path that cannot
 * be read is dropped rather than fatal) and "Settings files" (org → runtime →
 * project/folder → user → dynamic config → builtin defaults). This slice
 * implements the four levels the rest of the CLI observes directly:
 *
 *   org policy  >  runtime overlay  >  project/folder  >  user
 *
 * The full hierarchy has seven further levels (automation folder, `.factory`
 * folders, project `.agent`, plugins, dynamic config, builtin defaults); they
 * are owned by the extension, plugin and daemon slices and are merged by their
 * callers into {@link ResolveSettingsOptions.orgSettings} or by extending this
 * module when those specs land.
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";

import { InvalidSettingsError, UnreadableSettingsError } from "./errors.ts";
import {
  projectSettingsFile,
  resolvePath,
  userSettingsFile,
  type Environment,
} from "./paths.ts";
import { parseSettingsText, type Settings } from "./schema.ts";

/** Highest priority first. Do not reorder without changing the merge below. */
export type SettingsLevel = "org" | "runtime" | "project" | "user";

export interface ResolvedSettingsLayer {
  readonly level: SettingsLevel;
  /** The file that produced the layer, or `organization policy`. */
  readonly source: string;
  readonly settings: Settings;
}

/** A runtime overlay path that was rejected without aborting the process. */
export interface DroppedOverlay {
  readonly path: string;
  readonly reason: string;
}

export type RuntimeOverlayResolution =
  | { readonly kind: "absent" }
  | {
      readonly kind: "loaded";
      readonly path: string;
      readonly settings: Settings;
    }
  | ({ readonly kind: "dropped" } & DroppedOverlay);

export interface ResolveSettingsOptions {
  /** The `--settings` flag exactly as typed; wins over the inherited env path. */
  readonly flagSettings?: string;
  /** Organization policy already fetched by the caller (it is remote-only). */
  readonly orgSettings?: Settings;
  /** Override the user settings file (tests, isolated homes). */
  readonly userSettingsFile?: string;
  /** Override the project settings file (tests, `--cwd` fixtures). */
  readonly projectSettingsFile?: string;
}

export interface ResolvedSettings {
  /** The merged result, highest-priority layer winning. */
  readonly settings: Settings;
  /** The layers that contributed, highest priority first. */
  readonly layers: readonly ResolvedSettingsLayer[];
  /** What happened to the runtime overlay, including why it was dropped. */
  readonly overlay: RuntimeOverlayResolution;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read and validate one settings file. A missing file is `undefined` (a layer
 * that simply does not exist); a file that exists but is a directory or cannot
 * be read is {@link UnreadableSettingsError}; malformed content is
 * {@link InvalidSettingsError}.
 */
export async function readSettingsFile(
  filePath: string,
): Promise<Settings | undefined> {
  let stats: Stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new UnreadableSettingsError(filePath, errorMessage(error), error);
  }
  if (!stats.isFile()) {
    throw new UnreadableSettingsError(filePath, "not a regular file");
  }

  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new UnreadableSettingsError(filePath, errorMessage(error), error);
  }
  return parseSettingsText(text, filePath);
}

/**
 * Trim a settings path, expand a leading tilde and make it absolute at the
 * launch directory. A blank value names no file.
 */
export function resolveSettingsPath(
  environment: Environment,
  value: string,
): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : resolvePath(environment, trimmed);
}

/** `FACTORY_RUNTIME_SETTINGS_PATH` as the subject reads it: trimmed, or none. */
export function runtimeSettingsPathFromEnvironment(
  environment: Environment,
): string | undefined {
  const value = environment.env.FACTORY_RUNTIME_SETTINGS_PATH;
  return value === undefined
    ? undefined
    : resolveSettingsPath(environment, value);
}

/**
 * The overlay path this process uses: the `--settings` flag, then the
 * inherited environment variable (B77). A blank flag falls through, exactly as
 * the subject's `readTrimmedHomePath` returns no path for it.
 */
export function runtimeSettingsPath(
  environment: Environment,
  flagSettings?: string,
): string | undefined {
  return (
    (flagSettings === undefined
      ? undefined
      : resolveSettingsPath(environment, flagSettings)) ??
    runtimeSettingsPathFromEnvironment(environment)
  );
}

async function resolveOverlay(
  environment: Environment,
  flagSettings: string | undefined,
): Promise<RuntimeOverlayResolution> {
  const path = runtimeSettingsPath(environment, flagSettings);
  if (path === undefined) return { kind: "absent" };

  try {
    const settings = await readSettingsFile(path);
    if (settings === undefined) {
      return { kind: "dropped", path, reason: "file not found" };
    }
    return { kind: "loaded", path, settings };
  } catch (error) {
    // B79: a path that does not exist, is not a regular file or is unreadable
    // drops the overlay and is recorded; it never aborts. Invalid *content* is
    // a different failure and propagates.
    if (error instanceof UnreadableSettingsError) {
      return { kind: "dropped", path, reason: error.reason };
    }
    if (error instanceof InvalidSettingsError) throw error;
    throw error;
  }
}

/**
 * Merge two settings objects. `higher` wins. Records merge per key (a server,
 * hook event or droid definition replaces the lower one whole); arrays and
 * scalars replace. Merging is shallow on purpose: a higher layer's MCP server
 * must not inherit the lower layer's `command` when it defines a `url`.
 */
export function mergeSettings(lower: Settings, higher: Settings): Settings {
  const general =
    lower.general === undefined
      ? higher.general
      : higher.general === undefined
        ? lower.general
        : { ...lower.general, ...higher.general };

  const mcp =
    lower.mcp === undefined
      ? higher.mcp
      : higher.mcp === undefined
        ? lower.mcp
        : { ...lower.mcp, ...higher.mcp };

  const hooks =
    lower.hooks === undefined
      ? higher.hooks
      : higher.hooks === undefined
        ? lower.hooks
        : { ...lower.hooks, ...higher.hooks };

  const droids =
    lower.droids === undefined
      ? higher.droids
      : higher.droids === undefined
        ? lower.droids
        : { ...lower.droids, ...higher.droids };

  const outputStyles =
    lower.outputStyles === undefined
      ? higher.outputStyles
      : higher.outputStyles === undefined
        ? lower.outputStyles
        : { ...lower.outputStyles, ...higher.outputStyles };

  // `skills` and `commands` are lists: a higher layer replaces the list.
  const skills = higher.skills === undefined ? lower.skills : higher.skills;
  const commands =
    higher.commands === undefined ? lower.commands : higher.commands;

  return {
    ...(general === undefined ? {} : { general }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(droids === undefined ? {} : { droids }),
    ...(skills === undefined ? {} : { skills }),
    ...(outputStyles === undefined ? {} : { outputStyles }),
    ...(commands === undefined ? {} : { commands }),
  };
}

/**
 * Resolve every local layer for `environment` and merge them.
 *
 * Missing user/project files contribute nothing; a malformed one fails loudly.
 * The runtime overlay follows B79: an unreadable path is dropped and reported.
 */
export async function resolveSettings(
  environment: Environment,
  options: ResolveSettingsOptions = {},
): Promise<ResolvedSettings> {
  const layers: ResolvedSettingsLayer[] = [];

  if (options.orgSettings !== undefined) {
    layers.push({
      level: "org",
      source: "organization policy",
      settings: options.orgSettings,
    });
  }

  const overlay = await resolveOverlay(environment, options.flagSettings);
  if (overlay.kind === "loaded") {
    layers.push({
      level: "runtime",
      source: overlay.path,
      settings: overlay.settings,
    });
  }

  const projectPath =
    options.projectSettingsFile === undefined
      ? projectSettingsFile(environment)
      : resolveSettingsPath(environment, options.projectSettingsFile);
  if (projectPath !== undefined) {
    const projectSettings = await readSettingsFile(projectPath);
    if (projectSettings !== undefined) {
      layers.push({
        level: "project",
        source: projectPath,
        settings: projectSettings,
      });
    }
  }

  const userPath =
    options.userSettingsFile === undefined
      ? userSettingsFile(environment)
      : resolveSettingsPath(environment, options.userSettingsFile);
  if (userPath !== undefined) {
    const userSettings = await readSettingsFile(userPath);
    if (userSettings !== undefined) {
      layers.push({ level: "user", source: userPath, settings: userSettings });
    }
  }

  const settings = layers.reduceRight<Settings>(
    (lower, layer) => mergeSettings(lower, layer.settings),
    {},
  );

  return { settings, layers, overlay };
}
