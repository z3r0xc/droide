/**
 * The settings vocabulary this build understands, and the parser that enforces
 * it.
 *
 * A settings document is flat, like the subject's `settings.json`: ordinary
 * settings live at the root (`worktreeDirectory`) and the six structured
 * sections (`mcp`, `hooks`, `droids`, `skills`, `outputStyles`, `commands`)
 * are parsed separately. A `"general"` wrapper is refused for the same reason
 * the subject refuses it in a runtime overlay
 * (`specs/10-cli-surface.md`, "Settings files").
 *
 * Parsing validates, it never coerces: a number where a string belongs is an
 * {@link InvalidSettingsError} naming the dotted key path, and a key outside
 * the vocabulary is an {@link UnknownSettingError}. Both errors carry the file
 * that produced them.
 */
import { InvalidSettingsError, UnknownSettingError } from "./errors.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Opaque section entry whose own schema belongs to another slice. */
export type JsonObject = { readonly [key: string]: JsonValue };

export type CustomModelProvider =
  "anthropic" | "openai" | "generic-chat-completion-api" | "bedrock-converse";

/**
 * Persisted custom-model entry consumed by `droid exec`
 * (`specs/80-exec-and-streaming.md`, acceptance fixtures).
 */
export interface CustomModelSettings {
  readonly id?: string;
  readonly index?: number;
  readonly model: string;
  readonly provider: CustomModelProvider;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyHelper?: string;
  readonly apiKeyHelperTtlMs?: number;
  readonly displayName?: string;
  readonly maxContextLimit?: number;
  readonly enableThinking?: boolean;
}

/** Settings applied at the root of a document, merged key by key. */
export interface GeneralSettings {
  readonly worktreeDirectory?: string;
  readonly enabledPlugins?: Readonly<Record<string, boolean>>;
  readonly theme?: string;
  readonly locale?: string;
  readonly droidCoreModel?: string;
  readonly llmRequestTimeout?: number;
  readonly compactionTokenLimit?: number;
  readonly trustedFolders?: readonly string[];
  readonly customModels?: readonly CustomModelSettings[];
}

export interface McpStdioServerSettings {
  readonly type?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
}

export interface McpRemoteServerSettings {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
}

export type McpServerSettings =
  McpStdioServerSettings | McpRemoteServerSettings;

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd";

export interface HookCommandSettings {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
  readonly preserveRiskLevel?: boolean;
}

export interface HookConfigSettings {
  readonly matcher?: string;
  readonly commandRegex?: string;
  readonly hooks: readonly HookCommandSettings[];
}

export type HooksSettings = {
  readonly [Event in HookEvent]?: readonly HookConfigSettings[];
} & {
  readonly hooksDisabled?: boolean;
  readonly showHookOutput?: boolean;
};

/** The merged settings a layer contributes. Every field is optional. */
export interface Settings {
  readonly general?: GeneralSettings;
  readonly mcp?: Readonly<Record<string, McpServerSettings>>;
  readonly hooks?: HooksSettings;
  readonly droids?: Readonly<Record<string, JsonObject>>;
  readonly skills?: readonly string[];
  readonly outputStyles?: Readonly<Record<string, JsonObject>>;
  readonly commands?: readonly string[];
}

type RawObject = Readonly<Record<string, unknown>>;
type AllowedKeys = Readonly<Record<string, true>>;

const GENERAL_KEYS: AllowedKeys = {
  worktreeDirectory: true,
  enabledPlugins: true,
  theme: true,
  locale: true,
  droidCoreModel: true,
  llmRequestTimeout: true,
  compactionTokenLimit: true,
  trustedFolders: true,
  customModels: true,
};

const SETTINGS_KEYS: AllowedKeys = {
  ...GENERAL_KEYS,
  mcp: true,
  hooks: true,
  droids: true,
  skills: true,
  outputStyles: true,
  commands: true,
};

