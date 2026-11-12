/**
 * Session lifecycle for `droide exec`.
 *
 * Contract: `specs/80-exec-and-streaming.md` B35-B40 (continue, fork, streaming
 * session reuse) and `specs/40-sessions-and-storage.md` (transcript layout and
 * append rules).
 *
 * One run owns exactly one session. A plain run creates it, `-s` continues the
 * named one from its stored transcript, and `--fork` copies the named
 * transcript into a new id before continuing there. The transcript is written
 * as the turn proceeds through {@link TurnTranscript}: the user message, every
 * assistant and tool message, and one terminal record.
 *
 * The store is a disposable projection (`specs/40-sessions-and-storage.md`):
 * the JSONL transcript is the durable artefact, so the record written first is
 * the message the loop just settled. Paths come from the app context; ids and
 * the clock are injected so a run is replayable.
 */
import { existsSync, realpathSync } from "node:fs";
import * as nodePath from "node:path";

import type {
  DocumentBlock,
  ImageBlock,
  Message,
  Role,
  TextBlock,
} from "../agent/messages.ts";
import type { Environment, Platform } from "../config/paths.ts";
import type { AppContext } from "../app/context.ts";
import {
  openSessionStore,
  type SessionStore,
  type SessionStoreOptions,
} from "../session/store.ts";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../session/transcript.ts";
import { ExecUsageError } from "./errors.ts";
import type { ExecUsage } from "./records.ts";

/** What the agent loop's turn reports as it settles its messages. */
export interface TurnTranscript {
  userMessage(message: Message): void;
  assistantMessage(message: Message): void;
  toolMessage(message: Message): void;
  /** B25: the turn ended well; one `completion` record is appended. */
  turnCompleted(result: {
    readonly finalText: string;
    readonly numTurns: number;
    readonly durationMs: number;
    readonly usage: ExecUsage;
  }): void;
  turnFailed(message: string): void;
  turnCancelled(message: string): void;
}

/** A run's session: its id, its transcript, and the messages loaded so far. */
export interface ExecSession extends TurnTranscript {
  readonly sessionId: string;
  /** Every message in the transcript, oldest first, including this turn's. */
  messages(): readonly Message[];
  close(): void;
}

export interface OpenExecSessionOptions {
  readonly context: AppContext;
  readonly clock: () => number;
  readonly nextId: () => string;
  /** B35: continue this session. */
  readonly continueSessionId?: string;
  /** B36: fork this session into a new id. */
  readonly forkSessionId?: string;
  /** The id for a session this run creates; generated when omitted. */
  readonly newSessionId?: string;
  /** Defaults to `openSessionStore`; tests inject a fixture-backed store. */
  readonly openStore?: (options: SessionStoreOptions) => SessionStore;
}

function isRole(value: string): value is Role {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "system"
  );
}

/* -------------------------------------------------------------------------- */
/* Project keys                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `specs/40-sessions-and-storage.md` "On-disk layout": the transcript's
 * directory is derived from the run's working directory: resolve, canonicalise
 * when the directory exists, drop trailing separators, then prefix `-` and
 * flatten separators.
 */
export function projectKeyFor(cwd: string, platform: Platform): string {
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const absolute = path.resolve(cwd);
  let canonical = absolute;
  try {
    if (existsSync(absolute)) canonical = realpathSync(absolute);
  } catch {
    // A directory that cannot be canonicalised keeps its resolved spelling.
  }
  const normalized = canonical.replace(/[\\/]+$/, "");
  const key =
    platform === "win32"
      ? `-${normalized.replace(/^([A-Z]):/i, "$1").replace(/[\\/]+/g, "-")}`
      : `-${normalized.replace(/^\/+/, "").replace(/\/+/g, "-")}`;
  // A filesystem root flattens to `-`, which is not a valid project key; the
  // global root is the documented fallback (`''`).
  return key === "-" || key === "" ? "" : key;
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                               */
/* -------------------------------------------------------------------------- */

/** A `JsonValue` for any plain data a message block can carry. */
function jsonValueOf(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return String(value);
    case "object": {
      if (Array.isArray(value)) return value.map((item) => jsonValueOf(item));
      if (value === undefined) return null;
      const object: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        object[key] = jsonValueOf(item);
      }
      return object;
    }
    default:
      return null;
  }
}

function blockToJson(block: Message["content"][number]): JsonObject {
  const value = jsonValueOf(block);
  return isJsonObject(value) ? value : { type: "text", text: "" };
}

/**
 * One transcript line for a loop message. The `message` shape is the loop's
 * own (`specs/20-agent-loop.md` B6-B11), which is also what the search
 * projection reads (`specs/40-sessions-and-storage.md` B44-B45).
 */
