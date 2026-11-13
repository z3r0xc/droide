# Exec mode and streaming protocols

- **Target:** the `droide` CLI shipped from this repository
- **Status:** draft
- **Owner:** exec / protocol slice
- **Related:** `00-context.md`; `tests/parity/cases/help-exec.json`; deferred: session store, JSON-RPC streaming, ACP server, tool catalogue, settings precedence

## Purpose

`droide exec` is the non-interactive front door to the agent: one process, one
stdout a script can parse, one exit code CI can branch on. It takes the prompt
from argv, a file or stdin, applies an explicit autonomy ceiling instead of
asking a human, and reports the run in one of several machine formats —
terminal text, a single JSON summary, a JSONL event stream, a JSON-RPC
notification stream, or an ACP server. This spec fixes what a caller sees:
argv handling, prompt sources, permission behaviour without a human, the exact
record shapes and ordering of the JSONL stream, session continuation and
forking, and exit codes.

## Scope

Covers `droide exec` as an invocations and wire contract: option handling,
prompt acquisition, autonomy/permission resolution for an unattended process,
`--output-format text|json|stream-json|debug`, `--input-format stream-json`,
the boundary behaviour of `stream-jsonrpc`/`acp`/`acp-daemon`, and exit status.

Out of scope, with the owning spec named:

- The event-bus internals that produce stream-json records, the agent loop's
  retry policy, and turn persistence — agent-loop spec.
- The full JSON-RPC method catalogue and notification payloads served by
  `--output-format stream-jsonrpc` / `--input-format stream-jsonrpc` — a future
  `jsonrpc-streaming.md`. Only the exec boundary (transport, flag validation,
  lifetime, exit) is stated here.
- ACP (`acp`, `acp-daemon`) session semantics — a future `acp-server.md`.
- Session file layout, ids' creation rules and transcript record persistence —
  `session-store.md`. This spec states only what exec _emits_.
- Tool selection semantics beyond the autonomy base set (`--only-tools`,
  `--add-tools`, `--remove-tools`, MCP selectors) — tool-registry spec. Their
  effects on exec output (`--list-tools`) are named here.
- Authentication, settings hierarchy and model catalogue resolution.

There is **no `--json` and no `--quiet` flag on `droide exec`** in the
recorded release (`evidence/original/windows-x64/src/entrypoints/exec/command.ts:47-230` lists the
whole option set; the curated help lists the same set,
`entrypoints/exec/help.ts:100-150`). Scripted callers use
`-o json`/`-o stream-json`, and `exec` is quiet by construction: stdout carries
only the result, and `console.*` output is redirected to a log file (B33, B34).

## Terms

- **exec run** — one `droide exec` process. It performs zero, one, or (with
  `--input-format stream-json`) many agent turns.
- **prompt source** — where the user text comes from: `-f/--file`, piped stdin,
  or the positional argument.
- **turn** — one user message plus the assistant/tool traffic it causes.
- **stream-json** — the JSONL event protocol on stdout, one object per line,
  selected by `-o stream-json` (or its deprecated alias `debug`).
- **record** — one JSON object written by an exec mode. `json` mode writes one
  record and exits; `stream-json` writes a sequence terminated by a
  `completion` record (success) or an `error` record (failure).
- **autonomy level** — `off | low | medium | high`; the CLI accepts only
  `low|medium|high` via `--auto`
  (`packages/sdk-core/src/protocol/shared/enums.ts:22-28`).
- **autonomy mode** — the `(interactionMode, autonomyLevel)` pair exec resolves
  once per run: `spec` when `--use-spec`/`--spec-model` is given, else `auto`.
- **immediate exit** — the exec-only state in which a denied tool call that
  needs real approval ends the turn instead of only failing that tool.
- **owed work** — background work (e.g. a background `Task`) a run still owes
  the transcript before it may exit.
- **normalised record** — a record after the test harness replaces
  `timestamp`, `durationMs`/`duration_ms`, `session_id` and free-form tool
  output with fixed placeholders (see Acceptance tests). Determinism lives in
  the sequence, keys and values, not in wall-clock fields.

## Observable behaviour

### Invocation and prompt sources

**B1.** The command is `droide exec [options] [prompt]`
(`entrypoints/exec/command.ts:47-50`). An unrecognised option is rejected by
Commander before any bootstrap runs; the usage error is written to stderr and
the process exits `1` (`cli.ts:480`, `cli.ts:583-590`). `exec --help` is an
ordinary option that prints the curated help page and exits `0`
(`entrypoints/exec/command.ts:250-256`, `entrypoints/exec/help.ts:100`).

**B2.** With `-f/--file <path>`, the prompt is the file's UTF-8 content read
verbatim from `path.resolve(path)` relative to the run's working directory.
A file whose content is empty or whitespace-only is refused; a missing file, an
unreadable file and a permission failure each produce their own message on
stderr and exit `1` (`entrypoints/exec/handler.ts:209-244`).

**B3.** With no positional prompt and stdin not a TTY, stdin is read to EOF and
the whole text becomes the prompt (`entrypoints/exec/handler.ts:177-198`,
`:346-366`). Empty or whitespace-only stdin is refused
(`entrypoints/exec/handler.ts:357-364`).

**B4.** Prompt-source precedence is `--file` > piped stdin > positional
argument (`entrypoints/exec/handler.ts:338-377`). Supplying both `--file` and a
positional prompt is an error, reported before any other prompt work
(`entrypoints/exec/handler.ts:332-336`). A positional prompt suppresses stdin:
stdin is only read when the positional argument is absent.

**B5.** The positional prompt `-` is refused with the migration message
`The "-" syntax is no longer supported. Use one of: …` and exit `1`
(`entrypoints/exec/handler.ts:369-377`).

**B6.** With no prompt from any source, exec writes
`No prompt provided. Usage:` (followed by usage lines) to stderr and exits `1`
(`entrypoints/exec/handler.ts:379-383`).

**B7.** `--input-format stream-json` and `--input-format stream-jsonrpc` read
every message from stdin, so a positional prompt or `--file` alongside them is
refused: `Cannot use prompt argument in streaming mode. Messages are read from
stdin.`, exit `1`, before any session exists
(`entrypoints/exec/assertValidOptions.ts:354-367`,
`entrypoints/exec/run.ts:575-590`).

### Autonomy and permissions without a human

**B8.** Autonomy mode is resolved once per run: `spec` when `--use-spec` or
`--spec-model` is set, otherwise `auto`; the level is `--auto`'s value,
defaulting to `low`
(`commands/resolveToolSelection.ts:677-689`). A _mission_ run forces
`high`.

**B9.** Without `--auto` and without `--skip-permissions-unsafe`, the base
allowed tool set is the read-only set: mutating and shell tools are not
advertised, so the model cannot call them
(`commands/resolveToolSelection.ts:316-322`). This is the "read-only mode" the
help describes; it is a tool-availability rule, not a prompt-level rule.

