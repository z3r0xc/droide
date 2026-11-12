# Agent loop: message model, request assembly, streaming and the tool cycle

- **Target:** Factory AI `droid` 1.9.0
- **Status:** draft
- **Owner:** agent-loop slice
- **Related:** CLI surface spec (flags, dispatch), provider-transport spec (HTTP routes and auth material), tools spec (individual tool semantics), session-store spec (JSONL persistence and resume), extensions spec (hooks, skills, MCP)

## Purpose

The agent loop turns one submitted user message into a sequence of model
requests and tool executions, and records both. It owns the transcript
message model, the request it builds for a provider, the streaming events a
turn emits, the permission and validation gates a model tool call passes
through, the context it keeps (and compacts), and the model it targets. Every
other subsystem either feeds this loop (tools, hooks, skills) or consumes what
it records (TUI, JSON-RPC, exec, daemon).

## Scope

Covers the interactive entry path from `src/index.ts` to `AgentLoop`, the
message and content-block schema exchanged with providers, request assembly
(`system` + `messages` + `tools`), streaming accumulation, the tool-call
cycle, context/token management, plan-mode (`--use-spec`), and the model
catalogue as it affects a turn.

Does **not** cover: argument parsing and the dispatch table (CLI-surface
spec); provider credentials, routing, retries inside the transport itself and
proxy URL construction (provider-transport spec); individual tool behaviour
and schemas (tools spec); transcript file format, `seq` stamping, resume and
fork (session-store spec); hook discovery/exec, skill discovery, MCP
registration (extensions spec). Subagent (`Task`) execution is described only
where it changes the parent loop's outcome.

## Terms

- **Turn** — one `runAgentInternal` invocation from a submitted user message,
  ending in exactly one `AgentTurnCompletionReason`.
- **Iteration** — one model request plus, when the reply contains tool calls,
  the tool batch and the resulting tool-result message.
- **Transcript** — the persisted, ordered `FactoryDroidMessage` list.
- **Reminder** — CLI-authored text wrapped in `<system-reminder>` …
  `</system-reminder>` (`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/droid/constants.ts:24-25`),
  delivered either as a `user`-role message with `visibility: "llm_only"` or
  appended to the user's own message.
- **Context row** — the per-prompt LLM-only message carrying environment,
  instructions and turn reminders (id prefix `context-`).
- **Tool call id** — `call_<8-byte blake2b of assistant message id, hex>_<slot>`
  (`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/toolCalls.ts:73-76`).
- **Batch** — the tool calls from one assistant message, executed together.
- **Segment** — a maximal run of calls that may run concurrently, or a single
  call that must run alone (`segmentToolUsesForExecution`).
- **Auto Model / router** — session model `auto` or `auto-fast`, resolved to a
  concrete model before dispatch (`ModelID` routers,
  `evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/llm/enums.ts:7-30`,
  `evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/llm/enums.ts:118-121`).
- **Spec mode / plan mode** — `DroidInteractionMode.Spec`, entered by
  `--use-spec`; read-only until `ExitSpecMode` is approved.
- **Compaction** — replacing the pre-summary transcript with a summary message
  at request time; triggered by a token threshold or a context-limit error.
- **Pin** — the block tagged `prompt-cache-pin` that anchors the cached prefix
  (`evidence/original/windows-x64/packages/droid-core/src/llms/client/constants.ts:71`).

## Observable behaviour

### Entry, flags, turn lifecycle

**B1 — Interactive entry.** With no verb, `droid` runs the TUI default command;
the process entrypoint delegates to the command router, which loads the TUI
entrypoint lazily. A prompt may be supplied positionally.
`evidence/original/windows-x64/src/index.ts:1-3`, `evidence/original/windows-x64/src/index.ts:199-207`, `evidence/original/windows-x64/src/cli.ts:31-40`,
`evidence/original/windows-x64/src/cli.ts:477`.

**B2 — Startup overrides are applied after resume/load.** `--use-spec` sets
`DroidInteractionMode.Spec`; otherwise `--auto <level>` sets
`DroidInteractionMode.Auto`. `--auto` is then applied as the autonomy level,
so resuming a Spec session with only `--auto` does not persist a transient
mode. `--auto` accepts only `low`, `medium`, `high`; anything else is rejected
with `Invalid --auto value. Allowed values: low, medium, high.` on stderr and
exit code 1. `evidence/original/windows-x64/src/entrypoints/tui/run.ts:772-789`,
`evidence/original/windows-x64/src/entrypoints/tui/autonomyFlag.ts:5-19`, `evidence/original/windows-x64/src/entrypoints/tui/options.ts:47`.

**B3 — One turn at a time.** A second `runAgentInternal` while one is running
is refused (`Concurrent runAgent invocation prevented`) and returns `false`
without touching the transcript. `evidence/original/windows-x64/src/core/AgentLoop.ts:3336-3348`.

**B4 — Turn-start rows are written in view order.** Hook context rows, the
context row (`llm_only`), an open-file reminder, then the user message are
appended in that order; a failure stops at the failing row, keeping exactly
the rows already appended. `evidence/original/windows-x64/src/core/AgentLoop.ts:5104-5108`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:5240-5282`.

**B5 — A turn ends with one reason.** Completion is reported as one
`AgentTurnCompletionReason` (`completed`, `cancelled`, `permission_rejected`,
`error`, `model_authentication_failed`, …),
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/droid/enums.ts:264-292`. A stop request
also ends the turn as `cancelled` (`evidence/original/windows-x64/src/core/AgentLoop.ts:2062-2082`).

### Message model

**B6 — Message shape.** A message is
`{id, role, content[], createdAt, updatedAt, parentId?, seq?, visibility?,
userMessageSource?, sender?, author?, interactionMode?, …}` with roles
`user | assistant | tool | system`. `role` is required; `createdAt` and
`updatedAt` are Unix ms. `evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/enums.ts:13-18`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:283-330`.

**B7 — Content blocks.** `content` is an array of discriminated blocks:
`text {text}`, `image {source:{type:"base64",mediaType,data}, generated?}`,
`thinking {thinking, signature, signatureProvider?, durationMs?,
progressUpdate?}`, `redacted_thinking {data}`, `tool_use {id, name, input}`,
`tool_result {toolUseId, content?, isError?, modelContent?, respondedBy?}`,
`document {source}`. All but `tool_use` also accept an optional `id`.
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/enums.ts:20-29`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:33-115`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:214-247`.

