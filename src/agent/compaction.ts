/**
 * Context compaction.
 *
 * Contract: `specs/20-agent-loop.md` §B19 (the summary exists only in the
 * assembled request, never in the transcript), §B26 (the token figure a
 * provider reports), §B46 (the estimate's basis and the compaction limit) and
 * §B47 (threshold compaction, with suppression after a compaction that did not
 * lower the figure).
 *
 * The module is pure arithmetic plus one injected port: the estimate is a
 * function of message content, the predicate is a comparison, and the only I/O
 * is the caller's {@link Summarizer}. That is what lets the loop's compaction
 * branch be tested without a provider, a clock or a network.
 */
import {
  type ContentBlock,
  type Message,
  type ToolResultContent,
  isSendableToProvider,
} from "./messages.ts";
import type { Summarizer } from "./ports.ts";

/** Characters per token, the documented ratio (§B26, §B46). */
export const CHARS_PER_TOKEN = 4;

/**
 * Conservative allowance per content block for the provider's framing
 * (role markers, separators, field names). The spec does not pin a value; four
 * tokens per block is this build's constant and errs high, which is the safe
 * direction for a threshold that must fire before a request is refused.
 */
export const PER_BLOCK_OVERHEAD_TOKENS = 4;

/**
 * Share of the compaction limit at which {@link shouldCompact} fires. `1` is
 * the spec's threshold (§B47: strictly greater than the limit); a caller may
 * lower it to compact proactively.
 */
export const DEFAULT_COMPACTION_RATIO = 1;

/** Exchanges (user messages and what follows them) kept verbatim (§B19). */
export const DEFAULT_KEEP_RECENT_TURNS = 2;

/** Bounded summary size handed to the summarizer (§B49's soft cap). */
export const DEFAULT_MAX_SUMMARY_TOKENS = 4_000;

/** Id prefix of the request-only summary row (§B19, §B49). */
export const SUMMARY_ID_PREFIX = "injected-summary-";

/** A compaction that could not produce a usable summary. */
export class CompactionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
  }
}

/**
 * Length to feed the 4-chars-per-token ratio: multi-byte text must not be
 * under-counted, so take the larger of its UTF-8 byte count and its code-unit
 * count plus 1.5× the byte excess (§B46). ASCII is unaffected.
 */
function weightedChars(text: string): number {
  if (text.length === 0) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  const codeUnits = text.length;
  return Math.max(bytes, codeUnits + Math.ceil((bytes - codeUnits) * 1.5));
}

/** Serialised length of a structured value such as tool input. */
function jsonChars(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : weightedChars(text);
  } catch {
    return 0;
  }
}

/** Text a tool result costs; base64 media is bounded by the media caps. */
function toolResultChars(content: ToolResultContent | undefined): number {
  if (content === undefined) return 0;
  if (typeof content === "string") return weightedChars(content);
  let chars = 0;
  for (const part of content) {
    if (part.type === "text") chars += weightedChars(part.text);
    else if (part.type === "document" && part.source.type === "text")
      chars += weightedChars(part.source.data);
  }
  return chars;
}

function blockChars(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return weightedChars(block.text);
    case "thinking":
      return weightedChars(block.thinking);
    case "redacted_thinking":
      return weightedChars(block.data);
    case "tool_use":
      return weightedChars(block.name) + jsonChars(block.input);
    case "tool_result":
      return block.modelContent !== undefined
        ? weightedChars(block.modelContent)
        : toolResultChars(block.content);
    case "image":
      // Base64 payloads are governed by the media caps (§B11), not by this
      // estimate: counting them would evict recent work the summary cannot
      // replace.
      return 0;
    case "document":
      return block.source.type === "text"
        ? weightedChars(block.source.data)
        : 0;
  }
  return 0;
}

/**
 * Estimate the tokens `messages` cost in a provider request.
 *
 * Basis: `ceil(weighted characters / 4)` plus {@link PER_BLOCK_OVERHEAD_TOKENS}
 * per content block, where a character is weighted so multi-byte text is not
 * under-counted — `max(utf8 bytes, code units + 1.5 × (bytes − code units))`
 * (§B46). Base64 image and PDF payloads contribute nothing because they are
 * bounded separately by the media caps (§B11).
 *
 * This is an *estimate*, not a measurement: it is deterministic so a compaction
 * decision is reproducible in a test, and it errs high rather than low. The
 * authoritative figure is the provider's reported usage — input + output +
 * cache-read (§B26), surfaced by `src/transport/llm.ts` as `LlmUsage` — which
 * callers may compare against the same limit.
 *
 * Monotonic by construction: appending a message or a block never lowers the
 * result, since every term is non-negative.
 */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  let blocks = 0;
  for (const message of messages) {
    for (const block of message.content) {
      chars += blockChars(block);
      blocks += 1;
    }
  }
  return (
    Math.ceil(chars / CHARS_PER_TOKEN) + blocks * PER_BLOCK_OVERHEAD_TOKENS
  );
}