**B10.** `--auto low|medium|high` makes every model-available tool selectable
and lets the level decide which `Execute`/`Script` risks are auto-approved
(`commands/resolveToolSelection.ts:316-322`). Any other value is refused with
`Invalid --auto value. Allowed values: low, medium, high.` and exit `1`
(`entrypoints/exec/assertValidOptions.ts:283-289`).

**B11.** `--skip-permissions-unsafe` skips all confirmations and runs at
`high` (`entrypoints/exec/handler.ts:1092-1094`,
`entrypoints/exec/handler.ts:417-433`). It is mutually exclusive with `--auto`:
`Invalid flags: --auto and --skip-permissions-unsafe cannot be used together.`
(`entrypoints/exec/assertValidOptions.ts:177-179`).

**B12.** Both paths are clamped to the organization's managed maximum autonomy
level; a level above the maximum is silently lowered, and the `--list-tools`
header and the insufficient-permission guidance then name the clamped level
(`services/SessionService.ts:777-781`, `core/ToolExecutor.ts:1056-1091`).

**B13.** In a non-interactive run with no permission callback, a tool call that
requires confirmation is auto-denied without prompting, and the denial is
recorded against the tool as an `auto` decision
(`core/ToolExecutor.ts:840-861`).

**B14.** If a denied call is of confirmation type `Execute`, `Script`, or an
MCP tool, exec enters immediate-exit: the tool result is the denial message, the
agent loop appends one assistant message
`Exec ended early: insufficient permission to proceed. <guidance>` to the
transcript, the turn's completion reason is `PermissionRejected`, and the
process exits `1` (`core/ToolExecutor.ts:840-861`, `core/AgentLoop.ts:7667-7700`,
`exec/sharedAgentRunner.ts:241-268`, `exec/sharedAgentRunner.ts:1526-1530`).
`<guidance>` is selected by the run's live mode and level
(`core/ToolExecutor.ts:1056-1093`): a spec-mode session gets
`guidanceSpec`; `high` or mission gets `guidanceHigh`
(`Re-run with --skip-permissions-unsafe.`); `medium` gets `guidanceMedium`
(`Re-run with --auto high. For destructive commands, use
--skip-permissions-unsafe.`); `low` — the exec default — gets `guidanceLow`
(`Re-run with --auto medium or --auto high. For destructive commands, use
--skip-permissions-unsafe.`); any other level gets `guidanceDefault`; and when
the required level exceeds the organization maximum the guidance instead names
that ceiling (`guidanceMaxAutonomy`).

**B15.** A denied call of any other confirmation type (e.g. file edit) yields a
per-tool error result and the turn continues; no immediate exit is taken
(`core/ToolExecutor.ts:840-861`).

**B16.** A session started by a delegated parent (`--calling-session-id`) is
created with `autoRejectPermissionRequests: true`, so its permission requests
are cancelled silently and surfaced as a per-tool denial message rather than as
the human-facing insufficient-permission error
(`entrypoints/exec/handler.ts:1150-1160`, `exec/renderlessExecRunner.ts:176-200`).

**B17.** `--mission` requires `--auto high` or `--skip-permissions-unsafe`, and
is refused with `--spec-*`, `--session-id`, `--fork`, and streaming input
(`entrypoints/exec/assertValidOptions.ts:187-214`).

### Output format `text` (default)

**B18.** On success the process writes exactly the run's final assistant text
followed by one newline to stdout, and nothing else
(`entrypoints/exec/handler.ts:260-284`). An empty answer produces a bare
newline. Progress notes are ordinary assistant text in `stream-json` (B28) but
never replace the final answer when the last assistant message has one (B19).

**B19.** The final text is the last visible assistant answer of _this_ run: the
transcript may hold earlier turns of a resumed session, and none of them
qualify; when the last assistant message has no answer text but has progress
updates, the updates joined by a blank line stand in; otherwise the empty
string is the answer (`exec/renderlessExecRunner.ts:91-129`).

**B20.** On failure the final text is not printed to stdout; exec writes
`Error during droide execution: <message>` to stderr and exits `1`
(`entrypoints/exec/handler.ts:537-573`).

### Output format `json`

**B21.** `-o json` prints **one line** containing **one JSON object** — not an
array, no trailing records — and exits `0`
(`entrypoints/exec/handler.ts:267-275`). The object's keys are exactly:

| key           | type    | value                                |
| ------------- | ------- | ------------------------------------ |
| `type`        | string  | `"result"`                           |
| `subtype`     | string  | `"success"`                          |
| `is_error`    | boolean | `false`                              |
| `duration_ms` | number  | wall time of the run                 |
| `num_turns`   | number  | assistant messages in the transcript |
| `result`      | string  | final assistant text                 |
| `session_id`  | string  | the session that ran                 |
| `usage`       | object  | see B23                              |

(`exec/exec-summary.ts:4-21`; literal values confirmed at
`evidence/extracted/windows-x64/chunk-sm0347rw.js`.)

**B22.** On failure the same single object is printed with `subtype:"failure"`,
`is_error:true`, `result` = the error message, `num_turns` = `0`, and the run
exits `1` (`entrypoints/exec/handler.ts:546-557`,
`exec/exec-summary.ts:23-40`).

