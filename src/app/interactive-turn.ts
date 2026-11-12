/**
 * The interactive turn driver: one submitted line becomes one agent-loop turn
 * whose events become transcript rows.
 *
 * Contract:
 * - `specs/20-agent-loop.md` §B1–B5 (one turn at a time, one reason per turn),
 *   §B20–B30 (streaming events, the tool cycle, the permission gates) and
 *   §B46–B49 (compaction, when a limit is supplied);
 * - `specs/95-terminal-ui.md` §B12 (the running status) and R11/R12 (the
 *   approval prompt and the system notice).
 *
 * Everything is injected — the model wiring, the loop's tool port, the clock,
 * the frame timer and the paint callback — so this module never reads
 * `process`, tests never mount a terminal, and no request outlives the session.
 *
 * Rows are the transcript's own wire shape (`TranscriptEntry`): the driver
 * appends them, the renderer validates them. Streaming text is coalesced: a
 * burst of provider deltas updates the row in memory and schedules one paint,
 * so a fast stream costs one frame instead of one frame per token.
 */
import { runTurn } from "../agent/loop.ts";
import { DEFAULT_KEEP_RECENT_TURNS } from "../agent/compaction.ts";
import type {
  LoopClock,
  Provider,
  RetryPolicy,
  Summarizer,
  ToolRunner,
  TurnDependencies,
  TurnEvent,
} from "../agent/ports.ts";
import type { Message, Role } from "../agent/messages.ts";
import type { PermissionRequest, ToolClass } from "../tools/permissions.ts";
import type { KeyAction } from "../ui/keys.ts";
import {
  APPROVAL_OPTION_LABELS,
  STATUS_TEXTS,
  TURN_ALREADY_RUNNING,
  TURN_CANCELLED,
  withStopHint,
} from "../ui/strings.ts";
import type {
  ApprovalChoice,
  ApprovalOption,
  TranscriptEntry,
} from "../ui/transcript.ts";

/** What the driver needs to run a turn; resolved on the first submit. */
export interface TurnAgent {
  readonly provider: Provider;
  /** Builds the loop's tool port, exactly as the exec path does. */
  readonly tools: (confirm: ConfirmToolRequest) => ToolRunner;
  /** Enables threshold compaction at this token ceiling (§B46). */
  readonly compactionTokenLimit?: number;
  /** Ceiling on model requests per turn; defaults to 64. */
  readonly maxTurns?: number;
}

/** The confirmation callback the exec tool runner asks before an `ask` call. */
export type ConfirmToolRequest = (
  request: PermissionRequest,
) => Promise<boolean>;

/** Injectable timers: the frame coalescer and an abortable retry sleep. */
export interface TurnTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the transcript and status line show while a turn runs (B12). */
export type TurnStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "invoking"
  | "awaiting_approval"
  | "cancelling";

/** A ceiling, not a policy: enough iterations for a tool-using answer. */
export const DEFAULT_INTERACTIVE_MAX_TURNS = 64;

/** One paint per ~60 Hz frame at most. */
export const DEFAULT_FRAME_MS = 16;

/** The instruction compaction's summariser appends (same text as exec). */
const COMPACTION_INSTRUCTION =
  "Summarize the conversation above for continuity: decisions taken, files touched, " +
  "open questions and the next concrete step. Keep it under 400 words, no preamble.";

const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { choice: "once", label: APPROVAL_OPTION_LABELS.once },
  { choice: "session", label: APPROVAL_OPTION_LABELS.session },
  { choice: "deny", label: APPROVAL_OPTION_LABELS.deny },
];

/** No retries: a failed request is reported, not repeated. */
const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  factor: 1,
  shouldRetry: () => false,
};

/**
 * The loop's own gate stays out of the way: every decision is made by the
 * injected tool runner (which is exec's), so a denial becomes a tool result
 * instead of a silent skip.
 */
const ALLOW_ALL = {
  decide: () => "allow" as const,
  async confirm(): Promise<boolean> {
    return true;
  },
};

export interface TurnDriverOptions {
  /** Resolves the model and tool wiring; called at most once, on first use. */
  readonly connect: () => Promise<TurnAgent>;
  /** The wall clock, in Unix ms; only timestamps are read. */
  readonly clock: () => number;
  readonly timers: TurnTimers;
  /** Called when painted state changed; the owner repaints the shell. */
  readonly onChange: () => void;
  readonly frameMs?: number;
  /** Transcript rows already present (a resumed session). */
  readonly initialEntries?: readonly TranscriptEntry[];
  /** Messages already exchanged (a resumed session). */
  readonly initialMessages?: readonly Message[];
  /** Assistant, tool and user message ids; injected for replayable tests. */
  readonly nextMessageId?: (role: Role) => string;
}