**B8 — Tool-result content domain.** A `tool_result`'s `content` is a string
or an array of `text | image | document` blocks. `isError` marks failure; the
`content` is what a transcript shows, and `modelContent`, when present, is the
text the model reads instead. `evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:148-160`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:214-235`.

**B9 — Deterministic tool-call ids.** The id is derived from the assistant
message id and the block slot, so a replayed stream re-derives the same ids.
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/toolCalls.ts:73-76`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/chunk-processing.ts:790-800`.

**B10 — Visibility.** `both` (`null`), `llm_only`, `user_only`. A `user_only`
message is never sent to a provider; an `llm_only` message is never shown in
the user transcript. `evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/enums.ts:1-5`,
`evidence/original/windows-x64/packages/utils/src/messages/visibility.ts:234-249`.

**B11 — Images and documents.** Images are base64 with media type
`image/jpeg | image/png | image/gif | image/webp`; documents are base64 PDF
(`application/pdf`, optional `parsedData`) or plain text
(`text/plain`). At most the 10 most recent images and 5 most recent PDFs stay
in a request; older media is dropped from the request and the model is warned
by the media-limit reminder.
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:43-60`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:127-160`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/image-limits.ts:16-17`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/image-limits.ts:151`.

**B12 — User content assembly.** Attached images are emitted first, then the
attached-image path reminder (when paths are known), then the text blocks; a
caller-supplied `content` array replaces the text/images path. Extra content
blocks are appended after. `evidence/original/windows-x64/src/core/userMessageInjection.ts:120-169`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:1172-1195`.

**B13 — Assistant turn attribution is persisted.** An assistant message
records `modelId` (the model that actually served it), `apiProvider`,
`reasoningEffort`, router id and reason when the slot was a router, plus
provider replay metadata (`openaiMessageId`, `openaiPhase`,
`openaiEncryptedContent`, `thinking.signature`, `geminiNativeContent`).
`evidence/original/windows-x64/src/core/AgentLoop.ts:7400-7480`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/sessionV2/messages/schemas.ts:300-380`.

### Request assembly

**B14 — System message is a block list with a mandatory first block.** The
first system block's text is exactly
`You are Droid, an AI software engineering agent built by Factory.`; the
managed proxy rejects a request whose extracted system prompt does not start
with it. The last block of the prompt proper carries a one-hour
`cache_control`, and session-identity text follows the breakpoint so it stays
outside the shared prefix. `evidence/original/windows-x64/src/hooks/buildSystemMessageBlocks.ts:124-152`,
`evidence/original/windows-x64/packages/common/src/cli/constants.ts:1-2`,
`evidence/original/windows-x64/src/hooks/buildSystemMessageBlocks.ts:300-311`.

**B15 — System block order.** After the prefix: base system prompt (with
model-specific prose guidance substituted when the model asks for it), then
migration instructions, mission role guidance and ledger/shared-folder text,
TodoWrite guidance (only when the TodoWrite tool is offered) and optional
batched-todo guidance, service-account connector guidance, per-model
reminders (no-comments, parallel calls, autonomy, Gemini risk/tool/spec
nudges), Script-only override, output style, then session identity.
`evidence/original/windows-x64/src/hooks/buildSystemMessageBlocks.ts:154-311`,
`evidence/original/windows-x64/src/hooks/systemPrompt.ts:84-90`.

**B16 — History preparation.** Before a request the loop drops empty text
blocks, drops assistant turns with no usable text/tool use (image-only turns
only for Google), keeps the newest of duplicate tool pairs, normalises
thinking blocks to the target provider (downgrading foreign signatures),
applies image/PDF caps, strips pre-existing `cache_control`, then applies
cache breakpoints: a pin on the session-start context block, the same
message's last cacheable block, and the final message's last cacheable block
(three conversation breakpoints; the system prompt owns the fourth).
`evidence/original/windows-x64/packages/droid-core/src/llms/client/message-preparation.ts:914-1080`.

**B17 — Request payload.** The internal request is `{model, max_tokens,
messages, tools, system[], tool_choice?}`; `max_tokens` is capped by the
model's output capability and reasoning budget. Anthropic-family transports
receive these fields (plus `thinking` when enabled and provider betas);
OpenAI Chat Completions receives each `tool_result` as a `role:"tool"` message
with `tool_call_id` before any user text from the same message, and each
`tool_use` as an assistant `tool_calls` entry. `evidence/original/windows-x64/packages/droid-core/src/llms/client/sendMessage.ts:2673-2685`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/sendMessage.ts:2804-2826`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/converters.ts:1393-1490`.

**B18 — Tool descriptors.** The request's `tools` are `{name, description,
input_schema}` descriptors whose names are provider-safe (≤64 characters);
MCP tools are validated against the identity advertised for the turn.
`evidence/original/windows-x64/packages/droid-core/src/llms/client/constants.ts:85`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:6586-6600`, `evidence/original/windows-x64/src/agent/tools.ts:1500-1530`.

**B19 — Request-only rows.** The compaction summary and re-attached stable
reminders exist only in the assembled request, never in the transcript; they
are appended after the cached history so a retry keeps the same prefix.
`evidence/original/windows-x64/src/agent/requestAssembly.ts:581-627`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:6520-6540`,
`evidence/original/windows-x64/src/hooks/compaction/CompactionManager.ts:425-450`.

### Streaming

**B20 — Streaming event sequence.** One send emits, in order:
`onRequestStream`, `onMessageStart`, then any number of `onTextDelta`,
`onThinkingDelta`, `onToolInputDelta`, `onContentBlockComplete`,
`onToolUseDetected`, followed by `onMessageComplete` and
`onStreamingComplete(result, wasAborted?)`; a provider failure calls
`onStreamingError` and rejects. Each provider *attempt* is bracketed by
`beginProviderRequestAttempt` / `onProviderRequestAttemptComplete`.
`evidence/original/windows-x64/src/agent/messaging.ts:264-300`, `evidence/original/windows-x64/src/agent/messaging.ts:385-560`.

**B21 — Anthropic chunk mapping.** `message_start` records input, cache-read
and cache-creation tokens; `content_block_start` opens a text/thinking/
redacted-thinking/tool_use block (tool_use gets its deterministic id and is
announced immediately); `content_block_delta` applies `text_delta`,
`thinking_delta`, `signature_delta`, `input_json_delta`; `message_delta`
carries `stop_reason`; `message_stop` finalises usage.
`evidence/original/windows-x64/packages/droid-core/src/llms/client/chunk-processing.ts:735-900`.

**B22 — Partial tool input.** Each delta is parsed optimistically so the UI
can show growing arguments; execution never uses the partial parse — the
complete buffer is parsed once with `parseToolInputJson`, whose failure marks
the call `inputParseFailed`. Tool-call progress notifications are throttled to
at most one per 100 ms per call (trailing edge), so the last accumulated input
always ships. `evidence/original/windows-x64/packages/droid-core/src/llms/client/tool-input-stream.ts:1-6`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/chunk-processing.ts:320-340`,
`evidence/original/windows-x64/src/agent/messaging.ts:180-240`.

**B23 — A retry discards the partial attempt.** When a send retries within the
same request, the in-flight assistant message is retracted (event
`assistant-message-retracted`), unfinished tool invocations are cleared, and
the retry reopens the same message id so deltas stay attributable.
`evidence/original/windows-x64/src/agent/messaging.ts:264-296`.

**B24 — Emitted event names.** Text: `assistant-text-delta`,
`thinking-text-delta`, `text-block-complete`, `thinking-block-complete`.
Tools: `tool-call-start`, `tool-call-progress`, `tool-input-complete`,
`tool-result`, `tool-streaming-update`, `tool-execution-phase-changed`.
Messages: `message-created`, `user-message`, `assistant-message`,
`tool-message`. Lifecycle: `streaming-start`, `streaming-complete`,
`agent-turn-completed`, `agent-error`, `llm-retry-scheduled`,
`cancellation-requested`. `evidence/original/windows-x64/src/events/AgentEventBus.ts:33-100`,
`evidence/original/windows-x64/src/agent/messaging.ts:330-560`.

