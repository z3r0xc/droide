/**
 * The session index and its transcripts. Contract:
 * `specs/40-sessions-and-storage.md` (B17-B22, B38-B40, B43-B54).
 *
 * SQL is never assembled from caller input: every value is a bound parameter,
 * and the only SQL text this module branches on is between two constant
 * fragments (the tenancy rule is always the same three-parameter predicate).
 * Limits are validated before they reach SQLite and capped at the constants
 * below, which the README documents.
 */

import type { DatabaseSync } from "node:sqlite";
import { existsSync, truncateSync } from "node:fs";

import {
  CorruptSessionRowError,
  InvalidArgumentError,
  InvalidSessionIdError,
  MissingIngestRowError,
  NestedTransactionError,
  StoreClosedError,
  UnknownSessionError,
} from "./errors.ts";
import { createSessionIdFactory, isSessionId, type SessionClock, type SessionIdFactory } from "./ids.ts";
import { openSessionIndexDatabase } from "./open.ts";
import {
  appendTranscriptLine,
  isJsonObject,
  readTranscriptFile,
  serializeTranscriptRecord,
  transcriptPathFor,
  transcriptSize,
  validateProjectKey,
  type JsonObject,
  type JsonValue,
} from "./transcript.ts";

export const MAX_LIST_LIMIT = 1000;
export const MAX_LIST_OFFSET = 1_000_000;
export const MAX_SEARCH_SESSIONS = 1000;
export const MAX_SEARCH_HITS = 20;
export const MAX_CONTEXT_CHARS = 1000;
export const MAX_QUERY_CHARS = 500;

export const DEFAULT_LIST_LIMIT = 100;
export const DEFAULT_SEARCH_SESSIONS = 20;
export const DEFAULT_SEARCH_HITS = 3;
export const DEFAULT_CONTEXT_CHARS = 80;

const MUTATION_BUSY_TIMEOUT_MS = 25;
const RESTING_BUSY_TIMEOUT_MS = 0;
const MAX_SNIPPETS_PER_HIT = 3;
const MAX_JSON_DEPTH = 32;

export type SessionKind = "message_text" | "document" | "tool_use" | "tool_result";

export function isSessionKind(value: string): value is SessionKind {
  return (
    value === "message_text" || value === "document" || value === "tool_use" || value === "tool_result"
  );
}

export interface SessionRow {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly orgId: string | null;
  readonly owner: string | null;
  readonly parent: string | null;
  readonly callingSessionId: string | null;
  readonly callingToolUseId: string | null;
  readonly mission: string | null;
  readonly tags: Readonly<Record<string, JsonValue>>;
  readonly hasUserVisibleMessages: boolean | null;
  readonly archivedAt: string | null;
  readonly firstEventAt: number | null;
  readonly lastEventAt: number | null;
  readonly messagesCount: number;
  readonly hostId: string | null;
  readonly worktree: string | null;
  readonly artifacts: string | null;
  readonly settingsWriteSeq: number | null;
}

export interface NewSessionInput {
  readonly sessionId?: string;
  readonly projectKey?: string;
  readonly cwd?: string | null;
  readonly title?: string | null;
  readonly orgId?: string | null;
  readonly owner?: string | null;
  readonly parent?: string | null;
  readonly callingSessionId?: string | null;
  readonly callingToolUseId?: string | null;
  readonly mission?: string | null;
  readonly hostId?: string | null;
  readonly firstEventAt?: number | null;
  readonly archivedAt?: string | null;
}

export interface AppendResult {
  readonly size: number;
  readonly messagesCount: number;
  readonly lastEventAt: number | null;
  readonly hasUserVisibleMessages: boolean | null;
}

export interface ListSessionsOptions {
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  /** Ties are broken in favour of the session whose cwd equals this. */
  readonly cwd?: string | null;
}

export interface SessionListItem {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly updatedAt: number | null;
  readonly createdAt: number | null;
  readonly messagesCount: number;
  readonly archived: boolean;
  readonly tags: Readonly<Record<string, JsonValue>>;
}

