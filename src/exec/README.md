# `src/exec/` — non-interactive mode and output protocols

Contract: `specs/80-exec-and-streaming.md` (B1–B34, B54–B57).
`records.ts` builds the seven stream-json records and the `-o json` summary and
validates `--input-format stream-json` lines. `writer.ts` writes one JSON object
per `\n`-terminated line to an injected `Writable`. `turn.ts` owns the
`TurnRunner` seam plus `runOneShot`/`runOneShotSummary`. `validate.ts` throws
`ExecUsageError` before session work; `errors.ts` defines the typed failures.
`command.ts` and `runner.ts` are the live wiring described below.

## Wiring

```
cli/commands/exec.ts
   │ parsed flags (optsWithGlobals: the root declares some flags too)
   ▼
exec/command.ts  runExecCommand(argv, deps)
   │ validate flags → prompt → app context → model target → tools → provider
   ▼
exec/runner.ts   createExecTurnRunner ──▶ agent/loop.ts   runTurn
   │                     │
   │                     └── createExecToolRunner ──▶ tools/registry.ts dispatch
   ▼
exec/turn.ts     runOneShot / runOneShotSummary  (stream-json, json)
```

Both seams take everything external by injection — streams, clock, ids,
`fetch`, the app context and the tool registry — so unit tests run with no
process, timers or network.

### Resolution order in `command.ts`

1. **Flags.** `parseOutputFormat`, `parseInputFormat`, the `--file`/prompt
   conflict, the streaming-input prompt refusal, the input/output pairing, the
   `--auto` value and the `--auto`/`--skip-permissions-unsafe` conflict. All of
   them happen before configuration, prompt reading or any socket.
2. **App context.** `createAppContext` resolves settings by the usual chain;
   `--cwd` moves the effective working directory, which then anchors `--file`
   and every tool call.
3. **Prompt.** `--file` (resolved against that directory) > positional prompt >
   piped stdin. A positional prompt suppresses stdin; `--file` plus a positional
   prompt is refused first. A missing/empty file, empty stdin, `-`, or no source
   at all each produce the recorded message on stderr and exit `1`.
4. **Model target.** `-m` > `settings.droidCoreModel` > `gpt-6.1-sol`.
   - `custom:<id>` finds the `customModels[]` entry by `id` (then by `model`).
     Its `baseUrl` is the endpoint root: `<base>/chat/completions` for `openai`
     and `generic-chat-completion-api`, `<base>/messages` for `anthropic`.
     `apiKey` becomes `Authorization: Bearer …` (or `x-api-key` plus
     `anthropic-version` for Anthropic); `extraHeaders` is merged. An unknown
     id, a missing `baseUrl` and `bedrock-converse` are refused.
   - Anything else is managed: `FACTORY_API_KEY` (missing → the recorded
     authentication message) and `FACTORY_API_BASE_URL` (default
     `https://api.factory.ai`) at `/api/llm/o/v1/chat/completions`.
   - A missing model or credential fails **here**, before a provider object
     exists; no socket is opened.
5. **Tools.** Without `--auto`/`--skip-permissions-unsafe` only read-only and
   no-effect tools are advertised; either flag widens the set to every
   registered tool. The same names feed `system/init.tools` and the provider's
   catalogue.
6. **Run.** The provider streams; `createExecTurnRunner` feeds the loop and
   translates events; the selected output format writes.

### Tool execution (`createExecToolRunner`)

Per call: the name must be advertised (else B47's not-permitted result), then
`permissions.decide` runs, then `ToolRegistry.dispatch` validates and executes.
A refusal is a normal `{isError:true}` result, never an exception:

- a hard `deny` returns the algebra's refusal text;
- `ask` in a non-interactive session is an auto-denial (B46), and for
  `Execute`/MCP it is recorded as the **immediate exit** (B14);
- an interactive `ask` with no/declining `confirm` returns
  `Error: Tool execution cancelled by user`;
- registry validation failures keep B8's text; every failure is prefixed
  `Error: ` once;
- successes are flattened to text and cut head+tail at 32 KiB with the notice.

An immediate denial aborts the loop after the tool result is recorded, so no
second model request is made; the turn then ends with the assistant text
`Exec ended early: insufficient permission to proceed. …`, exactly one terminal
record, and exit `1`.

### Output modes

| `-o`                                  | Behaviour                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `text` (default)                      | final answer + `\n` on stdout; failures write `Error during droide execution: <message>` on stderr |
| `json`                                | one `result` object (`runOneShotSummary`)                                                         |
| `stream-json`, `debug`                | one record per line (`runOneShot`)                                                                |
| `stream-jsonrpc`, `acp`, `acp-daemon` | refused before any work: not implemented in this build                                            |
| `--input-format …`                    | refused before any work: not implemented in this build                                            |

## Record kinds (`-o stream-json`)

1. `system`/`init` — `cwd`, `session_id`, `tools`, `model`, `reasoning_effort`.
2. `message` — `role` (`user` | `assistant`), `id`, `text`, `timestamp`, `session_id`.
3. `reasoning` — `id`, `text`, `timestamp`, `session_id`.
4. `tool_call` — `id`, `messageId`, `toolId`, `toolName`, `parameters`, `timestamp`, `session_id`.
5. `tool_result` — `id`, `messageId`, `toolId`, `isError`, then `value` on success or `error:{type:"tool_error",message}` on failure.
6. `error` — `source` (`cli` | `agent_loop`), `message`.
7. `completion` — `finalText`, `numTurns`, `durationMs`, `usage`.

`-o json` writes one `result` object with the eight keys
`type, subtype, is_error, duration_ms, num_turns, result, session_id, usage`;
`usage` is snake_case and `ttft_ms` appears only when known.

## Ordering

`system/init` first. Then the trimmed user echo (never `<system-reminder>`
content). Then one record per non-empty content block, in block order; all
blocks of one message share its `id` and `timestamp`. A `progressUpdate`
thinking block is an assistant `message`, not `reasoning`. `tool_result.toolId`
resolves from calls seen in this process, else `""`. Success ends with exactly
one `completion`; failure ends with exactly one terminal `error`
(`source:"cli"`) and no `completion`. Stdout carries records only.

The record's `messageId` is the message that owns the block: a tool call carries
the assistant message's id, a tool result carries the tool-role message's id.

## Exit codes

| Code          | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `0`           | turn completed, `--help`, or broken pipe after the result was chosen                                 |
| `1`           | usage error, prompt-source error, missing model/credential, failed or cancelled turn, provider error |
| `130` / `143` | SIGINT / SIGTERM; a signal outranks every turn outcome                                               |

## Deliberate gaps

- `--input-format …`, `stream-jsonrpc`, ACP, sessions (`-s`, `--fork`),
  `--mission`, `--use-spec`/`--spec-model`, `--list-tools`, the tool-selection
  flags, `--append-system-prompt[-file]`, worktree options and `--tag` are
  refused loudly rather than half-implemented.
- Reasoning effort is reported in `system/init` but the provider port has no
  field for it.
- Usage deltas arrive from the transport already folded (`input` includes cache
  read/creation), so `cache_read_input_tokens` and
  `cache_creation_input_tokens` are reported as `0`.
- `TurnRequest` has no signal field, so an outer cancel reaches `runOneShot`
  but not a running loop turn.
- The 32 KiB cut notice names the output as not retained; no tool-output
  artifact is written by this build.
