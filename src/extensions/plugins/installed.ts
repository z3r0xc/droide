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
  readonly factoryDir: string;
  readonly projectDir: string;
  readonly enabledPlugins?: Readonly<Record<string, boolean>>;
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
  enabledPlugins: Readonly<Record<string, boolean>> | undefined,
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
      enabled: enabledPlugins?.[id] !== false,
    });
  }
  return records;
}

/** Read both scopes. Project entries shadow user entries with the same id. */
export function loadInstalledPlugins(
  options: LoadInstalledPluginsOptions,
): InstalledPluginsResult {
  const diagnostics: PluginDiagnostic[] = [];
  const user = readOneScope(
    options.factoryDir,
    "user",
    options.enabledPlugins,
    diagnostics,
  );
  const project = readOneScope(
    options.projectDir,
    "project",
    options.enabledPlugins,
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