export interface CompactionThreshold {
  /**
   * Share of the limit at which compaction fires proactively. Defaults to
   * {@link DEFAULT_COMPACTION_RATIO}, which makes the percentage and the hard
   * ceiling the same line: the spec's threshold (§B47).
   */
  readonly ratio?: number;
}

/**
 * Whether a request built from `messages` needs compacting (§B47).
 *
 * Two rules, in order: the hard ceiling (`estimate > limit`) always fires, and
 * the percentage (`estimate > limit × ratio`) lets a caller compact before the
 * ceiling is reached. The comparison is strict on both sides, matching the
 * spec's "exceeds the compaction limit".
 */
export function shouldCompact(
  messages: readonly Message[],
  limit: number,
  threshold: CompactionThreshold = {},
): boolean {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new RangeError(
      `compaction limit must be a non-negative number, got ${limit}`,
    );
  }
  const ratio = threshold.ratio ?? DEFAULT_COMPACTION_RATIO;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new RangeError(
      `compaction ratio must be a number in (0, 1], got ${ratio}`,
    );
  }
  const estimate = estimateTokens(messages);
  if (estimate > limit) return true;
  return estimate > limit * ratio;
}

export interface CompactOptions {
  readonly summarizer: Summarizer;
  /** Exchanges kept verbatim at the end; `0` summarizes everything (§B19). */
  readonly keepRecent: number;
  /** Cancels a summarizer call in flight. */
  readonly signal?: AbortSignal;
  /** Ceiling handed to the summarizer; defaults to 4000 tokens. */
  readonly maxTokens?: number;
  /** Pins the summary row's id; defaults to its insertion position. */
  readonly summaryId?: string;
}

export interface CompactionResult {
  /** The provider view after compaction; the input is unchanged. */
  readonly messages: readonly Message[];
  /** The request-only summary row, or `null` when nothing was replaced. */
  readonly summary: Message | null;
  /** False when the retained region already covers everything. */
  readonly compacted: boolean;
  /** How many messages the summary replaced. */
  readonly summarizedCount: number;
  /** Estimate for the provider view before compaction. */
  readonly beforeTokens: number;
  /** Estimate for the provider view after compaction. */
  readonly afterTokens: number;
  /** `user_only` rows, held out of the provider view (§B10). */
  readonly userOnly: readonly Message[];
}

/**
 * Whether the message at `index` starts a new turn. A turn begins at a user
 * message, and at an assistant message that follows a tool batch (the next
 * iteration of the same turn). Counting both shapes keeps "the last N turns"
 * meaningful whether the caller passes an interactive transcript or the
 * in-progress history of one running turn.
 */
function startsTurn(view: readonly Message[], index: number): boolean {
  const message = view[index];
  if (message === undefined) return false;
  if (message.role === "user") return true;
  if (message.role !== "assistant") return false;
  return view[index - 1]?.role === "tool";
}

/** Index at which the retained region starts, honouring turn boundaries. */
function retainedStart(
  view: readonly Message[],
  keepRecent: number,
  floor: number,
): number {
  if (keepRecent === 0) return view.length;
  let seen = 0;
  for (let index = view.length - 1; index >= floor; index -= 1) {
    if (!startsTurn(view, index)) continue;
    seen += 1;
    if (seen === keepRecent) return index;
  }
  // Fewer turns than requested: everything after the pinned prefix is
  // retained, so there is nothing to summarize.
  return floor;
}

/** Where each tool call lives, so a result can find its call. */
function callIndexes(view: readonly Message[]): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  view.forEach((message, messageIndex) => {
    for (const block of message.content) {
      if (block.type === "tool_use") indexes.set(block.id, messageIndex);
    }
  });
  return indexes;
}

/**
 * Move `start` earlier until no retained `tool_result` refers to a `tool_use`
 * inside the summarized region. Expanding the retained region (rather than
 * pushing the pair into the summary) keeps the exchange verbatim and never
 * leaves a result without its call (§B7, §B16).
 */