const CUSTOM_MODEL_KEYS: AllowedKeys = {
  id: true,
  index: true,
  model: true,
  provider: true,
  baseUrl: true,
  apiKey: true,
  apiKeyHelper: true,
  apiKeyHelperTtlMs: true,
  displayName: true,
  maxContextLimit: true,
  enableThinking: true,
};

const CUSTOM_MODEL_PROVIDERS: AllowedKeys = {
  anthropic: true,
  openai: true,
  "generic-chat-completion-api": true,
  "bedrock-converse": true,
};

const HTTP_URL = /^https?:\/\//i;

const MCP_STDIO_KEYS: AllowedKeys = {
  type: true,
  command: true,
  args: true,
  env: true,
  disabled: true,
};
const MCP_REMOTE_KEYS: AllowedKeys = {
  type: true,
  url: true,
  headers: true,
  disabled: true,
};

const HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
] as const;

const HOOK_EVENT_KEYS: AllowedKeys = {
  PreToolUse: true,
  PostToolUse: true,
  Notification: true,
  UserPromptSubmit: true,
  Stop: true,
  SubagentStop: true,
  PreCompact: true,
  SessionStart: true,
  SessionEnd: true,
};

const HOOK_SECTION_KEYS: AllowedKeys = {
  ...HOOK_EVENT_KEYS,
  hooksDisabled: true,
  showHookOutput: true,
};

const HOOK_KEYS: AllowedKeys = {
  matcher: true,
  commandRegex: true,
  hooks: true,
};
const HOOK_COMMAND_KEYS: AllowedKeys = {
  type: true,
  command: true,
  timeout: true,
  preserveRiskLevel: true,
};

function isObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isCustomModelProvider(value: string): value is CustomModelProvider {
  return Object.hasOwn(CUSTOM_MODEL_PROVIDERS, value);
}

function joinKeyPath(parent: string, key: string | number): string {
  return parent === "" ? String(key) : `${parent}.${key}`;
}

function expectObject(
  value: unknown,
  path: string,
  keyPath: string,
): RawObject {
  if (!isObject(value)) {
    throw new InvalidSettingsError(
      path,
      keyPath,
      `expected an object, got ${typeName(value)}`,
    );
  }
  return value;
}

function expectString(value: unknown, path: string, keyPath: string): string {
  if (typeof value !== "string") {
    throw new InvalidSettingsError(
      path,
      keyPath,
      `expected a string, got ${typeName(value)}`,
    );
  }
  return value;
}

function expectNumber(value: unknown, path: string, keyPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSettingsError(
      path,
      keyPath,
      `expected a finite number, got ${typeName(value)}`,
    );
  }
  return value;
}

function expectInteger(
  value: unknown,
  path: string,
  keyPath: string,
  minimum: number,
): number {
  const number = expectNumber(value, path, keyPath);
  if (!Number.isInteger(number) || number < minimum) {
    throw new InvalidSettingsError(
      path,
      keyPath,
      `expected an integer of at least ${minimum}, got ${number}`,
    );
  }
  return number;
}

function expectBoolean(value: unknown, path: string, keyPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new InvalidSettingsError(
      path,
      keyPath,
      `expected a boolean, got ${typeName(value)}`,
    );
  }
  return value;
}

function expectStringArray(
  value: unknown,
  path: string,
  keyPath: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidSettingsError(
      path,
      keyPath,
      `expected an array of strings, got ${typeName(value)}`,
    );
  }
  return value.map((entry, index) =>
    expectString(entry, path, joinKeyPath(keyPath, index)),
  );
}

function expectStringRecord(
  value: unknown,
  path: string,
  keyPath: string,
): Readonly<Record<string, string>> {
  const record = expectObject(value, path, keyPath);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = expectString(entry, path, joinKeyPath(keyPath, key));
  }
  return result;
}

function expectBooleanRecord(
  value: unknown,
  path: string,
  keyPath: string,
): Readonly<Record<string, boolean>> {
  const record = expectObject(value, path, keyPath);
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = expectBoolean(entry, path, joinKeyPath(keyPath, key));
  }
  return result;
}

