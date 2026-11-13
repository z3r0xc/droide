/**
 * Textual, atomic edits to a settings file.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` B36 (a plugin install
 * records its enablement in `settings.json`) and `specs/10-cli-surface.md`
 * "Settings files"; ADR 0013.
 *
 * A settings file is the user's document, not ours. The writer therefore never
 * re-serialises it: it parses JSONC far enough to locate one key's span, applies
 * the smallest textual edit, checks that the result still parses to the value
 * the caller asked for, and only then replaces the file. Comments, key order,
 * indentation, line endings and a byte-order mark all survive because nothing
 * outside the edited span is rewritten.
 *
 * The replacement is atomic: a temporary file in the same directory is written,
 * `fsync`ed, given the original mode and renamed over the target, and the
 * directory is `fsync`ed afterwards (POSIX). A file reached through a symbolic
 * link, or a path outside the directory the caller names, is refused instead.
 */
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ConfigError } from "./errors.ts";
import { stripJsonc, type JsonValue } from "./schema.ts";

/** Why a write was refused. Exactly one of these; there is no silent failure. */
export type SettingsWriteRefusal =
  "not-found" | "not-writable" | "ambiguous-key" | "invalid-document";

/**
 * A refused edit. The document on disk is untouched whenever this is thrown:
 * every check runs before the temporary file is created.
 */
export class SettingsWriteError extends ConfigError {
  readonly code: SettingsWriteRefusal;
  readonly path: string;
  readonly keyPath: string;
  readonly detail: string;

  constructor(
    code: SettingsWriteRefusal,
    path: string,
    keyPath: string,
    detail: string,
    cause?: unknown,
  ) {
    super(
      keyPath === ""
        ? `Cannot write ${path}: ${detail}`
        : `Cannot write setting "${keyPath}" in ${path}: ${detail}`,
      cause,
    );
    this.name = "SettingsWriteError";
    this.code = code;
    this.path = path;
    this.keyPath = keyPath;
    this.detail = detail;
  }
}

export interface SettingsWriteOptions {
  /**
   * The directory every write must stay inside (a scope's state root). The
   * resolved file path is compared against it after resolving symbolic links.
   */
  readonly root?: string;
  /** Insert a new member in key order instead of appending it. */
  readonly sorted?: boolean;
  /** Create the file as `{}` when it does not exist. */
  readonly createIfMissing?: boolean;
}

export interface SettingsReadOptions {
  /** Refuse a file outside this directory, as {@link SettingsWriteOptions}. */
  readonly root?: string;
}

export interface SettingsValueLookup {
  readonly present: boolean;
  readonly value?: JsonValue;
}

// ---------------------------------------------------------------------------
// JSONC scan: spans only, never a re-serialisation
// ---------------------------------------------------------------------------

interface ObjectMember {
  readonly key: string;
  readonly memberStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: JsonNode;
  /** Offset of the comma that follows this member, when there is one. */
  readonly commaAfter?: number;
}

interface ObjectNode {
  readonly kind: "object";
  readonly start: number;
  readonly innerStart: number;
  readonly innerEnd: number;
  readonly end: number;
  readonly members: readonly ObjectMember[];
}

interface ArrayNode {
  readonly kind: "array";
  readonly start: number;
  readonly innerEnd: number;
  readonly end: number;
  readonly count: number;
}

interface ScalarNode {
  readonly kind: "scalar";
  readonly start: number;
  readonly end: number;
}

type JsonNode = ObjectNode | ArrayNode | ScalarNode;

class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanError";
  }
}

/**
 * A minimal JSONC reader that records where every value sits. It tolerates the
 * comment and trailing-comma forms the readers accept; the document's validity
 * is still decided by `JSON.parse` on {@link stripJsonc}, so a scan can never
 * make an invalid document look editable.
 */
