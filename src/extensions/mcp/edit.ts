/**
 * Read-modify-write for the two `mcp.json` files. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B1-B6 (files, JSONC syntax, server
 * shape, name canonicalization, add/remove) and B24 (persistent
 * permissions).
 *
 * **Edits are surgical.** The document is never re-serialised wholesale: a
 * server is appended or deleted through its own member span, and a
 * permission entry is deleted the same way, so unrelated comments,
 * indentation and key order survive a write. No backup file is written; the
 * atomic temp-file-plus-rename in {@link writeMcpConfigText} is what keeps a
 * failed write from damaging the original.
 *
 * A document that does not parse, whose root is not an object, or whose
 * `persistentPermissions` has a shape this module does not understand is
 * refused. Refusing beats guessing: silently rewriting an unknown document
 * would destroy configuration the user meant to keep.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { isRecord } from "../guards.ts";
import { JsoncParseError, parseJsonc } from "../jsonc.ts";
import { parseMcpServerConfig } from "./config.ts";
import { normalizeServerName } from "./naming.ts";

/** The two scopes a session reads (B1). */
export type McpConfigScope = "user" | "project";

/** One `mcp.json` file selected for a read-modify-write. */
export interface McpEditTarget {
  readonly path: string;
  readonly scope: McpConfigScope;
}

/**
 * Filesystem surface of this module. `readFile` returns `undefined` for a
 * missing file (a missing `mcp.json` is not an error, B2); every write goes
 * through `writeFile` + `rename` so a crash cannot truncate the original.
 */
