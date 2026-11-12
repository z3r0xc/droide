/**
 * Skills. Contract: `specs/60-extensions-mcp-and-skills.md` B46-B51 (discovery,
 * buckets, layout, frontmatter, validation, collisions, disable ledger) and
 * B53-B56 (listing budget, rendering, activation payload).
 *
 * Frontmatter is a deliberately small YAML subset: scalars, quoted scalars,
 * block lists, and one nested map level (`metadata`). Anything that needs a
 * real YAML reader — flow collections, anchors, tags, block scalars, tabs,
 * duplicate keys — is rejected rather than guessed at.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Bucket priority, highest first (B46). */
export const SKILL_BUCKET_ORDER = [
  "OrgPlugin",
  "Runtime",
  "Mission",
  "Automation",
  "FolderDir",
  "ProjectDir",
  "ProjectPlugin",
  "UserDir",
  "UserPlugin",
  "Dynamic",
  "Builtin",
] as const;

export type SkillBucket = (typeof SKILL_BUCKET_ORDER)[number];

export type SkillStatus = "active" | "shadowed" | "disabled" | "invalid";

export type SkillDisabledCause = "ledger" | "frontmatter";

/** Frontmatter scalars keep three types: strings, booleans and null. */
export type FrontmatterScalar = string | boolean | null;

export type FrontmatterValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | ReadonlyMap<string, FrontmatterScalar>;

export interface ParsedFrontmatter {
  readonly values: ReadonlyMap<string, FrontmatterValue>;
  readonly body: string;
}

export type FrontmatterParseResult =
  | { readonly ok: true; readonly frontmatter: ParsedFrontmatter }
  | { readonly ok: false; readonly error: string };

class StrictYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictYamlError";
  }
}

function parseScalar(text: string): FrontmatterScalar {
  const value = text.trim();
  if (value === "") return null;
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new StrictYamlError(`Unterminated quoted value: ${value}`);
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") {
        throw new StrictYamlError(`Quoted value is not a string: ${value}`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof StrictYamlError) throw error;
      throw new StrictYamlError(`Invalid quoted value: ${value}`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new StrictYamlError(`Unterminated quoted value: ${value}`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  const first = value[0] ?? "";
  if ("&*!|>{[@`".includes(first)) {
    throw new StrictYamlError(
      `Unsupported YAML construct (anchors, tags, flow collections and block scalars are not accepted): ${value}`,
    );
  }
  if (value.includes(" #")) {
    throw new StrictYamlError(`Inline comments are not accepted: ${value}`);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  return value;
}

type Collector =
  | { readonly kind: "list"; readonly items: FrontmatterScalar[] }
  | { readonly kind: "map"; readonly entries: Map<string, FrontmatterScalar> };

/**
 * Parse the leading `---` frontmatter block and return it with the remaining
 * markdown body. Rejects ambiguous YAML instead of interpreting it.
 */
export function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: false, error: "Skill file has no frontmatter block." };
  }

  const values = new Map<string, FrontmatterValue>();
  let pendingKey: string | undefined;
  let collector: Collector | undefined;
  let bodyStart = -1;

  const finalize = (): void => {
    if (pendingKey === undefined) return;
    if (collector === undefined) {
      values.set(pendingKey, null);
    } else if (collector.kind === "list") {
      values.set(pendingKey, [...collector.items]);
    } else {
      values.set(pendingKey, new Map(collector.entries));
    }
    pendingKey = undefined;
    collector = undefined;
  };

  try {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line === "---") {
        finalize();
        bodyStart = index + 1;
        break;
      }
      if (line.includes("\t")) {
        throw new StrictYamlError("Tabs are not accepted in frontmatter.");
      }
      if (line.trim() === "") continue;

      const indented = line.startsWith(" ");
      if (indented) {
        if (pendingKey === undefined) {
          throw new StrictYamlError(
            "Indented value without a key is ambiguous.",
          );
        }
        const listItem = /^  - (.*)$/.exec(line);
        if (listItem !== null) {
          if (collector?.kind === "map") {
            throw new StrictYamlError("A key cannot mix a list and a map.");
          }
          if (collector === undefined) {
            collector = { kind: "list", items: [] };
          }
          collector.items.push(parseScalar(listItem[1] ?? ""));
          continue;
        }
        const mapEntry = /^  ([A-Za-z0-9_-]+):(?: (.*))?$/.exec(line);
        if (mapEntry !== null) {
          if (collector?.kind === "list") {
            throw new StrictYamlError("A key cannot mix a list and a map.");
          }
          if (collector === undefined) {
            collector = { kind: "map", entries: new Map() };
          }
          const key = mapEntry[1] ?? "";
          if (collector.entries.has(key)) {
            throw new StrictYamlError(`Duplicate key "${key}".`);
          }
          collector.entries.set(key, parseScalar(mapEntry[2] ?? ""));
          continue;
        }
        throw new StrictYamlError(
          "Nested values must be a two-space list item or key.",
        );
      }

      finalize();
      const keyLine = /^([A-Za-z0-9_-]+):(?: (.*))?$/.exec(line);
      if (keyLine === null) {
        throw new StrictYamlError(`Not a "key: value" line: ${line}`);
      }
      const key = keyLine[1] ?? "";
      if (values.has(key)) {
        throw new StrictYamlError(`Duplicate key "${key}".`);
      }
      const rawValue = keyLine[2];
      if (rawValue === undefined) {
        pendingKey = key;
        continue;
      }
      values.set(key, parseScalar(rawValue));
    }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof StrictYamlError
          ? error.message
          : "Skill frontmatter could not be parsed.",
    };
  }

  if (bodyStart === -1) {
    return { ok: false, error: "Skill frontmatter block is not closed." };
  }
  return {
    ok: true,
    frontmatter: {
      values,
      body: lines.slice(bodyStart).join("\n").trim(),
    },
  };
}