**B25 — An empty reply is an error, not an answer.** A stream with no visible
content, no tool call and no model-generated image raises
`LLMEmptyResponseError`; the loop does not persist an empty assistant message
and the turn ends with an error (or a retry per B56). Redacted thinking alone
does not count as output. `evidence/original/windows-x64/src/core/AgentLoop.ts:7480-7520`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/chunk-processing.ts:408-426`.

**B26 — Token accounting.** Per-send usage is the provider's `inputTokens`,
`outputTokens`, cache-read and cache-creation counts; thinking tokens are
estimated from delta length at 4 characters per token. The compaction figure
is `inputTokens + outputTokens + cacheReadTokens` (prompt-cache writes still
occupy the context). `evidence/original/windows-x64/packages/droid-core/src/llms/client/sendMessage.ts:6201-6225`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/chunk-processing.ts:860-880`,
`evidence/original/windows-x64/src/utils/contextUsage.ts:21-25`.

### Tool-call cycle

**B27 — Batch execution answers in request order.** Results are returned in
the order the tool calls appeared, whatever order segments executed in; each
call settles exactly once (the first result is the result) and the batch
produces a single `role:"tool"` message. `evidence/original/windows-x64/src/core/ToolExecutor.ts:2840-2900`,
`evidence/original/windows-x64/src/core/ToolExecutor.ts:1486-1530`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:2817-2870`.

**B28 — Admission.** Before any hook, validation or confirmation, the call's
`llmId` is resolved to one registered tool the session can run. An unknown
name, a tool the session or exec selection forbids, or an unregistered
executor is refused with a `MetaError` naming that condition; no hook sees the
call. `evidence/original/windows-x64/src/agent/tools.ts:1428-1500`, `evidence/original/windows-x64/src/agent/tools.ts:1500-1556`.

**B29 — Input validation gate.** For native tools with a Zod schema, input is
validated as a gate (the executor receives exactly what confirmation saw).
Execute's lenient keys are exempt; unknown/foreign tool servers validate
themselves. A failure is denied with `Invalid <tool> input: <field: message>;
received keys: …` (≤10 keys, each JSON-encoded and truncated to 64 code
points). A hook-rewritten invalid input uses the separate
`The call was not run: a PreToolUse hook rewrote its input into an invalid
shape` wording. `evidence/original/windows-x64/src/agent/toolInputValidation.ts:68-180`,
`evidence/original/windows-x64/src/agent/toolInputValidation.ts:183-205`,
`evidence/original/windows-x64/src/constants/constants.ts:44-52`.

**B30 — Pre-flight order.** PreToolUse hooks run first and win in this order:
`continue:false` stops the turn; exit code 3 aborts the agent; a
`permissionDecision` of `allow` bypasses confirmation (applying
`updatedInput`), `deny` refuses. Then input-shape validation, the Execute
blocklist, Execute's required risk parameters, spec-mode policy, sandbox
violation detection, and confirmation.
`evidence/original/windows-x64/src/agent/tools.ts:1725-1830`, `evidence/original/windows-x64/src/agent/tools.ts:1620-1675`,
`evidence/original/windows-x64/src/agent/tools.ts:1999-2035`.

**B31 — Confirmation decision.** Confirmations are skipped entirely when the
session skips them. `Read` and `LS` never confirm. `Create`/`Edit` confirm
unless file edits are auto-approved. `Execute` resolves in this order:
skip-all → command policy (`block` hard-denies with the policy message,
`allow` runs, `ask` prompts as high impact) → rolled-in read-only search
(allowed) → the call's `riskLevel` compared with the session autonomy level
(missing/invalid risk counts as high). `ExitSpecMode` confirms only in
interactive mode. `evidence/original/windows-x64/src/agent/shouldConfirmExecution.ts:820-950`,
`evidence/original/windows-x64/src/agent/autonomy.ts:120-190`.

**B32 — Permission prompting.** One prompt covers a segment's confirmation
candidates and carries `{toolUses[], options[], requestId}`; the answer
returns approved tool ids plus an outcome. The request aborts when the batch
aborts (`ToolAbortError`).
`evidence/original/windows-x64/src/agent/PermissionRequestHandler.ts:59-118`,
`evidence/original/windows-x64/src/core/ToolExecutor.ts:780-900`.

**B33 — Permission outcome semantics.** `cancel` approves nothing.
`proceed_once` approves the returned subset (or all when absent).
`proceed_always`/`proceed_always_file` approve all and raise the session
autonomy to the level the batch requires (except sandbox-only prompts).
`proceed_always_tools`/`proceed_always_server` approve all and persist MCP
grants. `proceed_auto_run_*` set the interaction mode. New-session outcomes
approve all and end the turn with a spec handoff. `proceed_edit` approves all
and leaves spec mode for editing.
`evidence/original/windows-x64/src/agent/tool-confirmation.ts:609-700`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/droid/enums.ts:2-24`.

**B34 — Execution concurrency.** Each batch is segmented: `Create`, `Edit`,
`ApplyPatch` are sequential barriers, and `Execute` is a barrier unless it is
a recognised read-only search with search tools rolled into Execute; every
other call may run concurrently with its neighbours. Segments run in order;
within a segment, parallel calls settle as each finishes.
`evidence/original/windows-x64/src/hooks/segmentToolUsesByConcurrency.ts:70-108`,
`evidence/original/windows-x64/src/core/ToolExecutor.ts:2490-2510`.

**B35 — Tool result shape and error envelope.** A successful result stores the
tool's content (and `modelContent` when the model's text differs). A failed
result stores content prefixed `Error: ` and `isError: true`. A call whose
arguments never parsed is stored as
`Tool call rejected: arguments were not a valid JSON object. Re-send the call
with complete, valid JSON arguments.` with `isError: true`.
`evidence/original/windows-x64/src/core/ToolExecutor.ts:1336-1420`,
`evidence/original/windows-x64/packages/utils/src/messages/contentBlocks.ts:264-268`,
`evidence/original/windows-x64/src/constants/constants.ts:44-46`.

**B36 — Truncation and large output.** Every model-facing result crosses a
byte budget: 32 KiB by default, 64 KiB for tools whose tier declares it (Read,
Task/TaskOutput, FetchUrl, Skill). An over-budget result is scrubbed for
secrets once and keeps its head and tail around one notice naming the whole
output (a tool-provided pointer, else a written tool-output artifact). Read
additionally caps line selection (default 2400 lines) and reports
`[Showing lines A-B of N total lines]`.
`evidence/original/windows-x64/packages/droid-core/src/tools/utils/constants.ts:32-56`,
`evidence/original/windows-x64/packages/droid-core/src/tools/utils/large-output.ts:505-560`,
`evidence/original/windows-x64/src/utils/truncate.ts:19-64`.