export interface McpConfigIo {
  readonly readFile: (path: string) => string | undefined;
  readonly makeDirectory: (path: string) => void;
  readonly writeFile: (path: string, text: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export type McpEditErrorCode =
  | "invalid-jsonc"
  | "invalid-document"
  | "invalid-name"
  | "invalid-server"
  | "duplicate-server"
  | "unknown-server"
  | "invalid-permissions"
  | "unknown-permission"
  | "read-failed"
  | "write-failed";

export class McpEditError extends Error {
  readonly code: McpEditErrorCode;
  readonly path: string;

  constructor(
    code: McpEditErrorCode,
    message: string,
    path: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "McpEditError";
    this.code = code;
    this.path = path;
  }
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Real filesystem; every path rule stays with the caller. */
export const defaultMcpConfigIo: McpConfigIo = {
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new McpEditError(
        "read-failed",
        `mcp.json could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        path,
        { cause: error },
      );
    }
  },
  makeDirectory: (path) => {
    mkdirSync(path, { recursive: true });
  },
  writeFile: (path, text) => {
    writeFileSync(path, text, "utf8");
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  remove: (path) => {
    rmSync(path, { force: true });
  },
};

interface JsoncToken {
  readonly kind: "punctuation" | "string" | "number" | "literal";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface JsoncScalarNode {
  readonly kind: "scalar";
  readonly start: number;
  readonly end: number;
}

interface JsoncArrayNode {
  readonly kind: "array";
  readonly start: number;
  readonly end: number;
}

export interface JsoncObjectMember {
  readonly key: string;
  readonly keyStart: number;
  readonly value: JsoncObjectNode | JsoncArrayNode | JsoncScalarNode;
  /** Exclusive end of the value. */
  readonly end: number;
}

export interface JsoncObjectNode {
  readonly kind: "object";
  readonly start: number;
  readonly end: number;
  readonly members: readonly JsoncObjectMember[];
}

type JsoncNode = JsoncObjectNode | JsoncArrayNode | JsoncScalarNode;

function structureError(message: string): Error {
  return new Error(message);
}

function isWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n" ||
    character === "\ufeff"
  );
}

function tokenizeJsonc(text: string): readonly JsoncToken[] {
  const tokens: JsoncToken[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";

    if (isWhitespace(character)) {
      index += 1;
      continue;
    }

    if (character === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      let closed = false;
      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          index += 2;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw structureError("unterminated block comment");
      continue;
    }

    const start = index;
    if (character === '"') {
      index += 1;
      let decoded = "";
      let closed = false;
      while (index < text.length) {
        const next = text[index] ?? "";
        if (next === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (next === "\\") {
          const escape = text[index + 1] ?? "";
          index += 2;
          switch (escape) {
            case '"':
            case "\\":
            case "/":
              decoded += escape;
              break;
            case "b":
              decoded += "\b";
              break;
            case "f":
              decoded += "\f";
              break;
            case "n":
              decoded += "\n";
              break;
            case "r":
              decoded += "\r";
              break;
            case "t":
              decoded += "\t";
              break;
            case "u": {
              const hex = text.slice(index, index + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                throw structureError("invalid unicode escape in string");
              }
              decoded += String.fromCharCode(Number.parseInt(hex, 16));
              index += 4;
              break;
            }
            default:
              throw structureError("invalid escape in string");
          }
          continue;
        }
        decoded += next;
        index += 1;
      }
      if (!closed) throw structureError("unterminated string");
      tokens.push({ kind: "string", value: decoded, start, end: index });
      continue;
    }

    if ("{}[]:,".includes(character)) {
      index += 1;
      tokens.push({
        kind: "punctuation",
        value: character,
        start,
        end: index,
      });
      continue;
    }

    const rest = text.slice(index);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number !== null) {
      index += number[0].length;
      tokens.push({ kind: "number", value: number[0], start, end: index });
      continue;
    }
    const literal = /^(?:true|false|null)/.exec(rest);
    if (literal !== null) {
      index += literal[0].length;
      tokens.push({
        kind: "literal",
        value: literal[0],
        start,
        end: index,
      });
      continue;
    }

    throw structureError(`unexpected character "${character}"`);
  }
  return tokens;
}

class JsoncStructureParser {
  private index = 0;
  private readonly tokens: readonly JsoncToken[];

  constructor(tokens: readonly JsoncToken[]) {
    this.tokens = tokens;
  }

  parseObjectDocument(): JsoncObjectNode {
    const node = this.parseValue();
    if (this.index !== this.tokens.length) {
      throw structureError("trailing content after the document");
    }
    if (node.kind !== "object") {
      throw structureError("the document root must be an object");
    }
    return node;
  }

  private peek(): JsoncToken | undefined {
    return this.tokens[this.index];
  }

  private next(): JsoncToken {
    const token = this.tokens[this.index];
    if (token === undefined) {
      throw structureError("unexpected end of document");
    }
    this.index += 1;
    return token;
  }

  private parseValue(): JsoncNode {
    const token = this.next();
    if (token.kind === "punctuation" && token.value === "{") {
      return this.parseObject(token);
    }
    if (token.kind === "punctuation" && token.value === "[") {
      return this.parseArray(token);
    }
    if (
      token.kind === "string" ||
      token.kind === "number" ||
      token.kind === "literal"
    ) {
      return { kind: "scalar", start: token.start, end: token.end };
    }
    throw structureError("expected a JSON value");
  }

  private parseObject(open: JsoncToken): JsoncObjectNode {
    const members: JsoncObjectMember[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw structureError("unterminated object");
      if (token.kind === "punctuation" && token.value === "}") {
        this.index += 1;
        return {
          kind: "object",
          start: open.start,
          end: token.end,
          members,
        };
      }
      if (token.kind !== "string") {
        throw structureError("object keys must be strings");
      }
      this.index += 1;
      const colon = this.next();
      if (!(colon.kind === "punctuation" && colon.value === ":")) {
        throw structureError('expected ":" after an object key');
      }
      const value = this.parseValue();
      members.push({
        key: token.value,
        keyStart: token.start,
        value,
        end: value.end,
      });
      const separator = this.peek();
      if (separator === undefined) {
        throw structureError("unterminated object");
      }
      if (separator.kind === "punctuation" && separator.value === ",") {
        this.index += 1;
        continue;
      }
      if (separator.kind === "punctuation" && separator.value === "}") {
        this.index += 1;
        return {
          kind: "object",
          start: open.start,
          end: separator.end,
          members,
        };
      }
      throw structureError('expected "," or "}" in an object');
    }
  }

  private parseArray(open: JsoncToken): JsoncArrayNode {
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw structureError("unterminated array");
      if (token.kind === "punctuation" && token.value === "]") {
        this.index += 1;
        return { kind: "array", start: open.start, end: token.end };
      }
      this.parseValue();
      const separator = this.peek();
      if (separator === undefined) {
        throw structureError("unterminated array");
      }
      if (separator.kind === "punctuation" && separator.value === ",") {
        this.index += 1;
        continue;
      }
      if (separator.kind === "punctuation" && separator.value === "]") {
        this.index += 1;
        return { kind: "array", start: open.start, end: separator.end };
      }
      throw structureError('expected "," or "]" in an array');
    }
  }
}

interface ParsedDocument {
  readonly text: string;
  readonly root: JsoncObjectNode;
}

function parseDocumentText(text: string, path: string): ParsedDocument {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new McpEditError(
      "invalid-jsonc",
      `mcp.json could not be parsed: ${
        error instanceof JsoncParseError ? error.message : String(error)
      }`,
      path,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new McpEditError(
      "invalid-document",
      "mcp.json must contain an object.",
      path,
    );
  }
  let root: JsoncObjectNode;
  try {
    root = new JsoncStructureParser(tokenizeJsonc(text)).parseObjectDocument();
  } catch (error) {
    throw new McpEditError(
      "invalid-jsonc",
      `mcp.json could not be read structurally: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path,
      { cause: error },
    );
  }
  return { text, root };
}

export interface McpConfigDocument {
  readonly path: string;
  readonly scope: McpConfigScope;
  readonly exists: boolean;
  readonly text: string;
  readonly root: JsoncObjectNode;
}

/**
 * Read and structurally validate one `mcp.json`. A missing file is `undefined`
 * (not an error); a file that does not parse, or whose root is not an object,
 * throws instead of contributing an empty document.
 */
export function readMcpConfigDocument(
  target: McpEditTarget,
  io: McpConfigIo = defaultMcpConfigIo,
): McpConfigDocument | undefined {
  const text = io.readFile(target.path);
  if (text === undefined) return undefined;
  const parsed = parseDocumentText(text, target.path);
  return {
    path: target.path,
    scope: target.scope,
    exists: true,
    text: parsed.text,
    root: parsed.root,
  };
}

/**
 * Write atomically: a sibling temp file in the same directory, then a rename.
 * A failure leaves the original byte-for-byte intact.
 */
export function writeMcpConfigText(
  path: string,
  text: string,
  io: McpConfigIo = defaultMcpConfigIo,
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
      // The temp file is best-effort cleanup; the original is untouched.
    }
    throw new McpEditError(
      "write-failed",
      `mcp.json could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path,
      { cause: error },
    );
  }
}

function objectMember(
  object: JsoncObjectNode,
  key: string,
): JsoncObjectMember | undefined {
  for (let index = object.members.length - 1; index >= 0; index -= 1) {
    const member = object.members[index];
    if (member !== undefined && member.key === key) return member;
  }
  return undefined;
}

function asObject(node: JsoncNode | undefined): JsoncObjectNode | undefined {
  return node !== undefined && node.kind === "object" ? node : undefined;
}

function lineIndentBefore(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

/** Leading whitespace of the line containing `index`, even mid-line. */
function lineLeadingIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart));
  return match?.[0] ?? "";
}

function detectIndentUnit(text: string): string {
  let smallest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^([ \t]+)\S/.exec(line);
    if (match === null) continue;
    const indent = match[1] ?? "";
    if (indent.includes("\t")) return "\t";
    if (smallest === undefined || indent.length < smallest.length) {
      smallest = indent;
    }
  }
  if (smallest === undefined || smallest.length > 8) return "  ";
  return smallest;
}

function formatValue(value: unknown, baseIndent: string, unit: string): string {
  const serialized = JSON.stringify(value, null, unit);
  return serialized.split("\n").join(`\n${baseIndent}`);
}

/**
 * Insert `key: value` into an object, preserving every byte around it. The
 * new member is placed after the last existing member; when that member ends
 * its line with a `//` comment, the comment keeps its line and the new member
 * goes below it.
 */
function insertObjectMember(
  text: string,
  object: JsoncObjectNode,
  key: string,
  value: unknown,
  unit: string,
): string {
  const parentIndent = lineLeadingIndent(text, object.start);
  const first = object.members[0];
  let memberIndent = `${parentIndent}${unit}`;
  if (first !== undefined) {
    const detected = lineIndentBefore(text, first.keyStart);
    if (detected !== "") memberIndent = detected;
  }
  const entry = `${JSON.stringify(key)}: ${formatValue(value, memberIndent, unit)}`;

  if (object.members.length === 0) {
    const closing = object.end - 1;
    const closingLineStart = text.lastIndexOf("\n", closing - 1) + 1;
    const closingPrefix = text.slice(closingLineStart, closing);
    if (closingLineStart > object.start && /^[ \t]*$/.test(closingPrefix)) {
      return (
        text.slice(0, closingLineStart) +
        `${memberIndent}${entry}\n` +
        text.slice(closingLineStart)
      );
    }
    return (
      text.slice(0, closing) +
      `\n${memberIndent}${entry}\n${parentIndent}` +
      text.slice(closing)
    );
  }

  const last = object.members[object.members.length - 1];
  if (last === undefined) return text;
  const valueEnd = last.end;

  let probe = valueEnd;
  while (probe < object.end && (text[probe] === " " || text[probe] === "\t")) {
    probe += 1;
  }
  let hadComma = false;
  if (text[probe] === ",") {
    hadComma = true;
    probe += 1;
    while (
      probe < object.end &&
      (text[probe] === " " || text[probe] === "\t")
    ) {
      probe += 1;
    }
  }
  if (text[probe] === "/" && text[probe + 1] === "/") {
    const newline = text.indexOf("\n", probe);
    if (newline !== -1 && newline < object.end) {
      const insertAt = newline + 1;
      const prefix =
        text.slice(0, valueEnd) +
        (hadComma ? "" : ",") +
        text.slice(valueEnd, insertAt);
      return `${prefix}${memberIndent}${entry}\n${text.slice(insertAt)}`;
    }
  }

  return (
    text.slice(0, valueEnd) +
    `,\n${memberIndent}${entry}` +
    text.slice(valueEnd)
  );
}

/**
 * Delete one object member and the comma that belongs to it. Horizontal
 * whitespace and line comments outside the member span are left alone.
 */
function removeObjectMember(text: string, member: JsoncObjectMember): string {
  let start = member.keyStart;
  const lineStart = text.lastIndexOf("\n", member.keyStart - 1) + 1;
  const prefix = text.slice(lineStart, member.keyStart);
  const startsLine = /^[ \t]*$/.test(prefix);
  if (startsLine) start = lineStart;

  let end = member.end;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) {
    end += 1;
  }
  let hadTrailingComma = false;
  if (text[end] === ",") {
    hadTrailingComma = true;
    end += 1;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) {
      end += 1;
    }
  }

  if (hadTrailingComma) {
    if (startsLine) {
      if (text[end] === "\r") end += 1;
      if (text[end] === "\n") end += 1;
    }
  } else {
    let before = start - 1;
    while (before >= 0 && /[ \t\r\n]/.test(text[before] ?? "")) before -= 1;
    if (text[before] === ",") {
      start = before;
    } else {
      start = lineStart;
      if (startsLine) {
        if (text[end] === "\r") end += 1;
        if (text[end] === "\n") end += 1;
      }
    }
  }

  return text.slice(0, start) + text.slice(end);
}

interface MemberRemoval {
  readonly text: string;
  readonly removed: boolean;
}

function removeMemberAtPath(
  text: string,
  path: string,
  keyPath: readonly string[],
): MemberRemoval {
  const root = parseDocumentText(text, path).root;
  let object = root;
  for (let index = 0; index < keyPath.length - 1; index += 1) {
    const segment = keyPath[index];
    if (segment === undefined) return { text, removed: false };
    const member = objectMember(object, segment);
    if (member === undefined) return { text, removed: false };
    const next = asObject(member.value);
    if (next === undefined) {
      throw new McpEditError(
        "invalid-document",
        `"${segment}" must be an object.`,
        path,
      );
    }
    object = next;
  }
  const lastKey = keyPath[keyPath.length - 1];
  if (lastKey === undefined) return { text, removed: false };
  const member = objectMember(object, lastKey);
  if (member === undefined) return { text, removed: false };
  return { text: removeObjectMember(text, member), removed: true };
}

/** The JSON an empty `mcpServers` entry would be written as (B6 shape). */
function formatNewDocument(
  key: string,
  config: Readonly<Record<string, unknown>>,
): string {
  const unit = "  ";
  const entry = `${JSON.stringify(key)}: ${formatValue(config, "    ", unit)}`;
  return `{\n${unit}"mcpServers": {\n${unit.repeat(2)}${entry}\n${unit}}\n}\n`;
}

export interface McpAddServerResult {
  /** Canonical name written as the key (B5). */
  readonly key: string;
  readonly text: string;
}

function isSafeRecordKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function canonicalServerName(name: string, path: string): string {
  let canonical: string;
  try {
    canonical = normalizeServerName(name);
  } catch (error) {
    throw new McpEditError(
      "invalid-name",
      error instanceof Error
        ? error.message
        : `MCP server name "${name}" is not valid.`,
      path,
      { cause: error },
    );
  }
  if (!isSafeRecordKey(canonical)) {
    throw new McpEditError(
      "invalid-name",
      `MCP server name "${canonical}" is reserved.`,
      path,
    );
  }
  return canonical;
}

/**
 * Add one server to a scope's file. The name is canonicalized before it is
 * written (B5 holds both ways: the written key is canonical and any existing
 * alias of the same canonical name makes the add fail). A duplicate is never
 * merged or overwritten — there is no force flag.
 */
export function addMcpServer(
  target: McpEditTarget,
  name: string,
  config: Readonly<Record<string, unknown>>,
  io: McpConfigIo = defaultMcpConfigIo,
): McpAddServerResult {
  const key = canonicalServerName(name, target.path);
  const parsed = parseMcpServerConfig(config);
  if (!parsed.ok) {
    const detail = parsed.issues
      .map((issue) =>
        issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
      )
      .join("; ");
    throw new McpEditError(
      "invalid-server",
      `MCP server "${key}" is invalid: ${detail}`,
      target.path,
    );
  }

  const document = readMcpConfigDocument(target, io);
  if (document === undefined) {
    const text = formatNewDocument(key, config);
    writeMcpConfigText(target.path, text, io);
    return { key, text };
  }

  const unit = detectIndentUnit(document.text);
  const serversMember = objectMember(document.root, "mcpServers");
  if (serversMember === undefined) {
    const text = insertObjectMember(
      document.text,
      document.root,
      "mcpServers",
      { [key]: config },
      unit,
    );
    writeMcpConfigText(target.path, text, io);
    return { key, text };
  }

  const servers = asObject(serversMember.value);
  if (servers === undefined) {
    throw new McpEditError(
      "invalid-document",
      '"mcpServers" must be an object.',
      target.path,
    );
  }

  for (const member of servers.members) {
    let existing: string;
    try {
      existing = normalizeServerName(member.key);
    } catch {
      continue;
    }
    if (existing === key) {
      throw new McpEditError(
        "duplicate-server",
        `MCP server "${key}" already exists as "${member.key}".`,
        target.path,
      );
    }
  }

  const text = insertObjectMember(document.text, servers, key, config, unit);
  writeMcpConfigText(target.path, text, io);
  return { key, text };
}

export interface McpRemoveServerResult {
  readonly text: string;
  /** Raw keys deleted; an alias of the canonical name is deleted too (B5). */
  readonly removed: readonly string[];
}

/** Remove a server by canonical name, aliases included. Unknown names throw. */
export function removeMcpServer(
  target: McpEditTarget,
  name: string,
  io: McpConfigIo = defaultMcpConfigIo,
): McpRemoveServerResult {
  const key = canonicalServerName(name, target.path);
  const document = readMcpConfigDocument(target, io);
  if (document === undefined) {
    throw new McpEditError(
      "unknown-server",
      `MCP server "${key}" is not configured in ${target.path}.`,
      target.path,
    );
  }

  const serversMember = objectMember(document.root, "mcpServers");
  if (serversMember === undefined) {
    throw new McpEditError(
      "unknown-server",
      `MCP server "${key}" is not configured in ${target.path}.`,
      target.path,
    );
  }
  const servers = asObject(serversMember.value);
  if (servers === undefined) {
    throw new McpEditError(
      "invalid-document",
      '"mcpServers" must be an object.',
      target.path,
    );
  }

  const aliases: string[] = [];
  for (const member of servers.members) {
    try {
      if (normalizeServerName(member.key) === key) aliases.push(member.key);
    } catch {
      continue;
    }
  }
  if (aliases.length === 0) {
    throw new McpEditError(
      "unknown-server",
      `MCP server "${key}" is not configured in ${target.path}.`,
      target.path,
    );
  }

  let text = document.text;
  for (const alias of aliases) {
    const removal = removeMemberAtPath(text, target.path, [
      "mcpServers",
      alias,
    ]);
    if (removal.removed) text = removal.text;
  }
  writeMcpConfigText(target.path, text, io);
  return { text, removed: aliases };
}

/** Impact levels of a persisted approval (B24). */
export type McpImpactLevel = "none" | "low" | "medium" | "high";

const MCP_IMPACT_LEVELS: Readonly<Record<string, true>> = {
  none: true,
  low: true,
  medium: true,
  high: true,
};

export interface McpPersistentPermissionEntry {
  readonly approvedAt: string;
  readonly impactLevel: McpImpactLevel;
  readonly serverIdentity?: string;
}

export interface McpPersistentPermissions {
  readonly servers: Readonly<Record<string, McpPersistentPermissionEntry>>;
  readonly tools: Readonly<
    Record<string, Readonly<Record<string, McpPersistentPermissionEntry>>>
  >;
}

function isMcpImpactLevel(value: string): value is McpImpactLevel {
  return MCP_IMPACT_LEVELS[value] === true;
}

function invalidPermissions(path: string, detail: string): McpEditError {
  return new McpEditError(
    "invalid-permissions",
    `"persistentPermissions" ${detail}`,
    path,
  );
}

function readPermissionEntry(
  value: unknown,
  path: string,
  where: string,
): McpPersistentPermissionEntry {
  if (!isRecord(value)) {
    throw invalidPermissions(path, `entry at ${where} must be an object.`);
  }
  const approvedAt = value["approvedAt"];
  if (typeof approvedAt !== "string" || approvedAt === "") {
    throw invalidPermissions(
      path,
      `entry at ${where} must have a non-empty string "approvedAt".`,
    );
  }
  const impactLevel = value["impactLevel"];
  if (typeof impactLevel !== "string" || !isMcpImpactLevel(impactLevel)) {
    throw invalidPermissions(
      path,
      `entry at ${where} must have "impactLevel" of none, low, medium or high.`,
    );
  }
  const serverIdentity = value["serverIdentity"];
  if (serverIdentity !== undefined && typeof serverIdentity !== "string") {
    throw invalidPermissions(
      path,
      `entry at ${where} must have a string "serverIdentity" when set.`,
    );
  }
  return {
    approvedAt,
    impactLevel,
    ...(serverIdentity === undefined ? {} : { serverIdentity }),
  };
}

function looksLikePermissionEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    (Object.hasOwn(value, "approvedAt") || Object.hasOwn(value, "impactLevel"))
  );
}