function messageRecord(message: Message, timestamp: number): JsonObject {
  return {
    type: "message",
    message: {
      id: message.id,
      role: message.role,
      content: message.content.map((block) => blockToJson(block)),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
  };
}

function completionRecord(input: {
  readonly finalText: string;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly usage: ExecUsage;
  readonly timestamp: number;
}): JsonObject {
  return {
    type: "completion",
    reason: "completed",
    finalText: input.finalText,
    numTurns: input.numTurns,
    durationMs: Math.max(0, input.durationMs),
    usage: {
      input_tokens: input.usage.input_tokens,
      output_tokens: input.usage.output_tokens,
      cache_read_input_tokens: input.usage.cache_read_input_tokens,
      cache_creation_input_tokens: input.usage.cache_creation_input_tokens,
      droide_credits: input.usage.droide_credits,
      thinking_tokens: input.usage.thinking_tokens,
      ...(input.usage.ttft_ms === undefined
        ? {}
        : { ttft_ms: input.usage.ttft_ms }),
    },
    timestamp: input.timestamp,
  };
}

function errorRecord(message: string, timestamp: number): JsonObject {
  return { type: "error", source: "cli", message, timestamp };
}

/* -------------------------------------------------------------------------- */
/* Reading a transcript back                                                  */
/* -------------------------------------------------------------------------- */

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

type ImageSource = Extract<
  Message["content"][number],
  { type: "image" }
>["source"];

function imageSourceOf(value: JsonValue | undefined): ImageSource | undefined {
  if (!isJsonObject(value)) return undefined;
  const mediaType = stringOf(value["mediaType"]);
  const data = stringOf(value["data"]);
  if (value["type"] !== "base64" || data === undefined) return undefined;
  if (
    mediaType !== "image/jpeg" &&
    mediaType !== "image/png" &&
    mediaType !== "image/gif" &&
    mediaType !== "image/webp"
  ) {
    return undefined;
  }
  return { type: "base64", mediaType, data };
}

type DocumentSource = Extract<
  Message["content"][number],
  { type: "document" }
>["source"];

function documentSourceOf(
  value: JsonValue | undefined,
): DocumentSource | undefined {
  if (!isJsonObject(value)) return undefined;
  const data = stringOf(value["data"]);
  if (data === undefined) return undefined;
  if (value["type"] === "text" && value["mediaType"] === "text/plain") {
    return { type: "text", mediaType: "text/plain", data };
  }
  if (value["type"] === "base64" && value["mediaType"] === "application/pdf") {
    return { type: "base64", mediaType: "application/pdf", data };
  }
  return undefined;
}

type ToolResultPart = Extract<
  Message["content"][number],
  { type: "tool_result" }
>;
type ToolResultContent = NonNullable<ToolResultPart["content"]>;

function toolResultContentOf(
  value: JsonValue | undefined,
): ToolResultContent | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: Array<TextBlock | ImageBlock | DocumentBlock> = [];
  for (const item of value) {
    const block = blockFromJson(item);
    if (block === undefined) continue;
    if (
      block.type === "text" ||
      block.type === "image" ||
      block.type === "document"
    ) {
      parts.push(block);
    }
  }
  return parts;
}

type ContentPart = Message["content"][number];

function blockFromJson(value: JsonValue): ContentPart | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value["type"]) {
    case "text": {
      const text = stringOf(value["text"]);
      if (text === undefined) return undefined;
      const id = stringOf(value["id"]);
      return id === undefined
        ? { type: "text", text }
        : { type: "text", text, id };
    }
    case "thinking": {
      const thinking = stringOf(value["thinking"]);
      if (thinking === undefined) return undefined;
      const signature = stringOf(value["signature"]) ?? "";
      const progress = stringOf(value["progressUpdate"]);
      const duration = numberOf(value["durationMs"]);
      return {
        type: "thinking",
        thinking,
        signature,
        ...(progress === undefined ? {} : { progressUpdate: progress }),
        ...(duration === undefined ? {} : { durationMs: duration }),
      };
    }
    case "redacted_thinking": {
      const data = stringOf(value["data"]);
      return data === undefined
        ? undefined
        : { type: "redacted_thinking", data };
    }
    case "tool_use": {
      const id = stringOf(value["id"]);
      const name = stringOf(value["name"]);
      if (id === undefined || name === undefined) return undefined;
      return { type: "tool_use", id, name, input: value["input"] ?? {} };
    }
    case "tool_result": {
      const toolUseId = stringOf(value["toolUseId"]);
      if (toolUseId === undefined) return undefined;
      const content = toolResultContentOf(value["content"]);
      const isError = value["isError"];
      return {
        type: "tool_result",
        toolUseId,
        ...(content === undefined ? {} : { content }),
        ...(typeof isError === "boolean" ? { isError } : {}),
      };
    }
    case "image": {
      const source = imageSourceOf(value["source"]);
      return source === undefined ? undefined : { type: "image", source };
    }
    case "document": {
      const source = documentSourceOf(value["source"]);
      return source === undefined ? undefined : { type: "document", source };
    }
    default:
      return undefined;
  }
}

/**
 * The loop's message for one stored line, or `undefined` for a record that is
 * not a message (a completion, an error) or a message this build cannot read.
 */