**B37 — A denied call yields a cancellation result, not an exception.** A call
that is not approved settles with `Tool execution cancelled by user` (short
form `tool execution cancelled` in non-interactive runs, with `: <reason>`
appended when the permission request itself failed); under spec mode a
restricted tool settles with
`Tool cancelled: Spec mode is active - file edits and other state mutations
are not allowed until the spec is approved`; a rejected `ExitSpecMode`
settles with its rejection text. `evidence/original/windows-x64/src/core/ToolExecutor.ts:1600-1660`,
`evidence/original/windows-x64/src/constants/constants.ts:12-20`.

**B38 — Rejection ends the turn only for approver-less or subagent work.** In
an ordinary interactive turn a user rejection leaves the turn running so the
model can adjust. A real rejection in an approver-backed subagent, or a
no-approver session below High autonomy, ends the turn with
`permission_rejected`. `evidence/original/windows-x64/src/core/ToolExecutor.ts:930-970`,
`evidence/original/windows-x64/src/core/ToolExecutor.ts:2880-2890`.

**B39 — Tool cancellation.** A stop aborts the streaming request, aborts the
batch, marks uncommitted calls cancelled, asks process/terminal owners to kill
their children, settles every batch-owned call with `Tool execution cancelled
by user`, settles any pending call the batch never owned, and appends
`Request interrupted by user` to the tool results when a tool message exists.
`evidence/original/windows-x64/src/core/AgentLoop.ts:2062-2160`,
`evidence/original/windows-x64/packages/common/src/session/constants.ts:60-68`.

**B40 — Special stop tools.** `ExitSpecMode` approval can end the batch
(`shouldStopAfterTools`); a terminal child outcome (mission/subagent control
tools) stops the turn after its batch; the loop then returns before sending
another request. `evidence/original/windows-x64/src/core/ToolExecutor.ts:228-235`,
`evidence/original/windows-x64/src/core/ToolExecutor.ts:2430-2470`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:7690-7730`.

### Context management

**B41 — One context row per prompt.** Each prompt gets a single LLM-only
`user` message (id prefix `context-`) holding a stable part (environment
block, instructions, deferred-tool catalog announcement, MCP auth/readiness,
TodoWrite nudges, file-change, worktree, mission text, tagged paths) and a
volatile part (current date, workspace-state snapshot). The per-request
re-attached reminders (deferred-tool baseline, skills listing, subagent
listing) are added by the request assembler rather than stored in the row. On the first message the last stable block is
tagged `prompt-cache-pin`.
`evidence/original/windows-x64/src/core/AgentLoop.ts:5104-5130`,
`evidence/original/windows-x64/src/agent/requestAssembly.ts:362-380`,
`evidence/original/windows-x64/src/utils/systemInfo.ts:1031-1055`.

**B42 — Environment block content.** The stable block renders
`User system info (<os>)`, resources, shell hint, model name, user language,
a "Session working directory" section with the `pwd` output, environment
commands, then `# Codebase and user instructions are shown below…`, a
`## Project Instructions:` section and a `## Personal Global Instructions:`
section, each rendering `% <cmd>` + output per instruction file.
`evidence/original/windows-x64/src/utils/systemInfo.ts:938-1030`.

**B43 — Instruction-file discovery.** Instruction file names, in preference
order, are `CLAUDE.md`, `Claude.md`, `AGENTS.md`, `Agents.md`, `agents.md`;
they are read from agent-context directories in the order
`.factory` (or the active factory dir), `.factory-dev`, `.agents`, `.agent`,
project first and personal (`~`) second. The prompt tells the model that
closer files take precedence. `evidence/original/windows-x64/packages/droid-core/src/core/constants.ts:5-11`,
`evidence/original/windows-x64/src/utils/agentsMdGuidelines.ts:36-60`,
`evidence/original/windows-x64/src/hooks/systemPrompt.ts:43-46`.

**B44 — Skills injection.** The turn's valid, model-invocable skills are
announced in one reminder whose header is
`Available skills (name: when to use it; activate one by exact name with the
Skill tool, which returns its full instructions):`; buckets order
org-plugin > runtime > mission > automation > folder > project-dir >
project-plugin > user-dir > user-plugin > dynamic > builtin, and a name
appearing twice keeps the earlier bucket. Later discoveries arrive as
append-only delta reminders
(`Additional skills now available (…)`) or removals
(`Skills no longer available (…)`); the Skill tool's description is stable.
`evidence/original/windows-x64/src/skills/availableSkillsReminder.ts:84-100`,
`evidence/original/windows-x64/src/skills/constants.ts:8-27`.
`--disable-builtin-skills` removes Factory's builtin set from the catalog
(`evidence/original/windows-x64/src/entrypoints/tui/options.ts:50-52`).

**B45 — `--append-system-prompt`.** The value and/or file text are resolved
once at startup: the file is read first (a read failure is a `MetaError`
`Failed to read --append-system-prompt-file:` naming the path), then the flag
text is joined after it with a blank line. The result is inherited by spawned
children. At request time the behavioural prompt is composed as: base
(session system prompt or runtime override) → preset `append` → the CLI
append text, joined with blank lines. `evidence/original/windows-x64/src/utils/appendSystemPromptArgs.ts:67-91`,
`evidence/original/windows-x64/src/entrypoints/tui/bootstrap.ts:906-930`,
`evidence/original/windows-x64/src/hooks/buildSystemMessageBlocks.ts:70-100`.

**B46 — Token accounting and compaction limits.** Token estimates use 4
characters per token over a length weighted so multi-byte text is not
under-counted (bytes, or code units + 1.5× the byte excess, whichever is
larger). The compaction limit for a model is: mission-orchestrator budget if
configured, else a per-model user override, else the model's default, always
capped at the provider's maximum input tokens. `evidence/original/windows-x64/packages/utils/src/llm/token-estimation.ts:5-33`,
`evidence/original/windows-x64/src/services/SettingsService.ts:4838-4855`.

**B47 — Threshold compaction.** After each iteration where tools were not
cancelled, the loop reads the last call's token figure; if it exceeds the
compaction limit it compacts before the next request. A failed threshold
compaction does not end the turn. If compaction ran and usage is still over
the limit, further threshold compactions are suppressed until usage drops
below the limit, so a session cannot loop.
`evidence/original/windows-x64/src/core/AgentLoop.ts:7743-7846`.