class SpanScanner {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): JsonNode {
    const value = this.parseValue();
    this.skipTrivia();
    if (this.index !== this.text.length) this.fail("text after the document");
    return value;
  }

  private fail(detail: string): never {
    throw new ScanError(
      `${detail} at character ${String(this.index)} of the document`,
    );
  }

  private skipTrivia(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
        continue;
      }
      if (char !== "/") return;
      const next = this.text[this.index + 1];
      if (next === "/") {
        while (this.index < this.text.length && this.text[this.index] !== "\n")
          this.index += 1;
        continue;
      }
      if (next === "*") {
        this.index += 2;
        while (
          this.index < this.text.length &&
          !(this.text[this.index] === "*" && this.text[this.index + 1] === "/")
        )
          this.index += 1;
        if (this.index >= this.text.length) this.fail("unterminated comment");
        this.index += 2;
        continue;
      }
      return;
    }
  }

  private parseValue(): JsonNode {
    this.skipTrivia();
    const char = this.text[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') {
      const start = this.index;
      this.parseString();
      return { kind: "scalar", start, end: this.index };
    }
    const start = this.index;
    while (this.index < this.text.length) {
      const current = this.text[this.index] ?? "";
      if (
        current === "," ||
        current === "}" ||
        current === "]" ||
        current === " " ||
        current === "\t" ||
        current === "\n" ||
        current === "\r"
      )
        break;
      if (current === "/") {
        const next = this.text[this.index + 1];
        if (next === "/" || next === "*") break;
      }
      this.index += 1;
    }
    if (this.index === start) this.fail("expected a value");
    return { kind: "scalar", start, end: this.index };
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      if (char === '"') {
        this.index += 1;
        const literal = this.text.slice(start, this.index);
        try {
          return JSON.parse(literal) as string;
        } catch {
          this.fail("a key is not a valid string");
        }
      }
      this.index += 1;
    }
    return this.fail("unterminated string");
  }

  private parseObject(): ObjectNode {
    const start = this.index;
    this.index += 1;
    const members: ObjectMember[] = [];
    this.skipTrivia();
    while (this.text[this.index] !== "}") {
      this.skipTrivia();
      if (this.text[this.index] !== '"') this.fail("expected a quoted key");
      const memberStart = this.index;
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.index] !== ":") this.fail('expected ":"');
      this.index += 1;
      this.skipTrivia();
      const value = this.parseValue();
      const member: ObjectMember = {
        key,
        memberStart,
        valueStart: value.start,
        valueEnd: value.end,
        value,
      };
      this.skipTrivia();
      if (this.text[this.index] === ",") {
        const commaAfter = this.index;
        members.push({ ...member, commaAfter });
        this.index += 1;
        this.skipTrivia();
        continue;
      }
      members.push(member);
      this.skipTrivia();
      if (this.text[this.index] !== "}") this.fail('expected "," or "}"');
      break;
    }
    if (this.text[this.index] !== "}") this.fail('expected "}"');
    const close = this.index;
    this.index += 1;
    return {
      kind: "object",
      start,
      innerStart: start + 1,
      innerEnd: close,
      end: this.index,
      members,
    };
  }

  private parseArray(): ArrayNode {
    const start = this.index;
    this.index += 1;
    let count = 0;
    this.skipTrivia();
    while (this.text[this.index] !== "]") {
      this.parseValue();
      count += 1;
      this.skipTrivia();
      if (this.text[this.index] === ",") {
        this.index += 1;
        this.skipTrivia();
        continue;
      }
      if (this.text[this.index] !== "]") this.fail('expected "," or "]"');
      break;
    }
    if (this.text[this.index] !== "]") this.fail('expected "]"');
    const close = this.index;
    this.index += 1;
    return {
      kind: "array",
      start,
      innerEnd: close,
      end: this.index,
      count,
    };
  }
}

// ---------------------------------------------------------------------------
// Locating a key path
// ---------------------------------------------------------------------------

type Walk =
  | {
      readonly kind: "found";
      readonly parent: ObjectNode;
      readonly member: ObjectMember;
    }
  | {
      readonly kind: "missing";
      readonly parent: ObjectNode;
      /** The segments that do not exist yet, in order, non-empty. */
      readonly remainder: readonly string[];
    }
  | { readonly kind: "ambiguous"; readonly key: string }
  | { readonly kind: "parent-not-object"; readonly key: string };

function walkKeyPath(root: JsonNode, keyPath: readonly string[]): Walk {
  let node: JsonNode = root;
  for (let index = 0; index < keyPath.length; index += 1) {
    const key = keyPath[index] ?? "";
    if (node.kind !== "object") return { kind: "parent-not-object", key };
    const matches = node.members.filter((member) => member.key === key);
    if (matches.length > 1) return { kind: "ambiguous", key };
    const member = matches[0];
    if (member === undefined)
      return { kind: "missing", parent: node, remainder: keyPath.slice(index) };
    if (index === keyPath.length - 1)
      return { kind: "found", parent: node, member };
    node = member.value;
  }
  return { kind: "ambiguous", key: "" };
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** The leading whitespace of the line that contains `offset`. */
function lineIndentAt(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && text[start - 1] !== "\n") start -= 1;
  let end = start;
  while (end < offset && (text[end] === " " || text[end] === "\t")) end += 1;
  return text.slice(start, end);
}