/** Sanitized skill name: lowercase, non-alphanumerics become `-`. */
export function sanitizeSkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

const SKILL_NAME_CHARACTERS = /^[a-z0-9-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface SkillDocumentContext {
  readonly bucket: SkillBucket;
  readonly filePath: string;
  readonly pluginId?: string;
  readonly pluginScope?: string;
}

export interface SkillCandidate {
  readonly bucket: SkillBucket;
  readonly filePath: string;
  readonly name: string;
  readonly rawName?: string;
  readonly description: string;
  readonly body: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly allowedTools: readonly string[];
  readonly version?: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly pluginId?: string;
  readonly pluginScope?: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly valid: boolean;
}

function readOptionalString(
  values: ReadonlyMap<string, FrontmatterValue>,
  key: string,
  warnings: string[],
): string | undefined {
  const value = values.get(key);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  warnings.push(`Skill frontmatter "${key}" must be a string.`);
  return undefined;
}

function readOptionalBoolean(
  values: ReadonlyMap<string, FrontmatterValue>,
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const value = values.get(key);
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  // TODO(spec): B48 does not say what a non-boolean flag means; the default is
  // kept and the type problem is reported as a warning.
  warnings.push(`Skill frontmatter "${key}" must be a boolean.`);
  return fallback;
}

function readAllowedTools(
  values: ReadonlyMap<string, FrontmatterValue>,
  warnings: string[],
): readonly string[] {
  // `tools` is the deprecated alias of `allowed-tools` (B48).
  const raw = values.has("allowed-tools")
    ? values.get("allowed-tools")
    : values.get("tools");
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    // TODO(spec): B48 accepts a string but does not define whether it is a
    // single tool or a delimited list; it is kept as one entry.
    return [raw];
  }
  if (Array.isArray(raw)) {
    const tools: string[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry: unknown = raw[index];
      if (typeof entry !== "string") {
        warnings.push(
          `Skill frontmatter tool entry #${index} is not a string.`,
        );
        continue;
      }
      tools.push(entry);
    }
    return tools;
  }
  warnings.push('Skill frontmatter "allowed-tools" must be a string or list.');
  return [];
}

function readMetadata(
  values: ReadonlyMap<string, FrontmatterValue>,
  warnings: string[],
): Readonly<Record<string, string>> | undefined {
  const raw = values.get("metadata");
  if (raw === undefined || raw === null) return undefined;
  if (!(raw instanceof Map)) {
    warnings.push('Skill frontmatter "metadata" must be a map.');
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of raw) {
    if (typeof value !== "string") {
      warnings.push(`Skill metadata "${key}" must be a string.`);
      continue;
    }
    metadata[key] = value;
  }
  return metadata;
}