**B23.** `usage` is snake_case and always carries `input_tokens`,
`output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`droide_credits`, `thinking_tokens`; `ttft_ms` is present only when the session
has a mean time-to-first-token (`exec/streamJsonEventHelpers.ts:212-231`).
Token counts are inclusive of child sessions. When no session exists yet, all
counters are `0` (`entrypoints/exec/handler.ts:246-258`).

### Output format `stream-json` (and its alias `debug`)

**B24.** `-o stream-json` writes JSONL: one JSON object per line terminated by
`\n`, never an array, never a wrapper (`exec/streamJsonEventHelpers.ts:152-154`).
`-o debug` is the deprecated spelling of the same format and produces
identical events (`packages/sdk-core/src/protocol/shared/enums.ts:134-143`;
selection logic `entrypoints/exec/handler.ts:1196-1198`).

**B25.** There are exactly seven record kinds. `timestamp` is epoch
milliseconds; `session_id` is the session that owns the message.

1. `system` / `init` — first record of every stream:
   `{"type":"system","subtype":"init","cwd":<string>,"session_id":<string>,
"tools":[<llmId>…],"model":<string>,"reasoning_effort":<string>}`
   (`entrypoints/exec/handler.ts:1217-1226`,
   `exec/streamingExecRunner.ts:212-221`). `tools` is every currently
   registered tool's `llmId` (`entrypoints/exec/handler.ts:1205-1206`); `model`
   and `reasoning_effort` are the values the session actually runs, which can
   differ from the flags when a legacy default was upgraded
   (`entrypoints/exec/handler.ts:1208-1216`).
2. `message` —
   `{"type":"message","role":"user"|"assistant","id":<string>,
"text":<string>,"timestamp":<number>,"session_id":<string>}`
   (`exec/streamJsonEventHelpers.ts:76-84`, `:166-184`).
3. `reasoning` —
   `{"type":"reasoning","id":<string>,"text":<string>,
"timestamp":<number>,"session_id":<string>}`
   (`exec/streamJsonEventHelpers.ts:48-57`, `:65-75`).
4. `tool_call` —
   `{"type":"tool_call","id":<toolUseId>,"messageId":<string>,
"toolId":<string>,"toolName":<string>,"parameters":<object>,
"timestamp":<number>,"session_id":<string>}`; `parameters` is the model's
   tool input verbatim, `toolId` and `toolName` are both the model-facing name
   (`exec/streamJsonEventHelpers.ts:85-100`).
5. `tool_result` —
   `{"type":"tool_result","id":<toolUseId>,"messageId":<string>,
"toolId":<string>,"isError":<boolean>,"value"?:<string>,
"error"?:{"type":"tool_error","message":<string>},
"timestamp":<number>,"session_id":<string>}`
   (`exec/streamJsonEventHelpers.ts:115-137`). Success carries `value`;
   failure carries `error` and omits `value`.
6. `error` —
   `{"type":"error","source":"cli"|"agent_loop","message":<string>,
"timestamp":<number>,"session_id":<string>}`
   (`exec/streamJsonEventHelpers.ts:139-150`, `:192-208`).
7. `completion` —
   `{"type":"completion","finalText":<string>,"numTurns":<number>,
"durationMs":<number>,"session_id":<string>,"timestamp":<number>,
"usage":{…}}` where `usage` is B23's object
   (`exec/streamJsonEventHelpers.ts:233-248`). `numTurns` counts assistant
   messages in the session transcript at the end of the run, so a continued
   session, or a later `--input-format stream-json` message, reports a
   cumulative count (`exec/renderlessExecRunner.ts:139-141`, `:693-695`).

**B26.** Ordering in a one-shot run is fixed: `system/init` first, before any
agent work; then the echo of the user message; then one record per transcript
content block in transcript order; then, on success, exactly one `completion`.
The init record is written after the event subscription is installed and before
the agent loop starts (`entrypoints/exec/handler.ts:1196-1227`), so no agent
record can precede it.

**B27.** Within one assistant message, one record is emitted per non-empty
content block, in block order, each carrying the same message `id` and
`timestamp`: `chatCompletionReasoningContent` (when present) yields a
`reasoning` record first, then each thinking block, each text block and each
`tool_use` block follow in the order they appear in `content`
(`exec/streamJsonEventHelpers.ts:41-104`). Blocks whose text is empty or
whitespace-only produce nothing.

**B28.** A thinking block flagged `progressUpdate` is emitted as a `message`
with `role:"assistant"`, not as `reasoning`
(`exec/streamJsonEventHelpers.ts:71-75`).

**B29.** The user-message echo is emitted only for text blocks, trimmed, and
never for content that begins with the system-reminder marker
(`exec/streamJsonEventHelpers.ts:166-184`).

**B30.** `tool_result` records carry the `toolId` of the call they answer,
resolved from `tool_call` records emitted earlier **in the same process**;
a result whose call was not seen in this process (e.g. an earlier turn of a
resumed session) carries `toolId:""`
(`exec/streamJsonEventHelpers.ts:85-89`, `:128`).

**B31.** `tool_result.value` is the tool's result content flattened to text,
byte-for-byte except that image parts become the literal placeholder
`placeholder`; leading and trailing whitespace is preserved. Model-only guidance
never enters `value` (`exec/streamJsonEventHelpers.ts:106-137`). On
`isError:true`, `value` is absent and `error.message` is that same flattened
text.

**B32.** On failure no `completion` record is written. Instead exactly one
`error` record closes the stream: `source:"cli"` when exec's own run result or
a thrown error ends the run, with `message` equal to the final text (or the
thrown error's message) (`entrypoints/exec/handler.ts:559-565`,
`:1294-1323`). Agent-loop failures additionally surface as
`source:"agent_loop"` records carrying the local diagnostic message
(`exec/streamJsonEventHelpers.ts:192-208`); both kinds may appear in one failed
run, and the later `cli` record is the terminal one.

**B33.** Stdout carries records only. Every diagnostic — selection warnings,
hook-settings issues, ignored-flag warnings, worktree notices, MCP start
failures — goes to stderr (`entrypoints/exec/handler.ts:145-147`, `:311-323`).
`console.*` output is redirected to `<home>/.droide/logs/console.log` (or
`.droide-dev` outside production) before any run output
(`utils/patch-console.ts:1-16`, `:65-80`), and when stdout is not a TTY the run
sets `FORCE_COLOR=0` and `NO_COLOR=1` for itself and its tool children
(`utils/command-wrapper.ts:12-24`).

**B34.** A closed stdout pipe (`… | head -1`) does not fail the run: writes are
best-effort, and a broken-pipe write after a successful result still exits `0`
(`utils/safeStdoutWrite.ts:17-31`, `entrypoints/exec/run.ts:183-197`).

### Sessions: continue, fork, propagate

**B35.** `-s/--session-id <id>` loads that session with its full conversation
history before the turn runs, and does **not** replay its earlier messages on
stdout. It requires a prompt, because B6 otherwise refuses the invocation
(`entrypoints/exec/help.ts:186-191`,
`entrypoints/exec/handler.ts:1122-1132`, `:325-384`).

**B36.** `--fork <id>` copies the source session's whole transcript into a new
session, applies the run's models at creation, and continues on the new branch;
`session_id` in every record is the new id
(`entrypoints/exec/handler.ts:1052-1072`, `:1119`).

**B37.** `--session-id` and `--fork` are mutually exclusive
(`Invalid flags: --session-id and --fork cannot be used together.`,
`entrypoints/exec/assertValidOptions.ts:181-185`). `--fork` is also refused with
`--use-spec`/`--spec-model`, `--worktree`, `--mission`, and with
`--input-format stream-jsonrpc` or an ACP output format
(`entrypoints/exec/assertValidOptions.ts:242-259`).

**B38.** `--session-id` is refused with `--use-spec`/`--spec-model`
(`entrypoints/exec/assertValidOptions.ts:238-240`).

**B39.** A new session's id is observable only through `-o json`
(`session_id`), `-o stream-json` (`session_id` on every record), or by pinning
it up front with the internal `--init-session-id`; `-o text` never prints it
(`entrypoints/exec/handler.ts:260-284`, `:1217-1226`).

**B40.** In `--input-format stream-json`, the session is created on the first
message (or loaded when `-s`/`--fork` supplied one) and its id is reported in
the single `system/init` record, which is written after session setup and
before that message's agent records; later messages reuse it
(`exec/streamingExecRunner.ts:162-223`).

### Input format `stream-json`

**B41.** `--input-format stream-json` requires `-o stream-json` (or `debug`) and
is otherwise refused with
`Invalid flags: --input-format stream-json requires --output-format stream-json
(or debug for backward compatibility) for proper event streaming.`
(`entrypoints/exec/assertValidOptions.ts:142-151`). Selecting it prints
`Warning: --input-format stream-json is deprecated. Use --input-format
stream-jsonrpc for daemon-compatible JSON-RPC protocol.` to stderr at
validation time (`:152-155`).

**B42.** stdin is read line by line, terminal mode off. Blank lines are ignored.
Every other line is parsed as one JSON object in the Anthropic
`MessageParam` shape: `role` must be `"user"` (anything else fails the line with
`Only 'user' messages are accepted via stdin.`), and `content` is either a
string or an array whose first `text` block supplies the prompt; no text yields
`Message must contain text content` (`exec/streamingExecRunner.ts:131-160`).

**B43.** A malformed line, a non-user role, or a text-less message produces one
`error` record with `source:"cli"` and the message above, and the stream
continues with the next line; the process does not exit
(`exec/streamingExecRunner.ts:286-296`). A record emitted before any session
exists carries `session_id:""` (`exec/streamingExecRunner.ts:288`).

**B44.** Messages are processed strictly one at a time, in arrival order, via a
serial chain over stdin lines (`exec/streamingExecRunner.ts:94-96`,
`:323-326`). Each message ends with exactly one record: `completion` on success,
`error` on failure (`exec/streamingExecRunner.ts:266-280`).

**B45.** Closing stdin runs every message already received to its result, then
ends the stream and exits `0`; a close cancels nothing
(`exec/streamingExecRunner.ts:328-347`).

**B46.** SIGINT during `--input-format stream-json` unsubscribes the event
stream, writes one final `error` record `Streaming session interrupted by user`,
stops the running turn, and writes nothing afterwards; the process exits `0`
(`exec/streamingExecRunner.ts:300-321`).

**B47.** Each message's records carry that message's session id, so every
message of one stream shares the same `session_id`
(`exec/streamingExecRunner.ts:226`, `:288`).

### Input/output format `stream-jsonrpc` and ACP (boundary contract)

**B48.** `--input-format stream-jsonrpc` requires `-o stream-jsonrpc`
(`Invalid flags: --input-format stream-jsonrpc requires --output-format
stream-jsonrpc for proper JSON-RPC streaming.`,
`entrypoints/exec/assertValidOptions.ts:158-165`). Session settings come from
the client's requests, so `-m/--model`, `--auto`, `-r/--reasoning-effort`,
`--disable-builtin-skills`, `--use-spec`, `--spec-*`, the tool-selection flags,
`-s/--session-id`, `--tag` and `--session-title` are still validated but have
no effect; any that are set are named in one yellow stderr warning
(`entrypoints/exec/constants.ts:14-53`,
`entrypoints/exec/handler.ts:311-323`).

**B49.** The transport is line-delimited JSON-RPC 2.0 over stdio: one message
per line out (`escapeJsonLineSeparators(JSON.stringify(message))` + `\n`), one
message per line in. Invalid JSON and schema-invalid messages are answered with
a response carrying `id:null` and error code `-32700` and the messages
`Invalid JSON` / `Invalid JSON-RPC message`; they never kill the process
(`exec/wire/StdioWire.ts:70-82`, `:120-145`).

**B50.** The server runs until the peer goes away: stdin EOF, SIGINT, SIGTERM,
SIGHUP, parent disconnect, or a failed stdout write all close it; a close
initiated by a signal or EOF drains in flight work, while losing the peer
(parent disconnect, output closed) interrupts it
(`exec/wire/StdioWire.ts:157-256`). A fatal error inside the
JSON-RPC runner exits `1` (`exec/runStreamingJsonRpcExec.ts:84-87`).

**B51.** `-o stream-jsonrpc` **without** `--input-format stream-jsonrpc` is the
one-shot variant: the prompt comes from argv/file/stdin exactly as in B2–B6, a
fresh session is created in the launch directory, and the process exits when
that turn reaches a terminal reason (`entrypoints/exec/handler.ts:959-982`).
`--mission`, `--session-id`, `--fork`, `--calling-session-id` and
`--calling-tool-use-id` are refused in this variant
(`entrypoints/exec/assertValidOptions.ts:107-137`).

**B52.** `-o acp` and `-o acp-daemon` hand the process to an in-process ACP
daemon before session fetch, and `--disable-builtin-skills` is refused in both
(`entrypoints/exec/handler.ts:821-833`,
`entrypoints/exec/assertValidOptions.ts:167-175`).

### `--list-tools`

**B53.** `--list-tools` resolves tool selection, prints the catalogue and exits
`0` without creating a session or consuming a prompt, and without requiring a
credential: it answers before a model target, session, socket or API key is
resolved, so it works with no login. The header line names the wire model when
one resolves and the configured model id when it does not
(`entrypoints/exec/handler.ts:800-814`; regression:
`tests/integration/exec/list-tools.test.ts`, "answers with no credential and no
model flag"). With `-o json` the catalogue is a
single-line JSON **array** whose entries are
`{id, llmId, displayName, description, category, defaultAllowed,
currentlyAllowed}` (`entrypoints/exec/handler.ts:458-461`,
`utils/toolCatalog.ts:138-169`). With any other format it is a text listing:
`Available tools for <model>`, `Autonomy: <autonomy>`, then category sections
with `  • <llmId> (<displayName>) - status: allowed|blocked[ override]`.
The categories this build declares are `Files` (`Read`, `Create`, `Edit`, `LS`),
`Search` (`Glob`, `Grep`), `Shell` (`Execute`) and `Tasks` (`TodoWrite`); a tool
that declares none is grouped under `Other`, which is also where an MCP tool
lands, because a server does not publish a category. Sections are ordered by
category name, entries by `llmId`
(`entrypoints/exec/handler.ts:449-535`). Under `stream-json`/`debug` the text
listing is used (`entrypoints/exec/handler.ts:800-809`). Selection warnings go
to stderr (`:810-812`).

### Exit codes

**B54.** `0` — the run's turn completed (completion reason `completed` or
`spec_handoff`), or `--list-tools`/`--help` finished
(`exec/sharedAgentRunner.ts:1526-1530`, `utils/agentTurnCompletion.ts:26-39`).

**B55.** `1` — any other outcome: invalid or conflicting flags, prompt-source
errors, authentication/model-policy refusals, provider errors, a turn that ended
on a denied or unapprovable permission, a cancelled turn, an unhandled
exception, a fatal JSON-RPC error, or startup failure
(`exec/sharedAgentRunner.ts:1526-1530`, `utils/command-wrapper.ts:99-106`,
`entrypoints/exec/run.ts:575-590`, `:670-679`).

**B56.** One-shot modes report a signal as `128 + signal number`: SIGINT →
`130`, SIGTERM → `143`. A signal outranks every turn outcome, including a
failed turn the signal itself cancelled
(`entrypoints/exec/handler.ts:955-957`, `utils/shutdownCoordinator.ts:85-88`,
`:433-444`, `exec/sharedAgentRunner.ts:1591-1597`).

**B57.** `--input-format stream-json` does not take signal exit codes: an
interrupted stream ends with `0` (B46), because the wrapper's signal path exits
`0` after cleanup (`entrypoints/exec/handler.ts:866-930`,
`utils/command-wrapper.ts:61-75`). The exit status of an interrupted ACP server
is owned by the daemon and is not specified here (Open question 3).

### Owed background work

**B58.** A one-shot run does not emit its `completion`/`result` or exit while
the session still owes background work: it drains it first, abandoning what does
not settle within the bound — 5 minutes of background-task idleness per task and
35 minutes per completion outcome, the latter overridable with
`DROIDE_ONE_SHOT_COMPLETION_OUTCOME_TIMEOUT_MS` — or immediately with the
respective reason when the main turn failed or permission was denied
(`exec/sharedAgentRunner.ts:1576-1600`, `exec/owedWork.ts:84-114`).

## Data & config

### CLI options consumed by this spec

| Flag                                                                                                                                                                                                                                                                           | Type / domain                                                     | Default          | Effect                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `[prompt]`                                                                                                                                                                                                                                                                     | string                                                            | —                | positional prompt (B4–B6)                                                                           |
| `-f, --file <path>`                                                                                                                                                                                                                                                            | path                                                              | —                | prompt from file (B2)                                                                               |
| `-o, --output-format <format>`                                                                                                                                                                                                                                                 | `text\|json\|stream-json\|stream-jsonrpc\|acp\|acp-daemon\|debug` | `text`           | output protocol (B18–B52)                                                                           |
| `--input-format <format>`                                                                                                                                                                                                                                                      | `stream-json\|stream-jsonrpc`                                     | —                | stdin protocol (B41–B51)                                                                            |
| `--auto <level>`                                                                                                                                                                                                                                                               | `low\|medium\|high`                                               | —                | autonomy level (B10)                                                                                |
| `--skip-permissions-unsafe`                                                                                                                                                                                                                                                    | boolean                                                           | false            | bypass confirmations (B11)                                                                          |
| `-s, --session-id <id>`                                                                                                                                                                                                                                                        | session id                                                        | —                | continue a session (B35)                                                                            |
| `--fork <id>`                                                                                                                                                                                                                                                                  | session id                                                        | —                | fork a session (B36)                                                                                |
| `-m, --model <id>`                                                                                                                                                                                                                                                             | model id / alias                                                  | settings default | session model                                                                                       |
| `-r, --reasoning-effort <level>`                                                                                                                                                                                                                                               | per model                                                         | per model        | session effort                                                                                      |
| `--use-spec`, `--spec-model`, `--spec-reasoning-effort`                                                                                                                                                                                                                        | —                                                                 | —                | spec mode (B8, B38)                                                                                 |
| `--disable-builtin-skills`                                                                                                                                                                                                                                                     | boolean                                                           | false            | refused in ACP (B52)                                                                                |
| `--list-tools`                                                                                                                                                                                                                                                                 | boolean                                                           | false            | catalogue and exit (B53)                                                                            |
| `--cwd <path>`, `-w/--worktree [name]`                                                                                                                                                                                                                                         | path / name                                                       | —                | run directory; mutually exclusive with each other                                                   |
| `--tag <spec>`                                                                                                                                                                                                                                                                 | repeatable name or JSON                                           | —                | session tags                                                                                        |
| `--mission`, `--worker-*`, `--validator-*`                                                                                                                                                                                                                                     | —                                                                 | —                | mission mode (B17)                                                                                  |
| `--append-system-prompt[-file]`, `--settings`                                                                                                                                                                                                                                  | text / path                                                       | —                | prompt/settings overlays                                                                            |
| `--only-tools`, `--add-tools`, `--remove-tools`                                                                                                                                                                                                                                | tool id list                                                      | —                | tool selection (tool-registry spec); visible in `exec --help`                                       |
| `--init-session-id`, `--calling-session-id`, `--calling-tool-use-id`, `--session-title`, `--depth`, `--request-id`, `--log-group-id`, `--tool-execution-mode`, `--allow-subagents-in-scripts`, `--enabled-tools`, `--additional-tools`, `--disabled-tools`, `--restrict-tools` | —                                                                 | —                | internal / delegated-run plumbing, hidden from `exec --help` (`entrypoints/exec/command.ts:60-230`) |

`--output-format` values are the `ExecOutputFormat` enum
(`packages/sdk-core/src/protocol/shared/enums.ts:134-143`); `--input-format`
values are `ExecInputFormat` (`:128-132`). Any other value is refused with
`Invalid --output-format value` / the input-format message and exit `1`
(`entrypoints/exec/assertValidOptions.ts:84-94`, `:274-281`).

### Environment

| Variable                                        | Used for                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DROIDE_API_KEY`                                | managed models; an unauthenticated managed run fails with the auth message (B55)                               |
| `DROIDE_ONE_SHOT_COMPLETION_OUTCOME_TIMEOUT_MS` | owed-work bound (B58)                                                                                          |
| `DROIDE_EXEC_ORIGINAL_INVOCATION`               | `0` marks a daemon-spawned worker, which suppresses origin attribution (`entrypoints/exec/handler.ts:619-632`) |
| `DROIDE_HOME_OVERRIDE`, `DROIDE_ENV`            | choose the `.droide` vs `.droide-dev` log directory (B33)                                                      |
| `FORCE_COLOR`, `NO_COLOR`                       | set to `0`/`1` by exec itself when stdout is not a TTY (B33)                                                   |