/** The file's indentation unit: a tab when the document indents with tabs. */
function indentUnitOf(text: string): string {
  const match = /\n([ \t]+)\S/u.exec(text);
  const indent = match?.[1];
  if (indent === undefined) return "  ";
  return indent.includes("\t") ? "\t" : indent;
}

function serialiseValue(value: JsonValue, continuationIndent: string): string {
  const compact = JSON.stringify(value);
  if (compact === undefined)
    throw new TypeError("a settings value must be JSON-serialisable");
  if (compact.length <= 72) return compact;
  const lines = JSON.stringify(value, null, 2).split("\n");
  return lines
    .map((line, index) => (index === 0 ? line : `${continuationIndent}${line}`))
    .join("\n");
}

/**
 * One member's text, creating the intermediate objects a deeper key path needs:
 * inserting `enabledPlugins.demo` into `{}` yields
 * `"enabledPlugins": {\n  "demo": true\n}` at the caller's indent.
 */
function renderMember(
  key: string,
  remainder: readonly string[],
  value: JsonValue,
  indent: string,
  unit: string,
): string {
  const quoted = JSON.stringify(key) ?? '""';
  const head = remainder[0];
  if (head === undefined)
    return `${quoted}: ${serialiseValue(value, indent + unit)}`;
  const rest = remainder.slice(1);
  const nested = renderMember(head, rest, value, indent + unit, unit);
  return `${quoted}: {\n${indent}${unit}${nested}\n${indent}}`;
}

// ---------------------------------------------------------------------------
// Reading and the refusal checks
// ---------------------------------------------------------------------------

interface LoadedDocument {
  readonly path: string;
  /** The text without a byte-order mark; every offset is relative to it. */
  readonly body: string;
  readonly bom: boolean;
  readonly root: JsonNode;
  readonly mode: number | undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function keyPathLabel(keyPath: readonly string[]): string {
  return keyPath.join(".");
}

function assertKeyPath(keyPath: readonly string[], path: string): void {
  if (keyPath.length === 0)
    throw new SettingsWriteError(
      "invalid-document",
      path,
      "",
      "a key path needs at least one segment",
    );
  for (const segment of keyPath) {
    if (segment === "" || segment.includes("\u0000"))
      throw new SettingsWriteError(
        "invalid-document",
        path,
        keyPathLabel(keyPath),
        "a key path segment must be non-empty and free of NUL",
      );
  }
}

const sameCase = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

/**
 * The file must resolve inside `root` once symbolic links are followed. The
 * target itself is checked separately and is never written through.
 */
function assertInsideRoot(
  path: string,
  root: string,
  keyPath: readonly string[],
): void {
  const rootPath = resolvePath(root);
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = realpathSync(rootPath);
    realParent = realpathSync(dirname(resolvePath(path)));
  } catch (error) {
    throw new SettingsWriteError(
      "not-found",
      path,
      keyPathLabel(keyPath),
      `its directory cannot be resolved: ${describe(error)}`,
      error,
    );
  }
  const candidate = join(realParent, basename(resolvePath(path)));
  const within =
    sameCase(candidate) === sameCase(realRoot) ||
    sameCase(candidate).startsWith(`${sameCase(realRoot)}${sep}`);
  if (!within)
    throw new SettingsWriteError(
      "not-writable",
      path,
      keyPathLabel(keyPath),
      `it resolves outside ${rootPath}`,
    );
}

function parseDocumentText(
  body: string,
  path: string,
  keyPath: readonly string[],
): JsonNode {
  try {
    JSON.parse(stripJsonc(body));
  } catch (error) {
    throw new SettingsWriteError(
      "invalid-document",
      path,
      keyPathLabel(keyPath),
      `it does not parse as JSONC: ${describe(error)}`,
      error,
    );
  }
  try {
    return new SpanScanner(body).parseDocument();
  } catch (error) {
    throw new SettingsWriteError(
      "invalid-document",
      path,
      keyPathLabel(keyPath),
      `it does not parse as JSONC: ${describe(error)}`,
      error,
    );
  }
}