function rejectUnknownKeys(
  raw: RawObject,
  allowed: AllowedKeys,
  path: string,
  keyPath: string,
): void {
  for (const key of Object.keys(raw)) {
    if (allowed[key] !== true) {
      throw new UnknownSettingError(path, joinKeyPath(keyPath, key));
    }
  }
}

function readOptionalString(
  raw: RawObject,
  key: string,
  path: string,
  keyPath: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  return expectString(value, path, joinKeyPath(keyPath, key));
}

function readOptionalBoolean(
  raw: RawObject,
  key: string,
  path: string,
  keyPath: string,
): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  return expectBoolean(value, path, joinKeyPath(keyPath, key));
}

function readOptionalNumber(
  raw: RawObject,
  key: string,
  path: string,
  keyPath: string,
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  return expectNumber(value, path, joinKeyPath(keyPath, key));
}

function readOptionalInteger(
  raw: RawObject,
  key: string,
  path: string,
  keyPath: string,
  minimum: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  return expectInteger(value, path, joinKeyPath(keyPath, key), minimum);
}

/** Every value must be JSON-shaped; a Date or a function is not a setting. */
function expectJsonObject(
  value: unknown,
  path: string,
  keyPath: string,
): JsonObject {
  const object = expectObject(value, path, keyPath);
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = expectJsonValue(entry, path, joinKeyPath(keyPath, key));
  }
  return result;
}

function expectJsonValue(
  value: unknown,
  path: string,
  keyPath: string,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidSettingsError(
        path,
        keyPath,
        `expected a finite number, got ${value}`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      expectJsonValue(entry, path, joinKeyPath(keyPath, index)),
    );
  }
  if (isObject(value)) {
    return expectJsonObject(value, path, keyPath);
  }
  throw new InvalidSettingsError(
    path,
    keyPath,
    `expected a JSON value, got ${typeName(value)}`,
  );
}

function parseGeneral(raw: RawObject, path: string): GeneralSettings {
  const worktreeDirectory = readOptionalString(
    raw,
    "worktreeDirectory",
    path,
    "",
  );
  const enabledPlugins =
    raw.enabledPlugins === undefined
      ? undefined
      : expectBooleanRecord(raw.enabledPlugins, path, "enabledPlugins");
  const theme = readOptionalString(raw, "theme", path, "");
  const locale = readOptionalString(raw, "locale", path, "");
  const droidCoreModel = readOptionalString(raw, "droidCoreModel", path, "");
  const llmRequestTimeout = readOptionalNumber(
    raw,
    "llmRequestTimeout",
    path,
    "",
  );
  const compactionTokenLimit = readOptionalNumber(
    raw,
    "compactionTokenLimit",
    path,
    "",
  );
  const trustedFolders =
    raw.trustedFolders === undefined
      ? undefined
      : expectStringArray(raw.trustedFolders, path, "trustedFolders");

  let customModels: readonly CustomModelSettings[] | undefined;
  if (raw.customModels !== undefined) {
    if (!Array.isArray(raw.customModels)) {
      throw new InvalidSettingsError(
        path,
        "customModels",
        `expected an array, got ${typeName(raw.customModels)}`,
      );
    }
    customModels = raw.customModels.map((entry, index) =>
      parseCustomModel(entry, path, joinKeyPath("customModels", index)),
    );
  }

  return {
    ...(worktreeDirectory === undefined ? {} : { worktreeDirectory }),
    ...(enabledPlugins === undefined ? {} : { enabledPlugins }),
    ...(theme === undefined ? {} : { theme }),
    ...(locale === undefined ? {} : { locale }),
    ...(droidCoreModel === undefined ? {} : { droidCoreModel }),
    ...(llmRequestTimeout === undefined ? {} : { llmRequestTimeout }),
    ...(compactionTokenLimit === undefined ? {} : { compactionTokenLimit }),
    ...(trustedFolders === undefined ? {} : { trustedFolders }),
    ...(customModels === undefined ? {} : { customModels }),
  };
}

