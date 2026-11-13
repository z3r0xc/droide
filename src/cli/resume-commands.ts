/**
 * `resume` command body.
 *
 * Contract: `specs/10-cli-surface.md` §B22–B25 and
 * `specs/40-sessions-and-storage.md` §B17, §B38–B40.
 *
 * Without an id the command chooses: on a terminal it offers the stored
 * sessions in a picker; on a pipe it prints the bounded newest-first list,
 * because there is nothing to choose with. With an id or a session link the
 * named session is validated against the store, then either a prompt runs one
 * non-interactive turn through the same path as `exec --session-id` or the
 * interactive shell takes the session, seeded with the stored transcript so the
 * first screen is the conversation (`src/app/session-seed.ts`).
 *
 * `--fork` copies the transcript into a new id first, with the same rules
 * `exec --fork` applies (a fork of an archived session is refused, and the copy
 * is registered against the effective working directory). Every refusal is a
 * one-line message on stderr and exit 1, matching the rest of the command
 * surface (`specs/10-cli-surface.md` B70/B72).
 */
import { ConfigError } from "../config/errors.ts";
import { openExecSession } from "../exec/session.ts";
import { isSessionId } from "../session/ids.ts";
import {
  TranscriptCorruptError,
  TranscriptUnavailableError,
} from "../session/errors.ts";
import { seedFromRecords, type SessionSeed } from "../app/session-seed.ts";
import {
  type SessionListItem,
  type SessionRow,
  type SessionStore,
  type SessionStoreOptions,
} from "../session/store.ts";
import type { CreateAppContextOptions, AppContext } from "../app/context.ts";
import type { ExecArgv, ExecCommandDeps } from "../exec/command.ts";

/** How many sessions one listing shows; the store clamps its own limits too. */
export const RESUME_LIST_LIMIT = 20;

/** Every refusal exits 1 (`specs/10-cli-surface.md` B70). */
export const RESUME_FAILURE_EXIT = 1;

export const LAST_REQUIRES_TERMINAL =
  "--last needs a terminal to pick a session; pass a session id instead.";
export const LAST_WITH_ID = "--last cannot be combined with a session id.";
export const FORK_NEEDS_ID = "--fork needs a session id.";
export const FORK_WITHOUT_PROMPT =
  "--fork needs a prompt when stdin and stdout are not both terminals.";

/** The picker was dismissed; nothing was resumed, so nothing is an error. */
export const NO_SESSION_SELECTED = "No session selected.";

/** B22: a transcript the shell cannot read is named, never an empty shell. */
export function missingTranscript(sessionId: string): string {
  return `The transcript for session ${sessionId} is missing, so it cannot be resumed.`;
}

export function corruptTranscript(sessionId: string, line: number): string {
  return `The transcript for session ${sessionId} is corrupt at line ${line}, so it cannot be resumed.`;
}

export function invalidSessionId(value: string): string {
  return `Invalid session id: ${value}. Expected a session UUID or a session link.`;
}

export function unknownSession(sessionId: string): string {
  return `Unknown session: ${sessionId}`;
}

export function archivedSession(
  action: "resume" | "fork",
  sessionId: string,
): string {
  return `Cannot ${action} an archived session: ${sessionId}`;
}

/** The options Commander has already parsed, normalised for this module. */
export interface ResumeCommandOptions {
  readonly sessionId: string | undefined;
  readonly promptParts: readonly string[];
  readonly fork: boolean;
  readonly last: boolean;
  readonly settings: string | undefined;
  readonly cwd: string | undefined;
}

/** A stored session as the resume surfaces name it. */
export interface ResumedSession {
  readonly sessionId: string;
  readonly title: string | null;
  readonly messagesCount: number;
  readonly updatedAt: number | null;
}

/** The two streams a terminal launch owns. */
export interface ResumeStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