/**
 * Read one document and run every refusal check that does not depend on the
 * edit: a symbolic link, a non-file, a path outside the root, an unreadable or
 * unparsable document. Nothing on disk is touched.
 */
function loadDocument(
  path: string,
  keyPath: readonly string[],
  options: SettingsReadOptions & { readonly writable: boolean },
): LoadedDocument {
  const resolved = resolvePath(path);
  if (options.root !== undefined)
    assertInsideRoot(resolved, options.root, keyPath);

  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    throw new SettingsWriteError(
      "not-found",
      resolved,
      keyPathLabel(keyPath),
      describe(error),
      error,
    );
  }
  if (stats.isSymbolicLink())
    throw new SettingsWriteError(
      "not-writable",
      resolved,
      keyPathLabel(keyPath),
      "it is a symbolic link",
    );
  if (!stats.isFile())
    throw new SettingsWriteError(
      "not-writable",
      resolved,
      keyPathLabel(keyPath),
      "it is not a regular file",
    );
  if (options.writable) {
    try {
      accessSync(resolved, fsConstants.W_OK);
    } catch (error) {
      throw new SettingsWriteError(
        "not-writable",
        resolved,
        keyPathLabel(keyPath),
        `it is not writable: ${describe(error)}`,
        error,
      );
    }
  }

  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new SettingsWriteError(
      "not-writable",
      resolved,
      keyPathLabel(keyPath),
      `it could not be read: ${describe(error)}`,
      error,
    );
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  return {
    path: resolved,
    body,
    bom,
    root: parseDocumentText(body, resolved, keyPath),
    mode: stats.mode,
  };
}

// ---------------------------------------------------------------------------
// Atomic replacement
// ---------------------------------------------------------------------------

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let handle: number | undefined;
  try {
    handle = openSync(directory, "r");
    fsyncSync(handle);
  } catch {
    // A directory fsync is best effort: the rename already happened.
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Nothing left to do.
      }
    }
  }
}