### Files

- `-f/--file` is read relative to the run's working directory (after `--cwd`)
  (`entrypoints/exec/handler.ts:211-213`).
- Console chatter: `<home>/.droide/logs/console.log`
  (`utils/patch-console.ts:12-16`, `:65-80`).
- `--settings <path>` merges a runtime settings file for this process only;
  exec never writes `~/.droide/settings.json` as a side effect of configuration
  (`entrypoints/exec/run.ts:279-292`).

## Errors

| Trigger                               | Identity (stdout/stderr)                                                                                                                                                                          | Exit                               | State after                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| Unknown option                        | Commander usage error on stderr                                                                                                                                                                   | 1                                  | nothing created (`cli.ts:480`, `:583-590`)                                         |
| Invalid/conflicting flags             | red `Invalid flags: …` on stderr                                                                                                                                                                  | 1                                  | nothing created; `run.ts` marks startup failed (`entrypoints/exec/run.ts:575-590`) |
| Bad `-f` file                         | `Prompt file not found: <path>` / `Prompt file is empty: <path>` / permission text                                                                                                                | 1                                  | no session                                                                         |
| Empty stdin                           | `No prompt received on stdin (the input was empty). …`                                                                                                                                            | 1                                  | no session                                                                         |
| No prompt                             | `No prompt provided. Usage:`                                                                                                                                                                      | 1                                  | no session                                                                         |
| Denied Execute/Script/MCP call        | assistant text `Exec ended early: insufficient permission to proceed. <guidance>`; text mode prints it on stderr as `Error during droide execution: …`, stream-json closes with an `error` record | 1                                  | turn and session persisted; retry with higher `--auto`                             |
| Provider/model failure                | `error` record (stream-json) or `Error during droide execution: <diagnostic>`                                                                                                                     | 1                                  | partial transcript persisted; retry is a new turn                                  |
| Unauthenticated managed run           | auth message as the run's final text                                                                                                                                                              | 1                                  | no model call                                                                      |
| Turn cancelled without a signal       | none added                                                                                                                                                                                        | 1                                  | turn persisted as cancelled                                                        |
| SIGINT / SIGTERM (one-shot modes)     | none added                                                                                                                                                                                        | 130 / 143 (B56)                    | turn persisted as cancelled                                                        |
| SIGINT (`--input-format stream-json`) | final `error` record `Streaming session interrupted by user`                                                                                                                                      | 0                                  | stream closed, no further records                                                  |
| Fatal JSON-RPC error                  | process teardown                                                                                                                                                                                  | 1                                  | server stops                                                                       |
| Closed stdout pipe                    | none                                                                                                                                                                                              | 0 if the result was already chosen | run unaffected                                                                     |

