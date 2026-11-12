/**
 * The model catalogue `exec --help` renders.
 *
 * The subject computes both the model list and the per-model reasoning table
 * from one catalogue in availability order, so the two sections can never
 * disagree. This table transcribes the catalogue the recorded build shows
 * (specs/10-cli-surface.md B28); adding a model means adding one row here.
 */

import type { ExecHelpModels } from "./exec-help.ts";


export type ReasoningEffort =
  | "none"
  | "minimal"
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ModelEntry {
  readonly id: string;
  readonly displayName: string;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly defaultReasoningEffort: ReasoningEffort;
}

/** Marked "(default)" in the model list; the parsed option itself has none. */
export const DEFAULT_MODEL_ID = "gpt-6.1-sol";

/** Flags stream-jsonrpc still validates but ignores (specs/10-cli-surface.md B34). */
export const STREAM_JSONRPC_IGNORED_FLAGS: readonly string[] = [
  "-m/--model",
  "--auto",
  "-r/--reasoning-effort",
  "--disable-builtin-skills",
  "--use-spec",
  "--spec-model",
  "--spec-reasoning-effort",
  "--only-tools/--add-tools/--remove-tools",
  "-s/--session-id",
  "--tag",
  "--session-title",
];


export const MODEL_CATALOGUE: readonly ModelEntry[] = [
  {
    id: "auto",
    displayName: "Auto Model",
    supportedReasoningEfforts: ["none"],
    defaultReasoningEffort: "none",
  },
  {
    id: "claude-fable-5.1",
    displayName: "Fable 5.1",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-fable-5",
    displayName: "Fable 5",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-5-5",
    displayName: "Opus 5.5",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "claude-opus-5-5-fast",
    displayName: "Opus 5.5 Fast Mode",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "claude-opus-5",
    displayName: "Opus 5",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-5-fast",
    displayName: "Opus 5 Fast Mode",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-4-8",
    displayName: "Opus 4.8",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-4-8-fast",
    displayName: "Opus 4.8 Fast Mode",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-4-7",
    displayName: "Opus 4.7",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-4-6",
    displayName: "Opus 4.6",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-opus-4-5-20251101",
    displayName: "Opus 4.5",
    supportedReasoningEfforts: ["off", "low", "medium", "high"],
    defaultReasoningEffort: "off",
  },
  {
    id: "claude-sonnet-5",
    displayName: "Sonnet 5",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "claude-sonnet-4-5-20250929",
    displayName: "Sonnet 4.5",
    supportedReasoningEfforts: ["off", "low", "medium", "high"],
    defaultReasoningEffort: "off",
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    supportedReasoningEfforts: ["off", "low", "medium", "high"],
    defaultReasoningEffort: "off",
  },
  {
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-6.1-sol-ultrafast",
    displayName: "GPT-6.1 Sol Ultra Fast",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-6-sol",
    displayName: "GPT-6 Sol",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-6-sol-fast",
    displayName: "GPT-6 Sol Fast Mode",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-sol-fast",
    displayName: "GPT-5.6 Sol Fast Mode",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-6-luna-fast",
    displayName: "GPT-6 Luna Fast Mode",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5-fast",
    displayName: "GPT-5.5 Fast Mode",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    supportedReasoningEfforts: ["medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-fast",
    displayName: "GPT-5.4 Fast Mode",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-5.4-mini-fast",
    displayName: "GPT-5.4 Mini Fast Mode",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3-Codex",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.3-codex-fast",
    displayName: "GPT-5.3-Codex Fast Mode",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2",
    displayName: "GPT-5.2",
    supportedReasoningEfforts: ["off", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "low",
  },
  {
    id: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash",
    supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "inkling",
    displayName: "Inkling",
    supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "mistral-medium-3.5",
    displayName: "Mistral Medium 3.5",
    supportedReasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "glm-5.3-flash",
    displayName: "GLM-5.3-Flash",
    supportedReasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "glm-5.3",
    displayName: "GLM-5.3",
    supportedReasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "max",
  },
  {
    id: "glm-5.2",
    displayName: "GLM-5.2",
    supportedReasoningEfforts: ["off", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "kimi-k3",
    displayName: "Kimi K3",
    supportedReasoningEfforts: ["off", "low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "qwen3.8-max",
    displayName: "Qwen3.8 Max",
    supportedReasoningEfforts: ["low", "medium", "xhigh"],
    defaultReasoningEffort: "xhigh",
  },
  {
    id: "nemotron-3-ultra",
    displayName: "Nemotron 3 Ultra",
    supportedReasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    supportedReasoningEfforts: ["off", "low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "deepseek-v4-flash-0731",
    displayName: "DeepSeek V4 Flash 0731 [Deprecated]",
    supportedReasoningEfforts: ["off", "low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro [Deprecated]",
    supportedReasoningEfforts: ["off", "low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "minimax-m3",
    displayName: "MiniMax M3",
    supportedReasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "muse-spark-1.3",
    displayName: "Muse Spark 1.3",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "muse-spark-1.2",
    displayName: "Muse Spark 1.2",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "grok-4.6",
    displayName: "Grok 4.6",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "minimax-m2.7",
    displayName: "MiniMax M2.7 [Deprecated]",
    supportedReasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
  },
];

/** Project the catalogue into the two views the help page renders. */
export function execHelpModels(): ExecHelpModels {
  return {
    models: MODEL_CATALOGUE.map((model) => ({ id: model.id, name: model.displayName })),
    defaultModelId: DEFAULT_MODEL_ID,
    modelDetails: MODEL_CATALOGUE.map((model) => ({
      name: model.displayName,
      supportsReasoning: model.supportedReasoningEfforts.some((effort) => effort !== "none"),
      supported: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    })),
    ignoredFlags: STREAM_JSONRPC_IGNORED_FLAGS,
  };
}
