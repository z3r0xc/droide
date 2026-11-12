/**
 * Typed wrappers for the helper's methods.
 *
 * Contract: `crates/README.md` (the nine methods) and `specs/90-native-layer.md`.
 * `NativeClient.request` deliberately returns unvalidated JSON — a helper is
 * another process, so its output is untrusted input. These wrappers are the
 * single place that parses it into typed values, and they throw
 * `NativeProtocolError` naming the method and field when the shape is wrong.
 */
import { NativeProtocolError } from "./errors.ts";
import type { NativeClient } from "./client.ts";

export interface SearchWalkResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

export interface SearchTextHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchTextResult {
  readonly hits: readonly SearchTextHit[];
  readonly truncated: boolean;
  readonly filesScanned: number;
}

export type SandboxProfileResult =
  | { readonly mechanism: "bubblewrap"; readonly argv: readonly string[] }
  | { readonly mechanism: "seatbelt"; readonly profile: string }
  | { readonly mechanism: "unconfined"; readonly reason: string };

function protocolError(method: string, detail: string): NativeProtocolError {
  return new NativeProtocolError(
    `${method} returned an unusable result: ${detail}`,
  );
}

function requireRecord(
  method: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError(method, "expected an object");
  }
  return value as Record<string, unknown>;
}

function requireString(
  method: string,
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string")
    throw protocolError(method, `field "${field}" must be a string`);
  return value;
}

function requireBoolean(
  method: string,
  record: Record<string, unknown>,
  field: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean")
    throw protocolError(method, `field "${field}" must be a boolean`);
  return value;
}

function requireNumber(
  method: string,
  record: Record<string, unknown>,
  field: string,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(method, `field "${field}" must be a finite number`);
  }
  return value;
}

function requireArray(
  method: string,
  record: Record<string, unknown>,
  field: string,
): unknown[] {
  const value = record[field];
  if (!Array.isArray(value))
    throw protocolError(method, `field "${field}" must be an array`);
  return value;
}

function requireStringArray(
  method: string,
  record: Record<string, unknown>,
  field: string,
): string[] {
  return requireArray(method, record, field).map((entry, index) => {
    if (typeof entry !== "string") {
      throw protocolError(
        method,
        `field "${field}[${index}]" must be a string`,
      );
    }
    return entry;
  });
}

export async function searchWalk(
  client: NativeClient,
  params: {
    readonly root: string;
    readonly glob?: string;
    readonly maxResults?: number;
    readonly includeHidden?: boolean;
  },
  options: { readonly timeoutMs?: number } = {},
): Promise<SearchWalkResult> {
  const method = "search.walk";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  return {
    paths: requireStringArray(method, result, "paths"),
    truncated: requireBoolean(method, result, "truncated"),
  };
}

export async function searchText(
  client: NativeClient,
  params: {
    readonly root: string;
    readonly query: string;
    readonly maxHits?: number;
    readonly caseSensitive?: boolean;
    readonly includeHidden?: boolean;
  },
  options: { readonly timeoutMs?: number } = {},
): Promise<SearchTextResult> {
  const method = "search.text";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  const hits = requireArray(method, result, "hits").map((entry, index) => {
    const hit = requireRecord(method, entry);
    const line = hit["line"];
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw protocolError(
        method,
        `field "hits[${index}].line" must be a positive integer`,
      );
    }
    return {
      path: requireString(method, hit, "path"),
      line,
      text: requireString(method, hit, "text"),
    };
  });
  return {
    hits,
    truncated: requireBoolean(method, result, "truncated"),
    filesScanned: requireNumber(method, result, "filesScanned"),
  };
}

export async function sandboxProfile(
  client: NativeClient,
  params: {
    readonly target?: string;
    readonly network?: boolean;
    readonly readPaths?: readonly string[];
    readonly writePaths?: readonly string[];
  },
  options: { readonly timeoutMs?: number } = {},
): Promise<SandboxProfileResult> {
  const method = "sandbox.profile";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  const mechanism = requireString(method, result, "mechanism");
  if (mechanism === "bubblewrap")
    return { mechanism, argv: requireStringArray(method, result, "argv") };
  if (mechanism === "seatbelt")
    return { mechanism, profile: requireString(method, result, "profile") };
  if (mechanism === "unconfined")
    return { mechanism, reason: requireString(method, result, "reason") };
  throw protocolError(method, `unknown mechanism "${mechanism}"`);
}

export async function ptyQuote(
  client: NativeClient,
  params: { readonly args: readonly string[]; readonly target?: string },
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const method = "pty.quote";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  return requireString(method, result, "commandLine");
}

export async function pathResolve(
  client: NativeClient,
  params: { readonly root: string; readonly path: string },
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const method = "path.resolve";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  return requireString(method, result, "path");
}

export async function secretsProtect(
  client: NativeClient,
  params: { readonly plaintext: string; readonly entropy?: string },
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const method = "secrets.protect";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  return requireString(method, result, "sealed");
}

export async function secretsUnprotect(
  client: NativeClient,
  params: { readonly sealed: string; readonly entropy?: string },
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const method = "secrets.unprotect";
  const result = requireRecord(
    method,
    await client.request(method, params, options),
  );
  return requireString(method, result, "plaintext");
}
