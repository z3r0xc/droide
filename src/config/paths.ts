/**
 * Filesystem locations the CLI reads and writes.
 *
 * Contract:
 * - `specs/40-sessions-and-storage.md` Terms ("Factory home", "Factory dir
 *   name", "Sessions dir", "Cache database") and "On-disk layout".
 * - `specs/10-cli-surface.md` B81 (`worktreeDirectory` defaults to
 *   `~/.factory/worktrees`) and B68 (launch-relative paths resolve at the
 *   launch directory).
 *
 * This is the **only** module allowed to read `process.env`, `os.homedir()` or
 * `process.cwd()`. Everything else takes an injected {@link Environment}, so a
 * test can never observe or touch the real home directory.
 */
import { homedir } from "node:os";
import * as nodePath from "node:path";

import { UnsupportedPlatformError } from "./errors.ts";

/** The platforms the CLI ships for; every path rule is fixed per platform. */
export type Platform = "win32" | "darwin" | "linux";

/**
 * Everything the path layer needs from the outside world. `env` is the raw
 * process environment (values may be absent); `home` is the operating system's
 * home directory; `cwd` is the launch directory.
 */
export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: Platform;
  readonly cwd: string;
}

export const FACTORY_DIR_PRODUCTION = ".factory";
export const FACTORY_DIR_DEVELOPMENT = ".factory-dev";

const SETTINGS_FILE = "settings.json";
const SETTINGS_LOCAL_FILE = "settings.local.json";

function isPlatform(value: string): value is Platform {
  return value === "win32" || value === "darwin" || value === "linux";
}

/**
 * The process environment, read exactly once at the boundary. Callers that
 * need a different home (tests, `FACTORY_HOME_OVERRIDE` fixtures) build their
 * own {@link Environment} instead.
 */
export function processEnvironment(): Environment {
  const platform = process.platform;
  if (!isPlatform(platform)) {
    throw new UnsupportedPlatformError(platform);
  }
  return {
    env: process.env,
    home: homedir(),
    platform,
    cwd: process.cwd(),
  };
}

/** `path.win32` or `path.posix`, chosen by the injected platform. */
function pathFor(platform: Platform): typeof nodePath.posix {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** Join with the separator the injected platform uses. */
export function joinPath(
  platform: Platform,
  ...segments: readonly string[]
): string {
  return pathFor(platform).join(...segments);
}

/** Whether `value` is absolute for the injected platform. */
export function isAbsolutePath(platform: Platform, value: string): boolean {
  return pathFor(platform).isAbsolute(value);
}

/**
 * A leading current-user tilde expanded to the injected home. `~user` is not
 * expanded, matching the subject (`packages/runtime/shell/src/path-expansion.ts`).
 */
export function expandTilde(environment: Environment, value: string): string {
  if (value === "~") return environment.home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return joinPath(environment.platform, environment.home, value.slice(2));
  }
  return value;
}

/**
 * `value` with a leading tilde expanded and made absolute at the launch
 * directory — the anchoring rule for `--settings` and
 * `FACTORY_RUNTIME_SETTINGS_PATH` (`specs/10-cli-surface.md` B65, B68).
 */
export function resolvePath(environment: Environment, value: string): string {
  return pathFor(environment.platform).resolve(
    environment.cwd,
    expandTilde(environment, value),
  );
}

/**
 * The Factory home: `FACTORY_HOME_OVERRIDE` when set and non-empty, else the
 * injected home (`specs/40-sessions-and-storage.md` Terms).
 */
export function factoryHome(environment: Environment): string {
  const override = environment.env.FACTORY_HOME_OVERRIDE;
  return override !== undefined && override !== ""
    ? override
    : environment.home;
}

/**
 * `.factory` for the production tier and `.factory-dev` otherwise. The
 * recorded Windows build is production, so an absent `FACTORY_ENV` means
 * production; any other value means development (`specs/40-sessions-and-storage.md`,
 * "Factory dir name").
 */
