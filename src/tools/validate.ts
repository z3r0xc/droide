/**
 * The tool-input validator.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B7 (validate before execution,
 * unknown keys stripped, defaults filled) and B8 (the rejection text). This is
 * a deliberately small algebra — the tool schemas only use objects, strings,
 * numbers, booleans, enums, arrays, unions, optional fields and defaults — so
 * no third-party dependency is needed.
 */

/** A description shown in B8's parameter guide. */
export interface SchemaBase {
  readonly description?: string;
  /** Absent from the input is not an error; the key is left out of the result. */
  readonly optional?: boolean;
}

export interface AnySchema extends SchemaBase {
  readonly kind: "any";
}

export interface StringSchema extends SchemaBase {
  readonly kind: "string";
  readonly default?: string;
}

export interface NumberSchema extends SchemaBase {
  readonly kind: "number";
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly default?: number;
}

export interface BooleanSchema extends SchemaBase {
  readonly kind: "boolean";
  readonly default?: boolean;
}

export interface EnumSchema extends SchemaBase {
  readonly kind: "enum";
  readonly values: readonly string[];
  readonly default?: string;
}

export interface ArraySchema extends SchemaBase {
  readonly kind: "array";
  readonly items: Schema;
  readonly default?: readonly unknown[];
}

export interface ObjectSchema extends SchemaBase {
  readonly kind: "object";
  readonly properties: Readonly<Record<string, Schema>>;
}

export interface UnionSchema extends SchemaBase {
  readonly kind: "union";
  readonly options: readonly Schema[];
}

export type Schema =
  | AnySchema
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | EnumSchema
  | ArraySchema
  | ObjectSchema
  | UnionSchema;

export interface ValidationIssue {
  /** Dotted path from the root, e.g. `input.pattern` or `input.items.0`. */
  readonly path: string;
  /** What was expected, without the path prefix. */
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

type RawObject = Readonly<Record<string, unknown>>;

function isRawObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receivedName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function expectedName(schema: Schema): string {
  switch (schema.kind) {
    case "string":
      return "string";
    case "number":
      return schema.integer === true ? "an integer" : "number";
    case "boolean":
      return "boolean";
    case "enum":
      return `one of ${schema.values.join(", ")}`;
    case "array":
      return "array";
    case "object":
      return "object";
    case "union":
      return schema.options.map(expectedName).join(" or ");
    case "any":
      return "any value";
  }
}

function joinPath(parent: string, key: string | number): string {
  return `${parent}.${String(key)}`;
}

function issue(
  path: string,
  expected: Schema,
  received?: unknown,
): ValidationIssue {
  return {
    path,
    message:
      received === undefined
        ? `expected ${expectedName(expected)}`
        : `expected ${expectedName(expected)}, received ${receivedName(received)}`,
  };
}

/** One schema application. Returns the cleaned value and records issues. */
function apply(
  schema: Schema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): unknown {
  switch (schema.kind) {
    case "any":
      return value;

    case "string": {
      if (typeof value === "string") return value;
      issues.push(issue(path, schema, value));
      return undefined;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(issue(path, schema, value));
        return undefined;
      }
      if (schema.integer === true && !Number.isInteger(value)) {
        issues.push({ path, message: "expected an integer" });
        return undefined;
      }
      if (schema.min !== undefined && value < schema.min) {
        issues.push({ path, message: `expected a number >= ${schema.min}` });
        return undefined;
      }
      if (schema.max !== undefined && value > schema.max) {
        issues.push({ path, message: `expected a number <= ${schema.max}` });
        return undefined;
      }
      return value;
    }

    case "boolean": {
      if (typeof value === "boolean") return value;
      issues.push(issue(path, schema, value));
      return undefined;
    }

    case "enum": {
      if (typeof value === "string" && schema.values.includes(value)) {
        return value;
      }
      issues.push(issue(path, schema, value));
      return undefined;
    }

    case "array": {
      if (!Array.isArray(value)) {
        issues.push(issue(path, schema, value));
        return undefined;
      }
      const items: unknown[] = [];
      for (const [index, item] of value.entries()) {
        items.push(apply(schema.items, item, joinPath(path, index), issues));
      }
      return items;
    }

    case "object": {
      if (!isRawObject(value)) {
        issues.push(issue(path, schema, value));
        return undefined;
      }
      // `removeAdditional`: keys the schema does not name are dropped.
      const result: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties)) {
        const present = Object.hasOwn(value, key) && value[key] !== undefined;
        if (!present) {
          if (property.optional === true) continue;
          if ("default" in property && property.default !== undefined) {
            result[key] = structuredClone(property.default);
            continue;
          }
          issues.push(issue(joinPath(path, key), property));
          continue;
        }
        const applied = apply(property, value[key], joinPath(path, key), issues);
        if (applied !== undefined) result[key] = applied;
      }
      return result;
    }

    case "union": {
      // The branch with the fewest issues is the shape the caller most likely
      // meant (B8's "closest union branch" rule).
      let best: readonly ValidationIssue[] | undefined;
      for (const option of schema.options) {
        const branchIssues: ValidationIssue[] = [];
        const applied = apply(option, value, path, branchIssues);
        if (branchIssues.length === 0) return applied;
        if (best === undefined || branchIssues.length < best.length) {
          best = branchIssues;
        }
      }
      issues.push(...(best ?? [issue(path, schema, value)]));
      return undefined;
    }
  }
}

/** Validates `value` against `schema`, filling defaults and dropping unknown keys. */
export function parseInput(schema: Schema, value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const applied = apply(schema, value, "input", issues);
  return issues.length === 0
    ? { ok: true, value: applied }
    : { ok: false, issues };
}

/** The issue list as B8 renders it, one `path: message` line per issue. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((entry) => `${entry.path}: ${entry.message}`).join("\n");
}

interface DescribedParameter {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

function parameterList(schema: Schema): readonly DescribedParameter[] {
  if (schema.kind !== "object") return [];
  const required = Object.entries(schema.properties)
    .filter(([, property]) => property.optional !== true)
    .map(([name]) => name);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    required: required.includes(name) && !("default" in property),
    description: property.description ?? "",
  }));
}

/**
 * B8's rejection body: the schema error, the parameter guide, and the retry
 * sentence. The guide is omitted only when the schema names no parameters.
 */
export function formatValidationFailure(
  toolId: string,
  issues: readonly ValidationIssue[],
  schema: Schema,
): string {
  const error = formatIssues(issues);
  const parameters = parameterList(schema);
  if (parameters.length === 0) {
    return `${error}\n\nTool "${toolId}" accepts no parameters.\n\nPlease retry with valid parameters.`;
  }
  const guide = parameters
    .map(
      (parameter) =>
        `- ${parameter.name}${parameter.required ? " (required)" : ""}: ${parameter.description}`,
    )
    .join("\n");
  return (
    `${error}\n\nTool "${toolId}" accepts the following parameters:\n` +
    `${guide}\n\nPlease retry with valid parameters.`
  );
}

/** Accepts a string or an array of strings (JSON-text arrays are parsed too). */
export function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.every((item): item is string => typeof item === "string")
      ) {
        return parsed;
      }
    } catch {
      // Not JSON: the whole string is one pattern.
    }
  }
  return [value];
}