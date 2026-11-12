/**
 * Ports the turn loop depends on.
 *
 * `specs/20-agent-loop.md` §B1–B5, B12–B20. The loop itself knows nothing about
 * HTTP, the filesystem or the CLI: providers, tools, permissions and time are
 * injected, which is what makes every branch testable without a network.
 */
import type { ContentBlock, Message, Role } from "./messages.ts";

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
  readonly isError?: boolean;
}

export interface ToolRunner {
  /** Execute one tool call. Must not throw for tool-level failures. */
  execute(
    name: string,
    input: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<ToolResult>;
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
}

export type AssistantBlock = Extract<
  ContentBlock,
  { type: "text" | "thinking" | "tool_use" }
>;
