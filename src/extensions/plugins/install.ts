/**
 * Plugin installation. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B37 (install flow), B38 (uninstall flow) and B39 (update flow), over the
 * layout in B31.
 *
 * Each scope keeps `<scopeRoot>/plugins/installed_plugins.json` as
 * `{schemaVersion, plugins: {id: entry[]}}`. A plugin is copied from its
 * marketplace checkout into `<scopeRoot>/plugins/<id>/<version>/`; the version
 * is the checkout's commit, so a marketplace at a new commit yields a new
 * directory and an older copy stays addressable until the entry is updated.
 *
 * Writes preserve every other id byte-for-byte: the document is parsed, only
 * `plugins[id]` is replaced, and the result goes through a temp file plus a
 * rename. A document that cannot be understood is refused rather than
 * rewritten.
 */
import { randomUUID } from "node:crypto";
import { cp } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";

import { isRecord } from "../guards.ts";
import { parseJsonc } from "../jsonc.ts";
import { compareVersions, type PluginScope } from "./installed.ts";
import {
  PluginError,
  pluginIdMessage,
  parsePluginId,
  type PluginId,
} from "./manifest.ts";
import {
  adoptDirectory,
  DEFAULT_GIT_TIMEOUT_MS,
  defaultGitRunner,
  defaultPluginIo,
  hashMarketplaceSource,
  loadMarketplaceManifest,
  PluginOperationError,
  pluginsDirectory,
  readKnownMarketplaces,
  writeTextAtomic,
  type GitRunner,
  type MarketplaceEntry,
  type PluginIo,
} from "./marketplace.ts";

/** Registry file inside `plugins/` (B31). */
export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";
const SCHEMA_VERSION = 1;

/** Where each scope keeps its plugin state (B31). */
export interface PluginScopes {
  readonly user: string;
  readonly project: string;
}