export interface TurnDriver {
  /** The rows the shell renders, oldest first. */
  readonly entries: readonly TranscriptEntry[];
  /** The conversation as the loop last left it. */
  readonly messages: readonly Message[];
  readonly status: TurnStatus;
  /** The status-line row while a turn runs; `undefined` when idle. */
  readonly statusText: string | undefined;
  readonly running: boolean;
  /** True while an approval prompt owns the keyboard. */
  readonly approvalOpen: boolean;
  /**
   * Submit one line: append the user row and start the turn. A submit while a
   * turn runs appends a notice instead (steering/queueing are not implemented).
   */
  submit(text: string): void;
  /** Esc: abort the in-flight turn; the loop settles as `cancelled`. */
  cancel(): void;
  /** Route one resolved key to an open approval; false when none is open. */
  handleApprovalAction(action: KeyAction): boolean;
  /** Answer the open approval directly; false when none is open. */
  decideApproval(choice: ApprovalChoice): boolean;
  /** Append a `●` notice row (composer notices, turn errors). */
  appendNotice(text: string): void;
  /** Resolves when the in-flight turn (if any) has settled. */
  settled(): Promise<void>;
  /** Abort an in-flight turn, drop the frame timer, and wait for settlement. */
  dispose(): Promise<void>;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/** A tool call's input as `key: value` rows; values stay raw for the renderer. */
function paramsOf(input: unknown): readonly (readonly [string, string])[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const params: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      params.push([key, value]);
      continue;
    }
    try {
      params.push([key, JSON.stringify(value) ?? String(value)]);
    } catch {
      params.push([key, String(value)]);
    }
  }
  return params;
}

/** B8: a tool result's text, images as a placeholder; model-only text never enters. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record["type"] === "text") {
        return typeof record["text"] === "string" ? record["text"] : "";
      }
      return record["type"] === "image" ? "placeholder" : "[document]";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/** R11: the one dimmed line under the approval header. */
function approvalSummary(request: PermissionRequest): string {
  const parts: string[] = [request.toolClass];
  if (request.riskLevel !== undefined) {
    parts.push(`risk: ${String(request.riskLevel)}`);
  }
  if (request.commandPolicy !== undefined) {
    parts.push(`policy: ${request.commandPolicy.decision}`);
  }
  if (request.path !== undefined) parts.push(request.path);
  return parts.join(" · ");
}