function validateName(rawName: string | undefined, errors: string[]): string {
  if (rawName === undefined || rawName.trim() === "") {
    errors.push("Skill must have a name");
    return "";
  }
  const sanitized = sanitizeSkillName(rawName);
  if (!SKILL_NAME_CHARACTERS.test(rawName)) {
    errors.push(
      "Skill name must contain only lowercase letters, numbers, and hyphens",
    );
  }
  if (sanitized === "") {
    errors.push("Skill name must contain at least one letter or number");
  }
  return sanitized;
}

interface CandidateFields {
  readonly rawName?: string;
  readonly description: string;
  readonly body: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly allowedTools: readonly string[];
  readonly version?: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
}

function buildCandidate(
  fields: CandidateFields,
  context: SkillDocumentContext,
): SkillCandidate {
  const errors: string[] = [];
  const name = validateName(fields.rawName, errors);
  if (fields.description === "") {
    // TODO(spec): B48 marks `description` required, but B49 names no identity
    // for a missing description; this message is the documented gap.
    errors.push("Skill must have a description");
  }
  if (fields.body === "") errors.push("Skill must have a system prompt");

  const warnings = [...fields.warnings];
  if (Array.from(fields.description).length > 200) {
    warnings.push("Skill description is longer than 200 characters.");
  }

  return {
    bucket: context.bucket,
    filePath: context.filePath,
    name,
    ...(fields.rawName !== undefined ? { rawName: fields.rawName } : {}),
    description: fields.description,
    body: fields.body,
    enabled: fields.enabled,
    userInvocable: fields.userInvocable,
    disableModelInvocation: fields.disableModelInvocation,
    allowedTools: fields.allowedTools,
    ...(fields.version !== undefined ? { version: fields.version } : {}),
    ...(fields.license !== undefined ? { license: fields.license } : {}),
    ...(fields.compatibility !== undefined
      ? { compatibility: fields.compatibility }
      : {}),
    ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
    ...(context.pluginId !== undefined ? { pluginId: context.pluginId } : {}),
    ...(context.pluginScope !== undefined
      ? { pluginScope: context.pluginScope }
      : {}),
    errors,
    warnings,
    valid: errors.length === 0,
  };
}

/** Parse one `SKILL.md` (or embedded builtin text) into a candidate. */
export function parseSkillDocument(
  markdown: string,
  context: SkillDocumentContext,
): SkillCandidate {
  const parsed = parseFrontmatter(markdown);
  if (!parsed.ok) {
    // TODO(spec): B49 names no identity for an unparseable frontmatter block;
    // the parser's own message is surfaced instead.
    return {
      bucket: context.bucket,
      filePath: context.filePath,
      name: "",
      description: "",
      body: "",
      enabled: true,
      userInvocable: true,
      disableModelInvocation: false,
      allowedTools: [],
      ...(context.pluginId !== undefined ? { pluginId: context.pluginId } : {}),
      ...(context.pluginScope !== undefined
        ? { pluginScope: context.pluginScope }
        : {}),
      errors: [parsed.error],
      warnings: [],
      valid: false,
    };
  }

  const { values, body } = parsed.frontmatter;
  const warnings: string[] = [];
  const rawName = readOptionalString(values, "name", warnings);
  const description = readOptionalString(values, "description", warnings);
  const rawVersion = values.get("version");
  const version = typeof rawVersion === "string" ? rawVersion : undefined;
  if (version !== undefined && !SEMVER.test(version)) {
    warnings.push(`Skill version "${version}" is not a semantic version.`);
  }

  const license = readOptionalString(values, "license", warnings);
  const compatibility = readOptionalString(values, "compatibility", warnings);
  const metadata = readMetadata(values, warnings);

  return buildCandidate(
    {
      ...(rawName !== undefined ? { rawName } : {}),
      description: description ?? "",
      body,
      enabled: readOptionalBoolean(values, "enabled", true, warnings),
      userInvocable: readOptionalBoolean(
        values,
        "user-invocable",
        true,
        warnings,
      ),
      disableModelInvocation: readOptionalBoolean(
        values,
        "disable-model-invocation",
        false,
        warnings,
      ),
      allowedTools: readAllowedTools(values, warnings),
      ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      warnings,
    },
    context,
  );
}

/** A code-authored skill (B52): no file on disk. */
export interface InMemorySkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly filePath?: string;
  readonly enabled?: boolean;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly allowedTools?: readonly string[];
  readonly version?: string;
}