Validation errors (flags, prompt sources) are reported **once**, on stderr,
before any model or session work; a retry with corrected flags is always safe.
Model/provider failures happen after the session exists and leave a persisted
transcript.

## Acceptance tests

All tests run offline against a scripted mock provider and a temporary
`DROIDE_HOME_OVERRIDE`. Fixtures are synthesised. The mock is a local HTTP
server (127.0.0.1, ephemeral port) serving the OpenAI-compatible
`POST /v1/chat/completions` streaming dialect, referenced by a `custom:` model in
a fixture `settings.json` whose `general.customModels[]` entry is
`{"id":"mock","model":"mock-1","provider":"openai","baseUrl":"http://127.0.0.1:<port>/v1","apiKey":"test"}`
(`packages/sdk-core/src/protocol/settings/schema.ts:366-395`,
`:586-608`). Each fixture scripts the exact assistant turns, including
`tool_calls`, so no network or model variance exists.

Normalisation applied to every stream-json fixture comparison:
`timestamp`, `durationMs` and `usage.ttft_ms` → `0`; `session_id` → `"<sid>"`;
`cwd` → `"<cwd>"`; `tools` sorted; `tool_result.value` → `"<tool-output>"`.
Everything else — record kind, order, key names and other values — is compared
exactly. `-o json` fixtures normalise `duration_ms` → `0` and `session_id` →
`"<sid>"`.