export interface PluginInstallDeps {
  readonly scopes: PluginScopes;
  readonly io?: PluginIo;
  readonly runGit?: GitRunner;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export interface InstalledPluginEntry {
  /** The registry key; not written into the entry itself. */
  readonly id: string;
  readonly scope: PluginScope;
  readonly installPath: string;
  readonly version: string;
  readonly installedAt: string;
  readonly lastUpdated: string;
  /** The marketplace name the plugin came from, as the registry records it. */
  readonly source: string;
  /** SHA-256 of the marketplace source at install time (B35). */
  readonly marketplaceSourceHash?: string;
}

export interface PluginInstallOptions {
  readonly scope?: PluginScope;
}

export function installedPluginsPath(scopeRoot: string): string {
  return join(pluginsDirectory(scopeRoot), INSTALLED_PLUGINS_FILE);
}

// ---------------------------------------------------------------------------
// Registry document
// ---------------------------------------------------------------------------

interface InstalledRegistryView {
  readonly path: string;
  /** The whole document, kept so unknown keys survive a write. */
  readonly document: Record<string, unknown>;
  /** `document.plugins`, the only part a mutation replaces. */
  readonly plugins: Record<string, unknown>;
}

/**
 * Read the installed registry. A missing file is an empty registry; a document
 * whose `plugins` is not a map is refused so a write cannot clobber it.
 */
function readInstalledRegistry(
  scopeRoot: string,
  io: PluginIo,
): InstalledRegistryView {
  const path = installedPluginsPath(scopeRoot);
  const text = io.readFile(path);
  if (text === undefined) {
    return { path, document: { schemaVersion: SCHEMA_VERSION }, plugins: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PluginOperationError(
      "registry-invalid",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new PluginOperationError(
      "registry-invalid",
      `${path} must contain an object with a "plugins" map.`,
    );
  }
  const plugins = parsed["plugins"];
  if (plugins === undefined) return { path, document: parsed, plugins: {} };
  if (!isRecord(plugins)) {
    throw new PluginOperationError(
      "registry-invalid",
      `${path} must contain an object with a "plugins" map.`,
    );
  }
  return { path, document: parsed, plugins };
}

function writeInstalledRegistry(
  view: InstalledRegistryView,
  plugins: Record<string, unknown>,
  io: PluginIo,
): void {
  const schemaVersion = view.document["schemaVersion"];
  const document = {
    ...view.document,
    schemaVersion:
      typeof schemaVersion === "number" ? schemaVersion : SCHEMA_VERSION,
    plugins,
  };
  writeTextAtomic(view.path, `${JSON.stringify(document, null, 2)}\n`, io);
}

function serialiseEntry(entry: InstalledPluginEntry): Record<string, unknown> {
  return {
    scope: entry.scope,
    installPath: entry.installPath,
    version: entry.version,
    installedAt: entry.installedAt,
    lastUpdated: entry.lastUpdated,
    source: entry.source,
    ...(entry.marketplaceSourceHash === undefined
      ? {}
      : { marketplaceSourceHash: entry.marketplaceSourceHash }),
  };
}

interface CurrentEntry {
  readonly raw: Record<string, unknown>;
  readonly installPath: string;
  readonly version: string;
}

/** The highest-version entry for this scope, or `undefined` when malformed. */
function pickCurrentEntry(
  entries: readonly unknown[],
  scope: PluginScope,
): CurrentEntry | undefined {
  let best: CurrentEntry | undefined;
  for (const value of entries) {
    if (!isRecord(value)) continue;
    const entryScope = value["scope"];
    if (entryScope !== undefined && entryScope !== scope) continue;
    const installPath = value["installPath"];
    const version = value["version"];
    if (typeof installPath !== "string" || typeof version !== "string")
      continue;
    if (best === undefined || compareVersions(version, best.version) >= 0) {
      best = { raw: value, installPath, version };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Identity and paths
// ---------------------------------------------------------------------------

interface ResolvedPluginId {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
}

function parsePluginSpec(raw: string): ResolvedPluginId {
  let parsed: PluginId;
  try {
    parsed = parsePluginId(raw);
  } catch (error) {
    if (error instanceof PluginError)
      throw new PluginOperationError("plugin-id-invalid", error.message, {
        cause: error,
      });
    throw error;
  }
  const unsafe = /[\\/\p{C}]/u;
  if (unsafe.test(parsed.name) || unsafe.test(parsed.marketplace)) {
    throw new PluginOperationError("plugin-id-invalid", pluginIdMessage(raw));
  }
  return {
    id: `${parsed.name}@${parsed.marketplace}`,
    name: parsed.name,
    marketplace: parsed.marketplace,
  };
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolvePath(root);
  const resolvedCandidate = resolvePath(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

/**
 * A plugin source path is relative to its marketplace and may not climb out of
 * it: the marketplace is untrusted input.
 */
function containedSourceDirectory(
  marketplaceRoot: string,
  relative: string,
  pluginId: string,
): string {
  if (relative === "" || isAbsolute(relative)) {
    throw new PluginOperationError(
      "source-invalid",
      `Plugin "${pluginId}" has a source that is not a relative path.`,
    );
  }
  const target = resolvePath(marketplaceRoot, relative);
  const root = resolvePath(marketplaceRoot);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new PluginOperationError(
      "source-invalid",
      `Plugin "${pluginId}" has a source outside its marketplace.`,
    );
  }
  return target;
}

/**
 * The version of a plugin at this moment: the marketplace checkout's commit,
 * shortened to twelve characters so it names a directory. A marketplace that
 * is not a git repository falls back to the recorded commit, then to `local`.
 */
async function resolveVersion(
  marketplace: MarketplaceEntry,
  deps: PluginInstallDeps,
): Promise<string> {
  const result = await (deps.runGit ?? defaultGitRunner)(
    ["rev-parse", "HEAD"],
    {
      cwd: marketplace.installLocation,
      timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    },
  );
  if (result.code === 0) {
    const commit = result.stdout.trim();
    if (/^[0-9a-f]{7,64}$/iu.test(commit)) return commit.slice(0, 12);
  }
  if (marketplace.commit !== undefined) return marketplace.commit.slice(0, 12);
  return "local";
}

async function copyIntoPlace(
  sourceDirectory: string,
  installPath: string,
  io: PluginIo,
): Promise<void> {
  const staging = `${installPath}.staging-${randomUUID().replace(/-/g, "")}`;
  io.makeDirectory(dirname(installPath));
  try {
    // TODO(spec B42): the Claude Code layout translation (.claude-plugin to
    // .factory-plugin, agents to droids, .mcp.json to mcp.json) is not
    // applied, so the plugin directory is copied verbatim.
    await cp(sourceDirectory, staging, { recursive: true });
    adoptDirectory(staging, installPath, io);
  } catch (error) {
    try {
      io.remove(staging);
    } catch {
      // A leftover staging directory is inert.
    }
    throw error instanceof PluginOperationError
      ? error
      : new PluginOperationError(
          "write-failed",
          `Plugin files could not be copied to ${installPath}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * `plugin install <plugin@marketplace> [-s user|project]` (B37). The plugin is
 * resolved in the marketplace registered for that scope, copied into the
 * install cache, and its entry is merged into the registry. An id installed in
 * the other scope is refused, because one plugin slot must have one owner.
 */
export async function installPlugin(
  rawSpec: string,
  options: PluginInstallOptions,
  deps: PluginInstallDeps,
): Promise<InstalledPluginEntry> {
  const io = deps.io ?? defaultPluginIo;
  const resolved = parsePluginSpec(rawSpec);
  const scope: PluginScope = options.scope ?? "user";
  const roots = deps.scopes;
  const root = roots[scope];
  const otherScope: PluginScope = scope === "user" ? "project" : "user";

  if (
    Object.hasOwn(
      readInstalledRegistry(roots[otherScope], io).plugins,
      resolved.id,
    )
  ) {
    throw new PluginOperationError(
      "plugin-exists",
      `Plugin "${resolved.id}" is already installed at ${otherScope} scope. Uninstall it there before installing it at ${scope} scope.`,
    );
  }

  // TODO(spec B37): the recorded-source drift refusal and the organization
  // policy denial are not applied: this build resolves neither configured
  // marketplace sources nor org policy into the context.
  const marketplaces = readKnownMarketplaces(root, io);
  const marketplace = marketplaces.entries.get(resolved.marketplace);
  if (marketplace === undefined) {
    throw new PluginOperationError(
      "marketplace-not-found",
      `Marketplace "${resolved.marketplace}" is not registered at ${scope} scope.`,
    );
  }
  const manifest = loadMarketplaceManifest(marketplace.installLocation, io);
  const plugin = manifest.plugins.find(
    (candidate) => candidate.name === resolved.name,
  );
  if (plugin === undefined) {
    throw new PluginOperationError(
      "plugin-not-found",
      `Plugin "${resolved.name}" was not found in marketplace "${resolved.marketplace}".`,
    );
  }
  if (plugin.source.kind === "external") {
    // TODO(spec B34): plugin sources fetched outside the marketplace (github,
    // url, git-subdir, npm, archive) are not downloaded by this build.
    throw new PluginOperationError(
      "source-unsupported",
      `Plugin "${resolved.id}" comes from a "${plugin.source.type}" source, which this build does not install.`,
    );
  }
  const sourceDirectory = containedSourceDirectory(
    marketplace.installLocation,
    plugin.source.path,
    resolved.id,
  );
  if (!io.exists(sourceDirectory)) {
    throw new PluginOperationError(
      "source-missing",
      `Plugin "${resolved.id}" has no directory at ${sourceDirectory}.`,
    );
  }

  const version = await resolveVersion(marketplace, deps);
  const installPath = join(pluginsDirectory(root), resolved.id, version);
  await copyIntoPlace(sourceDirectory, installPath, io);

  const timestamp = (deps.now ?? (() => new Date()))().toISOString();
  const entry: InstalledPluginEntry = {
    id: resolved.id,
    scope,
    installPath,
    version,
    installedAt: timestamp,
    lastUpdated: timestamp,
    source: resolved.marketplace,
    marketplaceSourceHash: hashMarketplaceSource(marketplace.source),
  };

  const registry = readInstalledRegistry(root, io);
  const existing = registry.plugins[resolved.id];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new PluginOperationError(
      "registry-invalid",
      `${registry.path} stores "${resolved.id}" as something other than a list of entries.`,
    );
  }
  const kept: unknown[] = [];
  const replacedPaths: string[] = [];
  for (const value of existing ?? []) {
    if (isRecord(value) && value["scope"] === scope) {
      const previousPath = value["installPath"];
      if (typeof previousPath === "string") replacedPaths.push(previousPath);
      continue;
    }
    kept.push(value);
  }
  writeInstalledRegistry(
    registry,
    { ...registry.plugins, [resolved.id]: [...kept, serialiseEntry(entry)] },
    io,
  );
  for (const previousPath of replacedPaths) {
    if (
      previousPath !== installPath &&
      isInside(pluginsDirectory(root), previousPath)
    ) {
      io.remove(previousPath);
    }
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export interface PluginUninstallOptions {
  readonly scope?: PluginScope;
}

export interface PluginUninstallResult {
  readonly id: string;
  readonly scope: PluginScope;
  readonly installPaths: readonly string[];
}

function referencesPluginId(document: unknown, id: string): boolean {
  if (!isRecord(document)) return false;
  if (
    isRecord(document["enabledPlugins"]) &&
    Object.hasOwn(document["enabledPlugins"], id)
  )
    return true;
  const general = document["general"];
  return (
    isRecord(general) &&
    isRecord(general["enabledPlugins"]) &&
    Object.hasOwn(general["enabledPlugins"], id)
  );
}

/**
 * The first settings file that still names this plugin (B36 enablement). A
 * settings file that cannot be parsed makes the check impossible, so the
 * uninstall is refused rather than deleting configuration out from under it.
 */
function findReference(
  id: string,
  roots: Readonly<Record<PluginScope, string>>,
  io: PluginIo,
): string | undefined {
  for (const root of [roots.user, roots.project]) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const path = join(root, name);
      const text = io.readFile(path);
      if (text === undefined) continue;
      let parsed: unknown;
      try {
        parsed = parseJsonc(text);
      } catch (error) {
        throw new PluginOperationError(
          "settings-invalid",
          `${path} could not be read, so the plugin reference cannot be checked: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (referencesPluginId(parsed, id)) return path;
    }
  }
  return undefined;
}

function installedEntryPaths(entries: readonly unknown[]): readonly string[] {
  const paths = new Set<string>();
  for (const value of entries) {
    if (!isRecord(value)) continue;
    const installPath = value["installPath"];
    if (typeof installPath === "string") paths.add(installPath);
  }
  return [...paths];
}

/**
 * `plugin uninstall <plugin@marketplace> [-s scope]` (B38). Without a scope
 * the user registry is checked first, then the project one. A settings file
 * that still references the plugin is refused rather than edited: removing
 * someone's enablement entry behind their back is worse than asking them to
 * drop the reference.
 */
export async function uninstallPlugin(
  rawSpec: string,
  options: PluginUninstallOptions,
  deps: PluginInstallDeps,
): Promise<PluginUninstallResult> {
  const io = deps.io ?? defaultPluginIo;
  const resolved = parsePluginSpec(rawSpec);
  const roots = deps.scopes;
  const notInstalled = () =>
    new PluginOperationError(
      "plugin-not-installed",
      `Plugin "${resolved.id}" is not installed.`,
    );

  let scope: PluginScope;
  if (options.scope !== undefined) {
    scope = options.scope;
    const entries = readInstalledRegistry(roots[scope], io).plugins[
      resolved.id
    ];
    if (!Array.isArray(entries) || entries.length === 0) throw notInstalled();
  } else if (
    Array.isArray(readInstalledRegistry(roots.user, io).plugins[resolved.id])
  ) {
    scope = "user";
  } else if (
    Array.isArray(readInstalledRegistry(roots.project, io).plugins[resolved.id])
  ) {
    scope = "project";
  } else {
    throw notInstalled();
  }

  const root = roots[scope];
  const registry = readInstalledRegistry(root, io);
  const entries = registry.plugins[resolved.id];
  if (!Array.isArray(entries) || entries.length === 0) throw notInstalled();

  const referencedBy = findReference(resolved.id, roots, io);
  if (referencedBy !== undefined) {
    throw new PluginOperationError(
      "plugin-referenced",
      `Plugin "${resolved.id}" is referenced by ${referencedBy}. Remove that reference before uninstalling it.`,
    );
  }

  const installPaths = installedEntryPaths(entries);
  const plugins = { ...registry.plugins };
  delete plugins[resolved.id];
  writeInstalledRegistry(registry, plugins, io);
  for (const installPath of installPaths) {
    if (isInside(pluginsDirectory(root), installPath)) io.remove(installPath);
  }
  return { id: resolved.id, scope, installPaths };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface PluginUpdateOptions {
  readonly scope?: PluginScope;
}

export interface PluginUpdateOutcome {
  readonly id: string;
  readonly scope: PluginScope;
  readonly version: string;
  readonly changed: boolean;
  readonly error?: string;
}

export interface PluginUpdateReport {
  readonly outcomes: readonly PluginUpdateOutcome[];
  /** A named plugin that no scanned scope holds (B39's "nothing to update"). */
  readonly missing: readonly string[];
}

async function updateOne(
  resolved: ResolvedPluginId,
  scope: PluginScope,
  deps: PluginInstallDeps,
  io: PluginIo,
): Promise<PluginUpdateOutcome> {
  const root = deps.scopes[scope];
  try {
    const registry = readInstalledRegistry(root, io);
    const entries = registry.plugins[resolved.id];
    if (!Array.isArray(entries) || entries.length === 0) {
      return {
        id: resolved.id,
        scope,
        version: "",
        changed: false,
        error: `Plugin "${resolved.id}" is not installed at ${scope} scope.`,
      };
    }
    const current = pickCurrentEntry(entries, scope);
    if (current === undefined) {
      return {
        id: resolved.id,
        scope,
        version: "",
        changed: false,
        error: `Plugin "${resolved.id}" has no usable registry entry at ${scope} scope.`,
      };
    }

    const marketplaces = readKnownMarketplaces(root, io);
    const marketplace = marketplaces.entries.get(resolved.marketplace);
    if (marketplace === undefined) {
      throw new PluginOperationError(
        "marketplace-not-found",
        `Marketplace "${resolved.marketplace}" is not registered at ${scope} scope.`,
      );
    }
    const manifest = loadMarketplaceManifest(marketplace.installLocation, io);
    const plugin = manifest.plugins.find(
      (candidate) => candidate.name === resolved.name,
    );
    if (plugin === undefined) {
      throw new PluginOperationError(
        "plugin-not-found",
        `Plugin "${resolved.name}" is no longer in marketplace "${resolved.marketplace}".`,
      );
    }
    if (plugin.source.kind === "external") {
      throw new PluginOperationError(
        "source-unsupported",
        `Plugin "${resolved.id}" comes from a "${plugin.source.type}" source, which this build does not install.`,
      );
    }
    const sourceDirectory = containedSourceDirectory(
      marketplace.installLocation,
      plugin.source.path,
      resolved.id,
    );
    if (!io.exists(sourceDirectory)) {
      throw new PluginOperationError(
        "source-missing",
        `Plugin "${resolved.id}" has no directory at ${sourceDirectory}.`,
      );
    }

    const version = await resolveVersion(marketplace, deps);
    if (version === current.version) {
      return { id: resolved.id, scope, version, changed: false };
    }

    const installPath = join(pluginsDirectory(root), resolved.id, version);
    await copyIntoPlace(sourceDirectory, installPath, io);
    const timestamp = (deps.now ?? (() => new Date()))().toISOString();
    const updatedEntries = entries.map((value) =>
      value === current.raw
        ? { ...current.raw, installPath, version, lastUpdated: timestamp }
        : value,
    );
    writeInstalledRegistry(
      registry,
      { ...registry.plugins, [resolved.id]: updatedEntries },
      io,
    );
    if (
      current.installPath !== installPath &&
      isInside(pluginsDirectory(root), current.installPath)
    ) {
      io.remove(current.installPath);
    }
    return { id: resolved.id, scope, version, changed: true };
  } catch (error) {
    return {
      id: resolved.id,
      scope,
      version: "",
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `plugin update [plugin@marketplace] [-s scope]` (B39). Each installed plugin
 * is re-resolved from its marketplace and replaced only when the version
 * differs; one failure is reported without stopping the rest.
 */
export async function updatePlugins(
  rawSpec: string | undefined,
  options: PluginUpdateOptions,
  deps: PluginInstallDeps,
): Promise<PluginUpdateReport> {
  const io = deps.io ?? defaultPluginIo;
  const scopes: readonly PluginScope[] =
    options.scope === undefined ? ["user", "project"] : [options.scope];

  if (rawSpec !== undefined) {
    const resolved = parsePluginSpec(rawSpec);
    const outcomes: PluginUpdateOutcome[] = [];
    for (const scope of scopes) {
      if (
        !Array.isArray(
          readInstalledRegistry(deps.scopes[scope], io).plugins[resolved.id],
        )
      )
        continue;
      outcomes.push(await updateOne(resolved, scope, deps, io));
    }
    return { outcomes, missing: outcomes.length === 0 ? [resolved.id] : [] };
  }

  const outcomes: PluginUpdateOutcome[] = [];
  for (const scope of scopes) {
    const ids = Object.keys(
      readInstalledRegistry(deps.scopes[scope], io).plugins,
    ).sort();
    for (const id of ids) {
      let resolved: ResolvedPluginId;
      try {
        resolved = parsePluginSpec(id);
      } catch {
        // A registry key this build cannot name is left exactly as it is.
        continue;
      }
      if (resolved.id !== id) continue;
      outcomes.push(await updateOne(resolved, scope, deps, io));
    }
  }
  return { outcomes, missing: [] };
}