function parseCustomModel(
  value: unknown,
  path: string,
  keyPath: string,
): CustomModelSettings {
  const raw = expectObject(value, path, keyPath);
  rejectUnknownKeys(raw, CUSTOM_MODEL_KEYS, path, keyPath);

  const model = expectString(raw.model, path, joinKeyPath(keyPath, "model"));
  if (model.trim() === "") {
    throw new InvalidSettingsError(
      path,
      joinKeyPath(keyPath, "model"),
      "expected a non-empty model id",
    );
  }

  const provider = expectString(
    raw.provider,
    path,
    joinKeyPath(keyPath, "provider"),
  );
  if (!isCustomModelProvider(provider)) {
    throw new InvalidSettingsError(
      path,
      joinKeyPath(keyPath, "provider"),
      `expected one of ${Object.keys(CUSTOM_MODEL_PROVIDERS).join(", ")}, got ${provider}`,
    );
  }

  const id = readOptionalString(raw, "id", path, keyPath);
  const index = readOptionalNumber(raw, "index", path, keyPath);
  const baseUrl = readOptionalString(raw, "baseUrl", path, keyPath);
  if (baseUrl !== undefined && !HTTP_URL.test(baseUrl)) {
    throw new InvalidSettingsError(
      path,
      joinKeyPath(keyPath, "baseUrl"),
      "expected an http or https URL",
    );
  }
  const apiKey = readOptionalString(raw, "apiKey", path, keyPath);
  if (apiKey === "") {
    throw new InvalidSettingsError(
      path,
      joinKeyPath(keyPath, "apiKey"),
      "expected a non-empty API key or no key at all",
    );
  }
  const apiKeyHelper = readOptionalString(raw, "apiKeyHelper", path, keyPath);
  const apiKeyHelperTtlMs = readOptionalInteger(
    raw,
    "apiKeyHelperTtlMs",
    path,
    keyPath,
    1,
  );
  const displayName = readOptionalString(raw, "displayName", path, keyPath);
  const maxContextLimit = readOptionalInteger(
    raw,
    "maxContextLimit",
    path,
    keyPath,
    1,
  );
  const enableThinking = readOptionalBoolean(
    raw,
    "enableThinking",
    path,
    keyPath,
  );

  return {
    ...(id === undefined ? {} : { id }),
    ...(index === undefined ? {} : { index }),
    model,
    provider,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyHelper === undefined ? {} : { apiKeyHelper }),
    ...(apiKeyHelperTtlMs === undefined ? {} : { apiKeyHelperTtlMs }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(maxContextLimit === undefined ? {} : { maxContextLimit }),
    ...(enableThinking === undefined ? {} : { enableThinking }),
  };
}

function parseMcpServer(
  value: unknown,
  path: string,
  keyPath: string,
): McpServerSettings {
  const raw = expectObject(value, path, keyPath);
  const type =
    raw.type === undefined
      ? undefined
      : expectString(raw.type, path, joinKeyPath(keyPath, "type"));

  if (type === undefined || type === "stdio") {
    rejectUnknownKeys(raw, MCP_STDIO_KEYS, path, keyPath);
    const command = expectString(
      raw.command,
      path,
      joinKeyPath(keyPath, "command"),
    );
    const args =
      raw.args === undefined
        ? undefined
        : expectStringArray(raw.args, path, joinKeyPath(keyPath, "args"));
    const env =
      raw.env === undefined
        ? undefined
        : expectStringRecord(raw.env, path, joinKeyPath(keyPath, "env"));
    const disabled = readOptionalBoolean(raw, "disabled", path, keyPath);
    return {
      ...(type === undefined ? {} : { type }),
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(disabled === undefined ? {} : { disabled }),
    };
  }

  if (type === "http" || type === "sse") {
    rejectUnknownKeys(raw, MCP_REMOTE_KEYS, path, keyPath);
    const url = expectString(raw.url, path, joinKeyPath(keyPath, "url"));
    if (!HTTP_URL.test(url)) {
      throw new InvalidSettingsError(
        path,
        joinKeyPath(keyPath, "url"),
        "expected an http or https URL",
      );
    }
    const headers =
      raw.headers === undefined
        ? undefined
        : expectStringRecord(
            raw.headers,
            path,
            joinKeyPath(keyPath, "headers"),
          );
    const disabled = readOptionalBoolean(raw, "disabled", path, keyPath);
    return {
      type,
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(disabled === undefined ? {} : { disabled }),
    };
  }

  throw new InvalidSettingsError(
    path,
    joinKeyPath(keyPath, "type"),
    `expected "stdio", "http" or "sse", got ${type}`,
  );
}