**B48 — Context-limit recovery.** On a context-limit error the loop compacts
(`reason: 'context_limit'`) and retries the same iteration in place; the
recovery is attempted once, with a fallback compaction model when the session
model cannot summarize.
`evidence/original/windows-x64/src/core/AgentLoop.ts:775-798`, `evidence/original/windows-x64/src/core/AgentLoop.ts:5699-5710`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:7151-7165`,
`evidence/original/windows-x64/src/hooks/compaction/CompactionManager.ts:892-900`.

**B49 — Summary message shape.** The request-time replacement for summarized
history is a `user` message with id prefix `injected-summary-`, containing
either "You summarized the conversation thus far earlier in this session, as
follows:" or "A previous instance of Droid has summarized …", then
`<summary> … </summary>`, the code-built retained lists, the IMPORTANT
authorship note, and — as its own trailing text block — the environment block
captured at summary time. A provider-switch serialization uses a fenced
transcript and tells the model to keep using native tool calling.
`evidence/original/windows-x64/src/hooks/compaction/CompactionManager.ts:436-520`.

**B50 — Plan mode (`--use-spec`).** The session's interaction mode becomes
`Spec`; `isSpecMode()` then reports true. A spec-mode reminder is persisted
(`Spec mode is active. …`) telling the model not to mutate the repo, to use
`AskUser` for choices and `ExitSpecMode` to present the plan. File-mutating
tools and automation-write tools are refused (B37 wording) unless the target
is a spec document under the workspace. `ExitSpecMode` proposes the plan; an
approved plan switches the mode back to Auto, an edit/handoff outcome ends the
batch, and a rejected one returns the rejection text.
`evidence/original/windows-x64/src/entrypoints/tui/run.ts:782-786`,
`evidence/original/windows-x64/src/services/SessionService.ts:4495-4497`,
`evidence/original/windows-x64/src/core/specModeReminder.ts:25-70`,
`evidence/original/windows-x64/src/agent/tools.ts:1999-2035`.

### Model catalogue and selection

**B51 — Catalogue shape.** Each registered model declares `id`, display
`name`/`shortName`, `provider`, eligible `apiProviders` (with per-region
overrides), `reasoningEffort {supported[], default}`, tier, `availableInCLI`,
context limits, optional `thinking` config, pricing/cost multiplier and
`matchPatterns` used for name resolution. Router ids are `auto` and
`auto-fast`. `evidence/original/windows-x64/packages/utils/src/llm/model-registry.ts:561-700`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/llm/enums.ts:7-30`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/llm/enums.ts:128-145`.

**B52 — Default and availability.** The available set is built from registry
entries filtered by feature flag, deployment/region policy and BYOK settings,
plus `custom:<name>-<index>` entries. The default is the highest-ranked
available candidate from a fixed default list, else a fixed fallback.
`evidence/original/windows-x64/src/models/availability.ts:33-46`,
`evidence/original/windows-x64/packages/utils/src/llm/index.ts:696-712`.

**B53 — Selection, switching and the spec slot.** A session keeps a main model
slot and an optional spec-mode slot; reads for dispatch resolve the active
slot and, for a router slot, its concrete pick. A model change mid-session
does not rewrite history; instead the next request carries a
`Model:` reminder when the visible name changed.
`evidence/original/windows-x64/src/services/SessionService.ts:4717-4765`,
`evidence/original/windows-x64/src/utils/systemInfo.ts:1073-1112`.

**B54 — Reasoning levels.** A turn sends a `ReasoningEffort`
(`none|dynamic|off|minimal|low|medium|high|xhigh|max`) that the model supports;
effort is clamped to the model's supported set, and a provider-coerced effort
is written back to the session unless the effort was deliberately lowered for
this turn.
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/llm/enums.ts:128-140`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:6690-6745`.

### Reliability

**B55 — Retry budget.** The loop's strategy is `non_interactive` when the
runtime is a non-interactive CLI run or a mission worker session, otherwise
`interactive`; best-effort background work uses `no_retry`. The interactive
default is 4 attempts, non-interactive 5, `no_retry` 1. Attempts use
exponential backoff (`delay × factor^attempt`) with jitter: base 1000 ms
(interactive) / 2000 ms (non-interactive), factor 2 / 2.5. Interactive
throttling extends to 6 attempts; a single provider with no rotation extends
capacity errors to 10. `evidence/original/windows-x64/src/core/AgentLoop.ts:1438-1443`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/retryPolicy/index.ts:20-60`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/retryPolicy/index.ts:186-203`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/sendMessage.ts:2302-2328`,
`evidence/original/windows-x64/packages/daemon-sdk/src/retry.ts:15-42`.

**B56 — Retry delays.** Throttling (429) waits max(5 s, backoff) capped at
30 s, preferring server `retry-after-ms`/`retry-after` (numeric seconds or an
HTTP date) and Anthropic rate-limit reset headers, plus ≤20 % jitter.
Provider capacity (500/502/503/529) waits 500 ms–1 s when another provider is
eligible, else throttling-style backoff. Timeouts wait
`3000 ms × 1.5^(attempt-1)` plus ≤1 s jitter, capped at 15 s. Other errors
jitter within [50 %, 100 %] of the backoff. Every wait is capped below the
32-bit timer limit. `evidence/original/windows-x64/packages/droid-core/src/llms/client/retryPolicy/index.ts:45-175`.

**B57 — Retry observability.** Every retryable failure that will be retried
emits `llm-retry-scheduled` with `{sessionId, attempt, reason}` where reason is
`overloaded | rate_limited | timeout | network | empty_response | unknown`;
aborts do not emit. `evidence/original/windows-x64/src/services/llmStreamingPlatform.ts:60-112`,
`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/droid/enums.ts:252-259`.

**B58 — Per-request timeout.** Each provider request carries an explicit
timeout of `general.llmRequestTimeout` ms, default 600 000; the SDK's own
retry is disabled (`maxRetries: 0`) because the loop is the single retry
authority. `evidence/original/windows-x64/src/services/SettingsService.ts:5232-5234`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/sendMessage.ts:1660-1672`.

**B59 — Mid-turn auth failure.** A managed-endpoint 401/403 ends the turn with
`AgentTurnCompletionReason.ModelAuthenticationFailed` and persists a
user-only system message: with a configured `FACTORY_API_KEY` the
"key appears to be invalid" copy, otherwise "Not authenticated. Please log in
using /login or set a valid FACTORY_API_KEY environment variable."
(or the customer-prem login-required copy). A BYOK endpoint's raw error text is
shown instead, because it may be any body.
`evidence/original/windows-x64/src/core/AgentLoop.ts:8331-8400`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:8440-8458`,
`evidence/original/windows-x64/src/commands/authHelpers.ts:52-68`,
`evidence/original/windows-x64/src/i18n/authMessages.ts:20-45`,
`evidence/original/windows-x64/src/utils/agentTurnCompletion.ts:99-140`.