export interface SearchOptions {
  readonly kind?: SessionKind | "all";
  readonly limitSessions?: number;
  readonly limitHits?: number;
  readonly contextChars?: number;
  readonly includeArchived?: boolean;
  readonly excludeChildren?: boolean;
  readonly includeHidden?: boolean;
  /** `null`/absent means only unattributed rows are visible (B39). */
  readonly activeOrgId?: string | null;
  readonly projectKey?: string | null;
  readonly since?: number;
  readonly until?: number;
}

export interface SearchHit {
  readonly docId: string;
  readonly kind: SessionKind;
  readonly toolName?: string;
  readonly messageRole?: string;
  readonly snippets: readonly string[];
}

export interface SearchSession {
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt?: number;
  readonly hits: readonly SearchHit[];
}

export interface SearchResult {
  readonly sessions: readonly SearchSession[];
  readonly sessionCount: { readonly count: number; readonly exact: boolean };
  readonly complete: boolean;
  readonly coverageReason?: string;
}

export interface SessionStoreOptions {
  readonly dbPath: string;
  readonly sessionsDir: string;
  readonly clock: SessionClock;
  readonly idFactory?: SessionIdFactory;
}

interface SearchCandidate {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly title: string | null;
  readonly lastEventAt: number | null;
}

interface SearchValue {
  readonly kind: SessionKind;
  readonly toolName?: string;
  readonly messageRole?: string;
  readonly summary?: boolean;
  readonly value: string;
}

interface MatchedSession {
  readonly candidate: SearchCandidate;
  readonly hits: readonly SearchHit[];
}

function isSqlRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function readInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function readBooleanish(row: Record<string, unknown>, key: string): boolean | null {
  const value = readInt(row, key);
  if (value === null) return null;
  return value !== 0;
}

function parseTags(sessionId: string, row: Record<string, unknown>): Record<string, JsonValue> {
  const raw = row["tags_json"];
  if (typeof raw !== "string") {
    throw new CorruptSessionRowError(sessionId, "tags are not JSON text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CorruptSessionRowError(sessionId, `tags are not JSON (${String(error)})`);
  }
  if (!isJsonObject(parsed)) {
    throw new CorruptSessionRowError(sessionId, "tags are not a JSON object");
  }
  return { ...parsed };
}

function rowToSession(row: Record<string, unknown>): SessionRow {
  const sessionId = readString(row, "session_id");
  const projectKey = readString(row, "project_key");
  if (sessionId === null || projectKey === null) {
    throw new CorruptSessionRowError(sessionId ?? "<unknown>", "missing identity columns");
  }
  return {
    sessionId,
    projectKey,
    cwd: readString(row, "cwd"),
    title: readString(row, "title"),
    orgId: readString(row, "org_id"),
    owner: readString(row, "owner"),
    parent: readString(row, "parent"),
    callingSessionId: readString(row, "calling_session_id"),
    callingToolUseId: readString(row, "calling_tool_use_id"),
    mission: readString(row, "mission"),
    tags: parseTags(sessionId, row),
    hasUserVisibleMessages: readBooleanish(row, "has_user_visible_messages"),
    archivedAt: readString(row, "archived_at"),
    firstEventAt: readInt(row, "first_event_at"),
    lastEventAt: readInt(row, "last_event_at"),
    messagesCount: readInt(row, "messages_count") ?? 0,
    hostId: readString(row, "host_id"),
    worktree: readString(row, "worktree"),
    artifacts: readString(row, "artifacts"),
    settingsWriteSeq: readInt(row, "settings_write_seq"),
  };
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("errcode" in error && typeof error.errcode === "number") {
    // SQLITE_CONSTRAINT is primary result code 19; extended codes keep that byte.
    return (error.errcode & 0xff) === 19;
  }
  return /constraint failed/i.test(error.message);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new InvalidArgumentError(
      `${name} must be an integer between ${minimum} and ${maximum}, got ${String(value)}`,
    );
  }
  return value;
}