export interface ResumeDeps {
  /** Product name used in the configuration-error prefix. */
  readonly program: string;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly streams: ResumeStreams;
  readonly stderr: NodeJS.WriteStream;
  readonly createContext: (
    options: CreateAppContextOptions,
  ) => Promise<AppContext>;
  readonly openStore: (options: SessionStoreOptions) => SessionStore;
  /** The `exec -s` path, injected so a test never reaches the network. */
  readonly runExec: (argv: ExecArgv, deps: ExecCommandDeps) => Promise<number>;
  readonly launchInteractive: (
    context: AppContext,
    streams: ResumeStreams,
    session: ResumedSession,
    seed: SessionSeed,
  ) => Promise<number>;
  /**
   * The terminal picker (B22). Receives the exact rows the list renderer would
   * show and reports an index, or `null` when the user aborted.
   */
  readonly pickSession: (
    labels: readonly string[],
    streams: ResumeStreams,
  ) => Promise<number | null>;
  readonly readStdin: () => Promise<string>;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly clock: () => number;
  readonly nextId: () => string;
}

const CONTROL_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const MAX_TITLE = 60;

/** Strip terminal sequences and collapse whitespace, as the list renderer does. */
function cleanTitle(title: string): string {
  return title.replace(CONTROL_SEQUENCE, "").replace(/\s+/g, " ").trim();
}

function cutTitle(title: string): string {
  const codePoints = Array.from(title);
  if (codePoints.length <= MAX_TITLE) return title;
  return `${codePoints.slice(0, MAX_TITLE).join("")}…`;
}

/**
 * A session id from a bare UUID or from a session link. A link is any absolute
 * URL whose last path segment is the id, which covers both the app's
 * `/sessions/<id>` pages and a `droide://sessions/<id>` deep link.
 */