function readPermissionsFromRoot(
  root: JsoncObjectNode,
  text: string,
  path: string,
): McpPersistentPermissions {
  const member = objectMember(root, "persistentPermissions");
  if (member === undefined) return { servers: {}, tools: {} };
  const permissions = asObject(member.value);
  if (permissions === undefined) {
    throw invalidPermissions(path, "must be an object.");
  }

  const servers: Record<string, McpPersistentPermissionEntry> = {};
  const tools: Record<
    string,
    Record<string, McpPersistentPermissionEntry>
  > = {};

  for (const child of permissions.members) {
    if (child.key !== "servers" && child.key !== "tools") {
      throw invalidPermissions(
        path,
        `has unsupported key "${child.key}"; expected "servers" or "tools".`,
      );
    }
    const childObject = asObject(child.value);
    if (childObject === undefined) {
      throw invalidPermissions(path, `."${child.key}" must be an object.`);
    }

    if (child.key === "servers") {
      for (const entry of childObject.members) {
        if (!isSafeRecordKey(entry.key)) {
          throw invalidPermissions(
            path,
            `contains a reserved server name "${entry.key}".`,
          );
        }
        servers[entry.key] = readPermissionEntry(
          readMemberValue(text, entry),
          path,
          `servers.${entry.key}`,
        );
      }
      continue;
    }

    for (const serverEntry of childObject.members) {
      if (!isSafeRecordKey(serverEntry.key)) {
        throw invalidPermissions(
          path,
          `contains a reserved server name "${serverEntry.key}".`,
        );
      }
      const rawValue = readMemberValue(text, serverEntry);
      if (looksLikePermissionEntry(rawValue)) {
        const separator = "___";
        const splitAt = serverEntry.key.indexOf(separator);
        if (splitAt <= 0) {
          throw invalidPermissions(
            path,
            `has a legacy flat tool key "${serverEntry.key}" without a server.`,
          );
        }
        const serverName = serverEntry.key.slice(0, splitAt);
        const toolName = serverEntry.key.slice(splitAt + separator.length);
        if (toolName === "" || !isSafeRecordKey(serverName)) {
          throw invalidPermissions(
            path,
            `has an invalid legacy flat tool key "${serverEntry.key}".`,
          );
        }
        tools[serverName] = {
          ...(tools[serverName] ?? {}),
          [toolName]: readPermissionEntry(
            rawValue,
            path,
            `tools.${serverEntry.key}`,
          ),
        };
        continue;
      }

      const nested = asObject(serverEntry.value);
      if (nested === undefined) {
        throw invalidPermissions(
          path,
          `."tools"."${serverEntry.key}" must be an object.`,
        );
      }
      const entries: Record<string, McpPersistentPermissionEntry> = {
        ...(tools[serverEntry.key] ?? {}),
      };
      for (const toolEntry of nested.members) {
        if (!isSafeRecordKey(toolEntry.key)) {
          throw invalidPermissions(
            path,
            `contains a reserved tool name "${toolEntry.key}".`,
          );
        }
        entries[toolEntry.key] = readPermissionEntry(
          readMemberValue(text, toolEntry),
          path,
          `tools.${serverEntry.key}.${toolEntry.key}`,
        );
      }
      tools[serverEntry.key] = entries;
    }
  }

  return { servers, tools };
}