function optionalEpoch(value: number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative epoch millisecond, got ${value}`);
  }
  return value;
}

function recordTimestamp(record: JsonObject): number | null {
  const value = record["timestamp"];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function isUserVisibleRecord(record: JsonObject): boolean {
  if (record["type"] !== "message") return false;
  const message = record["message"];
  return isJsonObject(message) && message["role"] === "user";
}

function collectStrings(value: JsonValue | undefined, depth = 0): readonly string[] {
  if (depth > MAX_JSON_DEPTH) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const collected: string[] = [];
    for (const item of value) collected.push(...collectStrings(item, depth + 1));
    return collected;
  }
  if (isJsonObject(value)) {
    const collected: string[] = [];
    for (const key of Object.keys(value)) collected.push(...collectStrings(value[key], depth + 1));
    return collected;
  }
  return [];
}

function pushValue(
  values: SearchValue[],
  kind: SessionKind,
  value: string | null,
  extra?: { readonly toolName?: string; readonly messageRole?: string },
): void {
  if (value === null || value.length === 0) return;
  const base = { kind, value };
  const withRole = extra?.messageRole === undefined ? base : { ...base, messageRole: extra.messageRole };
  values.push(extra?.toolName === undefined ? withRole : { ...withRole, toolName: extra.toolName });
}

function blockValues(block: JsonObject, role: string | undefined): readonly SearchValue[] {
  const values: SearchValue[] = [];
  const type = block["type"];
  const extra = role === undefined ? undefined : { messageRole: role };

  if (type === "text") {
    pushValue(values, "message_text", readString(block, "text"), extra);
    return values;
  }
  if (type === "thinking") {
    pushValue(values, "message_text", readString(block, "thinking"), extra);
    return values;
  }
  if (type === "tool_use") {
    const name = readString(block, "name");
    if (name !== null) pushValue(values, "tool_use", name, { toolName: name });
    const toolExtra = name === null ? undefined : { toolName: name };
    for (const inputValue of collectStrings(block["input"])) {
      pushValue(values, "tool_use", inputValue, toolExtra);
    }
    return values;
  }
  if (type === "tool_result") {
    const content = block["content"];
    if (typeof content === "string") {
      pushValue(values, "tool_result", content, extra);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (isJsonObject(part) && part["type"] === "text") {
          pushValue(values, "tool_result", readString(part, "text"), extra);
        }
      }
    }
    return values;
  }
  if (type === "document") {
    const source = block["source"];
    if (isJsonObject(source) && source["type"] === "text") {
      pushValue(values, "document", readString(source, "data"), extra);
    }
  }
  return values;
}

function searchableValues(record: JsonObject, line: number): readonly SearchValue[] {
  const values: SearchValue[] = [];

  // The summary line's title and cwd are searchable, but a `--kind` filter
  // excludes them because neither is a block of that kind (B47/B48).
  if (line === 1) {
    for (const key of ["title", "cwd"]) {
      const value = readString(record, key);
      if (value !== null) values.push({ kind: "message_text", summary: true, value });
    }
  }

  if (record["type"] !== "message") return values;
  const message = record["message"];
  if (!isJsonObject(message)) return values;
  const role = readString(message, "role") ?? undefined;
  const extra = role === undefined ? undefined : { messageRole: role };
  const content = message["content"];

  if (typeof content === "string") {
    pushValue(values, "message_text", content, extra);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (isJsonObject(block)) values.push(...blockValues(block, role));
    }
  }
  return values;
}

function makeSnippet(value: string, matchIndex: number, matchLength: number, radius: number): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(value.length, matchIndex + matchLength + radius);
  const body = value.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < value.length ? "…" : ""}`;
}

function collectHits(
  records: readonly JsonObject[],
  needle: string,
  kind: SessionKind | "all",
  limitHits: number,
  contextChars: number,
): readonly SearchHit[] {
  const hits: SearchHit[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    const line = index + 1;
    const groups = new Map<
      string,
      {
        readonly kind: SessionKind;
        readonly toolName?: string;
        readonly messageRole?: string;
        readonly snippets: string[];
      }
    >();

    for (const value of searchableValues(record, line)) {
      if (kind !== "all" && (value.kind !== kind || value.summary === true)) continue;
      const matchIndex = value.value.toLowerCase().indexOf(needle);
      if (matchIndex < 0) continue;

      const key = `${value.kind}\u0000${value.toolName ?? ""}`;
      const snippet = makeSnippet(value.value, matchIndex, needle.length, contextChars);
      const group = groups.get(key);
      if (group !== undefined) {
        if (group.snippets.length < MAX_SNIPPETS_PER_HIT) group.snippets.push(snippet);
        continue;
      }
      const created: {
        kind: SessionKind;
        toolName?: string;
        messageRole?: string;
        snippets: string[];
      } = { kind: value.kind, snippets: [snippet] };
      if (value.toolName !== undefined) created.toolName = value.toolName;
      if (value.messageRole !== undefined) created.messageRole = value.messageRole;
      groups.set(key, created);
    }

    for (const group of groups.values()) {
      const hit: {
        docId: string;
        kind: SessionKind;
        toolName?: string;
        messageRole?: string;
        snippets: readonly string[];
      } = { docId: `line:${line}`, kind: group.kind, snippets: group.snippets };
      if (group.toolName !== undefined) hit.toolName = group.toolName;
      if (group.messageRole !== undefined) hit.messageRole = group.messageRole;
      hits.push(hit);
      if (hits.length >= limitHits) return hits;
    }
  }
  return hits;
}