export function parseSessionArgument(value: string): string | null {
  const trimmed = value.trim();
  if (isSessionId(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((part) => part !== "");
  const last = segments.at(-1);
  return last !== undefined && isSessionId(last) ? last : null;
}

/**
 * Newest first, with a plain string tie-break so the bytes never depend on the
 * host locale, bounded to what one listing shows. Every surface that shows a
 * session and then takes an index from the user iterates *this* array, so a
 * chosen row can never name a different session than the one drawn.
 */
export function orderSessions(
  items: readonly SessionListItem[],
): readonly SessionListItem[] {
  return [...items]
    .sort((left, right) => {
      const byTime = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      if (byTime !== 0) return byTime;
      if (left.sessionId === right.sessionId) return 0;
      return left.sessionId < right.sessionId ? 1 : -1;
    })
    .slice(0, RESUME_LIST_LIMIT);
}

/**
 * Newest first, bounded, and identical on a terminal and a pipe.
 */
export function renderSessionList(items: readonly SessionListItem[]): string {
  if (items.length === 0) return "No sessions found.\n";

  const lines = ["Recent sessions:"];
  for (const item of orderSessions(items)) {
    const title =
      item.title === null ? "(untitled)" : cutTitle(cleanTitle(item.title));
    lines.push(
      `  ${item.sessionId}  ${title}` +
        ` · ${item.messagesCount} ${item.messagesCount === 1 ? "message" : "messages"}` +
        ` · ${item.updatedAt === null ? "unknown" : new Date(item.updatedAt).toISOString()}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The picker's rows, in the order given: one line of id, title (or
 * "(untitled)") and update time per session. The caller passes an array it will
 * index with the picker's answer (`orderSessions`), so the row drawn and the
 * session resumed are the same one. The picker draws the pointer itself, so a
 * row carries no indent or marker.
 */
export function renderPickerRows(
  items: readonly SessionListItem[],
): readonly string[] {
  return items.map((item) => {
    const title =
      item.title === null ? "(untitled)" : cutTitle(cleanTitle(item.title));
    const when =
      item.updatedAt === null
        ? "unknown"
        : new Date(item.updatedAt).toISOString();
    return `${item.sessionId}  ${title} · ${when}`;
  });
}

/** The one line every resume path prints before it continues a session. */
export function renderResumedHeader(
  session: ResumedSession,
  forkedFrom: string | undefined,
): string {
  let suffix = "";
  if (forkedFrom !== undefined) suffix = ` (forked from ${forkedFrom})`;
  else if (session.title !== null) {
    const title = cutTitle(cleanTitle(session.title));
    if (title !== "") suffix = ` (${title})`;
  }
  return `Resumed session ${session.sessionId}${suffix}\n`;
}

function resumedFrom(row: SessionRow): ResumedSession {
  return {
    sessionId: row.sessionId,
    title: row.title,
    messagesCount: row.messagesCount,
    updatedAt: row.lastEventAt,
  };
}

function fail(deps: ResumeDeps, message: string): void {
  deps.writeError(`${message}\n`);
  deps.setExitCode(RESUME_FAILURE_EXIT);
}

/** The argv `exec --session-id` would have built for this one turn. */
export function execArgvFor(
  sessionId: string | undefined,
  prompt: string,
  options: Pick<ResumeCommandOptions, "settings" | "cwd">,
): ExecArgv {
  return {
    prompt,
    file: undefined,
    outputFormat: undefined,
    inputFormat: undefined,
    model: undefined,
    reasoningEffort: undefined,
    auto: undefined,
    skipPermissionsUnsafe: false,
    cwd: options.cwd,
    settings: options.settings,
    sessionId,
    fork: undefined,
    mission: false,
    useSpec: false,
    disableBuiltinSkills: false,
    specModel: undefined,
    listTools: false,
    onlyTools: [],
    addTools: [],
    removeTools: [],
    appendSystemPrompt: undefined,
    appendSystemPromptFile: undefined,
    worktree: undefined,
    worktreeDir: undefined,
    tags: [],
  };
}

function execDeps(deps: ResumeDeps, context: AppContext): ExecCommandDeps {
  return {
    program: deps.program,
    environment: context.environment,
    stdout: deps.streams.stdout,
    stderr: deps.stderr,
    stdinIsTTY: deps.stdinIsTTY,
    readStdin: deps.readStdin,
    clock: deps.clock,
    nextId: deps.nextId,
    createContext: async () => context,
  };
}

/** Choose the `--last` session: the newest in this folder, else the newest. */
function newestSession(
  store: SessionStore,
  cwd: string,
): SessionListItem | null {
  const items = store.listSessions({ limit: RESUME_LIST_LIMIT, cwd });
  const local = items.find((item) => item.cwd === cwd);
  return local ?? items[0] ?? null;
}

/**
 * Copy `sourceId`'s transcript into a fresh id and report the new session.
 *
 * Delegating to `openExecSession` keeps the fork rules in exactly one place:
 * the same registration fields, the same archived refusal, the same record
 * copy as `exec --fork` (`specs/80-exec-and-streaming.md` B36).
 */
function forkSession(
  store: SessionStore,
  context: AppContext,
  sourceId: string,
  deps: ResumeDeps,
): ResumedSession {
  const session = openExecSession({
    context,
    clock: deps.clock,
    nextId: deps.nextId,
    forkSessionId: sourceId,
    openStore: () => store,
  });
  const forkedId = session.sessionId;
  try {
    const row = store.getSession(forkedId);
    if (row === null) throw new Error(`Unknown forked session: ${forkedId}`);
    return resumedFrom(row);
  } finally {
    // Closing the exec session closes the store it was handed; the caller's
    // own close in the outer `finally` is a no-op afterwards.
    session.close();
  }
}

async function continueSession(
  sessionId: string,
  prompt: string,
  options: ResumeCommandOptions,
  context: AppContext,
  store: SessionStore,
  deps: ResumeDeps,
): Promise<void> {
  const row = store.getSession(sessionId);
  if (row === null) {
    fail(deps, unknownSession(sessionId));
    return;
  }
  if (row.archivedAt !== null) {
    fail(deps, archivedSession(options.fork ? "fork" : "resume", sessionId));
    return;
  }

  const launching = prompt === "" && deps.stdinIsTTY && deps.stdoutIsTTY;

  // B22: the shell is seeded from the stored transcript before it mounts, so
  // the first screen is the conversation and the next request extends it. The
  // read happens before a fork, because forking copies every record and closes
  // this store (`openExecSession` owns the handle it was given).
  let seed: SessionSeed | undefined;
  if (launching) {
    try {
      seed = seedFromRecords(store.readSession(sessionId));
    } catch (error) {
      if (error instanceof TranscriptUnavailableError) {
        fail(deps, missingTranscript(sessionId));
        return;
      }
      if (error instanceof TranscriptCorruptError) {
        fail(deps, corruptTranscript(sessionId, error.line));
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      fail(
        deps,
        `The transcript for session ${sessionId} could not be read: ${detail}`,
      );
      return;
    }
  }

  let session = resumedFrom(row);
  if (options.fork) {
    try {
      session = forkSession(store, context, sessionId, deps);
    } catch (error) {
      fail(deps, error instanceof Error ? error.message : String(error));
      return;
    }
  }

  const forkedFrom = options.fork ? sessionId : undefined;
  deps.write(renderResumedHeader(session, forkedFrom));

  if (prompt === "") {
    if (seed === undefined) {
      deps.setExitCode(0);
      return;
    }
    deps.setExitCode(
      await deps.launchInteractive(context, deps.streams, session, seed),
    );
    return;
  }

  // The injected exec dependency receives the already-built context directly,
  // so both layers see one settings resolution and one effective directory.
  deps.setExitCode(
    await deps.runExec(
      execArgvFor(session.sessionId, prompt, options),
      execDeps(deps, context),
    ),
  );
}

/**
 * Runs `resume`, choosing between the listing, the picker selection and a
 * named session. Never throws for an expected refusal: the message is written
 * and the exit code set, so the Commander action stays a thin wire.
 */
export async function runResumeCommand(
  options: ResumeCommandOptions,
  deps: ResumeDeps,
): Promise<void> {
  const prompt = options.promptParts.join(" ").trim();
  const hasId = options.sessionId !== undefined;

  // B82: the contextual flags only make sense against a session the terminal
  // could pick, so they are refused before any configuration or store work.
  if (options.last && !deps.stdinIsTTY) {
    fail(deps, LAST_REQUIRES_TERMINAL);
    return;
  }
  if (options.last && hasId) {
    fail(deps, LAST_WITH_ID);
    return;
  }
  if (options.fork && !hasId && !options.last) {
    fail(deps, FORK_NEEDS_ID);
    return;
  }
  if (options.fork && prompt === "" && !(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    fail(deps, FORK_WITHOUT_PROMPT);
    return;
  }

  let context: AppContext;
  try {
    context = await deps.createContext({
      ...(options.settings === undefined
        ? {}
        : { settingsFlag: options.settings }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    deps.writeError(`${deps.program}: ${error.message}\n`);
    deps.setExitCode(RESUME_FAILURE_EXIT);
    return;
  }

  let store: SessionStore;
  try {
    store = deps.openStore({
      dbPath: context.paths.sessionIndexDatabase,
      sessionsDir: context.paths.sessionsDir,
      clock: { now: deps.clock },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(deps, `Could not open the session store: ${detail}`);
    return;
  }

  try {
    let sessionId: string;
    if (hasId) {
      const raw = options.sessionId;
      const parsed = raw === undefined ? null : parseSessionArgument(raw);
      if (parsed === null) {
        fail(deps, invalidSessionId(raw ?? ""));
        return;
      }
      sessionId = parsed;
    } else if (options.last) {
      const chosen = newestSession(store, context.environment.cwd);
      if (chosen === null) {
        deps.write("No sessions found.\n");
        deps.setExitCode(0);
        return;
      }
      sessionId = chosen.sessionId;
    } else {
      // B22: a terminal chooses; a pipe gets the bounded list and nothing to
      // choose with, unchanged from what it always printed.
      const items = orderSessions(
        store.listSessions({
          limit: RESUME_LIST_LIMIT,
          cwd: context.environment.cwd,
        }),
      );
      if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) {
        deps.write(renderSessionList(items));
        deps.setExitCode(0);
        return;
      }
      if (items.length === 0) {
        deps.write("No sessions found.\n");
        deps.setExitCode(0);
        return;
      }
      // The picker's answer indexes the very array it was drawn from, so the
      // row the user picked and the session resumed cannot disagree.
      const chosen = await deps.pickSession(
        renderPickerRows(items),
        deps.streams,
      );
      const item = chosen === null ? undefined : items[chosen];
      if (item === undefined) {
        deps.writeError(`${NO_SESSION_SELECTED}\n`);
        deps.setExitCode(0);
        return;
      }
      sessionId = item.sessionId;
    }

    await continueSession(sessionId, prompt, options, context, store, deps);
  } finally {
    store.close();
  }
}