/**
 * A member's JSON value, recovered from its own span. The slice is a valid
 * JSONC fragment (comments included), and `parseJsonc` has already been run
 * over the whole document, so this cannot introduce a new syntax dialect.
 */
function readMemberValue(text: string, member: JsoncObjectMember): unknown {
  return parseJsonc(text.slice(member.value.start, member.value.end));
}

/**
 * The persisted approvals of one scope (B24). A missing file has no
 * approvals. An unknown shape is refused rather than treated as empty.
 */
export function readPersistentPermissions(
  target: McpEditTarget,
  io: McpConfigIo = defaultMcpConfigIo,
): McpPersistentPermissions {
  const text = io.readFile(target.path);
  if (text === undefined) return { servers: {}, tools: {} };
  return readPermissionsFromText(text, target.path);
}

function readPermissionsFromText(
  text: string,
  path: string,
): McpPersistentPermissions {
  const root = parseDocumentText(text, path).root;
  return readPermissionsFromRoot(root, text, path);
}

export function countPersistentPermissions(
  permissions: McpPersistentPermissions,
): number {
  let tools = 0;
  for (const entries of Object.values(permissions.tools)) {
    tools += Object.keys(entries).length;
  }
  return Object.keys(permissions.servers).length + tools;
}

export interface McpPermissionEditResult {
  readonly text: string;
  readonly changed: boolean;
}

