/**
 * Typed failures of the configuration layer.
 *
 * Contract: `specs/10-cli-surface.md` B77-B79 (runtime overlay resolution and
 * the "overlay is dropped, not fatal" rule). Callers distinguish a *file that
 * cannot be read* (`UnreadableSettingsError`) from a *file that says something
 * invalid* (`InvalidSettingsError`): only the first is ever dropped silently.
 */

/** Base class so callers can catch any configuration failure as one kind. */
export class ConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfigError";
  }
}

/**
 * A settings file exists but cannot be used as a file: missing is reported by
 * `readSettingsFile` as `undefined`, so this always means "there is something
 * there that cannot be read" — a directory, a permission denial, an I/O fault.
 */
export class UnreadableSettingsError extends ConfigError {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string, cause?: unknown) {
    super(`Unreadable settings file ${path}: ${reason}`, cause);
    this.name = "UnreadableSettingsError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * A settings document parsed but violates the schema. `keyPath` is the dotted
 * path of the offending value (`general.worktreeDirectory`,
 * `mcp.context7.command`, `trustedFolders.0`); `""` means the document root.
 */
export class InvalidSettingsError extends ConfigError {
  readonly path: string;
  readonly keyPath: string;
  readonly detail: string;

  constructor(path: string, keyPath: string, detail: string, cause?: unknown) {
    super(
      keyPath === ""
        ? `Invalid settings in ${path}: ${detail}`
        : `Invalid setting "${keyPath}" in ${path}: ${detail}`,
      cause,
    );
    this.name = "InvalidSettingsError";
    this.path = path;
    this.keyPath = keyPath;
    this.detail = detail;
  }
}

/**
 * A key this build does not know. Rejecting it keeps a typo from being silently
 * ignored; the settings vocabulary is closed until a spec adds a key.
 */
export class UnknownSettingError extends ConfigError {
  readonly path: string;
  readonly keyPath: string;

  constructor(path: string, keyPath: string) {
    super(`Unknown setting "${keyPath}" in ${path}`);
    this.name = "UnknownSettingError";
    this.path = path;
    this.keyPath = keyPath;
  }
}

/**
 * `paths.ts` only models the three operating systems the CLI ships for. Any
 * other `process.platform` is refused rather than guessed at.
 */
export class UnsupportedPlatformError extends ConfigError {
  readonly platform: string;

  constructor(platform: string) {
    super(`Unsupported platform: ${platform}`);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
  }
}