function parseMcpSection(
  value: unknown,
  path: string,
): Readonly<Record<string, McpServerSettings>> {
  const raw = expectObject(value, path, "mcp");
  const servers: Record<string, McpServerSettings> = {};
  for (const [name, entry] of Object.entries(raw)) {
    servers[name] = parseMcpServer(entry, path, joinKeyPath("mcp", name));
  }
  return servers;
}

function parseHookCommand(
  value: unknown,
  path: string,
  keyPath: string,
): HookCommandSettings {
  const raw = expectObject(value, path, keyPath);
  rejectUnknownKeys(raw, HOOK_COMMAND_KEYS, path, keyPath);
  const type = expectString(raw.type, path, joinKeyPath(keyPath, "type"));
  if (type !== "command") {
    throw new InvalidSettingsError(
      path,
      joinKeyPath(keyPath, "type"),
      `expected "command", got ${type}`,
    );
  }
  const command = expectString(
    raw.command,
    path,
    joinKeyPath(keyPath, "command"),
  );
  const timeout = readOptionalInteger(raw, "timeout", path, keyPath, 1);
  const preserveRiskLevel = readOptionalBoolean(
    raw,
    "preserveRiskLevel",
    path,
    keyPath,
  );
  return {
    type: "command",
    command,
    ...(timeout === undefined ? {} : { timeout }),
    ...(preserveRiskLevel === undefined ? {} : { preserveRiskLevel }),
  };
}

function parseHookConfig(
  value: unknown,
  path: string,
  keyPath: string,
): HookConfigSettings {
  const raw = expectObject(value, path, keyPath);
  rejectUnknownKeys(raw, HOOK_KEYS, path, keyPath);
  const matcher = readOptionalString(raw, "matcher", path, keyPath);
  const commandRegex = readOptionalString(raw, "commandRegex", path, keyPath);
  if (!Array.isArray(raw.hooks)) {
    throw new InvalidSettingsError(
      path,
      joinKeyPath(keyPath, "hooks"),
      `expected an array of hook commands, got ${typeName(raw.hooks)}`,
    );
  }
  const hooks = raw.hooks.map((entry, index) =>
    parseHookCommand(
      entry,
      path,
      joinKeyPath(joinKeyPath(keyPath, "hooks"), index),
    ),
  );
  return {
    ...(matcher === undefined ? {} : { matcher }),
    ...(commandRegex === undefined ? {} : { commandRegex }),
    hooks,
  };
}

function parseHooksSection(value: unknown, path: string): HooksSettings {
  const raw = expectObject(value, path, "hooks");
  rejectUnknownKeys(raw, HOOK_SECTION_KEYS, path, "hooks");

  const events: { [Event in HookEvent]?: readonly HookConfigSettings[] } = {};
  for (const event of HOOK_EVENT_NAMES) {
    const entry = raw[event];
    if (entry === undefined) continue;
    if (!Array.isArray(entry)) {
      throw new InvalidSettingsError(
        path,
        joinKeyPath("hooks", event),
        `expected an array, got ${typeName(entry)}`,
      );
    }
    events[event] = entry.map((config, index) =>
      parseHookConfig(
        config,
        path,
        joinKeyPath(joinKeyPath("hooks", event), index),
      ),
    );
  }
  const hooksDisabled = readOptionalBoolean(
    raw,
    "hooksDisabled",
    path,
    "hooks",
  );
  const showHookOutput = readOptionalBoolean(
    raw,
    "showHookOutput",
    path,
    "hooks",
  );
  return {
    ...events,
    ...(hooksDisabled === undefined ? {} : { hooksDisabled }),
    ...(showHookOutput === undefined ? {} : { showHookOutput }),
  };
}