/**
 * Revoke a server-level approval and every tool approval nested under it.
 * An absent server throws `unknown-permission`; nothing is written then.
 */
export function revokeServerPermission(
  target: McpEditTarget,
  server: string,
  io: McpConfigIo = defaultMcpConfigIo,
): McpPermissionEditResult {
  const document = readMcpConfigDocument(target, io);
  if (document === undefined) {
    throw new McpEditError(
      "unknown-permission",
      `MCP server "${server}" has no persistent permissions.`,
      target.path,
    );
  }
  const permissions = readPermissionsFromRoot(
    document.root,
    document.text,
    target.path,
  );
  const flatTools = legacyToolKeys(document.text, target.path, server);
  const hasServer = Object.hasOwn(permissions.servers, server);
  const hasTools =
    Object.hasOwn(permissions.tools, server) || flatTools.length > 0;
  if (!hasServer && !hasTools) {
    throw new McpEditError(
      "unknown-permission",
      `MCP server "${server}" has no persistent permissions.`,
      target.path,
    );
  }

  let text = document.text;
  let changed = false;
  for (const keyPath of [
    ["persistentPermissions", "servers", server],
    ["persistentPermissions", "tools", server],
    ...flatTools.map((key) => ["persistentPermissions", "tools", key]),
  ] as const) {
    const removal = removeMemberAtPath(text, target.path, keyPath);
    if (removal.removed) {
      text = removal.text;
      changed = true;
    }
  }
  if (changed) writeMcpConfigText(target.path, text, io);
  return { text, changed };
}

