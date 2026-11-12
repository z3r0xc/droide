/**
 * The ACP turn seam.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §ACP B65-B69.
 *
 * `exec` and ACP share one turn path: a `TurnRunner` receives a `TurnRequest`
 * and reports transcript events through a `TurnEventSink`. This module widens
 * that sink with ACP-only affordances (a `session/update` writer and a
 * permission round-trip), translates the loop's events into the update shapes
 * B68 lists, and maps a settled turn onto B66's stop reasons.
 *
 * The runner is injected, so a test scripts a turn without a model, a provider
 * or a tool registry.
 */

import type { AssistantBlock, AssistantMessageEvent } from "./records.ts";
import type { TurnEventSink, TurnOutcome, TurnRequest } from "./turn.ts";
import {
  ACP_ERROR_CODES,
  AcpProtocolError,
  agentMessageChunk,
  agentThoughtChunk,
  isAllowKind,
  mapOptionsToAcp,
  permissionResponseToOutcome,
  type AcpConfirmationOption,
  type AcpPermissionOutcome,
  type AcpPermissionOption,
  type AcpPlanEntry,
  type AcpPromptImage,
  type AcpRequestPermissionParams,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCallStatus,
  type AcpToolKind,
  type AcpToolConfirmationOutcome,
} from "../acp/protocol.ts";
import { isRecord } from "../transport/schema.ts";
import type { PermissionRequest } from "../tools/permissions.ts";

/** One prompt as the ACP surface resolved it (B65). */
export interface AcpTurnRequest extends TurnRequest {
  /**
   * TODO(spec B65): images are parsed, validated and carried here, but the
   * shared `TurnRequest` has no image channel, so a plain exec runner drops
   * them. Attaching them needs the agent loop's media port, which this
   * slice does not own.
   */
  readonly images: readonly AcpPromptImage[];
}

/** A permission answer as the client sent it. */
export type AcpPermissionResponse = AcpPermissionOutcome;

/** Where a turn reports ACP progress and asks for permission. */
export interface AcpTurnSink extends TurnEventSink {
  /** Writes one `session/update`; resolves once the frame is flushed. */
  readonly update: (update: AcpSessionUpdate) => Promise<void>;
  /** Sends `session/request_permission` and awaits the client's answer. */
  readonly requestPermission: (
    params: AcpRequestPermissionParams,
  ) => Promise<AcpPermissionResponse>;
  /** The turn's cancellation signal. */
  readonly signal: AbortSignal;
}

/**
 * A turn runner that participates in ACP. Structurally, every exec
 * `TurnRunner` already satisfies it; the interface only lets a runner see the
 * callback and the cancellation signal.
 */
export interface AcpTurnRunner {
  run(request: AcpTurnRequest, sink: AcpTurnSink): Promise<TurnOutcome>;
}

export interface CreateAcpTurnSinkOptions {
  readonly sessionId: string;
  readonly update: (update: AcpSessionUpdate) => Promise<void>;
  readonly requestPermission: (
    params: AcpRequestPermissionParams,
  ) => Promise<AcpPermissionResponse>;
  readonly signal: AbortSignal;
}

const TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  Read: "read",
  LS: "read",
  Glob: "search",
  Grep: "search",
  Edit: "edit",
  Create: "edit",
  Execute: "execute",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
};

const TODO_LINE = /^\s*\d+\.\s*\[(pending|in_progress|completed)\]\s*(.+?)\s*$/;
const TODO_PRIORITY: Readonly<Record<string, AcpPlanEntry["priority"]>> = {
  high: "high",
  medium: "medium",
  low: "low",
};
const TODO_STATUS: Readonly<Record<string, AcpPlanEntry["status"]>> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
};

function todoEntriesFromArray(value: readonly unknown[]): AcpPlanEntry[] {
  const entries: AcpPlanEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item["content"] !== "string") return [];
    const content = item["content"];
    if (content.length === 0) return [];
    const status =
      typeof item["status"] === "string"
        ? TODO_STATUS[item["status"].toLowerCase()]
        : undefined;
    const priority =
      typeof item["priority"] === "string"
        ? TODO_PRIORITY[item["priority"].toLowerCase()]
        : undefined;
    entries.push({
      content,
      status: status ?? "pending",
      priority: priority ?? "medium",
    });
  }
  return entries;
}