| Clause                            | Test id                                               | Fixture                                                         |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| B1                                | `tests/exec/test_help_and_unknown_option`             | none                                                            |
| B2                                | `tests/exec/test_prompt_from_file`                    | `fixtures/exec/prompt.md`, `fixtures/exec/empty.md`             |
| B3, B6                            | `tests/exec/test_prompt_sources`                      | `fixtures/exec/echo.json`                                       |
| B4, B5                            | `tests/exec/test_prompt_source_conflicts`             | `fixtures/exec/prompt.md`                                       |
| B7                                | `tests/exec/test_streaming_rejects_prompt`            | none                                                            |
| B8, B9                            | `tests/exec/test_default_read_only_tools`             | `fixtures/exec/settings.json`                                   |
| B10, B11, B12                     | `tests/exec/test_autonomy_flags`                      | `fixtures/exec/settings.json`, `fixtures/exec/managed-max.json` |
| B13–B15                           | `tests/exec/test_permission_denied_exit`              | `fixtures/exec/wants_shell.json`                                |
| B16                               | `tests/exec/test_delegated_auto_reject`               | `fixtures/exec/delegated.json`                                  |
| B17                               | `tests/exec/test_mission_flag_conflicts`              | none                                                            |
| B18, B19                          | `tests/exec/test_text_output`                         | `fixtures/exec/one_turn_text.json`                              |
| B20                               | `tests/exec/test_text_output_error`                   | `fixtures/exec/provider_error.json`                             |
| B21, B23                          | `tests/exec/test_json_summary_success`                | `fixtures/exec/one_turn_tools.json`                             |
| B22                               | `tests/exec/test_json_summary_failure`                | `fixtures/exec/provider_error.json`                             |
| B24, B25, B26, B27, B29, B30, B31 | `tests/exec/test_stream_json_one_turn_tool_call`      | `fixtures/exec/one_turn_tools.json`                             |
| B28                               | `tests/exec/test_stream_json_progress_update`         | `fixtures/exec/progress_update.json`                            |
| B32                               | `tests/exec/test_stream_json_error_close`             | `fixtures/exec/provider_error.json`                             |
| B33, B34                          | `tests/exec/test_stdout_purity_and_broken_pipe`       | `fixtures/exec/one_turn_tools.json`                             |
| B35                               | `tests/exec/test_session_continue`                    | `fixtures/exec/two_sessions.json`                               |
| B36, B37, B38                     | `tests/exec/test_session_fork_and_conflicts`          | `fixtures/exec/two_sessions.json`                               |
| B39                               | `tests/exec/test_session_id_visibility`               | `fixtures/exec/one_turn_text.json`                              |
| B40, B42, B44, B45, B47           | `tests/exec/test_input_stream_json_multi_turn`        | `fixtures/exec/stream_input.jsonl`                              |
| B41                               | `tests/exec/test_stream_json_input_requires_output`   | none                                                            |
| B43, B46                          | `tests/exec/test_input_stream_json_errors_and_sigint` | `fixtures/exec/stream_input_bad.jsonl`                          |
| B48–B52                           | `tests/exec/test_protocol_mode_boundaries`            | none                                                            |
| B53                               | `tests/exec/test_list_tools`                          | `fixtures/exec/settings.json`                                   |
| B54, B55                          | `tests/exec/test_exit_codes`                          | `fixtures/exec/*.json`                                          |
| B56, B57                          | `tests/exec/test_signal_exit_codes`                   | `fixtures/exec/slow_turn.json`                                  |
| B58                               | `tests/exec/test_owed_work_drain`                     | `fixtures/exec/background_task.json`                            |

### `tests/exec/test_stream_json_one_turn_tool_call`

Invocation (cwd a temp dir containing `fixture.txt` with the single line
`hello fixture`):