function candidateFromInMemory(skill: InMemorySkill): SkillCandidate {
  const name = sanitizeSkillName(skill.name);
  return buildCandidate(
    {
      rawName: skill.name,
      description: skill.description,
      body: skill.body,
      enabled: skill.enabled ?? true,
      userInvocable: skill.userInvocable ?? true,
      disableModelInvocation: skill.disableModelInvocation ?? false,
      allowedTools: skill.allowedTools ?? [],
      ...(skill.version !== undefined ? { version: skill.version } : {}),
      warnings: [],
    },
    {
      bucket: "Builtin",
      filePath: skill.filePath ?? `builtin:${name}`,
    },
  );
}

export interface SkillRoot {
  readonly bucket: SkillBucket;
  readonly dir: string;
  readonly pluginId?: string;
  readonly pluginScope?: string;
}

export interface SkillDiscoveryOptions {
  readonly roots: readonly SkillRoot[];
  readonly builtinSkills?: readonly InMemorySkill[];
  /** The merged `disabledSkills` ledger (B51). */
  readonly disabledSkills?: readonly string[];
  readonly disableBuiltinSkills?: boolean;
  readonly readFile?: (path: string) => string;
  readonly readSkillsDirectory?: (dir: string) => readonly string[];
}

export interface ShadowedBy {
  readonly bucket: SkillBucket;
  readonly filePath: string;
  readonly sameBucket: boolean;
}

export interface EffectiveSkill {
  readonly name: string;
  readonly rawName?: string;
  readonly bucket: SkillBucket;
  readonly filePath: string;
  readonly description: string;
  readonly body: string;
  readonly status: SkillStatus;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly enabled: boolean;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly allowedTools: readonly string[];
  readonly version?: string;
  readonly pluginId?: string;
  readonly pluginScope?: string;
  readonly shadowedBy?: ShadowedBy;
  readonly disabledCause?: SkillDisabledCause;
}

export interface SkillCollision {
  readonly name: string;
  readonly winner: { readonly bucket: SkillBucket; readonly filePath: string };
  readonly loser: { readonly bucket: SkillBucket; readonly filePath: string };
  readonly sameBucket: boolean;
}

export interface SkillDiscoveryResult {
  readonly skills: readonly EffectiveSkill[];
  readonly collisions: readonly SkillCollision[];
}

/**
 * The disable ledger (B51): a union across settings levels, stored as
 * sanitized names. A name listed at any level stays disabled.
 */
export function mergeDisabledSkillLedger(
  levels: readonly (readonly string[])[],
): ReadonlySet<string> {
  const disabled = new Set<string>();
  for (const level of levels) {
    for (const raw of level) {
      const name = sanitizeSkillName(raw);
      if (name !== "") disabled.add(name);
    }
  }
  return disabled;
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function defaultReadSkillsDirectory(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNames);
  } catch {
    return [];
  }
}

function toEffective(
  candidate: SkillCandidate,
  status: SkillStatus,
): EffectiveSkill {
  return {
    name: candidate.name,
    ...(candidate.rawName !== undefined ? { rawName: candidate.rawName } : {}),
    bucket: candidate.bucket,
    filePath: candidate.filePath,
    description: candidate.description,
    body: candidate.body,
    status,
    errors: candidate.errors,
    warnings: candidate.warnings,
    enabled: candidate.enabled,
    userInvocable: candidate.userInvocable,
    disableModelInvocation: candidate.disableModelInvocation,
    allowedTools: candidate.allowedTools,
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
    ...(candidate.license !== undefined ? { license: candidate.license } : {}),
    ...(candidate.compatibility !== undefined
      ? { compatibility: candidate.compatibility }
      : {}),
    ...(candidate.metadata !== undefined
      ? { metadata: candidate.metadata }
      : {}),
    ...(candidate.pluginId !== undefined
      ? { pluginId: candidate.pluginId }
      : {}),
    ...(candidate.pluginScope !== undefined
      ? { pluginScope: candidate.pluginScope }
      : {}),
  };
}

function bucketRank(bucket: SkillBucket): number {
  return SKILL_BUCKET_ORDER.indexOf(bucket);
}