function todoEntriesFromText(value: string): AcpPlanEntry[] {
  const entries: AcpPlanEntry[] = [];
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const match = TODO_LINE.exec(line);
    if (match === null) return [];
    entries.push({
      content: match[2] ?? "",
      priority: "medium",
      status: TODO_STATUS[match[1] ?? "pending"] ?? "pending",
    });
  }
  return entries;
}

/** `TodoWrite` input as plan entries, or `undefined` when it is not one. */
export function planEntriesFromTodos(
  input: unknown,
): readonly AcpPlanEntry[] | undefined {
  if (!isRecord(input) || !Object.hasOwn(input, "todos")) return undefined;
  const todos = input["todos"];
  const entries =
    typeof todos === "string"
      ? todoEntriesFromText(todos)
      : Array.isArray(todos)
        ? todoEntriesFromArray(todos)
        : [];
  return entries.length === 0 ? undefined : entries;
}

function toolCallUpdate(
  block: Extract<AssistantBlock, { readonly kind: "tool_use" }>,
): AcpSessionUpdate {
  const plan =
    block.name === "TodoWrite" ? planEntriesFromTodos(block.input) : undefined;
  if (plan !== undefined) return { sessionUpdate: "plan", entries: plan };
  return {
    sessionUpdate: "tool_call",
    toolCallId: block.toolUseId,
    title: block.name,
    name: block.name,
    kind: TOOL_KINDS[block.name] ?? "other",
    status: "pending",
    rawInput: block.input,
    content: [],
  };
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * The ACP view of one turn's event stream. Text, thinking and tool calls are
 * emitted in transcript order; `agentError` is deliberately not text because
 * B66 puts the failure message on the terminal response itself.
 */
export function createAcpTurnSink(
  options: CreateAcpTurnSinkOptions,
): AcpTurnSink {
  return {
    update: options.update,
    requestPermission: options.requestPermission,
    signal: options.signal,

    async assistant(message: AssistantMessageEvent): Promise<void> {
      if (
        message.reasoningContent !== undefined &&
        !isBlank(message.reasoningContent)
      ) {
        await options.update(
          agentThoughtChunk(message.reasoningContent, message.id),
        );
      }
      for (const block of message.blocks) {
        if (block.kind === "thinking") {
          if (isBlank(block.text)) continue;
          await options.update(
            block.progressUpdate === true
              ? agentMessageChunk(block.text, message.id)
              : agentThoughtChunk(block.text, message.id),
          );
        } else if (block.kind === "text") {
          if (isBlank(block.text)) continue;
          await options.update(agentMessageChunk(block.text, message.id));
        } else {
          await options.update(toolCallUpdate(block));
        }
      }
    },

    async toolResult(result): Promise<void> {
      const status: AcpToolCallStatus = result.isError ? "failed" : "completed";
      await options.update({
        sessionUpdate: "tool_call_update",
        toolCallId: result.toolUseId,
        status,
        rawOutput: result.text,
        content:
          result.text === ""
            ? []
            : [
                {
                  type: "content",
                  content: { type: "text", text: result.text },
                },
              ],
      });
    },

    async agentError(): Promise<void> {
      // The turn's terminal outcome carries the message; B66 sends it as
      // `Error: <message>` once, not once per loop notification.
    },
  };
}

/**
 * ACP's agent-facing text for a recognized moderation refusal. The reference
 * agent localizes `errors:agent.contentModeration`; this build ships the
 * English copy.
 */
export const ACP_CONTENT_MODERATION_MESSAGE =
  "Request blocked by model provider safety checks. Please modify your request " +
  "and avoid high-risk cyber activity instructions.";

const MODERATION_MESSAGE_PATTERNS: readonly RegExp[] = [
  /content moderation/i,
  /content_filter/i,
  /cyber(?:[_\s-]?policy|security reasons)/i,
  /violating our usage policy/i,
  /rejected as a result of our safety system/i,
];

/** Whether a provider failure is a moderation block (B66). */
export function isContentModerationMessage(message: string): boolean {
  return MODERATION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export interface RunAcpTurnOptions {
  readonly runner: AcpTurnRunner;
  readonly request: AcpTurnRequest;
  readonly sink: AcpTurnSink;
  /** Defaults to {@link isContentModerationMessage}; injectable for tests. */
  readonly isModerationRefusal?: (message: string) => boolean;
}

export interface AcpTurnResult {
  readonly stopReason: AcpStopReason;
}

/**
 * Runs one prompt through the shared turn path and settles it as B66 says:
 * a cancelled turn returns `cancelled`, a completed one `end_turn`, a
 * moderation block sends the moderation text and returns `refusal`, and any
 * other ending sends `Error: <message>` and fails the request with an
 * internal error.
 */
export async function runAcpTurn(
  options: RunAcpTurnOptions,
): Promise<AcpTurnResult> {
  const { request, sink } = options;
  const isRefusal = options.isModerationRefusal ?? isContentModerationMessage;

  if (sink.signal.aborted) return { stopReason: "cancelled" };

  let outcome: TurnOutcome;
  try {
    outcome = await options.runner.run(request, sink);
  } catch (error) {
    if (sink.signal.aborted) return { stopReason: "cancelled" };
    throw new AcpProtocolError(
      ACP_ERROR_CODES.internal,
      error instanceof Error ? error.message : String(error),
      { sessionId: request.sessionId },
    );
  }

  if (sink.signal.aborted || outcome.kind === "cancelled") {
    return { stopReason: "cancelled" };
  }
  // TODO(spec B66): the shared `TurnOutcome` has no distinct
  // permission-rejection reason, so a call the user denied reaches this point
  // as `failed` and answers with an internal error instead of `end_turn`.
  if (outcome.kind === "completed") return { stopReason: "end_turn" };

  if (isRefusal(outcome.message)) {
    await sink.update(agentMessageChunk(ACP_CONTENT_MODERATION_MESSAGE));
    return { stopReason: "refusal" };
  }

  await sink.update(agentMessageChunk(`Error: ${outcome.message}`));
  throw new AcpProtocolError(ACP_ERROR_CODES.internal, outcome.message, {
    sessionId: request.sessionId,
  });
}

/* -------------------------------------------------------------------------- */
/* Permissions (B69)                                                          */
/* -------------------------------------------------------------------------- */

/** The confirmation outcomes this build offers for one permission request. */
export function confirmationOptionsFor(
  request: PermissionRequest,
): readonly AcpConfirmationOption[] {
  const options: AcpConfirmationOption[] = [
    { value: "proceed_once", label: "Allow" },
  ];
  if (request.toolClass === "execute") {
    options.push({ value: "proceed_always", label: "Allow always" });
  } else if (request.toolClass === "mcp") {
    options.push(
      { value: "proceed_always_tools", label: "Allow always this tool" },
      { value: "proceed_always_server", label: "" },
    );
  } else if (request.toolClass !== "read") {
    options.push({ value: "proceed_always", label: "Allow always" });
  }
  options.push({ value: "cancel", label: "Reject" });
  return options;
}

/** The ACP option set for one permission request. */
export function permissionOptionsFor(
  request: PermissionRequest,
  toolCount: number = 1,
): readonly AcpPermissionOption[] {
  return mapOptionsToAcp(confirmationOptionsFor(request), toolCount);
}

export interface CreateAcpConfirmOptions {
  readonly sessionId: string;
  readonly ask: (
    params: AcpRequestPermissionParams,
  ) => Promise<AcpPermissionResponse>;
  readonly toolCount?: number;
}

/**
 * The tool runner's `confirm` callback over an ACP permission round-trip.
 *
 * B69: a selected `allow_*` kind approves the call; a cancelled or rejected
 * answer (and any malformed answer) refuses it.
 *
 * TODO(spec B69): the exec tool runner's `confirm` seam receives no tool-use
 * id, so the permission card names the tool rather than the call ACP wants it
 * to refer to; carrying the id is a change to `src/tools/permissions.ts`,
 * outside this slice.
 */
export function createAcpConfirm(
  options: CreateAcpConfirmOptions,
): (request: PermissionRequest) => Promise<boolean> {
  return async (request) => {
    const acpOptions = permissionOptionsFor(request, options.toolCount ?? 1);
    let response: AcpPermissionResponse;
    try {
      response = await options.ask({
        sessionId: options.sessionId,
        toolCall: {
          toolCallId: `permission-${request.toolId}`,
          title: request.llmId ?? request.toolId,
        },
        options: acpOptions,
      });
    } catch {
      return false;
    }
    const outcome: AcpToolConfirmationOutcome = permissionResponseToOutcome(
      response,
      acpOptions.map((option) => option.optionId),
    );
    return isAllowKind(
      acpOptions.find((option) => option.optionId === outcome)?.kind ??
        "reject_once",
    );
  };
}
