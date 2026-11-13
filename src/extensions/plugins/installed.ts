/**
 * Installed-plugin registry.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B57–B60. Each scope keeps
 * `<scopeRoot>/plugins/installed_plugins.json` with
 * `{schemaVersion, plugins: {id: entry[]}}`; an id may have several entries (an
 * older version kept around), so a listing has to pick one deterministically —
 * the highest semver, falling back to the last written.
 *
 * The file is untrusted input: a malformed document becomes a diagnostic, never
 * an exception, and a single bad entry never hides the rest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../guards.ts";
import {
  isSourceAllowed,
  parsePluginSource,
  pluginSourceHash,
  type PluginSource,
} from "./sources.ts";

export type PluginScope = "user" | "project";

export interface InstalledPluginRecord {
  readonly id: string;
  readonly scope: PluginScope;
  readonly installPath: string;
  readonly version?: string;
  readonly installedAt?: string;
  readonly lastUpdated?: string;
  /** Resolved from `settings.general.enabledPlugins`; absent means enabled. */
  readonly enabled: boolean;
}

export interface PluginDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface InstalledPluginsResult {
  readonly plugins: readonly InstalledPluginRecord[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface LoadInstalledPluginsOptions {
  readonly stateDir: string;
  readonly projectDir: string;
  /** The merged enablement map: the highest settings level wins per key. */
  readonly enabledPlugins?: Readonly<Record<string, boolean>>;
  /**
   * `strictEnabledPlugins` (B36). When set, enablement is resolved against the
   * unmerged level maps ({@link enabledPluginsByLevel}), so a lower level can
   * never re-enable a plugin a higher level disabled.
   */
  readonly strictEnabledPlugins?: boolean;
  /**
   * `enabledPlugins` as each settings level states it, highest priority first
   * (org, runtime, project, user). Read only when `strictEnabledPlugins` is
   * true; without it the merged map is the best information available.
   */
  readonly enabledPluginsByLevel?: readonly Readonly<Record<string, boolean>>[];
  /** `strictKnownMarketplaces` (B36): what an external source must satisfy. */
  readonly allowedSources?: readonly PluginSource[];
}

/**
 * Whether one plugin is enabled (B36). An absent entry means enabled. Under
 * `strictEnabledPlugins` the first level that names the plugin answers and
 * later levels are not consulted; otherwise the merged map answers.
 */
export function resolvePluginEnablement(
  id: string,
  options: Pick<
    LoadInstalledPluginsOptions,
    "enabledPlugins" | "strictEnabledPlugins" | "enabledPluginsByLevel"
  >,
): boolean {
  if (options.strictEnabledPlugins === true) {
    for (const level of options.enabledPluginsByLevel ?? []) {
      if (Object.hasOwn(level, id)) return level[id] !== false;
    }
  }
  const merged = options.enabledPlugins;
  if (merged !== undefined && Object.hasOwn(merged, id))
    return merged[id] !== false;
  return true;
}

/**
 * The marketplace sources registered at one scope, used to re-authorize an
 * installed entry's recorded provenance (B35). A document this code cannot
 * read yields nothing: without a source there is no hash to compare, so a
 * hash-bearing entry is refused rather than trusted.
 */
function readRegisteredSources(
  root: string,
): ReadonlyMap<string, PluginSource> {
  let document: string;
  try {
    document = readFileSync(
      join(root, "plugins", "known_marketplaces.json"),
      "utf8",
    );
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return new Map();
  }
  const result = new Map<string, PluginSource>();
  if (!isRecord(parsed)) return result;
  for (const [name, entry] of Object.entries(parsed)) {
    if (!isRecord(entry) || !isRecord(entry["source"])) continue;
    try {
      result.set(name, parsePluginSource(entry["source"]));
    } catch {
      // An entry this code cannot name cannot authorize anything.
    }
  }
  return result;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Compare two semver-ish strings; unparsable versions sort below parsed ones. */
export function compareVersions(
  left: string | undefined,
  right: string | undefined,
): number {
  const parse = (value: string | undefined): number[] | null => {
    if (value === undefined) return null;
    const parts = value.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
    if (parts.length === 0 || parts.some((part) => Number.isNaN(part)))
      return null;
    return parts;
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readOneScope(
  root: string,
  scope: PluginScope,
  options: LoadInstalledPluginsOptions,
  diagnostics: PluginDiagnostic[],
): InstalledPluginRecord[] {
  const path = join(root, "plugins", "installed_plugins.json");
  let document: string;
  try {
    document = readFileSync(path, "utf8");
  } catch {
    // No registry for this scope is the normal case, not a problem.
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    diagnostics.push({
      path,
      message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed["plugins"])) {
    diagnostics.push({
      path,
      message: 'expected an object with a "plugins" map',
    });
    return [];
  }

  const records: InstalledPluginRecord[] = [];
  const registered = readRegisteredSources(root);
  for (const [id, rawEntries] of Object.entries(parsed["plugins"])) {
    if (!Array.isArray(rawEntries)) {
      diagnostics.push({
        path,
        message: `plugin "${id}" is not a list of entries`,
      });
      continue;
    }
    const entries = rawEntries.filter(isRecord);
    const withPath = entries.filter(
      (entry) => typeof entry["installPath"] === "string",
    );
    if (withPath.length === 0) {
      diagnostics.push({
        path,
        message: `plugin "${id}" has no entry with an installPath`,
      });
      continue;
    }
    const best = withPath.reduce((chosen, candidate) =>
      compareVersions(
        readString(candidate, "version"),
        readString(chosen, "version"),
      ) >= 0
        ? candidate
        : chosen,
    );
    const recordedHash = readString(best, "marketplaceSourceHash");
    if (recordedHash !== undefined) {
      const marketplaceName = readString(best, "source");
      const registeredSource =
        marketplaceName === undefined
          ? undefined
          : registered.get(marketplaceName);
      if (
        registeredSource === undefined ||
        pluginSourceHash(registeredSource) !== recordedHash
      ) {
        diagnostics.push({
          path,
          message: `plugin "${id}" was installed from a marketplace source that no longer matches; refusing to load it`,
        });
        continue;
      }
    }
    if (best["externalSource"] !== undefined) {
      let externalSource: PluginSource | undefined;
      try {
        externalSource = parsePluginSource(best["externalSource"]);
      } catch {
        externalSource = undefined;
      }
      if (externalSource === undefined) {
        if (options.allowedSources !== undefined) {
          diagnostics.push({
            path,
            message: `plugin "${id}" has an unreadable external source; refusing to load it`,
          });
          continue;
        }
      } else if (!isSourceAllowed(options.allowedSources, externalSource)) {
        diagnostics.push({
          path,
          message: `plugin "${id}" comes from an external source the policy does not allow; refusing to load it`,
        });
        continue;
      }
    }
    const installPath = readString(best, "installPath");
    if (installPath === undefined) continue;
    const version = readString(best, "version");
    const installedAt = readString(best, "installedAt");
    const lastUpdated = readString(best, "lastUpdated");
    records.push({
      id,
      scope,
      installPath,
      ...(version === undefined ? {} : { version }),
      ...(installedAt === undefined ? {} : { installedAt }),
      ...(lastUpdated === undefined ? {} : { lastUpdated }),
      enabled: resolvePluginEnablement(id, options),
    });
  }
  return records;
}

/** Read both scopes. Project entries shadow user entries with the same id. */
export function loadInstalledPlugins(
  options: LoadInstalledPluginsOptions,
): InstalledPluginsResult {
  const diagnostics: PluginDiagnostic[] = [];
  const user = readOneScope(options.stateDir, "user", options, diagnostics);
  const project = readOneScope(
    options.projectDir,
    "project",
    options,
    diagnostics,
  );

  const byId = new Map<string, InstalledPluginRecord>();
  for (const record of user) byId.set(record.id, record);
  for (const record of project) byId.set(record.id, record);

  return {
    plugins: [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    diagnostics,
  };
}

export interface RenderPluginListOptions {
  readonly scope?: PluginScope;
}

/** Render the listing. Wording is ours; the data is strictly what the registry holds. */
export function renderPluginList(
  result: InstalledPluginsResult,
  options: RenderPluginListOptions = {},
): string {
  const plugins =
    options.scope === undefined
      ? result.plugins
      : result.plugins.filter((plugin) => plugin.scope === options.scope);
  const enabled = plugins.filter((plugin) => plugin.enabled).length;

  const lines = [
    `${plugins.length} plugin${plugins.length === 1 ? "" : "s"} installed, ${enabled} enabled`,
  ];
  if (plugins.length > 0) {
    const idWidth = Math.max(...plugins.map((plugin) => plugin.id.length));
    const versionWidth = Math.max(
      ...plugins.map((plugin) => (plugin.version ?? "-").length),
    );
    for (const plugin of plugins) {
      lines.push(
        `  ${plugin.id.padEnd(idWidth)}  ${(plugin.version ?? "-").padEnd(versionWidth)}  ${plugin.scope.padEnd(7)}  ${plugin.enabled ? "enabled" : "disabled"}`,
      );
    }
  }
  if (result.diagnostics.length > 0) {
    lines.push("", "problems:");
    for (const diagnostic of result.diagnostics)
      lines.push(`  ${diagnostic.path}: ${diagnostic.message}`);
  }
  return `${lines.join("\n")}\n`;
}
