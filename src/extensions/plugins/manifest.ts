/**
 * Plugin identity and manifest. Contract: `specs/60-extensions-mcp-and-skills.md`
 * B33 (plugin root and `plugin.json`) and B37 (plugin id parsing).
 *
 * A plugin id is `plugin-name@marketplace`, split on the first `@` at index 1
 * or later. The manifest is optional JSONC; only `hooks` is read, plus a
 * `$schema` sniff that recognises an Agent Plugins document.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../guards.ts";
import { JsoncParseError, parseJsonc } from "../jsonc.ts";

/**
 * Manifest locations, most specific first (B33). `.droide-plugin/` is the
 * Factory layout; `.claude-plugin/` is the Claude Code root marker.
 *
 * TODO(spec): B33 states that `.droide-plugin/plugin.json` is read and that
 * `.claude-plugin/` marks a plugin root, but does not pin reading
 * `.claude-plugin/plugin.json` directly. The fallback mirrors B32's
 * marketplace rule until the install path is implemented.
 */
export const PLUGIN_MANIFEST_PATHS = [
  ".droide-plugin/plugin.json",
  ".claude-plugin/plugin.json",
] as const;

/** Prefix that marks an Agent Plugins document (B33). */
export const AGENT_PLUGINS_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/";

export type PluginErrorCode = "plugin-id-invalid" | "manifest-invalid";

export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(
    code: PluginErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PluginError";
    this.code = code;
  }
}

export interface PluginId {
  readonly name: string;
  readonly marketplace: string;
}

export function pluginIdMessage(raw: string): string {
  return `"${raw}" isn't a valid plugin name. Use plugin-name@marketplace, for example review-tools@team-tools.`;
}

/**
 * Parse `<plugin>@<marketplace>` on the first `@` at index >= 1 (B37). A
 * missing separator, an empty name, or an empty marketplace is the
 * `plugin-id-invalid` identity with the documented message.
 */
export function parsePluginId(raw: string): PluginId {
  const separator = raw.indexOf("@");
  if (separator < 1) {
    throw new PluginError("plugin-id-invalid", pluginIdMessage(raw));
  }
  const name = raw.slice(0, separator);
  const marketplace = raw.slice(separator + 1);
  if (name.trim() === "" || marketplace.trim() === "") {
    throw new PluginError("plugin-id-invalid", pluginIdMessage(raw));
  }
  return { name, marketplace };
}

export type PluginHookDeclaration =
  | {
      readonly kind: "event-map";
      readonly events: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "event-maps";
      readonly maps: readonly Readonly<Record<string, unknown>>[];
    }
  | { readonly kind: "hook-files"; readonly paths: readonly string[] };

export type PluginLayout = "factory" | "claude";

export interface PluginManifest {
  readonly path: string;
  readonly layout: PluginLayout;
  /** A `$schema` under `https://agent-plugins.org/schemas/` (B33). */
  readonly agentPlugins: boolean;
  readonly hooks?: PluginHookDeclaration;
}

function layoutForPath(path: string): PluginLayout {
  return path.includes(".claude-plugin") ? "claude" : "factory";
}

function readHooks(
  value: unknown,
  path: string,
): PluginHookDeclaration | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value)) {
    return { kind: "event-map", events: value };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      // TODO(spec): B33 allows an event map, a list of event maps, or a list of
      // hook-file paths; it does not classify an empty list.
      return { kind: "hook-files", paths: [] };
    }
    const allStrings = value.every((entry) => typeof entry === "string");
    if (allStrings) {
      return {
        kind: "hook-files",
        paths: value.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      };
    }
    const allRecords = value.every((entry) => isRecord(entry));
    if (allRecords) {
      return {
        kind: "event-maps",
        maps: value.filter(
          (entry): entry is Readonly<Record<string, unknown>> =>
            isRecord(entry),
        ),
      };
    }
  }
  throw new PluginError(
    "manifest-invalid",
    `Plugin manifest at ${path} has an unsupported "hooks" shape.`,
  );
}

/**
 * Validate one `plugin.json` (B33). Unknown keys are ignored; only `hooks` is
 * read. An unparseable or non-object document is `manifest-invalid`.
 */
export function parsePluginManifest(
  text: string,
  path: string,
): PluginManifest {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new PluginError(
      "manifest-invalid",
      `Plugin manifest at ${path} could not be parsed.`,
      error instanceof JsoncParseError ? { cause: error } : undefined,
    );
  }
  if (!isRecord(parsed)) {
    throw new PluginError(
      "manifest-invalid",
      `Plugin manifest at ${path} must contain an object.`,
    );
  }

  const schema = parsed["$schema"];
  const hooks = readHooks(parsed["hooks"], path);
  return {
    path,
    layout: layoutForPath(path),
    agentPlugins:
      typeof schema === "string" &&
      schema.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX),
    ...(hooks !== undefined ? { hooks } : {}),
  };
}

export type PluginManifestLoadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly manifest: PluginManifest };

export interface LoadPluginManifestOptions {
  readonly readFile?: (path: string) => string;
}

/**
 * Load the first manifest that exists under the plugin root (B33). A missing
 * manifest is not an error: `plugin.json` is optional.
 */
export function loadPluginManifest(
  rootDir: string,
  options: LoadPluginManifestOptions = {},
): PluginManifestLoadResult {
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    const path = join(rootDir, relativePath);
    let text: string;
    try {
      text = readFile(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
      }
      throw new PluginError(
        "manifest-invalid",
        `Plugin manifest at ${path} could not be read.`,
        { cause: error },
      );
    }
    return { kind: "present", manifest: parsePluginManifest(text, path) };
  }
  return { kind: "absent" };
}
