/**
 * `plugin` command bodies. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B31-B40: the on-disk layout, the marketplace CLI, the install/uninstall
 * lifecycle and the plugin enablement surface.
 *
 * Git, the clock and the filesystem surface are injected, so every command is
 * testable against a temporary repository and no case reaches the network.
 * `list` is read-only: it reads the two registries and the enablement map and
 * never touches a plugin's files.
 */
import { PROGRAM } from "./brand.ts";
import type { AppContext } from "../app/context.ts";
import {
  installPlugin,
  uninstallPlugin,
  updatePlugins,
  type PluginInstallDeps,
  type PluginScopes,
} from "../extensions/plugins/install.ts";
import {
  type InstalledPluginsResult,
  type PluginScope,
  loadInstalledPlugins,
  renderPluginList,
} from "../extensions/plugins/installed.ts";
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  renderMarketplaceList,
  updateMarketplaces,
  type GitRunner,
  type MarketplaceDeps,
  type PluginIo,
} from "../extensions/plugins/marketplace.ts";
import {
  resolvePluginPolicy,
  type PluginPolicy,
  type PluginSource,
  type SourceDeps,
} from "../extensions/plugins/sources.ts";

export interface PluginListOptions {
  readonly scope?: string;
}

export interface PluginListDeps {
  readonly context: AppContext;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

/** Everything a mutating `plugin` command may substitute in a test. */
export interface PluginCommandDeps extends PluginListDeps {
  readonly runGit?: GitRunner;
  readonly io?: PluginIo;
  readonly now?: () => Date;
}

const SCOPES: Readonly<Record<string, PluginScope>> = {
  user: "user",
  project: "project",
};

function invalidScope(deps: PluginListDeps, value: string): void {
  deps.writeError(
    `Invalid --scope value: ${value}. Expected user or project.\n`,
  );
  deps.setExitCode(1);
}

function report(deps: PluginListDeps, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : `Unexpected error: ${String(error)}`;
  deps.writeError(`${PROGRAM}: ${message}\n`);
  deps.setExitCode(1);
}

/** Enablement policy (B36); throws when a project names a token host. */
function pluginPolicy(deps: PluginListDeps): PluginPolicy {
  return resolvePluginPolicy(deps.context.settings, deps.context.layers);
}

function sourceDeps(deps: PluginListDeps): SourceDeps {
  return { env: deps.context.environment.env };
}

function marketplaceDeps(deps: PluginCommandDeps): MarketplaceDeps {
  return {
    scopeRoot: deps.context.paths.stateDir,
    ...(deps.io === undefined ? {} : { io: deps.io }),
    ...(deps.runGit === undefined ? {} : { runGit: deps.runGit }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    policy: pluginPolicy(deps),
    sourceDeps: sourceDeps(deps),
  };
}

function installDeps(deps: PluginCommandDeps): PluginInstallDeps {
  const scopes: PluginScopes = {
    user: deps.context.paths.stateDir,
    project: deps.context.paths.projectDir,
  };
  return {
    scopes,
    ...(deps.io === undefined ? {} : { io: deps.io }),
    ...(deps.runGit === undefined ? {} : { runGit: deps.runGit }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    policy: pluginPolicy(deps),
    sourceDeps: sourceDeps(deps),
    env: deps.context.environment.env,
  };
}

/** Resolve `--scope`; `undefined` means "both" or the command's default. */
function scopeOf(
  deps: PluginListDeps,
  value: string | undefined,
): PluginScope | undefined | null {
  if (value === undefined) return undefined;
  const scope = SCOPES[value];
  if (scope === undefined) {
    invalidScope(deps, value);
    return null;
  }
  return scope;
}

function versionSuffix(version: string): string {
  return version === "" ? "" : ` (${version.slice(0, 7)})`;
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

export interface MarketplaceAddOptions {
  readonly branch?: string;
}

export async function runMarketplaceAdd(
  url: string,
  options: MarketplaceAddOptions,
  deps: PluginCommandDeps,
): Promise<void> {
  try {
    const info = await addMarketplace(
      url,
      {
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        home: deps.context.environment.home,
        cwd: deps.context.environment.cwd,
      },
      marketplaceDeps(deps),
    );
    const count = info.pluginCount ?? 0;
    deps.write(
      `Added marketplace "${info.name}" (${count} plugin${count === 1 ? "" : "s"}).\n`,
    );
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

export async function runMarketplaceRemove(
  name: string,
  deps: PluginCommandDeps,
): Promise<void> {
  try {
    await removeMarketplace(name, marketplaceDeps(deps));
    deps.write(`Removed marketplace "${name}".\n`);
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

export function runMarketplaceList(deps: PluginCommandDeps): void {
  try {
    const result = listMarketplaces(marketplaceDeps(deps));
    deps.write(renderMarketplaceList(result));
    deps.setExitCode(result.diagnostics.length > 0 ? 1 : 0);
  } catch (error) {
    report(deps, error);
  }
}

export async function runMarketplaceUpdate(
  name: string | undefined,
  deps: PluginCommandDeps,
): Promise<void> {
  try {
    const outcomes = await updateMarketplaces(name, marketplaceDeps(deps));
    if (outcomes.length === 0) {
      deps.write(
        name === undefined
          ? "No marketplaces registered.\n"
          : `Marketplace "${name}" is not registered.\n`,
      );
      deps.setExitCode(0);
      return;
    }
    let failed = false;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        deps.write(`Updated marketplace "${outcome.name}".\n`);
        continue;
      }
      failed = true;
      deps.writeError(`${PROGRAM}: ${outcome.error ?? "update failed"}\n`);
    }
    deps.setExitCode(failed ? 1 : 0);
  } catch (error) {
    report(deps, error);
  }
}

// ---------------------------------------------------------------------------
// Install lifecycle
// ---------------------------------------------------------------------------

export interface PluginScopeOptions {
  readonly scope?: string;
}

export async function runPluginInstall(
  pluginSpec: string,
  options: PluginScopeOptions,
  deps: PluginCommandDeps,
): Promise<void> {
  const scope = scopeOf(deps, options.scope);
  if (scope === null) return;
  try {
    const entry = await installPlugin(
      pluginSpec,
      scope === undefined ? {} : { scope },
      installDeps(deps),
    );
    deps.write(`Installed ${entry.id}${versionSuffix(entry.version)}.\n`);
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

export async function runPluginUninstall(
  pluginSpec: string,
  options: PluginScopeOptions,
  deps: PluginCommandDeps,
): Promise<void> {
  const scope = scopeOf(deps, options.scope);
  if (scope === null) return;
  try {
    const result = await uninstallPlugin(
      pluginSpec,
      scope === undefined ? {} : { scope },
      installDeps(deps),
    );
    deps.write(`Uninstalled ${result.id}.\n`);
    deps.setExitCode(0);
  } catch (error) {
    report(deps, error);
  }
}

export async function runPluginUpdate(
  pluginSpec: string | undefined,
  options: PluginScopeOptions,
  deps: PluginCommandDeps,
): Promise<void> {
  const scope = scopeOf(deps, options.scope);
  if (scope === null) return;
  try {
    const report = await updatePlugins(
      pluginSpec,
      scope === undefined ? {} : { scope },
      installDeps(deps),
    );
    if (report.missing.length > 0) {
      deps.write(
        `Plugin "${report.missing[0] ?? ""}" is not installed, so there is nothing to update.\n`,
      );
      deps.setExitCode(0);
      return;
    }
    if (report.outcomes.length === 0) {
      deps.write("No plugins installed, so there is nothing to update.\n");
      deps.setExitCode(0);
      return;
    }
    let failed = false;
    for (const outcome of report.outcomes) {
      if (outcome.error !== undefined) {
        failed = true;
        deps.writeError(`${PROGRAM}: ${outcome.error}\n`);
        continue;
      }
      deps.write(
        outcome.changed
          ? `Updated ${outcome.id}${versionSuffix(outcome.version)}.\n`
          : `${outcome.id} is already up to date${versionSuffix(outcome.version)}.\n`,
      );
    }
    deps.setExitCode(failed ? 1 : 0);
  } catch (error) {
    report(deps, error);
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function runPluginList(
  options: PluginListOptions,
  deps: PluginListDeps,
): Promise<void> {
  const scope = scopeOf(deps, options.scope);
  if (scope === null) return;

  let allowedSources: readonly PluginSource[] | undefined;
  try {
    allowedSources = pluginPolicy(deps).allowedSources;
  } catch (error) {
    report(deps, error);
    return;
  }
  // B36: with `strictEnabledPlugins` the level maps are what decides, so the
  // list must see them unmerged; a lower level cannot re-enable a plugin a
  // higher level disabled.
  const levelMaps = deps.context.layers
    .map((layer) => layer.settings.enabledPlugins)
    .filter(
      (map): map is Readonly<Record<string, boolean>> => map !== undefined,
    );
  const settings = deps.context.settings;
  const result: InstalledPluginsResult = loadInstalledPlugins({
    stateDir: deps.context.paths.stateDir,
    projectDir: deps.context.paths.projectDir,
    ...(settings.enabledPlugins === undefined
      ? {}
      : { enabledPlugins: settings.enabledPlugins }),
    ...(settings.strictEnabledPlugins === undefined
      ? {}
      : { strictEnabledPlugins: settings.strictEnabledPlugins }),
    ...(levelMaps.length === 0 ? {} : { enabledPluginsByLevel: levelMaps }),
    ...(allowedSources === undefined ? {} : { allowedSources }),
  });

  deps.write(renderPluginList(result, scope === undefined ? {} : { scope }));
  deps.setExitCode(result.diagnostics.length > 0 ? 1 : 0);
}
