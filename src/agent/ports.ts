/**
 * Ports the turn loop depends on.
 *
 * `specs/20-agent-loop.md` §B1–B5, B12–B20. The loop itself knows nothing about
 * HTTP, the filesystem or the CLI: providers, tools, permissions and time are
 * injected, which is what makes every branch testable without a network.
 */
import type { ContentBlock, ImageBlock, Message, Role } from "./messages.ts";

/** One incremental piece of a provider response. */
export type ProviderDelta =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly signature?: string;
    }
  | {
      readonly type: "tool_use_start";
      readonly name: string;
      readonly slot: number;
    }
  | {
      readonly type: "tool_use_input";
      readonly slot: number;
      readonly json: string;
    }
  | { readonly type: "usage"; readonly input: number; readonly output: number }
  | { readonly type: "done" };

export interface Provider {
  /**
   * Stream one assistant response for `messages`. Must be abortable: an aborted
   * signal rejects with an `AbortError`-like error.
   */
  stream(
    messages: readonly Message[],
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<ProviderDelta>;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: unknown;
}

export interface PermissionGate {
  decide(request: PermissionRequest): PermissionDecision;
  /** Resolve an `ask` decision; a rejection or `false` cancels the call. */
  confirm(request: PermissionRequest): Promise<boolean>;
}

export interface ToolResult {
  /** What the transcript shows. */
  readonly content: string;
  /** What the model reads, when it differs. */
  readonly modelContent?: string;
  /**
   * Image blocks the model receives with this result (`specs/20-agent-loop.md`
   * B35). Absent or empty keeps the result text-only; `content` still draws the
   * transcript either way. The loop turns these into the `tool_result` block's
   * content array, and a dialect that cannot carry images reads `content`.
   */
  readonly media?: readonly ImageBlock[];
  readonly isError?: boolean;
}

export interface ToolRunner {
  /** Execute one tool call. Must not throw for tool-level failures. */
  execute(
    name: string,
    input: unknown,
    options: {
      readonly signal: AbortSignal;
      /**
       * The assistant `tool_use` block's id for this call, so a permission
       * card can name the call rather than the tool (spec 60 §B69).
       */
      readonly toolUseId?: string;
    },
  ): Promise<ToolResult>;
}

/**
 * Summarizes the part of a transcript that compaction replaces (§B47, §B49).
 * A port, so the loop's compaction branch is testable with a scripted answer
 * and never needs a provider or a network.
 */
export interface Summarizer {
  summarize(
    messages: readonly Message[],
    options: { readonly signal: AbortSignal; readonly maxTokens: number },
  ): Promise<string>;
}

/** Compaction configuration; absent from a turn means "never compact". */
export interface CompactionConfig {
  /** The compaction limit in tokens (§B46). */
  readonly limit: number;
  readonly summarizer: Summarizer;
  /** Exchanges kept verbatim after the summary; defaults to two. */
  readonly keepRecent?: number;
  /** Proactive share of the limit; defaults to the hard ceiling. */
  readonly ratio?: number;
  /** Ceiling handed to the summarizer. */
  readonly maxSummaryTokens?: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  /** Upper bound for one delay. */
  readonly maxDelayMs?: number;
  readonly shouldRetry: (error: unknown, attempt: number) => boolean;
}

export interface LoopClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export type TurnEvent =
  | { readonly type: "turn_start"; readonly messageId: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly name: string;
      readonly isError: boolean;
    }
  | { readonly type: "assistant_message"; readonly message: Message }
  | { readonly type: "tool_message"; readonly message: Message }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly delayMs: number;
      readonly reason: string;
    }
  | {
      readonly type: "compaction";
      /** Estimate for the provider view before the attempt, in tokens. */
      readonly before: number;
      /** Estimate after it; equal to `before` when nothing was replaced. */
      readonly after: number;
      /** How many messages the summary replaced. */
      readonly summarized: number;
      /** True when the request view was actually replaced. */
      readonly compacted: boolean;
      /** Present when the summarizer failed; the turn then continues (§B47). */
      readonly error?: string;
    }
  | {
      readonly type: "turn_complete";
      readonly reason: "completed" | "max_turns" | "error" | "cancelled";
      readonly error?: string;
    };

export interface TurnDependencies {
  readonly provider: Provider;
  readonly tools: ToolRunner;
  readonly permissions: PermissionGate;
  readonly clock: LoopClock;
  readonly retry: RetryPolicy;
  /** Receives every event in order; must not throw. */
  readonly emit: (event: TurnEvent) => void;
  /** Assistant message ids; injected so replays stay deterministic. */
  readonly nextMessageId: (role: Role) => string;
  /**
   * Context compaction (§B46–B49). Absent disables it entirely, so every
   * existing caller keeps the loop's behaviour unchanged.
   */
  readonly compaction?: CompactionConfig;
}

export type AssistantBlock = Extract<
  ContentBlock,
  { type: "text" | "thinking" | "tool_use" }
>;