function titleTier(title: string | null, needle: string): number {
  if (title === null) return 2;
  const lower = title.toLowerCase();
  if (lower === needle) return 0;
  return lower.includes(needle) ? 1 : 2;
}

function hasUserTextHit(hits: readonly SearchHit[]): boolean {
  return hits.some((hit) => hit.kind === "message_text" && hit.messageRole === "user");
}

function compareMatches(left: MatchedSession, right: MatchedSession, needle: string): number {
  const tier = titleTier(left.candidate.title, needle) - titleTier(right.candidate.title, needle);
  if (tier !== 0) return tier;
  const user = Number(hasUserTextHit(right.hits)) - Number(hasUserTextHit(left.hits));
  if (user !== 0) return user;
  const recency = (right.candidate.lastEventAt ?? 0) - (left.candidate.lastEventAt ?? 0);
  if (recency !== 0) return recency;
  return right.candidate.sessionId.localeCompare(left.candidate.sessionId);
}

const SESSION_COLUMNS = `
  session_id, project_key, cwd, title, org_id, owner, parent,
  calling_session_id, calling_tool_use_id, mission, json(tags) AS tags_json,
  has_user_visible_messages, archived_at, first_event_at, last_event_at,
  messages_count, host_id, worktree, artifacts, settings_write_seq
`;