/** Revoke one tool approval; the server-level approval is left alone. */
export function revokeToolPermission(
  target: McpEditTarget,
  server: string,
  tool: string,
  io: McpConfigIo = defaultMcpConfigIo,
): McpPermissionEditResult {
  const document = readMcpConfigDocument(target, io);
  if (document === undefined) {
    throw new McpEditError(
      "unknown-permission",
      `MCP tool "${server}___${tool}" has no persistent permission.`,
      target.path,
    );
  }
  const permissions = readPermissionsFromRoot(
    document.root,
    document.text,
    target.path,
  );
  const flatKey = `${server}___${tool}`;
  const nested = permissions.tools[server];
  const hasNested = nested !== undefined && Object.hasOwn(nested, tool);
  const hasFlat = legacyToolKeys(document.text, target.path, server).includes(
    flatKey,
  );
  if (!hasNested && !hasFlat) {
    throw new McpEditError(
      "unknown-permission",
      `MCP tool "${server}___${tool}" has no persistent permission.`,
      target.path,
    );
  }

  let text = document.text;
  let changed = false;
  if (hasNested) {
    const removal = removeMemberAtPath(text, target.path, [
      "persistentPermissions",
      "tools",
      server,
      tool,
    ]);
    if (removal.removed) {
      text = removal.text;
      changed = true;
    }
    const after = parseDocumentText(text, target.path).root;
    const permissionsMember = objectMember(after, "persistentPermissions");
    const permissionsObject = asObject(permissionsMember?.value);
    const toolsMember =
      permissionsObject === undefined
        ? undefined
        : objectMember(permissionsObject, "tools");
    const toolsObject = asObject(toolsMember?.value);
    const serverMember =
      toolsObject === undefined ? undefined : objectMember(toolsObject, server);
    const serverObject = asObject(serverMember?.value);
    if (serverObject !== undefined && serverObject.members.length === 0) {
      const prune = removeMemberAtPath(text, target.path, [
        "persistentPermissions",
        "tools",
        server,
      ]);
      if (prune.removed) text = prune.text;
    }
  }
  if (hasFlat) {
    const removal = removeMemberAtPath(text, target.path, [
      "persistentPermissions",
      "tools",
      flatKey,
    ]);
    if (removal.removed) {
      text = removal.text;
      changed = true;
    }
  }
  if (changed) writeMcpConfigText(target.path, text, io);
  return { text, changed };
}

