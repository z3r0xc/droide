# `src/exec/` — non-interactive output protocols

Contract: `specs/80-exec-and-streaming.md` (B18-B34, B54-B57).
`records.ts` builds the seven stream-json records and the `-o json` summary and
validates `--input-format stream-json` lines. `writer.ts` writes one JSON object
per `\n`-terminated line to an injected `Writable`. `turn.ts` owns the
`TurnRunner` seam plus `runOneShot`/`runOneShotSummary`. `validate.ts` throws
`ExecUsageError` before session work; `errors.ts` defines the typed failures.

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

## Exit codes

| Code          | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `0`           | turn completed, help/list-tools, or broken pipe after the result was chosen |
| `1`           | usage error, failed or cancelled turn, provider error                       |
| `130` / `143` | SIGINT / SIGTERM; a signal outranks every turn outcome                      |