export function factoryDirName(environment: Environment): string {
  const tier = environment.env.FACTORY_ENV?.trim();
  return tier === undefined || tier === "" || tier === "production"
    ? FACTORY_DIR_PRODUCTION
    : FACTORY_DIR_DEVELOPMENT;
}

/** `<Factory home>/<Factory dir name>`: the base every stored file lives under. */
export function factoryDir(environment: Environment): string {
  return joinPath(
    environment.platform,
    factoryHome(environment),
    factoryDirName(environment),
  );
}

/** The user settings file: `<base>/settings.json`. */
export function userSettingsFile(environment: Environment): string {
  return joinPath(environment.platform, factoryDir(environment), SETTINGS_FILE);
}

/** The user's local override file: `<base>/settings.local.json`. */
export function userLocalSettingsFile(environment: Environment): string {
  return joinPath(
    environment.platform,
    factoryDir(environment),
    SETTINGS_LOCAL_FILE,
  );
}

/** The directory the run treats as the project root (the launch directory). */
export function projectRoot(environment: Environment): string {
  return environment.cwd;
}

/** `<project root>/.factory`: project-scoped configuration. */
export function projectDir(environment: Environment): string {
  return joinPath(
    environment.platform,
    projectRoot(environment),
    FACTORY_DIR_PRODUCTION,
  );
}

/** The project settings file: `<project root>/.factory/settings.json`. */
export function projectSettingsFile(environment: Environment): string {
  return joinPath(environment.platform, projectDir(environment), SETTINGS_FILE);
}

/** The project local override: `<project root>/.factory/settings.local.json`. */
export function projectLocalSettingsFile(environment: Environment): string {
  return joinPath(
    environment.platform,
    projectDir(environment),
    SETTINGS_LOCAL_FILE,
  );
}

/** `<base>/sessions` (`specs/40-sessions-and-storage.md` Terms). */
export function sessionsDir(environment: Environment): string {
  return joinPath(environment.platform, factoryDir(environment), "sessions");
}

/** `<base>/cache`. */
export function cacheDir(environment: Environment): string {
  return joinPath(environment.platform, factoryDir(environment), "cache");
}

/** `<base>/cache/session-index`. */
export function sessionIndexDir(environment: Environment): string {
  return joinPath(environment.platform, cacheDir(environment), "session-index");
}

/** `<base>/cache/session-index/index.db`. */
export function sessionIndexDatabase(environment: Environment): string {
  return joinPath(
    environment.platform,
    sessionIndexDir(environment),
    "index.db",
  );
}

/** `<base>/logs`. */
export function logsDir(environment: Environment): string {
  return joinPath(environment.platform, factoryDir(environment), "logs");
}

/** `<base>/temp`: scratch space under the operational root. */
export function tempDir(environment: Environment): string {
  return joinPath(environment.platform, factoryDir(environment), "temp");
}

/** A path inside `<base>/temp`. */
export function tempPath(
  environment: Environment,
  ...segments: readonly string[]
): string {
  return joinPath(environment.platform, tempDir(environment), ...segments);
}

/**
 * The root Factory-managed worktrees live under: the absolute
 * `general.worktreeDirectory` setting, else `<base>/worktrees`. A relative
 * setting cannot name one root, so it is ignored in favour of the default
 * (`specs/10-cli-surface.md` B81).
 */
export function worktreesRoot(
  environment: Environment,
  worktreeDirectory?: string,
): string {
  const fallback = joinPath(
    environment.platform,
    factoryDir(environment),
    "worktrees",
  );
  if (worktreeDirectory === undefined) return fallback;
  const expanded = expandTilde(environment, worktreeDirectory);
  if (!isAbsolutePath(environment.platform, expanded)) return fallback;
  return pathFor(environment.platform).resolve(environment.cwd, expanded);
}
