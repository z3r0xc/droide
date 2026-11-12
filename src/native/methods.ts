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

export interface PtySpawnOptions {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

export interface PtyReadResult {
  /** Base64 payload; the caller decodes with the helper's encoding. */
  readonly data: string;
  readonly exited: boolean;
  readonly exitCode: number | null;
}

/** Start a pseudo-terminal session; the id is opaque and lives until `ptyClose`. */
export async function ptySpawn(
  client: NativeClient,
  options: PtySpawnOptions,
  request: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const method = "pty.spawn";
  const params: Record<string, unknown> = {
    program: options.program,
    args: [...(options.args ?? [])],
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
  };
  if (options.cwd !== undefined) params["cwd"] = options.cwd;
  if (options.env !== undefined) params["env"] = options.env;
  const result = requireRecord(
    method,
    await client.request(method, params, request),
  );
  return requireString(method, result, "sessionId");
}

/** Read whatever is available, waiting up to `timeoutMs` for the first byte. */
export async function ptyRead(
  client: NativeClient,
  sessionId: string,
  options: {
    readonly timeoutMs?: number;
    readonly requestTimeoutMs?: number;
  } = {},
): Promise<PtyReadResult> {
  const method = "pty.read";
  const result = requireRecord(
    method,
    await client.request(
      method,
      {
        sessionId,
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      },
      options.requestTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.requestTimeoutMs },
    ),
  );
  const exitCode = result["exitCode"];
  if (
    exitCode !== null &&
    (typeof exitCode !== "number" || !Number.isInteger(exitCode))
  ) {
    throw protocolError(method, 'field "exitCode" must be an integer or null');
  }
  return {
    data: requireString(method, result, "data"),
    exited: requireBoolean(method, result, "exited"),
    exitCode: typeof exitCode === "number" ? exitCode : null,
  };
}

export async function ptyWrite(
  client: NativeClient,
  sessionId: string,
  data: string,
  request: { readonly timeoutMs?: number } = {},
): Promise<number> {
  const method = "pty.write";
  const result = requireRecord(
    method,
    await client.request(method, { sessionId, data }, request),
  );
  return requireNumber(method, result, "written");
}

export async function ptyResize(
  client: NativeClient,
  sessionId: string,
  size: { readonly cols: number; readonly rows: number },
  request: { readonly timeoutMs?: number } = {},
): Promise<void> {
  await client.request("pty.resize", { sessionId, ...size }, request);
}

export async function ptyKill(
  client: NativeClient,
  sessionId: string,
  request: { readonly timeoutMs?: number } = {},
): Promise<number | null> {
  const method = "pty.kill";
  const result = requireRecord(
    method,
    await client.request(method, { sessionId }, request),
  );
  const exitCode = result["exitCode"];
  if (
    exitCode !== null &&
    (typeof exitCode !== "number" || !Number.isInteger(exitCode))
  ) {
    throw protocolError(method, 'field "exitCode" must be an integer or null');
  }
  return typeof exitCode === "number" ? exitCode : null;
}

/** Idempotent: closing an already-closed session succeeds. */
export async function ptyClose(
  client: NativeClient,
  sessionId: string,
  request: { readonly timeoutMs?: number } = {},
): Promise<void> {
  await client.request("pty.close", { sessionId }, request);
}