```
droide exec --output-format stream-json --model custom:mock "read fixture.txt" < /dev/null
```

Mock script: turn 1 = one assistant message whose content is a `tool_calls`
entry `Read` with `{"file_path":"fixture.txt"}` and no text; turn 2 = assistant
text `Done.`.

Expected normalised stdout, in this order, one record per line, nothing else:

```
{"type":"system","subtype":"init","cwd":"<cwd>","session_id":"<sid>","tools":[…,"Read",…],"model":"custom:mock","reasoning_effort":"<effort>"}
{"type":"message","role":"user","id":"<uuid>","text":"read fixture.txt","timestamp":0,"session_id":"<sid>"}
{"type":"tool_call","id":"<tool-use-id>","messageId":"<uuid>","toolId":"Read","toolName":"Read","parameters":{"file_path":"fixture.txt"},"timestamp":0,"session_id":"<sid>"}
{"type":"tool_result","id":"<tool-use-id>","messageId":"<uuid>","toolId":"Read","isError":false,"value":"<tool-output>","timestamp":0,"session_id":"<sid>"}
{"type":"message","role":"assistant","id":"<uuid>","text":"Done.","timestamp":0,"session_id":"<sid>"}
{"type":"completion","finalText":"Done.","numTurns":2,"durationMs":0,"session_id":"<sid>","timestamp":0,"usage":{"input_tokens":<n>,"output_tokens":<n>,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"droide_credits":0,"thinking_tokens":0}}
```