function avoidSplittingPairs(
  view: readonly Message[],
  start: number,
  floor: number,
  calls: ReadonlyMap<string, number>,
): number {
  let current = start;
  for (;;) {
    let earliest = current;
    for (let index = current; index < view.length; index += 1) {
      const message = view[index];
      if (message === undefined) continue;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const call = calls.get(block.toolUseId);
        if (call === undefined || call >= earliest) continue;
        earliest = Math.max(floor, call);
      }
    }
    if (earliest === current) return current;
    current = earliest;
  }
}

/**
 * The documented request-time replacement text (§B49).
 *
 * TODO(spec B49): the row carries the intro line and the `<summary>` wrapper
 * only. The code-built retained lists (files read, TODOs), the IMPORTANT
 * authorship note and the environment block captured at summary time are not
 * available to this clean-room `compact()`, which sees messages and nothing
 * else.
 */
export function renderSummary(summary: string): string {
  return [
    "You summarized the conversation thus far earlier in this session, as follows:",
    "",
    "<summary>",
    summary,
    "</summary>",
    "",
    "Continue from this summary. The messages it replaced are no longer in context; re-read a file or re-run a tool when you need their detail.",
  ].join("\n");
}

/**
 * Build the provider view for one request, replacing the middle of the
 * transcript with one summary row (§B19, §B47).
 *
 * - Leading `system` messages are the system prompt and are kept verbatim.
 * - The last `keepRecent` exchanges (a user message and what follows it) are
 *   kept verbatim.
 * - Everything between them is handed to the summarizer once and replaced by a
 *   single `llm_only` user row; the replacement is request-only and must not be
 *   appended to the transcript.
 * - A tool call and its results are never separated: the retained region grows
 *   backwards until every retained result's call is retained too.
 * - `user_only` rows never enter the provider view (§B10); they are returned in
 *   {@link CompactionResult.userOnly} so nothing is dropped from the caller's
 *   transcript.
 *
 * Returns `compacted: false` with the unchanged view when there is nothing
 * between the pinned prefix and the retained region. A summarizer failure
 * propagates (as {@link CompactionError} for an empty summary); the loop
 * decides to continue with the uncompacted view (§B47).
 */
export async function compact(
  messages: readonly Message[],
  options: CompactOptions,
): Promise<CompactionResult> {
  if (!Number.isInteger(options.keepRecent) || options.keepRecent < 0) {
    throw new RangeError(
      `keepRecent must be a non-negative integer, got ${options.keepRecent}`,
    );
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError(
      `maxTokens must be a positive integer, got ${maxTokens}`,
    );
  }

  const userOnly: Message[] = [];
  const view: Message[] = [];
  for (const message of messages) {
    if (isSendableToProvider(message)) view.push(message);
    else userOnly.push(message);
  }

  const beforeTokens = estimateTokens(view);

  let pinned = 0;
  while (pinned < view.length && view[pinned]?.role === "system") pinned += 1;

  const calls = callIndexes(view);
  const start = avoidSplittingPairs(
    view,
    retainedStart(view, options.keepRecent, pinned),
    pinned,
    calls,
  );

  const middle = view.slice(pinned, start);
  const last = middle[middle.length - 1];
  if (last === undefined) {
    return {
      messages: view,
      summary: null,
      compacted: false,
      summarizedCount: 0,
      beforeTokens,
      afterTokens: beforeTokens,
      userOnly,
    };
  }

  const signal = options.signal ?? new AbortController().signal;
  const text = await options.summarizer.summarize(middle, {
    signal,
    maxTokens,
  });
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CompactionError("the summarizer returned an empty summary");
  }

  const summary: Message = {
    id: options.summaryId ?? `${SUMMARY_ID_PREFIX}${pinned}`,
    role: "user",
    content: [{ type: "text", text: renderSummary(trimmed) }],
    // Timestamped from the last replaced message: a replay of the same
    // transcript produces the same row without reading a clock.
    createdAt: last.updatedAt,
    updatedAt: last.updatedAt,
    visibility: "llm_only",
  };

  const compactedMessages: readonly Message[] = [
    ...view.slice(0, pinned),
    summary,
    ...view.slice(start),
  ];

  return {
    messages: compactedMessages,
    summary,
    compacted: true,
    summarizedCount: middle.length,
    beforeTokens,
    afterTokens: estimateTokens(compactedMessages),
    userOnly,
  };
}