function writeAtomically(
  path: string,
  text: string,
  mode: number,
  keyPath: readonly string[],
): void {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${randomUUID().replace(/-/gu, "")}.tmp`,
  );
  let handle: number | undefined;
  try {
    handle = openSync(temporary, "w");
    fchmodSync(handle, mode & 0o7777);
    writeFileSync(handle, text, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Best effort.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not exist; the original is what matters.
    }
    throw new SettingsWriteError(
      "not-writable",
      path,
      keyPathLabel(keyPath),
      `it could not be replaced: ${describe(error)}`,
      error,
    );
  }
  syncDirectory(directory);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * The edited text must parse and hold exactly the value that was asked for.
 * This is the guard that lets the writer promise "smallest edit, never a
 * reformat": a scanner mistake becomes a refusal, not a corrupted file.
 */
function verifyEdit(
  text: string,
  path: string,
  keyPath: readonly string[],
  expected: SettingsValueLookup,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (error) {
    throw new SettingsWriteError(
      "invalid-document",
      path,
      keyPathLabel(keyPath),
      "the edit would leave a document that does not parse",
      error,
    );
  }
  let node: unknown = parsed;
  for (const key of keyPath) {
    if (
      typeof node !== "object" ||
      node === null ||
      Array.isArray(node) ||
      !Object.hasOwn(node, key)
    ) {
      if (!expected.present) return;
      throw new SettingsWriteError(
        "invalid-document",
        path,
        keyPathLabel(keyPath),
        "the edit did not create the requested value",
      );
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (!expected.present)
    throw new SettingsWriteError(
      "invalid-document",
      path,
      keyPathLabel(keyPath),
      "the edit did not remove the requested value",
    );
  if (!isDeepStrictEqual(node, expected.value))
    throw new SettingsWriteError(
      "invalid-document",
      path,
      keyPathLabel(keyPath),
      "the edit did not produce the requested value",
    );
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The value at a key path, plus whether the key exists at all. */
export function lookupSettingsValue(
  path: string,
  keyPath: readonly string[],
  options: SettingsReadOptions = {},
): SettingsValueLookup {
  assertKeyPath(keyPath, path);
  let document: LoadedDocument;
  try {
    document = loadDocument(path, keyPath, {
      ...options,
      writable: false,
    });
  } catch (error) {
    if (error instanceof SettingsWriteError && error.code === "not-found")
      return { present: false };
    throw error;
  }
  const walk = walkKeyPath(document.root, keyPath);
  switch (walk.kind) {
    case "found":
      return {
        present: true,
        value: JSON.parse(
          stripJsonc(
            document.body.slice(walk.member.valueStart, walk.member.valueEnd),
          ),
        ) as JsonValue,
      };
    case "missing":
      return { present: false };
    case "ambiguous":
      throw new SettingsWriteError(
        "ambiguous-key",
        path,
        keyPathLabel(keyPath),
        `"${walk.key}" appears more than once, so which value to read is not knowable`,
      );
    case "parent-not-object":
      return { present: false };
  }
}

/**
 * Set one value, creating the file (as `{}`) and any missing intermediate
 * object only when the caller says so. Everything that is not the edited span
 * is preserved byte for byte.
 */
export function setSettingsValue(
  path: string,
  keyPath: readonly string[],
  value: JsonValue,
  options: SettingsWriteOptions = {},
): void {
  assertKeyPath(keyPath, path);
  let document: LoadedDocument;
  try {
    document = loadDocument(path, keyPath, { ...options, writable: true });
  } catch (error) {
    const missing =
      error instanceof SettingsWriteError && error.code === "not-found";
    if (!missing || options.createIfMissing !== true) throw error;
    const resolved = resolvePath(path);
    if (options.root !== undefined) {
      // The root itself may not exist yet, so check the path lexically before
      // creating directories and resolve links afterwards.
      const rootPath = resolvePath(options.root);
      if (
        sameCase(resolved) !== sameCase(rootPath) &&
        !sameCase(resolved).startsWith(`${sameCase(rootPath)}${sep}`)
      )
        throw new SettingsWriteError(
          "not-writable",
          resolved,
          keyPathLabel(keyPath),
          `it resolves outside ${rootPath}`,
        );
    }
    try {
      mkdirSync(dirname(resolved), { recursive: true });
    } catch (makeError) {
      throw new SettingsWriteError(
        "not-writable",
        resolved,
        keyPathLabel(keyPath),
        `its directory could not be created: ${describe(makeError)}`,
        makeError,
      );
    }
    document = {
      path: resolved,
      body: "{}\n",
      bom: false,
      root: new SpanScanner("{}\n").parseDocument(),
      mode: 0o600,
    };
    if (options.root !== undefined)
      assertInsideRoot(resolved, options.root, keyPath);
  }

  const walk = walkKeyPath(document.root, keyPath);
  const unit = indentUnitOf(document.body);
  let start: number;
  let end: number;
  let replacement: string;

  switch (walk.kind) {
    case "ambiguous":
      throw new SettingsWriteError(
        "ambiguous-key",
        document.path,
        keyPathLabel(keyPath),
        `"${walk.key}" appears more than once; edit the file by hand so one value is meant`,
      );
    case "parent-not-object":
      throw new SettingsWriteError(
        "invalid-document",
        document.path,
        keyPathLabel(keyPath),
        `"${walk.key}" is not an object, so nothing can be set below it`,
      );
    case "found": {
      const indent = lineIndentAt(document.body, walk.member.memberStart);
      start = walk.member.valueStart;
      end = walk.member.valueEnd;
      replacement = serialiseValue(value, `${indent}${unit}`);
      break;
    }
    case "missing": {
      const object = walk.parent;
      const indent = lineIndentAt(
        document.body,
        object.members[0]?.memberStart ?? object.innerEnd,
      );
      const memberIndent =
        object.members.length === 0 ? `${indent}${unit}` : indent;
      const memberKey = keyPath[keyPath.length - walk.remainder.length] ?? "";
      const entry = renderMember(
        memberKey,
        walk.remainder.slice(1),
        value,
        memberIndent,
        unit,
      );
      if (object.members.length === 0) {
        const closing = lineIndentAt(document.body, object.innerEnd);
        start = object.innerStart;
        end = object.innerEnd;
        replacement = `\n${closing}${unit}${entry}\n${closing}`;
        break;
      }
      const inline = !document.body
        .slice(object.innerStart, object.innerEnd)
        .includes("\n");
      const target =
        options.sorted === true ? sortedPosition(object, memberKey) : undefined;
      if (target !== undefined) {
        start = target;
        end = target;
        replacement = `${entry},\n${memberIndent}`;
        break;
      }
      // Append after the last member, keeping any trailing comma (and the
      // comment that may follow it) valid: a document ending in `true,` gets
      // its new member after that comma rather than a second one.
      const last = object.members[object.members.length - 1];
      const separator = last?.commaAfter;
      if (separator !== undefined) {
        start = separator + 1;
        end = start;
        replacement = inline ? ` ${entry},` : `\n${memberIndent}${entry},`;
        break;
      }
      start = last?.valueEnd ?? object.innerStart;
      end = start;
      replacement = inline ? `, ${entry}` : `,\n${memberIndent}${entry}`;
      break;
    }
  }

  // Inserted text follows the document's own line ending; untouched bytes keep
  // theirs. A CRLF file therefore stays CRLF.
  const inserted = document.body.includes("\r\n")
    ? replacement.replace(/\n/gu, "\r\n")
    : replacement;
  const edited = `${document.body.slice(0, start)}${inserted}${document.body.slice(end)}`;
  verifyEdit(edited, document.path, keyPath, { present: true, value });
  writeAtomically(
    document.path,
    (document.bom ? "\ufeff" : "") + edited,
    document.mode ?? 0o600,
    keyPath,
  );
}

/**
 * Where a new member belongs in key order: the first existing key that sorts
 * after it, or `undefined` when it goes at the end. A duplicate key cannot
 * occur because {@link walkKeyPath} reports `missing` only for absent keys.
 */
function sortedPosition(object: ObjectNode, key: string): number | undefined {
  for (const member of object.members)
    if (member.key > key) return member.memberStart;
  return undefined;
}

/**
 * Remove one member. Returns `false` when the key is already absent, so a
 * repeated uninstall is a no-op that still leaves the file alone.
 */
export function removeSettingsValue(
  path: string,
  keyPath: readonly string[],
  options: SettingsReadOptions = {},
): boolean {
  assertKeyPath(keyPath, path);
  const document = loadDocument(path, keyPath, {
    ...options,
    writable: true,
  });
  const walk = walkKeyPath(document.root, keyPath);
  if (walk.kind === "missing") return false;
  if (walk.kind === "ambiguous")
    throw new SettingsWriteError(
      "ambiguous-key",
      document.path,
      keyPathLabel(keyPath),
      `"${walk.key}" appears more than once; edit the file by hand so one value is meant`,
    );
  if (walk.kind === "parent-not-object")
    throw new SettingsWriteError(
      "invalid-document",
      document.path,
      keyPathLabel(keyPath),
      `"${walk.key}" is not an object, so nothing can be removed below it`,
    );

  const { parent, member } = walk;
  const position = parent.members.indexOf(member);
  let start: number;
  let end: number;

  const inner = document.body.slice(parent.innerStart, parent.innerEnd);
  if (parent.members.length === 1 && !inner.includes("/")) {
    // The object becomes `{}`: with nothing but whitespace left inside, drop
    // it whole so no blank line is left where the member was.
    start = parent.innerStart;
    end = parent.innerEnd;
  } else if (parent.members.length === 1) {
    // A comment survives its member: the object keeps the comment and loses
    // only the entry (and the comma that separated it from nothing).
    start = member.memberStart;
    end =
      member.commaAfter === undefined ? member.valueEnd : member.commaAfter + 1;
  } else if (
    member.commaAfter !== undefined &&
    position < parent.members.length - 1
  ) {
    start = member.memberStart;
    end = member.commaAfter + 1;
    // Take the following indentation with it, or the next key keeps a blank
    // line's worth of leading whitespace.
    while (
      end < document.body.length &&
      (document.body[end] === " " ||
        document.body[end] === "\t" ||
        document.body[end] === "\n" ||
        document.body[end] === "\r")
    )
      end += 1;
  } else if (
    member.commaAfter === undefined &&
    position < parent.members.length - 1
  ) {
    // Cannot happen in a document that parses; refuse rather than guess.
    throw new SettingsWriteError(
      "invalid-document",
      document.path,
      keyPathLabel(keyPath),
      "the member has no separator before the next one",
    );
  } else {
    const previous = parent.members[position - 1];
    if (previous?.commaAfter === undefined)
      throw new SettingsWriteError(
        "invalid-document",
        document.path,
        keyPathLabel(keyPath),
        "the member has no separator from the previous one",
      );
    start = previous.commaAfter;
    end = member.valueEnd;
  }

  const edited = document.body.slice(0, start) + document.body.slice(end);
  verifyEdit(edited, document.path, keyPath, { present: false });
  writeAtomically(
    document.path,
    (document.bom ? "\ufeff" : "") + edited,
    document.mode ?? 0o600,
    keyPath,
  );
  return true;
}
