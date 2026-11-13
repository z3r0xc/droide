/**
 * Startup context: environment, resolved settings and derived paths.
 *
 * `specs/10-cli-surface.md` §B74–B80 (precedence) and `specs/40-sessions-and-storage.md`
 * (on-disk layout). Built once per process, after argument parsing and before
 * any command runs, so every command sees the same view.
 */
import {
  type Environment,
  cacheDir,
  stateDir,
  logsDir,
  processEnvironment,
  projectDir,
  projectSettingsFile,
  resolvePath,
  sessionIndexDatabase,
  sessionIndexDir,
  sessionsDir,
  userSettingsFile,
  worktreesRoot,
} from "../config/paths.ts";
import {
  type DroppedOverlay,
  type ResolvedSettingsLayer,
  resolveSettings,
} from "../config/resolve.ts";
import type { Settings } from "../config/schema.ts";

export interface AppPaths {
  readonly stateDir: string;
  readonly userSettingsFile: string;
  readonly projectDir: string;
  readonly projectSettingsFile: string;
  readonly sessionsDir: string;
  readonly sessionIndexDir: string;
  readonly sessionIndexDatabase: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly worktreesRoot: string;
}

export interface AppContext {
  readonly environment: Environment;
  readonly paths: AppPaths;
  readonly settings: Settings;
  /** Contributing layers, highest priority first. */
  readonly layers: readonly ResolvedSettingsLayer[];
  /** Runtime overlays that were rejected instead of aborting the run. */
  readonly droppedOverlays: readonly DroppedOverlay[];
}

export interface CreateAppContextOptions {
  /** Defaults to the process environment; tests inject a fixture. */
  readonly environment?: Environment;
  /** `--cwd`, as typed. Resolved against the launch directory. */
  readonly cwd?: string;
  /** `--settings`, as typed. Wins over `DROIDE_RUNTIME_SETTINGS_PATH`. */
  readonly settingsFlag?: string;
  /** Organization policy, already fetched (it is remote-only). */
  readonly orgSettings?: Settings;
}

/**
 * Build the context every command runs against.
 *
 * Paths are derived from the *effective* environment: when `--cwd` is given the
 * project layer and project paths move with it, while the user layer stays at
 * the real home. The launch directory is never mutated.
 */
export async function createAppContext(
  options: CreateAppContextOptions = {},
): Promise<AppContext> {
  const base = options.environment ?? processEnvironment();
  const environment: Environment =
    options.cwd === undefined
      ? base
      : { ...base, cwd: resolvePath(base, options.cwd) };

  const resolved = await resolveSettings(environment, {
    ...(options.settingsFlag === undefined
      ? {}
      : { flagSettings: options.settingsFlag }),
    ...(options.orgSettings === undefined
      ? {}
      : { orgSettings: options.orgSettings }),
  });

  return {
    environment,
    settings: resolved.settings,
    layers: resolved.layers,
    droppedOverlays:
      resolved.overlay.kind === "dropped" ? [resolved.overlay] : [],
    paths: {
      stateDir: stateDir(environment),
      userSettingsFile: userSettingsFile(environment),
      projectDir: projectDir(environment),
      projectSettingsFile: projectSettingsFile(environment),
      sessionsDir: sessionsDir(environment),
      sessionIndexDir: sessionIndexDir(environment),
      sessionIndexDatabase: sessionIndexDatabase(environment),
      cacheDir: cacheDir(environment),
      logsDir: logsDir(environment),
      worktreesRoot: worktreesRoot(environment),
    },
  };
}
