/**
 * `search|find` command body.
 *
 * Contract: `specs/40-sessions-and-storage.md` §B43–B56. Option parsing lives in
 * the Commander definition; this module validates, runs the store query and
 * renders. The human wording is ours (open question 1 of that spec); the
 * `--json` shape is contractual.
 */
import type {
  SearchHit,
  SearchResult,
  SessionStore,
} from "../session/store.ts";

export const SEARCH_KINDS = [
  "message_text",
  "document",
  "tool_use",
  "tool_result",
  "all",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchCommandOptions {
  readonly kind?: string;
  readonly limitSessions?: string;
  readonly limitHits?: string;
  readonly contextChars?: string;
  readonly json?: boolean;
  readonly reindex?: boolean;
  readonly includeArchived?: boolean;
  readonly excludeChildren?: boolean;
  readonly includeHidden?: boolean;
}

export interface SearchDeps {
  readonly openStore: () => Promise<SessionStore>;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

const LIMITS = {
  limitSessions: { min: 1, max: 1000 },
  limitHits: { min: 1, max: 20 },
  contextChars: { min: 0, max: 1000 },
} as const;

const MAX_SNIPPET = 120;
const MAX_TITLE = 60;

const CONTROL_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

function parseBounded(
  name: keyof typeof LIMITS,
  raw: string | undefined,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  const { min, max } = LIMITS[name];
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      ok: false,
      message: `${name} must be an integer between ${min} and ${max}, got ${raw}`,
    };
  }
  return { ok: true, value };
}

/** Cut to `limit` code points without splitting a surrogate pair. */
function cut(text: string, limit: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) return text;
  return `${codePoints.slice(0, limit).join("")}…`;
}

function clean(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "").replace(/\s+/g, " ").trim();
}

function anchor(docId: string): string {
  const line = /^line:(\d+)$/.exec(docId);
  if (line !== null) return `L${line[1]}`;
  const event = /^event:(.+)$/.exec(docId);
  if (event !== null) return `@${event[1]}`;
  return docId;
}

function renderHit(hit: SearchHit): string[] {
  const tool = hit.toolName === undefined ? "" : ` ${hit.toolName}`;
  return hit.snippets.map(
    (snippet) =>
      `  ${anchor(hit.docId)} ${hit.kind}${tool}: ${cut(clean(snippet), MAX_SNIPPET)}`,
  );
}

export function renderSearchText(result: SearchResult, query: string): string {
  const total = result.sessionCount.count;
  const shown = result.sessions.length;
  const countLine = result.sessionCount.exact
    ? `${total} session${total === 1 ? "" : "s"} matched "${query}"`
    : `${total} session${total === 1 ? "" : "s"} matched "${query}" (showing ${shown})`;
  const lines: string[] = [countLine];
  if (!result.complete) lines.push("results are incomplete");
  for (const session of result.sessions) {
    const title =
      session.title === undefined
        ? ""
        : ` ${cut(clean(session.title), MAX_TITLE)}`;
    lines.push(`${session.sessionId}${title} · ${session.hits.length}`);
    for (const hit of session.hits) lines.push(...renderHit(hit));
  }
  return `${lines.join("\n")}\n`;
}

/** The contractual `--json` projection (B54). */
export function renderSearchJson(result: SearchResult): string {
  const payload = {
    sessions: result.sessions.map((session) => ({
      sessionId: session.sessionId,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.updatedAt === undefined
        ? {}
        : { updatedAt: session.updatedAt }),
      hits: session.hits.map((hit) => ({
        docId: hit.docId,
        kind: hit.kind,
        ...(hit.toolName === undefined ? {} : { toolName: hit.toolName }),
        ...(hit.messageRole === undefined
          ? {}
          : { messageRole: hit.messageRole }),
        snippets: hit.snippets,
      })),
    })),
    sessionCount: result.sessionCount,
    complete: result.complete,
    ...(result.coverageReason === undefined
      ? {}
      : { coverageReason: result.coverageReason }),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export async function runSearchCommand(
  query: string,
  options: SearchCommandOptions,
  deps: SearchDeps,
): Promise<void> {
  const kind = options.kind ?? "all";
  if (!(SEARCH_KINDS as readonly string[]).includes(kind)) {
    deps.writeError(
      `Invalid --kind value: ${kind}. Expected one of ${SEARCH_KINDS.join(", ")}.\n`,
    );
    deps.setExitCode(1);
    return;
  }

  const sessions = parseBounded("limitSessions", options.limitSessions);
  if (!sessions.ok) {
    deps.writeError(`${sessions.message}\n`);
    deps.setExitCode(1);
    return;
  }
  const hits = parseBounded("limitHits", options.limitHits);
  if (!hits.ok) {
    deps.writeError(`${hits.message}\n`);
    deps.setExitCode(1);
    return;
  }
  const context = parseBounded("contextChars", options.contextChars);
  if (!context.ok) {
    deps.writeError(`${context.message}\n`);
    deps.setExitCode(1);
    return;
  }

  let store: SessionStore;
  try {
    store = await deps.openStore();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      deps.setExitCode(130);
      return;
    }
    deps.writeError(
      `search failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    deps.setExitCode(1);
    return;
  }

  try {
    // `--reindex` brings the transcript index up to date before the query; the
    // search itself still falls back to the literal scan for any transcript the
    // index cannot speak for (B43, B55).
    if (options.reindex === true) store.reindex();
    const result = await store.search(query, {
      kind: kind as SearchKind,
      ...(sessions.value === undefined
        ? {}
        : { limitSessions: sessions.value }),
      ...(hits.value === undefined ? {} : { limitHits: hits.value }),
      ...(context.value === undefined ? {} : { contextChars: context.value }),
      ...(options.includeArchived === true ? { includeArchived: true } : {}),
      ...(options.excludeChildren === true ? { excludeChildren: true } : {}),
      ...(options.includeHidden === true ? { includeHidden: true } : {}),
    });
    deps.write(
      options.json === true
        ? renderSearchJson(result)
        : renderSearchText(result, query),
    );
    deps.setExitCode(0);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      deps.setExitCode(130);
      return;
    }
    deps.writeError(
      `search failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    deps.setExitCode(1);
  } finally {
    store.close();
  }
}
