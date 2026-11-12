# `src/exec/` — non-interactive output protocols

Contract: `specs/80-exec-and-streaming.md` (B18-B34, B54-B57).

| Module | Responsibility |
|---|---|
| `records.ts` | The seven stream-json records, the `-o json` summary, their builders, and the `--input-format stream-json` line validator |
| `writer.ts` | One JSON object per `\n`-terminated line over an injected `Writable`; flushes; tolerates a broken pipe |
| `turn.ts` | `TurnRunner` seam and `runOneShot` / `runOneShotSummary` orchestration |
| `validate.ts` | Option validation that throws `ExecUsageError` before any session work |
| `errors.ts` | `ExecUsageError`, `ExecStreamError`, `ExecAbortedError` |

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
one `completion`; failure ends with exactly one terminal `error` (`source:"cli"`)
and no `completion`. Stdout carries records only; diagnostics go to stderr.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | turn completed (or completed stream), help/list-tools |
| `1` | usage error, failed or cancelled turn, provider error |
| `130` / `143` | SIGINT / SIGTERM; a signal outranks every turn outcome |

A broken stdout pipe closes the writer and still exits `0` once the result was
chosen.