**B60 — Abort is not failure.** An aborted request returns the empty
`ABORTED_RESULT` without recording a failure metric, and the turn ends as
`cancelled`; a provider failure records a failure metric and calls
`onStreamingError`. `evidence/original/windows-x64/packages/droid-core/src/llms/client/sendMessage.ts:6236-6252`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/constants.ts:38-42`.

## Data & config

| Item | Where | Type / domain | Default | Absent / malformed |
|---|---|---|---|---|
| `--append-system-prompt <text>` | CLI flag | string | none | missing value → `Missing value for --append-system-prompt <text>` |
| `--append-system-prompt-file <path>` | CLI flag | path | none | unreadable → `MetaError: Failed to read --append-system-prompt-file:` + path |
| `--auto <level>` | CLI flag | `low\|medium\|high` | unset (session setting) | any other value → stderr error, exit 1 |
| `--use-spec` | CLI flag | boolean | false | — |
| `--disable-builtin-skills` | CLI flag | boolean | false | — |
| `general.llmRequestTimeout` | settings | integer ms | 600000 | absent → default |
| `general.compactionTokenLimitPerModel` | settings | map model→tokens | none | unknown model → model default, capped at max input |
| session model / spec model / reasoning effort | session settings | model id / effort | resolved default | router resolves to concrete, else default model |
| message `visibility` | protocol | `both\|llm_only\|user_only` | absent = `both` | absent → visible to both |
| tool-results model budget | protocol constant | bytes | 32768 (64 KiB tier) | absent tier → 32 KiB |
| media caps | protocol constant | counts | 10 images / 5 PDFs | over cap → oldest evicted + placeholder |

Flags and settings sources: `evidence/original/windows-x64/src/entrypoints/tui/options.ts:9-52`,
`evidence/original/windows-x64/src/utils/appendSystemPromptArgs.ts:12-55`,
`evidence/original/windows-x64/src/entrypoints/tui/autonomyFlag.ts:5-19`,
`evidence/original/windows-x64/src/services/SettingsService.ts:4838-4855`,
`evidence/original/windows-x64/src/services/SettingsService.ts:5232-5234`.

## Errors

**Argument errors (before any turn).** Bad `--auto` value → localized
`Invalid --auto value. Allowed values: low, medium, high.`, exit 1
(`evidence/original/windows-x64/src/entrypoints/tui/run.ts:549-556`). Missing append-prompt value or an
unreadable append-prompt file aborts startup, not a turn
(`evidence/original/windows-x64/src/utils/appendSystemPromptArgs.ts:16-55`, `:67-91`).

**Admission errors.** Unknown tool, session-forbidden tool, unregistered
executor: `MetaError` naming the tool; the call never reaches hooks or
confirmation; the batch settles the other calls normally
(`evidence/original/windows-x64/src/agent/tools.ts:1436-1500`).

**Validation errors.** Malformed native tool input → denial as a tool result
(B29); provider-side JSON that never parses → `inputParseFailed` and the
invalid-arguments result (B35).

**Permission errors.** User refusal → cancellation tool result (B37), turn
continues unless B38 applies. A permission transport failure is reported in
the cancellation text (`Tool execution cancelled: <reason>`). An abort during
the wait → `ToolAbortError`.

**Hook errors.** `continue:false` → `HookStopError` ending the turn; exit code
3 → `AgentAbortError`; a PreToolUse deny → denial result; a hook rewriting
input into an invalid shape → the hook-specific rejection (B29).

**Spec-mode errors.** Restricted tool → `Tool cancelled: Spec mode is active
…` result; blank `ExitSpecMode.plan` → the "called with an empty `plan`"
correction; rejected plan → `EXIT_SPEC_MODE_REJECTED` result plus a user-only
system notice. `evidence/original/windows-x64/src/constants/constants.ts:12-22`,
`evidence/original/windows-x64/src/core/ToolExecutor.ts:1635-1660`.

**Provider errors.** Retryable (throttle/capacity/timeout/network/empty) are
retried per B55–B58 and reported via `llm-retry-scheduled`. Terminal failures
end the turn with `error` plus a user-only system message chosen by class:
auth (B59), overloaded, content moderation, context length, request too large,
empty response, output degeneration, network (naming the host only for a BYOK
endpoint), timeout. `evidence/original/windows-x64/src/core/AgentLoop.ts:8400-8500`.

**Cancellation.** Abort yields `ABORTED_RESULT`, no failure metric, turn reason
`cancelled` (B60), cancelled tool results (B39).

## Acceptance tests

Fixtures are synthesised JSON under `tests/fixtures/agent_loop/`: each
`stream_*.json` is an ordered provider chunk list; each `history_*.json` is a
`FactoryDroidMessage[]`; each `tool_*.json` is a batch plus tool registry stub
outcomes. Time, ids and jitter are injected.

| Clause | Test id | Fixture |
|---|---|---|
| B1 | `tests/agent_loop/test_default_command_is_tui` | none |
| B2 | `tests/agent_loop/test_auto_and_spec_flags_after_resume` | `flags_resume.json` |
| B3 | `tests/agent_loop/test_concurrent_turn_refused` | `history_simple.json` |
| B4 | `tests/agent_loop/test_turn_rows_in_view_order` | `history_simple.json` |
| B5 | `tests/agent_loop/test_turn_completion_reason` | `stream_text.json` |
| B6, B7 | `tests/agent_loop/test_message_block_schema` | `history_blocks.json` |
| B8 | `tests/agent_loop/test_tool_result_content_domain` | `history_tool_result.json` |
| B9 | `tests/agent_loop/test_tool_call_id_deterministic` | `stream_tool_use.json` |
| B10 | `tests/agent_loop/test_user_only_excluded_from_request` | `history_visibility.json` |
| B11 | `tests/agent_loop/test_media_caps_evict_oldest` | `history_media_overflow.json` |
| B12 | `tests/agent_loop/test_user_content_assembly_order` | `attachments.json` |
| B13 | `tests/agent_loop/test_assistant_attribution_persisted` | `stream_text.json` |
| B14 | `tests/agent_loop/test_system_prefix_and_cache_breakpoint` | `tools_minimal.json` |
| B15 | `tests/agent_loop/test_system_block_order` | `tools_full.json` |
| B16 | `tests/agent_loop/test_history_preparation_drops_and_breakpoints` | `history_dirty.json` |
| B17 | `tests/agent_loop/test_anthropic_payload_shape` | `history_tools.json` |
| B17 | `tests/agent_loop/test_openai_tool_message_mapping` | `history_tools.json` |
| B18 | `tests/agent_loop/test_tool_descriptor_names` | `tools_long_name.json` |
| B19 | `tests/agent_loop/test_summary_is_request_only` | `history_summarized.json` |
| B20 | `tests/agent_loop/test_stream_callback_sequence` | `stream_text.json` |
| B21 | `tests/agent_loop/test_anthropic_chunk_mapping` | `stream_thinking_tool.json` |
| B22 | `tests/agent_loop/test_partial_tool_input_throttled` | `stream_tool_use_slow.json` |
| B23 | `tests/agent_loop/test_retry_retracts_partial_message` | `stream_fail_then_text.json` |
| B24 | `tests/agent_loop/test_emitted_event_names` | `stream_text.json` |
| B25 | `tests/agent_loop/test_empty_reply_is_error` | `stream_empty.json` |
| B26 | `tests/agent_loop/test_usage_and_compaction_tokens` | `stream_usage.json` |
| B27 | `tests/agent_loop/test_results_in_request_order` | `tool_batch_parallel.json` |
| B28 | `tests/agent_loop/test_admission_refusal` | `tool_unknown.json` |
| B29 | `tests/agent_loop/test_input_validation_denial` | `tool_invalid_input.json` |
| B29 | `tests/agent_loop/test_execute_lenient_fields` | `tool_execute_lenient.json` |
| B30 | `tests/agent_loop/test_preflight_hook_order` | `hooks_pre_tool_use.json` |
| B31 | `tests/agent_loop/test_confirmation_matrix` | `tool_confirmation_matrix.json` |
| B32 | `tests/agent_loop/test_permission_prompt_batching` | `tool_batch_two.json` |
| B33 | `tests/agent_loop/test_permission_outcomes` | `permission_outcomes.json` |
| B34 | `tests/agent_loop/test_segments_parallel_then_sequential` | `tool_batch_mixed.json` |
| B35 | `tests/agent_loop/test_error_result_envelope` | `tool_failure.json` |
| B36 | `tests/agent_loop/test_result_truncation_head_tail` | `tool_large_output.json` |
| B36 | `tests/agent_loop/test_read_line_truncation_note` | `read_large_file.txt` |
| B37 | `tests/agent_loop/test_denied_path_tool_call_feedback` | `tool_edit_denied.json` |
| B37 | `tests/agent_loop/test_spec_mode_restricted_tool` | `tool_spec_mode.json` |
| B38 | `tests/agent_loop/test_rejection_ends_subagent_turn` | `tool_denied_subagent.json` |
| B39 | `tests/agent_loop/test_stop_cancels_batch` | `tool_batch_running.json` |
| B40 | `tests/agent_loop/test_stop_after_tools` | `tool_exit_spec_mode.json` |
| B41 | `tests/agent_loop/test_context_row_single_per_prompt` | `turn_context.json` |
| B42 | `tests/agent_loop/test_environment_block_rendering` | `system_info.json` |
| B43 | `tests/agent_loop/test_instruction_file_discovery_order` | `agents_md_tree/` |
| B44 | `tests/agent_loop/test_skills_reminder_and_delta` | `skills_two_turns.json` |
| B45 | `tests/agent_loop/test_append_system_prompt_precedence` | `append_prompt.txt` |
| B46 | `tests/agent_loop/test_token_weighting_and_limit_cap` | `usage_cases.json` |
| B47 | `tests/agent_loop/test_threshold_compaction_and_suppression` | `usage_over_threshold.json` |
| B48 | `tests/agent_loop/test_context_limit_recovery_once` | `stream_context_limit.json` |
| B49 | `tests/agent_loop/test_summary_message_shape` | `summary_meta.json` |
| B50 | `tests/agent_loop/test_spec_mode_reminder_and_denial` | `turn_spec_mode.json` |
| B51 | `tests/agent_loop/test_registry_entry_fields` | `model_registry_slice.json` |
| B52 | `tests/agent_loop/test_default_model_candidate_order` | `availability_sets.json` |
| B53 | `tests/agent_loop/test_spec_slot_and_model_switch_reminder` | `model_switch.json` |
| B54 | `tests/agent_loop/test_reasoning_effort_clamp` | `effort_cases.json` |
| B55 | `tests/agent_loop/test_retry_attempt_budgets` | `retry_errors.json` |
| B56 | `tests/agent_loop/test_retry_delay_schedule` | `retry_headers.json` |
| B57 | `tests/agent_loop/test_retry_event_emitted` | `retry_errors.json` |
| B58 | `tests/agent_loop/test_request_timeout_default` | `settings_timeout.json` |
| B59 | `tests/agent_loop/test_auth_failure_mid_turn` | `stream_401.json` |
| B60 | `tests/agent_loop/test_abort_result_no_failure_metric` | `stream_aborted.json` |

Two tests are load-bearing for this spec's acceptance.

**Scripted stream → events and transcript (`test_stream_callback_sequence`,
`test_assistant_attribution_persisted`).** `stream_text.json` is the inline
fixture below, fed to the fake Anthropic transport in order:

```
message_start{id:"msg_1", usage:{input_tokens:12, cache_read_input_tokens:0, cache_creation_input_tokens:0}}
content_block_start{index:0, content_block:{type:"text", text:""}} · text_delta "Hello" · text_delta " world" · content_block_stop{index:0}
message_delta{delta:{stop_reason:"end_turn"}, usage:{output_tokens:2}} · message_stop
```

Expected event sequence (payload fields not listed are ignored):
`streaming-start` → `assistant-text-delta{blockIndex:0,textDelta:"Hello"}` →
`assistant-text-delta{blockIndex:0,textDelta:" world"}` →
`text-block-complete{blockIndex:0}` → `streaming-complete`. Both deltas carry
the same `messageId`. Expected transcript record: one assistant message,
`role:"assistant"`, `content` = `[{"type":"text","text":"Hello world"}]`,
`modelId` = the injected model, `apiProvider` = the fake transport's provider;
and one tool-message-free turn ending `completed`.

**Denied path → permission decision and feedback (`test_denied_path_tool_call_feedback`).**
Input: an interactive session at autonomy `off`; one assistant message with a
single `Edit` call `{file_path:"<tmp>/a.txt", old_str:"x", new_str:"y"}`; the
permission transport records the request and answers
`{outcome:"cancel", approvedToolIds:[]}`.
Expected permission decision: exactly one `PermissionRequest` carrying that
one tool use, then `PermissionResponse{approvedToolIds:[]}` with outcome
`cancel`; no execution event (`tool-call-complete`) for the call; the file is
unchanged. Expected feedback: one tool-result block
`{"type":"tool_result","toolUseId":"<call_…_0>","content":"Error: Tool execution cancelled by user","isError":true}`;
the turn ends `completed` (not `permission_rejected`), and the next request's
serialized history ends with that tool result.

## Evidence

Citations written `src/…` or `packages/…` are relative to
`evidence/original/windows-x64/`; the table below abbreviates them for
readability. All citations are `[observed]` unless noted.

| Evidence | Supports | Method |
|---|---|---|
| `ev_loop_entry` | B1 | read `evidence/original/windows-x64/src/index.ts:1-3,199-207`, `evidence/original/windows-x64/src/cli.ts:31-40,477` |
| `ev_loop_flags` | B2, B45, B50 | read `evidence/original/windows-x64/src/entrypoints/tui/run.ts:549-556,772-789`, `options.ts:9-52`, `autonomyFlag.ts:5-19` |
| `ev_loop_turn` | B3, B4, B5, B40 | read `evidence/original/windows-x64/src/core/AgentLoop.ts:3003-3013,3252-3348,5104-5130,5240-5282,7690-7730` |
| `ev_loop_messages` | B6, B7, B8, B10 | read `droid-sdk-core/.../sessionV2/messages/{enums,schemas}.ts`, `utils/src/messages/visibility.ts:234-249` |
| `ev_loop_tool_ids` | B9 | read `droid-sdk-core/.../messages/toolCalls.ts:73-76`, `chunk-processing.ts:790-800` |
| `ev_loop_media` | B11, B12 | read `image-limits.ts:16-17,151`, `userMessageInjection.ts:120-169` |
| `ev_loop_attribution` | B13, B26 | read `AgentLoop.ts:7377-7490`, `schemas.ts:300-380`, `contextUsage.ts:21-25` |
| `ev_loop_system_prompt` | B14, B15, B45 | read `buildSystemMessageBlocks.ts:70-311`, `systemPrompt.ts:84-90`, `common/src/cli/constants.ts:1-2` |
| `ev_loop_prep` | B16, B19 | read `message-preparation.ts:914-1080`, `requestAssembly.ts:362-380,581-627` |
| `ev_loop_payload` | B17, B18 | read `sendMessage.ts:2673-2685,2804-2826`, `converters.ts:1393-1490`, `client/constants.ts:85` |
| `ev_loop_stream` | B20, B21, B22, B23, B24, B25 | read `agent/messaging.ts:264-600`, `chunk-processing.ts:735-900,320-340`, `AgentEventBus.ts:33-100` |
| `ev_loop_tools` | B27–B40 | read `ToolExecutor.ts:1336-1530,1600-1660,2352-2510,2840-2900`, `agent/tools.ts:1428-1830,1999-2035`, `autonomy.ts:49-190`, `shouldConfirmExecution.ts:820-950`, `tool-confirmation.ts:609-700`, `segmentToolUsesByConcurrency.ts:70-108` |
| `ev_loop_truncation` | B36 | read `tools/utils/constants.ts:32-56`, `large-output.ts:505-560`, `utils/truncate.ts:19-64` |
| `ev_loop_context` | B41–B44 | read `AgentLoop.ts:4790-4840,5104-5130`, `systemInfo.ts:938-1030,1031-1055`, `agentsMdGuidelines.ts:36-60`, `skills/*` |
| `ev_loop_compaction` | B46–B49 | read `token-estimation.ts:5-33`, `SettingsService.ts:4838-4855`, `AgentLoop.ts:7743-7846,7151-7165`, `CompactionManager.ts:425-520,892-900` |
| `ev_loop_models` | B51–B54 | read `model-registry.ts:561-700`, `llm/enums.ts:7-30,128-145`, `availability.ts:33-46`, `llm/index.ts:696-712`, `SessionService.ts:4717-4765`, `systemInfo.ts:1073-1112` |
| `ev_loop_retry` | B55–B58, B60 | read `retryPolicy/index.ts:20-203`, `daemon-sdk/src/retry.ts:15-42`, `llmStreamingPlatform.ts:60-112`, `sendMessage.ts:1660-1672,2302-2328,6236-6252`, `AgentLoop.ts:1438-1443` |
| `ev_loop_auth` | B59 | read `AgentLoop.ts:8331-8458`, `authHelpers.ts:52-68`, `authMessages.ts:20-45`, `agentTurnCompletion.ts:99-140` |

All citations are `[observed]` unless noted. `[derived]` claims: B15 block order
(assembled from separate pushes in one function), B26 compaction figure
(composed from four observed fields), B55 attempt budgets (composed from
`getDefaultRetryCount` and the route-aware wrapper), B56 delay schedule
(composed from `retryPolicy` and `daemon-sdk`'s `computeRetryDelay`).
`[inferred]` claims are only in Open questions.

## Open questions

1. **`SendMessageParams` / `StreamingResult` / `Callback` type declarations are
   absent** (type-only modules elided). Field names and optionality for B17,
   B20, B21 and B26 are read from call sites, not from the types. Settle with
   the declaration file or a runtime capture of the stream callbacks. Blocks
   exact test assertions on `StreamingResult` (which fields are always
   present).
2. **Exact retry jitter distribution**: `sendMessage` passes `jitter: true`
   *and* a custom `getDelay`; `daemon-sdk` applies jitter only when `getDelay`
   is absent (`daemon-sdk/src/retry.ts:33-37`). The effective delay for
   default-class errors therefore depends on whether `jitter` is still applied
   by the caller. B56's default branch may be ±20 % off. Blocks a bit-exact
   delay test; the current test asserts bounds only.
3. **Per-tool `modelResultBudgetBytes` tiers**: only the default (32 KiB) and
   the named 64 KiB text tier are visible; which tools declare the wider tier
   is read from comments and call sites. Blocks a per-tool budget assertion.
4. **Compaction summary soft cap and reserve** (`SUMMARY_SOFT_CAP_DEFAULT =
   4000`, `SUMMARY_RESERVE_DEFAULT = 16000`) are defined but their effect on
   the produced summary is not observable without the summarizer prompt.
   Blocks a deterministic summary-length test.
5. **Model default candidate lists** (`_DEFAULT_FACTORY_MODEL_CANDIDATES`) are
   module-private; the ordering is only observable by calling
   `resolveDefaultFactoryModel`. B52's test drives the exported function with
   synthesised availability sets rather than asserting the list.
6. **Localized error copy** beyond English: B59's exact strings are the English
   catalog; other locales change the text but not the classification. No
   acceptance test may pin non-English wording.
7. **`--auto` vs settings precedence** when no flag is passed and a resumed
   session carries a level: B2 asserts only the flag path, which is observed;
   the settings path is not traced here.

## Clean-room notes

**Contract a reimplementation must reproduce.**

- The transcript is a `FactoryDroidMessage[]` with the seven block types,
  `visibility` semantics, deterministic tool-call ids, and `tool_result`
  `{toolUseId, content, isError, modelContent}` framing; tool results for one
  assistant message form exactly one `role:"tool"` message in request order.
- The system message is a block list whose first block is the exact
  `You are Droid, …` line, with the cached prefix anchored by
  `prompt-cache-pin` and the cache breakpoint on the last stable block.
- Provider requests carry `{model, max_tokens, messages, tools, system}`;
  OpenAI-family conversion maps tool results to `role:"tool"` +
  `tool_call_id` before user text.
- Streaming emits start → deltas (`text`, `thinking`, tool input) → block
  completion → message completion, accumulates partial tool input without
  using it for execution, and retracts the partial assistant message on retry.
- A tool call passes: admission → input-shape gate → pre-flight hooks (with
  their documented precedence) → blocklist/risk params → spec-mode policy →
  sandbox → confirmation → execution. Denials and validation failures are
  tool results, not exceptions; the batch always answers every call.
- Concurrency: file mutations and Execute are barriers; other calls may run
  concurrently; results are merged in request order.
- Model-facing results are truncated to 32 KiB (64 KiB tier) with a head/tail
  notice and secret scrubbing.
- Context: one LLM-only context row per prompt with environment, instruction
  files in the documented order and the documented section headings; a skills
  reminder with the documented header and bucket priority; `--use-spec` is read-only
  until an approved `ExitSpecMode`.
- Token accounting: 4 chars/token weighted for multi-byte text; compaction
  figure = input + output + cache-read; threshold compaction with suppression
  after a failed reduction; context-limit compaction retried once.
- Retry: 4/5/1 attempts by strategy, exponential backoff with the documented
  bases/factors, throttle `Retry-After` respect, capacity and timeout special
  cases, `llm-retry-scheduled` with the six reasons, no retry on abort.
- Mid-turn auth failure yields `model_authentication_failed` plus the
  login/key guidance, never a silent retry loop.

**Explicitly not part of the contract.** Provider transport internals (HTTP
headers, proxy URLs, Bedrock/Vertex clients), the exact wording of
non-English locales, the private default-model candidate list, individual
tool schemas and side effects, hook/skill/MCP discovery, transcript file
layout and resume, and any telemetry naming. Streaming internal class and
function names (`StreamingState`, `processAnthropicChunk`) are ours to choose;
only the emitted events, the persisted records and the wire payload shape are
contractual.
### Recorded divergence: the identity line

The subject's first system block says it was built by the original vendor. That
sentence is **not** part of the compatibility contract: reproducing it would make
this build state something false about its origin. The implemented line is

```
You are Droide, an AI software engineering agent.
```

(see `src/agent/context.ts`, `identityLine()`). Everything the clause pins about
*position* and *ordering* — identity first, then environment, skills, project
instructions, appended text — is reproduced exactly; only the vendor claim is
dropped. Any parity test that compares system prompts must normalise this line
rather than treat it as a drift.
