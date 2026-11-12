/**
 * Plugin marketplaces. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B31 (on-disk layout), B32 (marketplace manifest), B34 (source kinds) and
 * B40 (the `marketplace` CLI).
 *
 * A registered marketplace is one entry in
 * `<scopeRoot>/plugins/known_marketplaces.json`, keyed by the name derived from
 * its source, with the checkout at `<scopeRoot>/plugins/marketplaces/<name>/`
 * for git sources and the source directory itself for a local one. Git is an
 * injected runner so a test can point it at a temporary repository path and no
 * case ever reaches the network.
 *
 * The registry is untrusted input: an unreadable document is refused rather
 * than overwritten, and one invalid entry is dropped with a diagnostic instead
 * of hiding its neighbours. Every write is a temp file plus a rename in the
 * same directory, so a failure leaves the previous bytes in place.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";

import { isRecord } from "../guards.ts";
import { JsoncParseError, parseJsonc } from "../jsonc.ts";
import type { PluginDiagnostic } from "./installed.ts";

/** `plugins/` under a scope root (B31). */
export const PLUGINS_DIR = "plugins";
/** Registry file inside `plugins/` holding every registered marketplace. */
export const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";
/** Checkouts of git marketplaces, one directory per derived name. */
export const MARKETPLACES_DIR = "marketplaces";
/** Manifest locations, most specific first (B32). */
export const MARKETPLACE_MANIFEST_PATHS = [
  ".factory-plugin/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

/** Default wall-clock budget for one git invocation. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
/** The exit code this build reports when `git` is not on PATH. */
export const GIT_MISSING_EXIT = 127;
const GIT_TIMEOUT_EXIT = 124;

export type PluginOperationErrorCode =
  | "marketplace-invalid-source"
  | "marketplace-exists"
  | "marketplace-not-found"
  | "manifest-invalid"
  | "plugin-id-invalid"
  | "plugin-not-found"
  | "plugin-exists"
  | "plugin-not-installed"
  | "plugin-referenced"
  | "source-unsupported"
  | "source-invalid"
  | "source-missing"
  | "registry-invalid"
  | "settings-invalid"
  | "git-missing"
  | "git-failed"
  | "write-failed"
  | "read-failed";

export class PluginOperationError extends Error {
  readonly code: PluginOperationErrorCode;

  constructor(
    code: PluginOperationErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "PluginOperationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Filesystem surface
// ---------------------------------------------------------------------------

/**
 * Everything this module and the installer touch on disk, so a test can make
 * one operation fail (a throwing `rename`) and observe that the registry on
 * disk is untouched. `readFile` returns `undefined` for a missing file: a
 * missing registry is the normal case, not an error.
 */
export interface PluginIo {
  readonly readFile: (path: string) => string | undefined;
  readonly makeDirectory: (path: string) => void;
  readonly writeFile: (path: string, text: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  readonly exists: (path: string) => boolean;
}

function fileErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

export const defaultPluginIo: PluginIo = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      const code = fileErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR")
        return undefined;
      throw new PluginOperationError(
        "read-failed",
        `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  },
  makeDirectory(path) {
    mkdirSync(path, { recursive: true });
  },
  writeFile(path, text) {
    writeFileSync(path, text, "utf8");
  },
  rename(from, to) {
    renameSync(from, to);
  },
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
  exists(path) {
    return existsSync(path);
  },
};

/**
 * Write `text` atomically: a sibling temp file, then a rename. A rename that
 * fails leaves the original byte-for-byte intact; the temp file is cleaned up
 * best-effort.
 */
export function writeTextAtomic(
  path: string,
  text: string,
  io: PluginIo = defaultPluginIo,
): void {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${randomUUID().replace(/-/g, "")}.tmp`,
  );
  try {
    io.makeDirectory(directory);
    io.writeFile(temporary, text);
    io.rename(temporary, path);
  } catch (error) {
    try {
      io.remove(temporary);
    } catch {
      // Best-effort cleanup; the original is what matters.
    }
    throw new PluginOperationError(
      "write-failed",
      `${basename(path)} could not be written: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Publish `staging` at `target`, keeping whatever was there until the new
 * directory is in place. A failed publish restores the previous directory.
 */
export function adoptDirectory(
  staging: string,
  target: string,
  io: PluginIo = defaultPluginIo,
): void {
  if (!io.exists(target)) {
    io.rename(staging, target);
    return;
  }
  const backup = `${target}.previous-${randomUUID().replace(/-/g, "")}`;
  io.rename(target, backup);
  try {
    io.rename(staging, target);
  } catch (error) {
    try {
      io.rename(backup, target);
    } catch {
      // The backup stays on disk rather than being deleted.
    }
    throw error;
  }
  io.remove(backup);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A source this build can register (B34). */
export type MarketplaceSource =
  | { readonly source: "local"; readonly path: string }
  | {
      readonly source: "github";
      readonly repo: string;
      readonly ref?: string;
      readonly sha?: string;
    }
  | {
      readonly source: "url";
      readonly url: string;
      readonly ref?: string;
      readonly sha?: string;
    };

export interface ParseMarketplaceSourceOptions {
  /** Used to expand a leading `~`, from the injected environment. */
  readonly home?: string;
  /** Resolves a relative local path; the launch directory. */
  readonly cwd?: string;
  /** `--branch`; wins over a `#ref` in the source. */
  readonly branch?: string;
}

const GIT_URL_PATTERN = /^(?:https?|ssh|git|file):\/\//i;
const SCP_LIKE_PATTERN = /^[^@\s/]+@[^:\s]+:.+$/;

function expandHome(text: string, home: string | undefined): string {
  if (home === undefined) return text;
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\"))
    return join(home, text.slice(2));
  return text;
}

function looksLikeLocalPath(text: string): boolean {
  return (
    text === "~" ||
    text.startsWith("~/") ||
    text.startsWith("~\\") ||
    text.startsWith("./") ||
    text.startsWith(".\\") ||
    text.startsWith("../") ||
    text.startsWith("..\\") ||
    text.startsWith("/") ||
    text.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

function parseGithubSource(
  text: string,
): { readonly repo: string; readonly ref?: string } | undefined {
  const https =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?(?:#([^?#\s]*))?\/?$/i.exec(
      text,
    );
  if (https !== null) {
    const owner = https[1];
    const repository = https[2];
    if (owner === undefined || repository === undefined) return undefined;
    const ref = https[3];
    return {
      repo: `${owner}/${repository}`,
      ...(ref === undefined || ref === "" ? {} : { ref }),
    };
  }
  const scp =
    /^(?:[^@\s]+@)?github\.com:([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?(?:#([^?#\s]*))?$/i.exec(
      text,
    );
  if (scp !== null) {
    const owner = scp[1];
    const repository = scp[2];
    if (owner === undefined || repository === undefined) return undefined;
    const ref = scp[3];
    return {
      repo: `${owner}/${repository}`,
      ...(ref === undefined || ref === "" ? {} : { ref }),
    };
  }
  return undefined;
}

function splitUrlPin(text: string): {
  readonly url: string;
  readonly ref?: string;
} {
  const index = text.indexOf("#");
  if (index === -1) return { url: text };
  const url = text.slice(0, index);
  const ref = text.slice(index + 1);
  return { url, ...(ref === "" ? {} : { ref }) };
}

/**
 * Parse the `add` argument (B40): a git URL (any transport git understands) or
 * a local directory, with a leading `~` expanded. `--branch` overrides the
 * `#ref` fragment. Anything else is refused before a clone is attempted.
 */
export function parseMarketplaceSource(
  raw: string,
  options: ParseMarketplaceSourceOptions = {},
): MarketplaceSource {
  const text = raw.trim();
  if (text === "") {
    throw new PluginOperationError(
      "marketplace-invalid-source",
      "A marketplace repository URL or local path is required.",
    );
  }
  const expanded = expandHome(text, options.home);
  if (looksLikeLocalPath(expanded)) {
    const path =
      isAbsolute(expanded) || options.cwd === undefined
        ? expanded
        : resolvePath(options.cwd, expanded);
    return { source: "local", path };
  }

  const pin = (ref: string | undefined): { ref?: string } => {
    const chosen = options.branch ?? ref;
    return chosen === undefined || chosen === "" ? {} : { ref: chosen };
  };

  const github = parseGithubSource(expanded);
  if (github !== undefined) {
    return {
      source: "github",
      repo: github.repo,
      ...pin(github.ref),
    };
  }
  if (GIT_URL_PATTERN.test(expanded) || SCP_LIKE_PATTERN.test(expanded)) {
    const { url, ref } = splitUrlPin(expanded);
    return { source: "url", url, ...pin(ref) };
  }
  throw new PluginOperationError(
    "marketplace-invalid-source",
    `"${raw}" is not a git URL or a local directory.`,
  );
}

/** The clone URL for a git source; local sources are registered in place. */
export function gitUrlForSource(source: MarketplaceSource): string {
  if (source.source === "github")
    return `https://github.com/${source.repo}.git`;
  if (source.source === "url") return source.url;
  return source.path;
}

function nameFromUrl(raw: string): string {
  const withoutPin = raw.replace(/[?#][\s\S]*$/, "");
  let repositoryPath = withoutPin;
  let fallback = "unknown-marketplace";
  const scpPath = withoutPin.includes("://")
    ? undefined
    : /^(?:[^@]+@)?[^:]+:(.+)$/.exec(withoutPin)?.[1];
  if (scpPath !== undefined) {
    repositoryPath = scpPath;
  } else if (URL.canParse(withoutPin)) {
    const parsed = new URL(withoutPin);
    repositoryPath = parsed.pathname;
    fallback = parsed.hostname === "" ? fallback : parsed.hostname;
  }
  const parts = repositoryPath
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] ?? fallback;
}

/**
 * Derive the registry name from a source (B31/B40). A pin is appended so two
 * refs of one repository can coexist; ref separators are flattened because the
 * name is also a directory name.
 */
export function marketplaceNameForSource(source: MarketplaceSource): string {
  let base: string;
  if (source.source === "local") {
    base = basename(source.path) || "unknown-marketplace";
  } else if (source.source === "github") {
    base =
      source.repo.split("/").filter(Boolean).at(-1) ?? "unknown-marketplace";
  } else {
    base = nameFromUrl(source.url);
  }
  const pinned =
    source.source === "local"
      ? base
      : source.sha !== undefined
        ? `${base}@${source.sha.slice(0, 8)}`
        : source.ref !== undefined
          ? `${base}@${source.ref.replace(/[\\/]+/g, "-")}`
          : base;
  const safe = pinned
    .replace(/[^A-Za-z0-9._@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe === "" || safe === "." || safe === ".." || safe === "__proto__") {
    throw new PluginOperationError(
      "marketplace-invalid-source",
      `The marketplace name "${pinned}" is not usable. Use a repository with a normal name.`,
    );
  }
  return safe;
}

/** One line, no control characters: a registry value is untrusted text. */
function terminalSafe(value: string): string {
  return value.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
}

/** The canonical rendering for `marketplace list` (credentials removed). */
export function formatMarketplaceSource(source: MarketplaceSource): string {
  let shown: string;
  if (source.source === "github") shown = `github:${source.repo}`;
  else if (source.source === "local") shown = `local:${source.path}`;
  else shown = redactUrl(source.url);
  if (source.source === "local") return terminalSafe(shown);
  if (source.sha !== undefined) return `${terminalSafe(shown)}@${source.sha}`;
  if (source.ref !== undefined) return `${terminalSafe(shown)}#${source.ref}`;
  return terminalSafe(shown);
}

function redactUrl(raw: string): string {
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  }
  // scp-like `user@host:path`: drop the user, never the host.
  return raw.replace(/^[^@/]+@/, "");
}

// ---------------------------------------------------------------------------
// Marketplace manifest (B32)
// ---------------------------------------------------------------------------

/**
 * A plugin's source within a marketplace: a path relative to the marketplace
 * root, or an external source kind this build registers but does not fetch.
 */
export type MarketplacePluginSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "external"; readonly type: string };

export interface MarketplacePluginEntry {
  readonly name: string;
  readonly description?: string;
  readonly source: MarketplacePluginSource;
  readonly category?: string;
  readonly homepage?: string;
  readonly tags?: readonly string[];
}

export interface MarketplaceOwner {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

export interface MarketplaceManifest {
  readonly name: string;
  readonly description?: string;
  readonly owner?: MarketplaceOwner;
  readonly plugins: readonly MarketplacePluginEntry[];
}

const KNOWN_PLUGIN_SOURCE_TYPES: Readonly<Record<string, true>> = {
  github: true,
  url: true,
  local: true,
  "git-subdir": true,
  npm: true,
  archive: true,
};

function invalidManifest(path: string, detail: string): PluginOperationError {
  return new PluginOperationError(
    "manifest-invalid",
    `Marketplace manifest at ${path} ${detail}`,
  );
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw invalidManifest(path, `has a non-string "${key}".`);
  return value;
}

function readPluginSource(
  value: unknown,
  path: string,
  pluginName: string,
): MarketplacePluginSource {
  if (typeof value === "string") {
    if (value.trim() === "")
      throw invalidManifest(path, `has an empty source for "${pluginName}".`);
    return { kind: "path", path: value };
  }
  if (isRecord(value) && typeof value["source"] === "string") {
    const type = value["source"];
    if (KNOWN_PLUGIN_SOURCE_TYPES[type] !== true)
      throw invalidManifest(
        path,
        `has an unknown source kind "${type}" for "${pluginName}".`,
      );
    if (type === "local" || type === "git-subdir") {
      if (typeof value["path"] !== "string" || value["path"] === "")
        throw invalidManifest(
          path,
          `has a "${type}" source for "${pluginName}" without a path.`,
        );
    }
    if (type === "github" && typeof value["repo"] !== "string")
      throw invalidManifest(
        path,
        `has a "github" source for "${pluginName}" without a repo.`,
      );
    if (
      (type === "url" || type === "archive") &&
      typeof value["url"] !== "string"
    )
      throw invalidManifest(
        path,
        `has a "${type}" source for "${pluginName}" without a url.`,
      );
    if (type === "npm" && typeof value["package"] !== "string")
      throw invalidManifest(
        path,
        `has an "npm" source for "${pluginName}" without a package.`,
      );
    return { kind: "external", type };
  }
  throw invalidManifest(path, `has an unsupported source for "${pluginName}".`);
}

function readPluginEntry(value: unknown, path: string): MarketplacePluginEntry {
  if (!isRecord(value))
    throw invalidManifest(path, "has a plugin entry that is not an object.");
  const name = value["name"];
  if (typeof name !== "string" || name.trim() === "")
    throw invalidManifest(path, 'has a plugin entry without a "name".');
  const description = readOptionalString(value, "description", path);
  const category = readOptionalString(value, "category", path);
  const homepage = readOptionalString(value, "homepage", path);
  let tags: readonly string[] | undefined;
  if (value["tags"] !== undefined) {
    const raw = value["tags"];
    if (!Array.isArray(raw) || raw.some((tag) => typeof tag !== "string"))
      throw invalidManifest(path, `has non-string tags for "${name}".`);
    tags = raw.filter((tag): tag is string => typeof tag === "string");
  }
  return {
    name,
    source: readPluginSource(value["source"], path, name),
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(tags === undefined ? {} : { tags }),
  };
}

function readOwner(value: unknown, path: string): MarketplaceOwner | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw invalidManifest(path, 'has a non-object "owner".');
  const name = value["name"];
  if (typeof name !== "string" || name.trim() === "")
    throw invalidManifest(path, 'has an owner without a "name".');
  const email = readOptionalString(value, "email", path);
  const url = readOptionalString(value, "url", path);
  return {
    name,
    ...(email === undefined ? {} : { email }),
    ...(url === undefined ? {} : { url }),
  };
}

/**
 * Validate one `marketplace.json` (B32). The name loses non-printable
 * characters; a missing name or plugins array, or a plugin entry whose source
 * is the wrong shape, rejects the document.
 */
export function parseMarketplaceManifest(
  text: string,
  path: string,
): MarketplaceManifest {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new PluginOperationError(
      "manifest-invalid",
      `Marketplace manifest at ${path} could not be parsed.`,
      error instanceof JsoncParseError ? { cause: error } : undefined,
    );
  }
  if (!isRecord(parsed)) throw invalidManifest(path, "must contain an object.");
  const rawName = parsed["name"];
  if (typeof rawName !== "string")
    throw invalidManifest(path, 'is missing a string "name".');
  const name = rawName.replace(/\p{C}/gu, "").trim();
  if (name === "") throw invalidManifest(path, "has an empty name.");
  const description = readOptionalString(parsed, "description", path);
  const owner = readOwner(parsed["owner"], path);
  const rawPlugins = parsed["plugins"];
  if (!Array.isArray(rawPlugins))
    throw invalidManifest(path, 'is missing a "plugins" array.');
  const plugins = rawPlugins.map((entry) => readPluginEntry(entry, path));
  return {
    name,
    plugins,
    ...(description === undefined ? {} : { description }),
    ...(owner === undefined ? {} : { owner }),
  };
}

/**
 * Load the manifest under a marketplace root, preferring
 * `.factory-plugin/marketplace.json` (B32). No manifest at either location is
 * `manifest-invalid`: a registered marketplace without one is not usable.
 */
export function loadMarketplaceManifest(
  rootDir: string,
  io: PluginIo = defaultPluginIo,
): MarketplaceManifest {
  for (const relative of MARKETPLACE_MANIFEST_PATHS) {
    const path = join(rootDir, relative);
    const text = io.readFile(path);
    if (text === undefined) continue;
    return parseMarketplaceManifest(text, path);
  }
  throw new PluginOperationError(
    "manifest-invalid",
    `No marketplace manifest found in ${rootDir} (expected ${MARKETPLACE_MANIFEST_PATHS.join(" or ")}).`,
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface MarketplaceEntry {
  readonly source: MarketplaceSource;
  readonly installLocation: string;
  readonly lastUpdated: string;
  readonly autoUpdate: boolean;
  /** The commit the checkout was recorded at, when git could report one. */
  readonly commit?: string;
}

export interface KnownMarketplacesResult {
  readonly entries: ReadonlyMap<string, MarketplaceEntry>;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export function pluginsDirectory(scopeRoot: string): string {
  return join(scopeRoot, PLUGINS_DIR);
}

export function knownMarketplacesPath(scopeRoot: string): string {
  return join(pluginsDirectory(scopeRoot), KNOWN_MARKETPLACES_FILE);
}

export function marketplacesDirectory(scopeRoot: string): string {
  return join(pluginsDirectory(scopeRoot), MARKETPLACES_DIR);
}

function readSource(value: unknown): MarketplaceSource | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["source"];
  const ref = typeof value["ref"] === "string" ? value["ref"] : undefined;
  const sha = typeof value["sha"] === "string" ? value["sha"] : undefined;
  if (kind === "local" && typeof value["path"] === "string")
    return { source: "local", path: value["path"] };
  if (kind === "github" && typeof value["repo"] === "string")
    return {
      source: "github",
      repo: value["repo"],
      ...(ref === undefined ? {} : { ref }),
      ...(sha === undefined ? {} : { sha }),
    };
  if (kind === "url" && typeof value["url"] === "string")
    return {
      source: "url",
      url: value["url"],
      ...(ref === undefined ? {} : { ref }),
      ...(sha === undefined ? {} : { sha }),
    };
  return undefined;
}

function readEntry(value: unknown): MarketplaceEntry | undefined {
  if (!isRecord(value)) return undefined;
  const source = readSource(value["source"]);
  const installLocation = value["installLocation"];
  const lastUpdated = value["lastUpdated"];
  if (source === undefined) return undefined;
  if (typeof installLocation !== "string" || installLocation === "")
    return undefined;
  if (typeof lastUpdated !== "string" || lastUpdated === "") return undefined;
  const commit =
    typeof value["commit"] === "string" ? value["commit"] : undefined;
  return {
    source,
    installLocation,
    lastUpdated,
    autoUpdate: value["autoUpdate"] !== false,
    ...(commit === undefined ? {} : { commit }),
  };
}

function serialiseSource(source: MarketplaceSource): Record<string, unknown> {
  if (source.source === "local") return { source: "local", path: source.path };
  const pinned = {
    ...(source.ref === undefined ? {} : { ref: source.ref }),
    ...(source.sha === undefined ? {} : { sha: source.sha }),
  };
  return source.source === "github"
    ? { source: "github", repo: source.repo, ...pinned }
    : { source: "url", url: source.url, ...pinned };
}

/** SHA-256 of a source's canonical form, recorded on each installed entry. */
export function hashMarketplaceSource(source: MarketplaceSource): string {
  return createHash("sha256")
    .update(JSON.stringify(serialiseSource(source)), "utf8")
    .digest("hex");
}

function serialiseEntry(entry: MarketplaceEntry): Record<string, unknown> {
  return {
    source: serialiseSource(entry.source),
    installLocation: entry.installLocation,
    lastUpdated: entry.lastUpdated,
    autoUpdate: entry.autoUpdate,
    ...(entry.commit === undefined ? {} : { commit: entry.commit }),
  };
}

function isUsableName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    name !== "__proto__" &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/**
 * Read and validate the registry. A missing file is empty; a document that is
 * not an object of entries is refused so a mutation cannot clobber it. One
 * invalid entry is skipped with a diagnostic and the rest stay visible.
 */
export function readKnownMarketplaces(
  scopeRoot: string,
  io: PluginIo = defaultPluginIo,
): KnownMarketplacesResult {
  const path = knownMarketplacesPath(scopeRoot);
  const diagnostics: PluginDiagnostic[] = [];
  const entries = new Map<string, MarketplaceEntry>();
  const text = io.readFile(path);
  if (text === undefined) return { entries, diagnostics };

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
      `${path} must contain an object of marketplace entries.`,
    );
  }
  for (const [name, rawEntry] of Object.entries(parsed)) {
    if (!isUsableName(name)) {
      diagnostics.push({
        path,
        message: `"${name}" is not a marketplace name`,
      });
      continue;
    }
    const entry = readEntry(rawEntry);
    if (entry === undefined) {
      diagnostics.push({
        path,
        message: `marketplace "${name}" has an unrecognized entry`,
      });
      continue;
    }
    entries.set(name, entry);
  }
  return { entries, diagnostics };
}

/** Write the registry atomically, with names and keys in a stable order. */
export function writeKnownMarketplaces(
  scopeRoot: string,
  entries: ReadonlyMap<string, MarketplaceEntry>,
  io: PluginIo = defaultPluginIo,
): void {
  const document: Record<string, unknown> = {};
  for (const name of [...entries.keys()].sort()) {
    const entry = entries.get(name);
    if (entry !== undefined) document[name] = serialiseEntry(entry);
  }
  writeTextAtomic(
    knownMarketplacesPath(scopeRoot),
    `${JSON.stringify(document, null, 2)}\n`,
    io,
  );
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitRunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One git invocation. The runner never rejects: a non-zero exit is data, so a
 * caller can phrase the refusal and a test can point the runner at a local
 * repository without any code path reaching the network.
 */
export type GitRunner = (
  args: readonly string[],
  options: GitRunOptions,
) => Promise<GitResult>;

function exitCodeOf(error: {
  readonly code?: unknown;
  readonly killed?: boolean;
}): number {
  if (error.code === "ENOENT") return GIT_MISSING_EXIT;
  if (typeof error.code === "number") return error.code;
  if (error.killed === true) return GIT_TIMEOUT_EXIT;
  return 1;
}

export function createGitRunner(): GitRunner {
  return (args, options) => {
    const { promise, resolve } = Promise.withResolvers<GitResult>();
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        resolve({
          code: exitCodeOf(error),
          stdout: typeof stdout === "string" ? stdout : "",
          stderr:
            typeof stderr === "string" && stderr !== ""
              ? stderr
              : error.message,
        });
      },
    );
    return promise;
  };
}

export const defaultGitRunner: GitRunner = createGitRunner();

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .find((candidate) => candidate.trim() !== "");
  return line === undefined ? "" : line.trim();
}

async function runGitChecked(
  runner: GitRunner,
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitResult> {
  const result = await runner(args, options);
  if (result.code === 0) return result;
  if (result.code === GIT_MISSING_EXIT) {
    throw new PluginOperationError(
      "git-missing",
      "git is required for this marketplace but was not found on PATH.",
    );
  }
  if (result.code === GIT_TIMEOUT_EXIT) {
    throw new PluginOperationError(
      "git-failed",
      `git ${args[0] ?? "command"} timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`,
    );
  }
  const detail = firstLine(result.stderr);
  throw new PluginOperationError(
    "git-failed",
    `git ${args[0] ?? "command"} failed${detail === "" ? ` with exit code ${result.code}` : `: ${terminalSafe(detail)}`}.`,
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface MarketplaceDeps {
  /** The user scope root: `<factoryDir>` (B31). */
  readonly scopeRoot: string;
  readonly io?: PluginIo;
  readonly runGit?: GitRunner;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export interface MarketplaceInfo {
  readonly name: string;
  readonly entry: MarketplaceEntry;
  readonly pluginCount?: number;
  readonly displayName?: string;
  readonly problem?: string;
}

export interface MarketplaceListResult {
  readonly marketplaces: readonly MarketplaceInfo[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface AddMarketplaceOptions {
  readonly branch?: string;
  readonly home?: string;
  readonly cwd?: string;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolvePath(root);
  const resolvedCandidate = resolvePath(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

async function readCommit(
  directory: string,
  deps: MarketplaceDeps,
): Promise<string | undefined> {
  const result = await (deps.runGit ?? defaultGitRunner)(
    ["rev-parse", "HEAD"],
    {
      cwd: directory,
      timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    },
  );
  if (result.code !== 0) return undefined;
  const commit = result.stdout.trim();
  return /^[0-9a-f]{7,64}$/iu.test(commit) ? commit : undefined;
}

async function cloneSource(
  source: MarketplaceSource,
  directory: string,
  deps: MarketplaceDeps,
): Promise<void> {
  if (source.source === "local") {
    throw new PluginOperationError(
      "source-unsupported",
      `A local marketplace is registered in place; ${source.path} is not cloned.`,
    );
  }
  const runner = deps.runGit ?? defaultGitRunner;
  const options: GitRunOptions = {
    cwd: dirname(directory),
    timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  };
  (deps.io ?? defaultPluginIo).makeDirectory(dirname(directory));
  await runGitChecked(
    runner,
    [
      "clone",
      "--depth=1",
      "--no-tags",
      ...(source.ref === undefined ? [] : ["--branch", source.ref]),
      "--",
      gitUrlForSource(source),
      directory,
    ],
    options,
  );
  if (source.sha !== undefined) {
    // A commit that no branch advertises still has to be fetched by name.
    await runGitChecked(
      runner,
      [
        "fetch",
        "--depth=1",
        "--no-tags",
        "--",
        gitUrlForSource(source),
        source.sha,
      ],
      { cwd: directory, timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS },
    );
    await runGitChecked(runner, ["reset", "--hard", "FETCH_HEAD"], {
      cwd: directory,
      timeoutMs: deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
  }
}

async function requiredCommit(
  directory: string,
  deps: MarketplaceDeps,
): Promise<string> {
  const commit = await readCommit(directory, deps);
  if (commit === undefined) {
    throw new PluginOperationError(
      "git-failed",
      `The marketplace checkout at ${directory} has no commit.`,
    );
  }
  return commit;
}

/**
 * `marketplace add <url> [--branch]` (B40). The manifest is validated before
 * the checkout is adopted, and an existing name is refused — never replaced.
 */
export async function addMarketplace(
  rawSource: string,
  options: AddMarketplaceOptions,
  deps: MarketplaceDeps,
): Promise<MarketplaceInfo> {
  const io = deps.io ?? defaultPluginIo;
  const source = parseMarketplaceSource(rawSource, options);
  const name = marketplaceNameForSource(source);
  const registry = readKnownMarketplaces(deps.scopeRoot, io);
  if (registry.entries.has(name)) {
    throw new PluginOperationError(
      "marketplace-exists",
      `Marketplace "${name}" is already registered. Run \`plugin marketplace remove ${name}\` before adding it again.`,
    );
  }

  const lastUpdated = (deps.now ?? (() => new Date()))().toISOString();
  let entry: MarketplaceEntry;
  let pluginCount: number;
  let displayName: string;

  if (source.source === "local") {
    if (!io.exists(source.path)) {
      throw new PluginOperationError(
        "marketplace-invalid-source",
        `The marketplace directory ${source.path} does not exist.`,
      );
    }
    const manifest = loadMarketplaceManifest(source.path, io);
    const commit = await readCommit(source.path, deps);
    pluginCount = manifest.plugins.length;
    displayName = manifest.name;
    entry = {
      source,
      installLocation: source.path,
      lastUpdated,
      autoUpdate: true,
      ...(commit === undefined ? {} : { commit }),
    };
  } else {
    const staging = join(
      marketplacesDirectory(deps.scopeRoot),
      `.staging-${randomUUID().replace(/-/g, "")}`,
    );
    try {
      await cloneSource(source, staging, deps);
      const manifest = loadMarketplaceManifest(staging, io);
      const commit = await requiredCommit(staging, deps);
      const target = join(marketplacesDirectory(deps.scopeRoot), name);
      adoptDirectory(staging, target, io);
      pluginCount = manifest.plugins.length;
      displayName = manifest.name;
      entry = {
        source,
        installLocation: target,
        lastUpdated,
        autoUpdate: true,
        commit,
      };
    } catch (error) {
      try {
        io.remove(staging);
      } catch {
        // A leftover staging directory is inert.
      }
      throw error;
    }
  }

  const entries = new Map(registry.entries);
  entries.set(name, entry);
  writeKnownMarketplaces(deps.scopeRoot, entries, io);
  return { name, entry, pluginCount, displayName };
}

async function refreshMarketplace(
  name: string,
  entry: MarketplaceEntry,
  deps: MarketplaceDeps,
): Promise<MarketplaceEntry> {
  const io = deps.io ?? defaultPluginIo;
  const lastUpdated = (deps.now ?? (() => new Date()))().toISOString();
  if (entry.source.source === "local") {
    loadMarketplaceManifest(entry.source.path, io);
    const commit = await readCommit(entry.source.path, deps);
    return {
      ...entry,
      installLocation: entry.source.path,
      lastUpdated,
      ...(commit === undefined ? {} : { commit }),
    };
  }

  const staging = join(
    marketplacesDirectory(deps.scopeRoot),
    `.staging-${randomUUID().replace(/-/g, "")}`,
  );
  try {
    await cloneSource(entry.source, staging, deps);
    loadMarketplaceManifest(staging, io);
    const commit = await requiredCommit(staging, deps);
    adoptDirectory(staging, entry.installLocation, io);
    return { ...entry, lastUpdated, commit };
  } catch (error) {
    try {
      io.remove(staging);
    } catch {
      // A leftover staging directory is inert.
    }
    throw error;
  }
}

export interface MarketplaceUpdateOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly commit?: string;
  readonly error?: string;
}

/**
 * `marketplace update [name]` (B40). One marketplace or all; a failure keeps
 * that marketplace's previous checkout and registry entry, and every other
 * outcome is still recorded.
 */
export async function updateMarketplaces(
  name: string | undefined,
  deps: MarketplaceDeps,
): Promise<readonly MarketplaceUpdateOutcome[]> {
  const io = deps.io ?? defaultPluginIo;
  const registry = readKnownMarketplaces(deps.scopeRoot, io);
  if (name !== undefined && !registry.entries.has(name)) {
    throw new PluginOperationError(
      "marketplace-not-found",
      `Marketplace "${name}" is not registered.`,
    );
  }
  const names =
    name === undefined ? [...registry.entries.keys()].sort() : [name];
  const entries = new Map(registry.entries);
  const outcomes: MarketplaceUpdateOutcome[] = [];
  for (const key of names) {
    const entry = entries.get(key);
    if (entry === undefined) continue;
    try {
      const updated = await refreshMarketplace(key, entry, deps);
      entries.set(key, updated);
      outcomes.push({
        name: key,
        ok: true,
        ...(updated.commit === undefined ? {} : { commit: updated.commit }),
      });
    } catch (error) {
      outcomes.push({
        name: key,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (outcomes.some((outcome) => outcome.ok)) {
    writeKnownMarketplaces(deps.scopeRoot, entries, io);
  }
  return outcomes;
}

/**
 * `marketplace remove <name>` (B40). The entry is unregistered first; a
 * checkout this build created is then deleted. A local source directory is
 * never touched — it belongs to the user.
 */
export async function removeMarketplace(
  name: string,
  deps: MarketplaceDeps,
): Promise<{ readonly name: string; readonly checkoutRemoved: boolean }> {
  const io = deps.io ?? defaultPluginIo;
  const registry = readKnownMarketplaces(deps.scopeRoot, io);
  const entry = registry.entries.get(name);
  if (entry === undefined) {
    throw new PluginOperationError(
      "marketplace-not-found",
      `Marketplace "${name}" is not registered.`,
    );
  }
  const entries = new Map(registry.entries);
  entries.delete(name);
  writeKnownMarketplaces(deps.scopeRoot, entries, io);

  let checkoutRemoved = false;
  if (
    entry.source.source !== "local" &&
    isInside(marketplacesDirectory(deps.scopeRoot), entry.installLocation)
  ) {
    io.remove(entry.installLocation);
    checkoutRemoved = true;
  }
  return { name, checkoutRemoved };
}

/** `marketplace list` (B40): every entry plus what its manifest offers. */
export function listMarketplaces(deps: MarketplaceDeps): MarketplaceListResult {
  const io = deps.io ?? defaultPluginIo;
  const registry = readKnownMarketplaces(deps.scopeRoot, io);
  const marketplaces: MarketplaceInfo[] = [];
  for (const name of [...registry.entries.keys()].sort()) {
    const entry = registry.entries.get(name);
    if (entry === undefined) continue;
    try {
      const manifest = loadMarketplaceManifest(entry.installLocation, io);
      marketplaces.push({
        name,
        entry,
        pluginCount: manifest.plugins.length,
        displayName: manifest.name,
      });
    } catch (error) {
      marketplaces.push({
        name,
        entry,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { marketplaces, diagnostics: registry.diagnostics };
}

/** Render the listing. Every value is reduced to one safe line. */
export function renderMarketplaceList(result: MarketplaceListResult): string {
  const lines: string[] = [];
  if (result.marketplaces.length === 0) {
    lines.push("No marketplaces registered.");
  } else {
    const rows = result.marketplaces.map((marketplace) => ({
      name: terminalSafe(marketplace.name),
      source: formatMarketplaceSource(marketplace.entry.source),
      plugins:
        marketplace.pluginCount === undefined
          ? "?"
          : String(marketplace.pluginCount),
      display:
        marketplace.displayName === undefined ||
        marketplace.displayName === marketplace.name
          ? "—"
          : terminalSafe(marketplace.displayName),
      problem: marketplace.problem,
    }));
    const nameWidth = Math.max(...rows.map((row) => row.name.length));
    const sourceWidth = Math.max(...rows.map((row) => row.source.length));
    lines.push(
      `${"NAME".padEnd(nameWidth)}  ${"SOURCE".padEnd(sourceWidth)}  PLUGINS  DISPLAY NAME`,
    );
    for (const row of rows) {
      lines.push(
        `${row.name.padEnd(nameWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.plugins.padStart(7)}  ${row.display}`,
      );
      if (row.problem !== undefined)
        lines.push(`  ${terminalSafe(row.problem)}`);
    }
  }
  if (result.diagnostics.length > 0) {
    lines.push("", "problems:");
    for (const diagnostic of result.diagnostics)
      lines.push(`  ${diagnostic.path}: ${terminalSafe(diagnostic.message)}`);
  }
  return `${lines.join("\n")}\n`;
}