export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #sessionsDir: string;
  readonly #clock: SessionClock;
  readonly #ids: SessionIdFactory;
  #inTransaction = false;
  #closed = false;

  constructor(db: DatabaseSync, options: SessionStoreOptions) {
    this.#db = db;
    this.#sessionsDir = options.sessionsDir;
    this.#clock = options.clock;
    this.#ids = options.idFactory ?? createSessionIdFactory(options.clock);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  getSession(sessionId: string): SessionRow | null {
    this.#ensureOpen();
    const row = this.#db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
      .get(sessionId);
    return isSqlRow(row) ? rowToSession(row) : null;
  }

  registerSession(input: NewSessionInput = {}): SessionRow {
    this.#ensureOpen();
    const sessionId = input.sessionId ?? this.#ids.next();
    if (!isSessionId(sessionId)) throw new InvalidSessionIdError(sessionId);
    const projectKey = input.projectKey ?? "";
    validateProjectKey(projectKey);

    try {
      this.#transaction(() => {
        this.#db
          .prepare(
            `INSERT INTO sessions (
               session_id, project_key, cwd, title, org_id, owner, parent,
               calling_session_id, calling_tool_use_id, mission,
               has_user_visible_messages, archived_at, first_event_at, last_event_at,
               messages_count, host_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?)`,
          )
          .run(
            sessionId,
            projectKey,
            input.cwd ?? null,
            input.title ?? null,
            input.orgId ?? null,
            input.owner ?? null,
            input.parent ?? null,
            input.callingSessionId ?? null,
            input.callingToolUseId ?? null,
            input.mission ?? null,
            input.archivedAt ?? null,
            input.firstEventAt ?? null,
            input.hostId ?? null,
          );
        this.#db.prepare("INSERT INTO session_ingest (session_id) VALUES (?)").run(sessionId);
      });
    } catch (error) {
      if (isConstraintError(error)) throw new DuplicateSessionError(sessionId, error);
      throw error;
    }

    const created = this.getSession(sessionId);
    if (created === null) {
      throw new CorruptSessionRowError(sessionId, "row vanished after insert");
    }
    return created;
  }

  deleteSession(sessionId: string): boolean {
    this.#ensureOpen();
    const result = this.#db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    return Number(result.changes) > 0;
  }

  appendTranscriptRecord(sessionId: string, record: JsonObject): AppendResult {
    this.#ensureOpen();
    const session = this.#requireSession(sessionId);
    const path = transcriptPathFor(this.#sessionsDir, session.projectKey, sessionId);
    const line = serializeTranscriptRecord(record);
    const beforeSize = transcriptSize(path);

    appendTranscriptLine(path, line);
    try {
      return this.#transaction(() => {
        const ingest = this.#db
          .prepare("SELECT transcript_offset FROM session_ingest WHERE session_id = ?")
          .get(sessionId);
        if (!isSqlRow(ingest)) throw new MissingIngestRowError(sessionId);
        const offset = readInt(ingest, "transcript_offset") ?? 0;
        const size = beforeSize + Buffer.byteLength(line, "utf8");
        // An append counts only where it ends past what a refresh has read
        // (B20); the file size is authoritative for the bookkeeping.
        const counted = size > offset ? 1 : 0;
        const eventAt = recordTimestamp(record) ?? this.#clock.now();
        const visible = isUserVisibleRecord(record) ? 1 : 0;

        this.#db
          .prepare(
            `UPDATE sessions
                SET messages_count = messages_count + ?,
                    last_event_at = MAX(COALESCE(last_event_at, 0), ?),
                    has_user_visible_messages = CASE WHEN ? = 1 THEN 1
                                                    ELSE has_user_visible_messages END
              WHERE session_id = ?`,
          )
          .run(counted, eventAt, visible, sessionId);

        this.#db
          .prepare(
            `UPDATE session_ingest
                SET transcript_size = ?,
                    transcript_offset = ?,
                    transcript_mtime_ms = ?,
                    transcript_messages_count = transcript_messages_count + ?
              WHERE session_id = ?`,
          )
          .run(size, size, this.#clock.now(), counted, sessionId);

        const updated = this.#requireSession(sessionId);
        return {
          size,
          messagesCount: updated.messagesCount,
          lastEventAt: updated.lastEventAt,
          hasUserVisibleMessages: updated.hasUserVisibleMessages,
        };
      });
    } catch (error) {
      // The transcript is ahead of the index only until the next refresh; an
      // index write that failed outright must not leave a line the index never
      // counted, so undo the append (B21's "no partial row").
      try {
        truncateSync(path, beforeSize);
      } catch {
        // A refused truncate leaves the line for a refresh to reconcile.
      }
      throw error;
    }
  }

  readSession(sessionId: string): readonly JsonObject[] {
    this.#ensureOpen();
    const session = this.#requireSession(sessionId);
    const path = transcriptPathFor(this.#sessionsDir, session.projectKey, sessionId);
    return readTranscriptFile(path, sessionId);
  }

  listSessions(options: ListSessionsOptions = {}): readonly SessionListItem[] {
    this.#ensureOpen();
    const limit = boundedInteger(options.limit ?? DEFAULT_LIST_LIMIT, 0, MAX_LIST_LIMIT, "limit");
    const offset = boundedInteger(options.offset ?? 0, 0, MAX_LIST_OFFSET, "offset");
    const cwd = options.cwd ?? null;
    const includeArchived = options.includeArchived === true ? 1 : 0;

    const rows = this.#db
      .prepare(
        `SELECT s.session_id, s.project_key, s.cwd, s.title, s.archived_at,
                s.first_event_at, s.messages_count, json(s.tags) AS tags_json,
                NULLIF(MAX(COALESCE(i.transcript_mtime_ms, 0),
                           COALESCE(s.last_event_at, 0)), 0) AS modified_time_ms
           FROM sessions s
           LEFT JOIN session_ingest i ON i.session_id = s.session_id
          WHERE s.project_key <> 'btw'
            AND (? = 1 OR s.archived_at IS NULL)
          ORDER BY modified_time_ms DESC,
                   CASE WHEN ? IS NULL THEN 0 WHEN s.cwd = ? THEN 1 ELSE 0 END DESC,
                   s.session_id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(includeArchived, cwd, cwd, limit, offset);

    const items: SessionListItem[] = [];
    for (const row of rows) {
      if (!isSqlRow(row)) continue;
      const sessionId = readString(row, "session_id");
      const projectKey = readString(row, "project_key");
      if (sessionId === null || projectKey === null) continue;
      items.push({
        sessionId,
        projectKey,
        cwd: readString(row, "cwd"),
        title: readString(row, "title"),
        updatedAt: readInt(row, "modified_time_ms"),
        createdAt: readInt(row, "first_event_at"),
        messagesCount: readInt(row, "messages_count") ?? 0,
        archived: readString(row, "archived_at") !== null,
        tags: parseTags(sessionId, row),
      });
    }
    return items;
  }

  tag(sessionId: string, name: string, value: JsonValue = 1): void {
    this.#ensureOpen();
    validateTagName(name);
    this.#transaction(() => {
      const tags = this.#readTags(sessionId);
      this.#writeTags(sessionId, serializeTags({ ...tags, [name]: value }));
    });
  }

  untag(sessionId: string, name: string): void {
    this.#ensureOpen();
    validateTagName(name);
    this.#transaction(() => {
      const tags = this.#readTags(sessionId);
      if (!(name in tags)) return;
      const next: Record<string, JsonValue> = { ...tags };
      delete next[name];
      this.#writeTags(sessionId, serializeTags(next));
    });
  }

  search(query: string, options: SearchOptions = {}): SearchResult {
    this.#ensureOpen();
    const needle = normalizeQuery(query);
    const kind = options.kind ?? "all";
    if (kind !== "all" && !isSessionKind(kind)) {
      throw new InvalidArgumentError(`unknown search kind: ${String(kind)}`);
    }
    const limitSessions = boundedInteger(
      options.limitSessions ?? DEFAULT_SEARCH_SESSIONS,
      1,
      MAX_SEARCH_SESSIONS,
      "limitSessions",
    );
    const limitHits = boundedInteger(
      options.limitHits ?? DEFAULT_SEARCH_HITS,
      1,
      MAX_SEARCH_HITS,
      "limitHits",
    );
    const contextChars = boundedInteger(
      options.contextChars ?? DEFAULT_CONTEXT_CHARS,
      0,
      MAX_CONTEXT_CHARS,
      "contextChars",
    );
    const activeOrgId = options.activeOrgId ?? null;
    if (activeOrgId !== null && activeOrgId.length === 0) {
      throw new InvalidArgumentError("activeOrgId must not be empty");
    }
    const projectKey = options.projectKey ?? null;
    const since = optionalEpoch(options.since, "since");
    const until = optionalEpoch(options.until, "until");

    const candidates = this.#searchCandidates({
      includeArchived: options.includeArchived === true,
      excludeChildren: options.excludeChildren === true,
      includeHidden: options.includeHidden === true,
      activeOrgId,
      projectKey,
      since,
      until,
    });

    const matched: MatchedSession[] = [];
    let complete = true;
    for (const candidate of candidates) {
      const path = transcriptPathFor(this.#sessionsDir, candidate.projectKey, candidate.sessionId);
      if (!existsSync(path)) {
        // A row whose file vanished is a coverage gap, not a crash: the next
        // refresh prunes it (B30). The result says so instead of guessing.
        complete = false;
        continue;
      }
      const records = readTranscriptFile(path, candidate.sessionId);
      const hits = collectHits(records, needle, kind, limitHits, contextChars);
      if (hits.length > 0) matched.push({ candidate, hits });
    }

    matched.sort((left, right) => compareMatches(left, right, needle));

    const sessions: SearchSession[] = [];
    for (const match of matched.slice(0, limitSessions)) {
      const session: {
        sessionId: string;
        title?: string;
        updatedAt?: number;
        hits: readonly SearchHit[];
      } = { sessionId: match.candidate.sessionId, hits: match.hits };
      if (match.candidate.title !== null) session.title = match.candidate.title;
      if (match.candidate.lastEventAt !== null) session.updatedAt = match.candidate.lastEventAt;
      sessions.push(session);
    }

    const result: {
      sessions: readonly SearchSession[];
      sessionCount: { readonly count: number; readonly exact: boolean };
      complete: boolean;
      coverageReason?: string;
    } = {
      sessions,
      sessionCount: { count: matched.length, exact: true },
      complete,
    };
    if (!complete) result.coverageReason = "transcript-missing";
    return result;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new StoreClosedError();
  }

  #requireSession(sessionId: string): SessionRow {
    const session = this.getSession(sessionId);
    if (session === null) throw new UnknownSessionError(sessionId);
    return session;
  }

  #transaction<T>(work: () => T): T {
    if (this.#inTransaction) throw new NestedTransactionError();
    this.#inTransaction = true;
    this.#db.exec(`PRAGMA busy_timeout = ${MUTATION_BUSY_TIMEOUT_MS}`);
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // The failure came from BEGIN/COMMIT itself; keep the original error.
        }
        throw error;
      }
    } finally {
      this.#inTransaction = false;
      this.#db.exec(`PRAGMA busy_timeout = ${RESTING_BUSY_TIMEOUT_MS}`);
    }
  }

  #readTags(sessionId: string): Readonly<Record<string, JsonValue>> {
    const row = this.#db.prepare("SELECT json(tags) AS tags_json FROM sessions WHERE session_id = ?").get(sessionId);
    if (!isSqlRow(row)) throw new UnknownSessionError(sessionId);
    return parseTags(sessionId, row);
  }

  #writeTags(sessionId: string, serialized: string): void {
    const result = this.#db
      .prepare("UPDATE sessions SET tags = jsonb(?) WHERE session_id = ?")
      .run(serialized, sessionId);
    if (Number(result.changes) === 0) throw new UnknownSessionError(sessionId);
  }

  #searchCandidates(options: {
    readonly includeArchived: boolean;
    readonly excludeChildren: boolean;
    readonly includeHidden: boolean;
    readonly activeOrgId: string | null;
    readonly projectKey: string | null;
    readonly since: number | null;
    readonly until: number | null;
  }): readonly SearchCandidate[] {
    const rows = this.#db
      .prepare(
        `SELECT session_id, project_key, title, last_event_at
           FROM sessions
          WHERE (? = 1 OR archived_at IS NULL)
            AND (? = 1 OR calling_session_id IS NULL)
            AND (? = 1 OR has_user_visible_messages IS NOT 0)
            AND ((? IS NULL AND org_id IS NULL)
                 OR (? IS NOT NULL AND (org_id IS NULL OR org_id = ?)))
            AND (? IS NULL OR project_key = ?)
            AND (? IS NULL OR COALESCE(last_event_at, 0) >= ?)
            AND (? IS NULL OR COALESCE(last_event_at, 0) <= ?)
          ORDER BY session_id ASC`,
      )
      .all(
        options.includeArchived ? 1 : 0,
        options.excludeChildren ? 1 : 0,
        options.includeHidden ? 1 : 0,
        options.activeOrgId,
        options.activeOrgId,
        options.activeOrgId,
        options.projectKey,
        options.projectKey,
        options.since,
        options.since,
        options.until,
        options.until,
      );

    const candidates: SearchCandidate[] = [];
    for (const row of rows) {
      if (!isSqlRow(row)) continue;
      const sessionId = readString(row, "session_id");
      const projectKey = readString(row, "project_key");
      if (sessionId === null || projectKey === null) continue;
      candidates.push({
        sessionId,
        projectKey,
        title: readString(row, "title"),
        lastEventAt: readInt(row, "last_event_at"),
      });
    }
    return candidates;
  }
}

function normalizeQuery(query: string): string {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) throw new InvalidArgumentError("search query is empty");
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw new InvalidArgumentError(`search query is longer than ${MAX_QUERY_CHARS} characters`);
  }
  return trimmed;
}

function validateTagName(name: string): void {
  if (name.length === 0 || name.length > 128) {
    throw new InvalidArgumentError("tag name must be 1-128 characters");
  }
}

function serializeTags(tags: Readonly<Record<string, JsonValue>>): string {
  try {
    return JSON.stringify(tags);
  } catch (error) {
    throw new InvalidArgumentError(`tag value is not JSON-serialisable: ${String(error)}`);
  }
}

export function openSessionStore(options: SessionStoreOptions): SessionStore {
  const opened = openSessionIndexDatabase({ dbPath: options.dbPath, clock: options.clock });
  return new SessionStore(opened.db, options);
}