Assertions: `reasoning_effort` is the non-empty effort the session resolved
(the fixture pins the model's effort, so the test compares it exactly); exactly
three UUID-shaped ids repeat consistently
(`message.id` ↔ `tool_call.messageId`/`tool_result.messageId`;
`tool_call.id` = `tool_result.id`); `session_id` identical on all records;
`Read` ∈ `tools`; no `error` record; exit code `0`; stderr contains no records.

### `tests/exec/test_exit_codes`

Four invocations, same mock harness, `settings.json` fixture, stdin
`/dev/null`:

| Scenario          | Invocation                                                                             | Fixture script                                                         | Expected stdout                                               | Expected stderr                                                                                                                                                                           | Exit |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| success           | `droide exec --model custom:mock "say hi"`                                             | assistant text `hi`                                                    | `hi\n`                                                        | empty                                                                                                                                                                                     | 0    |
| denied permission | `droide exec --auto low --model custom:mock "delete it"`                               | assistant `tool_calls` → `Execute` with `{"command":"rm -rf ./build"}` | empty                                                         | `Error during droide execution: Exec ended early: insufficient permission to proceed. Re-run with --auto medium or --auto high. For destructive commands, use --skip-permissions-unsafe.` | 1    |
| provider error    | `droide exec --model custom:mock "say hi"`                                             | server returns HTTP 500 on turn 1                                      | empty                                                         | `Error during droide execution: <provider diagnostic>`                                                                                                                                    | 1    |
| cancelled         | `droide exec --model custom:mock "say hi"`, SIGINT sent once the first token is served | assistant stream never completes                                       | empty (or the partial text, if the turn had already answered) | —                                                                                                                                                                                         | 130  |

The denied-permission case must reach a _confirmation_ rather than a
tool-availability refusal: `--auto low` makes every tool selectable, and an
`Execute` command above the low risk band is then auto-denied, taking B14's
immediate exit. (Without `--auto` the same call would be filtered as
unavailable before confirmation and never reach B14.) A `Read`-only mock must
assert exit `0` with the tool result present.

### `tests/exec/test_json_summary_success`

`droide exec -o json --model custom:mock "say hi" < /dev/null` prints exactly one
line, parses as one object with keys
`type,subtype,is_error,duration_ms,num_turns,result,session_id,usage`,
`type:"result"`, `subtype:"success"`, `is_error:false`, `result:"hi"`,
`num_turns:1`, exit `0`, no other stdout byte.

### `tests/exec/test_input_stream_json_multi_turn`

Piping `fixtures/exec/stream_input.jsonl` (`{"role":"user","content":"one"}` then
`{"role":"user","content":"two"}`) into
`droide exec --input-format stream-json --output-format stream-json --model custom:mock`
yields: one `system/init`; then for message "one" the user echo, the assistant
text and one `completion`; then for message "two" the same three records under
the same `session_id`; then EOF and exit `0`. The stderr starts with the
deprecation warning (B41).

## Evidence

| Evidence             | Supports                                            | Method                                                                                                                                 |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ev_exec_cmd_1`      | B1, B10, B11, B35–B38, option table                 | read `entrypoints/exec/command.ts:47-230`                                                                                              |
| `ev_exec_help_1`     | B1, B9, B35, B53                                    | read `entrypoints/exec/help.ts:100-303` and `tests/parity/expected/help-exec.json`                                                     |
| `ev_exec_prompt_1`   | B2–B6                                               | read `entrypoints/exec/handler.ts:177-244`, `:325-384`                                                                                 |
| `ev_exec_validate_1` | B7, B10, B37, B38, B41, B48, B51, B52               | read `entrypoints/exec/assertValidOptions.ts:71-315`, `:354-367`                                                                       |
| `ev_exec_validate_2` | B7, B55                                             | read `entrypoints/exec/run.ts:575-590`                                                                                                 |
| `ev_exec_autonomy_1` | B8, B10, B12                                        | read `commands/resolveToolSelection.ts:316-322`, `:677-689`; `services/SessionService.ts:777-781`                                      |
| `ev_exec_perm_1`     | B13–B15                                             | read `core/ToolExecutor.ts:840-861`, `:1056-1129`                                                                                      |
| `ev_exec_perm_2`     | B14, B55                                            | read `core/AgentLoop.ts:7667-7700`; `exec/sharedAgentRunner.ts:241-268`, `:1526-1530`                                                  |
| `ev_exec_perm_3`     | B16                                                 | read `entrypoints/exec/handler.ts:1150-1160`; `exec/renderlessExecRunner.ts:176-200`                                                   |
| `ev_exec_out_1`      | B18–B23, B53                                        | read `entrypoints/exec/handler.ts:246-284`, `:449-573`, `:800-814`; `exec/exec-summary.ts:4-40`                                        |
| `ev_exec_out_2`      | B21, B22 literal `"result"`/`"success"`/`"failure"` | grep of shipped locale/exec chunk `evidence/extracted/windows-x64/chunk-sm0347rw.js` **[derived]**                                     |
| `ev_exec_stream_1`   | B24–B34                                             | read `exec/streamJsonEventHelpers.ts:41-248`                                                                                           |
| `ev_exec_stream_2`   | B25, B26, B32                                       | read `entrypoints/exec/handler.ts:1194-1227`, `:1294-1323`                                                                             |
| `ev_exec_stream_3`   | B25, B33, B34, B39                                  | read `utils/safeStdoutWrite.ts:17-31`; `entrypoints/exec/run.ts:183-197`                                                               |
| `ev_exec_session_1`  | B35, B36, B39                                       | read `entrypoints/exec/handler.ts:1052-1180`                                                                                           |
| `ev_exec_input_1`    | B40–B47                                             | read `exec/streamingExecRunner.ts:53-355`                                                                                              |
| `ev_exec_rpc_1`      | B48–B51                                             | read `entrypoints/exec/constants.ts:14-53`; `entrypoints/exec/handler.ts:311-323`, `:933-982`; `exec/runStreamingJsonRpcExec.ts:20-88` |
| `ev_exec_rpc_2`      | B49, B50                                            | read `exec/wire/StdioWire.ts:70-250`                                                                                                   |
| `ev_exec_acp_1`      | B52                                                 | read `entrypoints/exec/handler.ts:821-833`                                                                                             |
| `ev_exec_exit_1`     | B54–B57                                             | read `utils/command-wrapper.ts:61-110`; `utils/shutdownCoordinator.ts:85-88`, `:433-444`; `utils/agentTurnCompletion.ts:26-52`         |
| `ev_exec_owed_1`     | B58                                                 | read `exec/owedWork.ts:84-114`; `exec/sharedAgentRunner.ts:1576-1600`                                                                  |
| `ev_exec_console_1`  | B33                                                 | read `utils/patch-console.ts:1-80`; `utils/command-wrapper.ts:12-24`                                                                   |
| `ev_exec_catalog_1`  | B53                                                 | read `utils/toolCatalog.ts:138-169`                                                                                                    |
| `ev_exec_model_1`    | Acceptance fixtures (`custom:` model shape)         | read `packages/sdk-core/src/protocol/settings/schema.ts:366-395`, `:586-608`                                                           |

## Open questions

1. **`ExecEvent` union declaration.** `src/exec/types.ts` and `src/exec/enums.ts`
   were type-only modules elided by the bundler, so B25's seven record kinds are
   reconstructed from every constructor/consumer site rather than from one type
   declaration. A future event kind added elsewhere would be missed. Settled by
   re-extracting the type modules from the source maps. No clause is blocked:
   the observed emitters are exhaustive in the recovered source.
2. **`stream-jsonrpc` notification catalogue.** The full set of JSON-RPC
   notifications (turn lifecycle, tool events, MCP status, permission requests)
   emitted by `JsonRpcStreamingExecRunner` is not specified here (B48–B51 cover
   only the boundary). Settled by a dedicated `jsonrpc-streaming.md` reading
   `exec/streamingJsonRpcExecRunner.ts` and
   `packages/sdk-core/src/protocol/agent`. Blocks implementation of the
   JSON-RPC payloads, not of exec.
3. **ACP exit codes and lifetime.** `runAcpDaemon` owns exit status after B52;
   the codes are unknown at this slice. Settled by an `acp-server.md`.
4. **Exact `usage.ttft_ms` rounding.** B23 states presence only; the value's
   rounding/units (integer ms?) is set by `sessionService.getMeanTimeToFirstTokenMs`
   and not verified here. Settled by reading that accessor. Does not block; the
   acceptance tests mask the value.
5. **ANSI colour on a TTY.** B20/B14 texts are produced through `chalk`, so on a
   TTY the stderr line carries escape codes. The spec pins the plain text; the
   exact colour codes are not contractual. Settled by deciding (as a design
   choice) that a conforming build must emit the same plain text and may colour
   it.
6. **Windows signal mapping.** B56 uses `os.constants.signals`; on Windows only
   SIGINT/SIGTERM-equivalent delivery exists, so `droide exec` may observe fewer
   signal kinds than on POSIX. Settled by a Windows-specific recorded case.
   Only the two documented codes are contractual.

## Clean-room notes

**Must reproduce (the contract).**

- `droide exec [options] [prompt]`, the option names and defaults in the table
  above, the four validation refusals of B7/B37/B38/B48/B51, and the
  `--file` > stdin > argv precedence with its conflict and no-prompt errors.
- Default autonomy = auto/low with the read-only tool base; `--auto` widening to
  all tools; `--skip-permissions-unsafe` bypassing confirmations at the
  organization's maximum; the mutually-exclusive checks.
- The non-interactive permission rule: auto-deny, and end the turn with
  `Exec ended early: insufficient permission to proceed. <guidance>` when the
  denied call is shell/script/MCP, exit `1`; otherwise fail only that tool.
- The four output modes' byte-level shape: `text` = final answer + `\n`;
  `json` = one object with exactly the eight keys (B21) and a `usage` of six
  counters plus optional `ttft_ms`; `stream-json` = the seven record kinds,
  their exact key names and casing (`session_id`, `finalText`, `numTurns`, `durationMs`,
  `isError`, `toolName`, `messageId`), one record per line, `system/init` first,
  one `completion` last on success, an `error` instead on failure.
- Ordering within a message (B27), the progress-update special case (B28), the
  trimmed user echo (B29), `toolId:""` for unknown calls (B30), and verbatim
  tool output with the `placeholder` substitution for images (B31).
- `--input-format stream-json`'s record shape, serial processing, per-message
  completion-or-error, deprecation warning, and "close runs everything, SIGINT
  emits one final error record then exits 0".
- Session continuation and forking as observable through `session_id`, plus the
  rule that `-s` replays nothing on stdout.
- Exit codes `0`, `1`, `130`/`143` and their precedence (a signal outranks a
  turn outcome; the `--input-format stream-json` mode reports `0` instead).
- Stdout purity, console redirection, and broken-pipe tolerance.
- One-shot owed-work draining before the terminal record.

**Explicitly not part of the contract.**

- Internal module layout, the `JsonRpcStreamingExecRunner`, ACP internals, the
  full JSON-RPC payload catalogue, event-bus implementation, tool implementations
  and their output formatting, and the session file format.
- Wall-clock values (`timestamp`, `durationMs`, `duration_ms`, `ttft_ms`),
  generated UUIDs and session-id values.
- ANSI colouring of stderr messages, log-file contents, telemetry, worktree
  management, MCP startup, and mission-mode orchestration.
- The hidden internal flags beyond their validation effects.
- Exact rendered text of provider diagnostics (provider-owned), and the
  `--list-tools` section ordering beyond the documented categories.

### Recorded derivation: `--list-tools` fields

B53 pins both renderings and the seven JSON fields. One field needs a derivation
of ours: `defaultAllowed`. The clause names it but not its source, so this build
defines it as **catalogue membership at the strictest autonomy (`off`)**; a row
whose `defaultAllowed` differs from `currentlyAllowed` is printed with the
` override` suffix.

Category names were not recovered: every built-in declares `Other` until a
category name is pinned, and `ToolDefinition.category` is optional so a real
name is a one-line change per tool. Placement before any prompt, session or
socket stays contractual (`TODO(spec B53)` records the one open derivation).