export function messageFromRecord(record: JsonObject): Message | undefined {
  if (record["type"] !== "message") return undefined;
  const raw = record["message"];
  if (!isJsonObject(raw)) return undefined;
  const id = stringOf(raw["id"]);
  const role = stringOf(raw["role"]);
  const content = raw["content"];
  if (id === undefined || role === undefined || !isRole(role)) {
    return undefined;
  }
  if (!Array.isArray(content)) return undefined;

  const blocks: ContentPart[] = [];
  for (const entry of content) {
    const block = blockFromJson(entry);
    if (block !== undefined) blocks.push(block);
  }
  if (blocks.length === 0 && content.length > 0) return undefined;

  const timestamp = numberOf(record["timestamp"]) ?? 0;
  const createdAt = numberOf(raw["createdAt"]) ?? timestamp;
  const updatedAt = numberOf(raw["updatedAt"]) ?? createdAt;
  return {
    id,
    role,
    content: blocks,
    createdAt,
    updatedAt,
  };
}

function messagesFromRecords(records: readonly JsonObject[]): Message[] {
  const messages: Message[] = [];
  for (const record of records) {
    const message = messageFromRecord(record);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

/* -------------------------------------------------------------------------- */
/* The session                                                                */
/* -------------------------------------------------------------------------- */

class StoredExecSession implements ExecSession {
  readonly #store: SessionStore;
  readonly #sessionId: string;
  readonly #clock: () => number;
  readonly #messages: Message[];

  constructor(
    store: SessionStore,
    sessionId: string,
    clock: () => number,
    history: readonly Message[],
  ) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.#clock = clock;
    this.#messages = [...history];
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  messages(): readonly Message[] {
    return [...this.#messages];
  }

  userMessage(message: Message): void {
    this.#append(message);
  }

  assistantMessage(message: Message): void {
    this.#append(message);
  }

  toolMessage(message: Message): void {
    this.#append(message);
  }

  turnCompleted(result: {
    readonly finalText: string;
    readonly numTurns: number;
    readonly durationMs: number;
    readonly usage: ExecUsage;
  }): void {
    this.#write(completionRecord({ ...result, timestamp: this.#clock() }));
  }

  turnFailed(message: string): void {
    this.#write(errorRecord(message, this.#clock()));
  }

  turnCancelled(message: string): void {
    this.#write(errorRecord(message, this.#clock()));
  }

  close(): void {
    this.#store.close();
  }

  #append(message: Message): void {
    this.#write(messageRecord(message, this.#clock()));
    this.#messages.push(message);
  }

  #write(record: JsonObject): void {
    this.#store.appendTranscriptRecord(this.#sessionId, record);
  }
}

function requireSession(
  store: SessionStore,
  sessionId: string,
  action: "continue" | "fork",
): void {
  const row = store.getSession(sessionId);
  if (row === null) {
    throw new ExecUsageError(`Unknown session: ${sessionId}`);
  }
  if (row.archivedAt !== null) {
    throw new ExecUsageError(
      `Cannot ${action} an archived session: ${sessionId}`,
    );
  }
}

function registerNewSession(
  store: SessionStore,
  sessionId: string,
  environment: Environment,
  clock: () => number,
): void {
  store.registerSession({
    sessionId,
    projectKey: projectKeyFor(environment.cwd, environment.platform),
    cwd: environment.cwd,
    firstEventAt: clock(),
  });
}

/**
 * Creates, loads or forks the run's session. A new session is registered empty;
 * a continued one starts from its stored messages and appends after them; a
 * fork copies every stored record to a fresh id first (B35-B36).
 *
 * The caller owns the returned handle and must `close()` it.
 */
export function openExecSession(options: OpenExecSessionOptions): ExecSession {
  const store = (options.openStore ?? openSessionStore)({
    dbPath: options.context.paths.sessionIndexDatabase,
    sessionsDir: options.context.paths.sessionsDir,
    clock: { now: options.clock },
  });

  try {
    if (options.continueSessionId !== undefined) {
      requireSession(store, options.continueSessionId, "continue");
      const records = store.readSession(options.continueSessionId);
      return new StoredExecSession(
        store,
        options.continueSessionId,
        options.clock,
        messagesFromRecords(records),
      );
    }

    if (options.forkSessionId !== undefined) {
      requireSession(store, options.forkSessionId, "fork");
      const records = store.readSession(options.forkSessionId);
      const sessionId = options.nextId();
      registerNewSession(
        store,
        sessionId,
        options.context.environment,
        options.clock,
      );
      for (const record of records) {
        store.appendTranscriptRecord(sessionId, record);
      }
      return new StoredExecSession(
        store,
        sessionId,
        options.clock,
        messagesFromRecords(records),
      );
    }

    const sessionId = options.newSessionId ?? options.nextId();
    registerNewSession(
      store,
      sessionId,
      options.context.environment,
      options.clock,
    );
    return new StoredExecSession(store, sessionId, options.clock, []);
  } catch (error) {
    store.close();
    // A store failure is reported as the run's own refusal, not as a stack.
    if (error instanceof ExecUsageError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExecUsageError(`Could not open the session: ${detail}`, {
      cause: error,
    });
  }
}