/** Every legacy flat `tools` key whose `${server}___` prefix matches. */
function legacyToolKeys(
  text: string,
  path: string,
  server: string,
): readonly string[] {
  const root = parseDocumentText(text, path).root;
  const permissions = objectMember(root, "persistentPermissions");
  const permissionsObject = asObject(permissions?.value);
  const toolsMember =
    permissionsObject === undefined
      ? undefined
      : objectMember(permissionsObject, "tools");
  const tools = asObject(toolsMember?.value);
  if (tools === undefined) return [];
  const prefix = `${server}___`;
  return tools.members
    .filter(
      (member) =>
        member.key.startsWith(prefix) &&
        member.key.length > prefix.length &&
        looksLikePermissionEntry(readMemberValue(text, member)),
    )
    .map((member) => member.key);
}

/** Remove the whole `persistentPermissions` member (B24 clear). */
export function clearPersistentPermissions(
  target: McpEditTarget,
  io: McpConfigIo = defaultMcpConfigIo,
): McpPermissionEditResult {
  const document = readMcpConfigDocument(target, io);
  if (document === undefined) return { text: "", changed: false };
  // Validate before deleting: an unknown shape is refused, not overwritten.
  readPermissionsFromRoot(document.root, document.text, target.path);
  const removal = removeMemberAtPath(document.text, target.path, [
    "persistentPermissions",
  ]);
  if (!removal.removed) {
    return { text: document.text, changed: false };
  }
  writeMcpConfigText(target.path, removal.text, io);
  return { text: removal.text, changed: true };
}