function parseOpaqueObjectSection(
  value: unknown,
  path: string,
  key: string,
): Readonly<Record<string, JsonObject>> {
  const raw = expectObject(value, path, key);
  const result: Record<string, JsonObject> = {};
  for (const [name, entry] of Object.entries(raw)) {
    result[name] = expectJsonObject(entry, path, joinKeyPath(key, name));
  }
  return result;
}

/**
 * Validate one parsed settings document. `source` is the file path (or a
 * synthetic label) recorded in every error.
 */
export function parseSettingsDocument(raw: unknown, source: string): Settings {
  const root = expectObject(raw, source, "");

  if ("general" in root) {
    throw new InvalidSettingsError(
      source,
      "general",
      'general settings belong at the root of the document; the "general" wrapper is not supported',
    );
  }
  rejectUnknownKeys(root, SETTINGS_KEYS, source, "");

  const hasGeneral = Object.keys(root).some(
    (key) => GENERAL_KEYS[key] === true,
  );
  const generalRaw: Record<string, unknown> = {};
  for (const key of Object.keys(root)) {
    if (GENERAL_KEYS[key] === true) generalRaw[key] = root[key];
  }
  const general = hasGeneral ? parseGeneral(generalRaw, source) : undefined;
  const mcp =
    root.mcp === undefined ? undefined : parseMcpSection(root.mcp, source);
  const hooks =
    root.hooks === undefined
      ? undefined
      : parseHooksSection(root.hooks, source);
  const droids =
    root.droids === undefined
      ? undefined
      : parseOpaqueObjectSection(root.droids, source, "droids");
  const skills =
    root.skills === undefined
      ? undefined
      : expectStringArray(root.skills, source, "skills");
  const outputStyles =
    root.outputStyles === undefined
      ? undefined
      : parseOpaqueObjectSection(root.outputStyles, source, "outputStyles");
  const commands =
    root.commands === undefined
      ? undefined
      : expectStringArray(root.commands, source, "commands");

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
 * Parse the text of a settings file. JSONC is accepted: `//` and block
 * comments and trailing commas are removed with their character positions
 * preserved, so a JSON syntax error still points at the right offset.
 */
export function parseSettingsText(text: string, source: string): Settings {
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(json));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidSettingsError(
      source,
      "",
      `invalid JSON: ${detail}`,
      error,
    );
  }
  return parseSettingsDocument(raw, source);
}

function skipString(chars: readonly string[], start: number): number {
  let index = start + 1;
  while (index < chars.length) {
    if (chars[index] === "\\") {
      index += 2;
      continue;
    }
    if (chars[index] === '"') return index + 1;
    index += 1;
  }
  return index;
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function stripComments(text: string): string {
  const chars = [...text];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === '"') {
      index = skipString(chars, index);
      continue;
    }
    if (char === "/" && chars[index + 1] === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (
        index < chars.length &&
        chars[index] !== "\n" &&
        chars[index] !== "\r"
      ) {
        chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && chars[index + 1] === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (
        index < chars.length &&
        !(chars[index] === "*" && chars[index + 1] === "/")
      ) {
        if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
        index += 1;
      }
      if (index < chars.length) {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

function stripTrailingCommas(text: string): string {
  const chars = [...text];
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === '"') {
      index = skipString(chars, index);
      continue;
    }
    if (chars[index] === ",") {
      let next = index + 1;
      while (next < chars.length && isJsonWhitespace(chars[next])) next += 1;
      if (chars[next] === "}" || chars[next] === "]") chars[index] = " ";
    }
    index += 1;
  }
  return chars.join("");
}

function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}