function collectCandidates(
  options: SkillDiscoveryOptions,
): readonly SkillCandidate[] {
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const readSkillsDirectory =
    options.readSkillsDirectory ?? defaultReadSkillsDirectory;
  const disableBuiltin = options.disableBuiltinSkills === true;

  const roots = options.roots
    .map((root, index) => ({ root, index }))
    .sort((left, right) => {
      const rank = bucketRank(left.root.bucket) - bucketRank(right.root.bucket);
      return rank !== 0 ? rank : left.index - right.index;
    });

  const candidates: SkillCandidate[] = [];
  for (const { root } of roots) {
    if (disableBuiltin && root.bucket === "Builtin") continue;
    for (const directory of readSkillsDirectory(root.dir)) {
      const filePath = join(root.dir, directory, "SKILL.md");
      let text: string;
      try {
        text = readFile(filePath);
      } catch {
        continue;
      }
      candidates.push(
        parseSkillDocument(text, {
          bucket: root.bucket,
          filePath,
          ...(root.pluginId !== undefined ? { pluginId: root.pluginId } : {}),
          ...(root.pluginScope !== undefined
            ? { pluginScope: root.pluginScope }
            : {}),
        }),
      );
    }
  }

  if (!disableBuiltin) {
    for (const skill of options.builtinSkills ?? []) {
      candidates.push(candidateFromInMemory(skill));
    }
  }
  return candidates;
}

/**
 * Resolve the effective skill set (B46-B51). Candidates are visited in bucket
 * priority order; a valid candidate claims its sanitized name, the first claim
 * in a bucket and across buckets wins, and later same-name candidates are
 * shadowed. The ledger and `enabled: false` disable the winner without
 * promoting anything shadowed by it.
 */
export function discoverSkills(
  options: SkillDiscoveryOptions,
): SkillDiscoveryResult {
  const candidates = collectCandidates(options);
  const ledger = new Set<string>();
  for (const raw of options.disabledSkills ?? []) {
    const name = sanitizeSkillName(raw);
    if (name !== "") ledger.add(name);
  }

  const claims = new Map<string, SkillCandidate>();
  const skills: EffectiveSkill[] = [];
  const collisions: SkillCollision[] = [];

  for (const candidate of candidates) {
    if (!candidate.valid || candidate.name === "") {
      skills.push(toEffective(candidate, "invalid"));
      continue;
    }
    const winner = claims.get(candidate.name);
    if (winner === undefined) {
      claims.set(candidate.name, candidate);
      skills.push(toEffective(candidate, "active"));
      continue;
    }
    const sameBucket = winner.bucket === candidate.bucket;
    const shadowed = toEffective(candidate, "shadowed");
    skills.push({
      ...shadowed,
      shadowedBy: {
        bucket: winner.bucket,
        filePath: winner.filePath,
        sameBucket,
      },
    });
    collisions.push({
      name: candidate.name,
      winner: { bucket: winner.bucket, filePath: winner.filePath },
      loser: { bucket: candidate.bucket, filePath: candidate.filePath },
      sameBucket,
    });
  }

  const resolved: EffectiveSkill[] = skills.map((skill): EffectiveSkill => {
    if (skill.status !== "active") return skill;
    if (ledger.has(skill.name)) {
      return { ...skill, status: "disabled", disabledCause: "ledger" };
    }
    if (!skill.enabled) {
      return { ...skill, status: "disabled", disabledCause: "frontmatter" };
    }
    return skill;
  });

  return { skills: resolved, collisions };
}

/** One safe line, capped at the given number of code points. */
export function capSkillTrigger(trigger: string, maxCodePoints = 200): string {
  const safe = trigger.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim();
  const codePoints = Array.from(safe);
  if (codePoints.length <= maxCodePoints) return safe;
  if (maxCodePoints <= 0) return "";
  return `${codePoints.slice(0, maxCodePoints - 1).join("")}…`;
}

export const SKILLS_REMINDER_HEADER =
  "Available skills (name: when to use it; activate one by exact name with the Skill tool, which returns its full instructions):";

export const SKILL_TOOL_DESCRIPTION =
  "Activate one skill by exact name from the latest system reminder. Use a relevant skill proactively, but never invent a name or reactivate an active skill.";

export const SKILL_LISTING_FALLBACK_CHARACTERS = 8000;
export const MAX_SKILL_TRIGGER_CODE_POINTS = 200;

/**
 * Listing budget (B54): 1.5 % of the working token limit at 4 chars/token;
 * 8000 characters when no token limit is known.
 */
export function skillListingBudget(workingTokenLimit?: number): number {
  if (workingTokenLimit === undefined || workingTokenLimit <= 0) {
    return SKILL_LISTING_FALLBACK_CHARACTERS;
  }
  return Math.floor((workingTokenLimit * 15 * 4) / 1000);
}