export function createTurnDriver(options: TurnDriverOptions): TurnDriver {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  let entries: TranscriptEntry[] = [...(options.initialEntries ?? [])];
  let messages: Message[] = [...(options.initialMessages ?? [])];
  let status: TurnStatus = "idle";
  let frame: unknown;
  let disposed = false;
  let counter = 0;
  let turn:
    | { readonly controller: AbortController; readonly promise: Promise<void> }
    | undefined;
  /** The assistant row the current response streams into. */
  let assistantRow: number | undefined;
  let assistantText = "";
  let callRows = new Map<string, number>();
  let selected = 0;
  let pending:
    | {
        readonly key: string;
        readonly toolClass: ToolClass;
        readonly row: number;
        readonly resolve: (approved: boolean) => void;
      }
    | undefined;
  const sessionApprovals = new Set<string>();
  let connecting: Promise<TurnAgent> | undefined;
  let tools: ToolRunner | undefined;

  function nextId(role: Role): string {
    if (options.nextMessageId !== undefined) return options.nextMessageId(role);
    counter += 1;
    return `${role}-${counter}`;
  }

  const clearFrame = (): void => {
    if (frame === undefined) return;
    options.timers.clearTimeout(frame);
    frame = undefined;
  };

  /** One paint per frame: the first change schedules it, the rest join it. */
  function publish(immediate = false): void {
    if (disposed) return;
    if (immediate) {
      clearFrame();
      options.onChange();
      return;
    }
    if (frame !== undefined) return;
    frame = options.timers.setTimeout(() => {
      frame = undefined;
      options.onChange();
    }, frameMs);
  }

  function appendEntry(entry: TranscriptEntry): number {
    entries = [...entries, entry];
    return entries.length - 1;
  }

  function updateEntry(index: number, patch: Record<string, unknown>): void {
    if (index < 0 || index >= entries.length) return;
    entries = entries.map((entry, at) =>
      at === index ? { ...entry, ...patch } : entry,
    );
  }

  function appendNotice(text: string): void {
    if (disposed) return;
    appendEntry({ kind: "notice", text });
    publish(true);
  }

  function settlePending(choice: ApprovalChoice): boolean {
    const current = pending;
    if (current === undefined) return false;
    pending = undefined;
    // A process call is never remembered for the session: the whole class is
    // the one the spec keeps behind an explicit prompt.
    if (choice === "session" && current.toolClass !== "execute") {
      sessionApprovals.add(current.key);
    }
    updateEntry(current.row, { decision: choice });
    status = "invoking";
    current.resolve(choice !== "deny");
    publish(true);
    return true;
  }

  /** R11: an `ask` becomes a row and a promise; the renderer is never blocked. */
  function requestApproval(request: PermissionRequest): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const key = request.llmId ?? request.toolId;
    if (sessionApprovals.has(key)) return Promise.resolve(true);
    // The loop settles one call at a time, so a second prompt cannot overlap.
    if (pending !== undefined) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    selected = 0;
    const row = appendEntry({
      kind: "approval",
      toolName: key,
      summary: approvalSummary(request),
      options: APPROVAL_OPTIONS,
      selected: 0,
    });
    pending = { key, toolClass: request.toolClass, row, resolve };
    status = "awaiting_approval";
    publish(true);
    return promise;
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal.aborted) return Promise.reject(abortError());
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const handle = options.timers.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      options.timers.clearTimeout(handle);
      reject(abortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return promise;
  }

  function summarizerFor(provider: Provider): Summarizer {
    return {
      async summarize(list, { signal }) {
        const instruction: Message = {
          id: "compaction-instruction",
          role: "user",
          content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
          createdAt: options.clock(),
          updatedAt: options.clock(),
        };
        let summary = "";
        for await (const delta of provider.stream([...list, instruction], {
          signal,
        })) {
          if (delta.type === "text") summary += delta.text;
        }
        return summary;
      },
    };
  }

  function dependencies(current: TurnAgent): TurnDependencies {
    if (tools === undefined) tools = current.tools(requestApproval);
    const clock: LoopClock = { now: options.clock, sleep };
    const compaction =
      current.compactionTokenLimit === undefined
        ? {}
        : {
            compaction: {
              limit: current.compactionTokenLimit,
              summarizer: summarizerFor(current.provider),
              keepRecent: DEFAULT_KEEP_RECENT_TURNS,
            },
          };
    return {
      provider: current.provider,
      tools,
      permissions: ALLOW_ALL,
      clock,
      retry: NO_RETRY,
      emit: handleEvent,
      nextMessageId: nextId,
      ...compaction,
    };
  }

  function startAssistantRow(text: string): void {
    if (assistantRow === undefined)
      assistantRow = appendEntry({
        kind: "assistant",
        text,
      });
    else updateEntry(assistantRow, { text });
  }

  function handleEvent(event: TurnEvent): void {
    switch (event.type) {
      case "turn_start":
        status = "thinking";
        assistantRow = undefined;
        assistantText = "";
        publish();
        return;
      case "thinking_delta":
        // R3: thinking is collapsed — it earns a status, never a row.
        if (status !== "streaming" && status !== "thinking") {
          status = "thinking";
          publish();
        }
        return;
      case "text_delta":
        status = "streaming";
        assistantText += event.text;
        startAssistantRow(assistantText);
        publish();
        return;
      case "assistant_message": {
        const text = event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text.length > 0) {
          assistantText = text;
          startAssistantRow(text);
        }
        assistantRow = undefined;
        assistantText = "";
        publish();
        return;
      }
      case "tool_call": {
        status = "invoking";
        const row = appendEntry({
          kind: "tool",
          name: event.name,
          params: paramsOf(event.input),
          state: "pending",
          interrupted: false,
        });
        callRows.set(event.id, row);
        publish();
        return;
      }
      case "tool_result": {
        const row = callRows.get(event.id);
        if (row !== undefined) {
          updateEntry(row, { state: event.isError ? "error" : "success" });
        }
        publish();
        return;
      }
      case "tool_message": {
        for (const block of event.message.content) {
          if (block.type !== "tool_result") continue;
          const row = callRows.get(block.toolUseId);
          if (row === undefined) continue;
          updateEntry(row, {
            state: block.isError === true ? "error" : "success",
            result: resultText(block.content),
          });
        }
        publish();
        return;
      }
      case "retry":
        status = "thinking";
        publish();
        return;
      case "compaction":
        return;
      case "turn_complete":
        // `run` reports the outcome; this event only names it for observers.
        return;
    }
  }

  async function connectAgent(): Promise<TurnAgent> {
    connecting ??= options.connect();
    return connecting;
  }

  function appendCancelled(): void {
    appendEntry({ kind: "notice", text: TURN_CANCELLED });
  }

  async function run(
    history: readonly Message[],
    controller: AbortController,
  ): Promise<void> {
    if (controller.signal.aborted) {
      appendCancelled();
      return;
    }
    let current: TurnAgent;
    try {
      current = await connectAgent();
    } catch (error) {
      // A missing credential or a broken tool server: the shell stays usable
      // and the user reads why in the transcript.
      appendEntry({
        kind: "notice",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (controller.signal.aborted) {
      appendCancelled();
      return;
    }
    try {
      const outcome = await runTurn(dependencies(current), {
        messages: history,
        maxTurns: current.maxTurns ?? DEFAULT_INTERACTIVE_MAX_TURNS,
        signal: controller.signal,
      });
      messages = [...outcome.messages];
      // B5: the loop reports exactly one reason. Cancellation does not emit a
      // `turn_complete`, so the notice is appended here, once.
      if (outcome.reason === "cancelled") appendCancelled();
      else if (outcome.reason === "error") {
        appendEntry({
          kind: "notice",
          text: `Error: ${outcome.error ?? "The model request failed."}`,
        });
      } else if (outcome.reason === "max_turns") {
        appendEntry({
          kind: "notice",
          text: "Turn ended after reaching the maximum number of turns.",
        });
      }
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) appendCancelled();
      else {
        appendEntry({
          kind: "notice",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      messages = [...history];
    }
  }

  function submit(text: string): void {
    if (disposed) return;
    if (turn !== undefined) {
      // TODO(spec 95 B10): steering and the queued-message list are not
      // implemented, so a second submit is refused with a notice instead of
      // being queued or delivered to the running turn.
      appendNotice(TURN_ALREADY_RUNNING);
      return;
    }
    entries = [...entries, { kind: "user", text, specMode: false }];
    const at = options.clock();
    const userMessage: Message = {
      id: nextId("user"),
      role: "user",
      content: [{ type: "text", text }],
      createdAt: at,
      updatedAt: at,
    };
    const history = [...messages, userMessage];
    const controller = new AbortController();
    status = "thinking";
    assistantRow = undefined;
    assistantText = "";
    callRows = new Map();
    publish(true);
    const promise = run(history, controller).finally(() => {
      if (turn?.controller !== controller) return;
      turn = undefined;
      status = "idle";
      assistantRow = undefined;
      assistantText = "";
      publish(true);
    });
    turn = { controller, promise };
  }

  function cancel(): void {
    if (disposed) return;
    if (pending !== undefined) {
      settlePending("deny");
      return;
    }
    if (turn === undefined) return;
    if (status !== "cancelling") {
      status = "cancelling";
      publish(true);
    }
    turn.controller.abort();
  }

  function handleApprovalAction(action: KeyAction): boolean {
    if (pending === undefined) return false;
    switch (action.kind) {
      case "history": {
        const count = APPROVAL_OPTIONS.length;
        selected =
          action.direction === "previous"
            ? (selected + count - 1) % count
            : (selected + 1) % count;
        if (pending !== undefined) updateEntry(pending.row, { selected });
        publish(true);
        return true;
      }
      case "insert": {
        const key = action.text.toLowerCase();
        if (key === "y" || key === "1") return settlePending("once");
        if (key === "a" || key === "2") return settlePending("session");
        if (key === "n" || key === "3") return settlePending("deny");
        return true;
      }
      case "submit":
      case "newline":
        return settlePending(APPROVAL_OPTIONS[selected]?.choice ?? "once");
      case "escape":
      case "interrupt":
        return settlePending("deny");
      case "quit":
        return false;
      default:
        return true;
    }
  }

  return {
    get entries() {
      return entries;
    },
    get messages() {
      return messages;
    },
    get status() {
      return status;
    },
    get statusText() {
      switch (status) {
        case "idle":
          return undefined;
        case "thinking":
          return withStopHint(STATUS_TEXTS.thinking);
        case "streaming":
          return withStopHint(STATUS_TEXTS.streaming);
        case "invoking":
          return withStopHint(STATUS_TEXTS.invoking);
        case "awaiting_approval":
          return withStopHint(STATUS_TEXTS.confirmation);
        case "cancelling":
          return withStopHint(STATUS_TEXTS.cancelling);
      }
    },
    get running() {
      return turn !== undefined;
    },
    get approvalOpen() {
      return pending !== undefined;
    },
    submit,
    cancel,
    handleApprovalAction,
    decideApproval: settlePending,
    appendNotice,
    settled(): Promise<void> {
      return turn?.promise ?? Promise.resolve();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      clearFrame();
      settlePending("deny");
      const current = turn;
      current?.controller.abort();
      if (current !== undefined) await current.promise.catch(() => undefined);
      // A wiring promise that was never awaited must not surface as an
      // unhandled rejection once the session is gone.
      await connecting?.catch(() => undefined);
    },
  };
}