function triggerPriority(skill: EffectiveSkill): number {
  // Builtin and Automation keep their trigger unconditionally; the rest are
  // upgraded with personal (user directory) above plugin skills.
  if (skill.bucket === "Builtin" || skill.bucket === "Automation") return -1;
  if (skill.bucket === "UserDir") return 0;
  if (
    skill.bucket === "OrgPlugin" ||
    skill.bucket === "ProjectPlugin" ||
    skill.bucket === "UserPlugin"
  ) {
    return 2;
  }
  // TODO(spec): B54 orders "personal above plugin" but does not rank the
  // remaining buckets; they keep discovery order within this tier.
  return 1;
}

/**
 * Render the per-turn skills reminder (B53, B54). One line per model-invocable
 * active skill; every name is reserved first, then the remaining budget buys
 * triggers. Builtin and automation triggers are never dropped.
 */
export function renderSkillsReminder(
  skills: readonly EffectiveSkill[],
  options: { readonly workingTokenLimit?: number } = {},
): string {
  const eligible = skills.filter(
    (skill) => skill.status === "active" && !skill.disableModelInvocation,
  );
  if (eligible.length === 0) return "";

  const budget = skillListingBudget(options.workingTokenLimit);
  const triggers = eligible.map((skill) =>
    capSkillTrigger(skill.description, MAX_SKILL_TRIGGER_CODE_POINTS),
  );

  const reserved = eligible.reduce(
    (total, skill) => total + skill.name.length + 1,
    0,
  );
  let remaining = budget - reserved;

  const included = new Array<boolean>(eligible.length).fill(false);
  for (let index = 0; index < eligible.length; index += 1) {
    const skill = eligible[index];
    if (skill === undefined) continue;
    if (triggerPriority(skill) !== -1) continue;
    const trigger = triggers[index] ?? "";
    included[index] = trigger !== "";
    if (included[index]) remaining -= trigger.length + 2;
  }

  const upgradeOrder = eligible
    .map((skill, index) => ({ skill, index }))
    .filter(({ skill }) => triggerPriority(skill) >= 0)
    .sort((left, right) => {
      const rank = triggerPriority(left.skill) - triggerPriority(right.skill);
      return rank !== 0 ? rank : left.index - right.index;
    });

  for (const { index } of upgradeOrder) {
    const trigger = triggers[index] ?? "";
    if (trigger === "") continue;
    const cost = trigger.length + 2;
    if (cost > remaining) continue;
    included[index] = true;
    remaining -= cost;
  }

  const lines = eligible.map((skill, index) => {
    const trigger = triggers[index] ?? "";
    return included[index] && trigger !== ""
      ? `${skill.name}: ${trigger}`
      : skill.name;
  });
  return [SKILLS_REMINDER_HEADER, ...lines].join("\n");
}

export type SkillActivationFailureCode =
  "skillNotFound" | "skillDisabled" | "skillInvalid";

export type SkillActivationResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: SkillActivationFailureCode;
      readonly message: string;
    };

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Activate one skill by name (B56). The winner of the name is used even when
 * it is disabled; shadowed duplicates are never resolvable on their own.
 */
export function activateSkill(
  skills: readonly EffectiveSkill[],
  requestedName: string,
): SkillActivationResult {
  const name = sanitizeSkillName(requestedName);
  // A claimed name (active or disabled) always answers first; an unrelated
  // invalid document that happens to sanitize to the same name never masks it.
  const claimed = skills.find(
    (entry) =>
      entry.name === name &&
      (entry.status === "active" || entry.status === "disabled"),
  );
  if (claimed?.status === "disabled") {
    return {
      ok: false,
      code: "skillDisabled",
      message: `Skill "${claimed.name}" is disabled.`,
    };
  }
  if (claimed === undefined) {
    const invalid = skills.find(
      (entry) => entry.name === name && entry.status === "invalid",
    );
    if (invalid !== undefined) {
      return {
        ok: false,
        code: "skillInvalid",
        message: `Skill "${invalid.name}" is invalid: ${invalid.errors.join("; ")}`,
      };
    }
    return {
      ok: false,
      code: "skillNotFound",
      message: `No skill named "${requestedName}" is available.`,
    };
  }
  const skill = claimed;
  return {
    ok: true,
    text: [
      `Skill "${skill.name}" is now active.`,
      `<skill name="${escapeAttribute(skill.name)}" filePath="${escapeAttribute(
        skill.filePath,
      )}">`,
      skill.body,
      "</skill>",
    ].join("\n"),
  };
}
