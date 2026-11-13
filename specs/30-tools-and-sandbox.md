# Tools and sandbox

- **Target:** the `droide` CLI shipped from this repository
- **Status:** draft
- **Owner:** tools / sandbox
- **Related:** `10-cli-surface.md` (flags, exit codes), `20-agent-loop.md` (dispatch,
  confirmation plumbing, hooks), `40-sessions-and-daemon.md` (session store that
  `SearchSessions` reads), `50-mcp.md` (server lifecycle), `60-permissions.md` if a
  separate permission-rules spec exists

## Purpose

This subsystem is the agent's only way to touch the world: a registry of tool
definitions the model can call, the executors that perform file, search, shell,
web, task and MCP operations, and the two gates in front of them — the
autonomy/risk decision and the sandbox. A user observes it as "what the agent is
allowed to do", as concrete file/process effects, and as refusal text when a call
is denied.

## Scope

Covers: the tool registry and definition metadata; the input/output schemas of
every built-in tool reachable in the recorded release; which tools are advertised to the model,
deferred behind `ToolSearch`, or internal; the permission decision for mutating
calls; the filesystem and shell execution model; and `src/sandbox/**`, including
the platform confinement layers and `apply-seccomp`.

Does not cover: the LLM provider wire format or how tool schemas are rendered per
provider (`20-agent-loop.md`); hook execution and their `permissionDecision`
(`src/services/HookService.ts`, `20-agent-loop.md`); MCP server transport and
lifecycle (`50-mcp.md`); the `AskUser`/`ExitSpecMode` UI (`70-ui.md`); settings
merge precedence beyond the keys named here (`80-settings.md`); permission-rule
compilation beyond its tool-facing effect (`src/services/commandPolicy.ts`).

Deferred deliberately: the daemon-side (`packages/daemon-core`) tool surface and
the desktop-app-only tool sets, because they are registered outside the CLI
registry (`@`McpService`and`src/tools/tui.ts` are the CLI's complete set).

## Terms

- **llmId** — the model-facing tool name (`Read`, `Execute`, `mcp__…`-mapped
  `<server>___<tool>`). Constants live in `sdk-core/protocol/tools`.
- **tool id** — the registry key (`read-cli`, `execute-cli`); one llmId may have
  several ids (`@packages/core/src/tools/registry.ts:83`).
- **deferred tool** — a tool whose schema is not in the turn's catalog until
  `ToolSearch` loads it (`deferred: true`).
- **side effect** — declared sandbox class of a tool: `filesystem-read`,
  `filesystem-write`, `network`, `process`, `external-service`,
  `persistent-settings` (`@packages/core/src/tools/enums.ts:10-17`).
- **autonomy level** — `off | low | medium | high`
  (`@packages/sdk-core/src/protocol/shared/enums.ts:22-27`). Selected by
  `--auto <level>`; `--skip-permissions-unsafe` sets a confirmation bypass instead.
- **risk level** — the model's declared `low | medium | high` impact of an
  `Execute` command; invalid or missing parses to `high`
  (`@packages/core/src/tools/utils/risk-level.ts:23-35`).
- **workspace root** — the agent working directory (`getAgentWorkingDirectory()`),
  the base for relative paths and the default search root. Not a jail: file tools
  accept absolute paths anywhere, subject to the gates below.
- **sandbox** — two layers: application-level policy checks in
  `SandboxManager` (vendor prefix elided), and OS-level confinement through
  `@anthropic-ai/sandbox-runtime` (SRT).
- **per-command mode** — each `Execute` command is wrapped individually
  (`SandboxMode.PerCommand`); **whole-process mode** — the CLI re-execs itself
  under the OS sandbox for its whole lifetime (`SandboxMode.WholeProcess`)
  (`@packages/sdk-core/src/protocol/settings/enums.ts:27-30`).
- **deny floor** — non-overridable deny entries the manager adds itself:
  credential files (read+write) and trusted/executable config (write)
  (`@src/sandbox/SandboxManager.ts:262-284`, `:333-345`).
- **`@path:line` citation** — shorthand in this spec for
  `evidence/original/windows-x64/<path>:<line>`.

## Tool inventory

`advertised` = reachable by the model in a normal session (`deferred` = only after
`ToolSearch`); `user` = offered in UI tool selection; `confirm` = declared
`requiresConfirmation` (metadata, see B41); effects per B1. Output is the declared
result schema unless noted.

| llmId                                                                                                                                      | id                          | advertised                 | user | confirm             | effects                     | output                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------------------- | ---- | ------------------- | --------------------------- | ------------------------------------------------------------ |
| `Read`                                                                                                                                     | `read-cli`                  | yes                        | no   | no                  | fs-read                     | string \| ImageBlock \| blocks                               |
| `LS`                                                                                                                                       | `ls-cli`                    | yes                        | no   | no                  | fs-read                     | `{name,type,size}[]`                                         |
| `Glob`                                                                                                                                     | `glob-search-cli`           | yes                        | yes  | no                  | fs-read                     | absolute paths                                               |
| `Grep`                                                                                                                                     | `grep_tool_cli`             | yes                        | yes  | no                  | fs-read                     | paths \| `{path,line,text,kind}[]`                           |
| `Create`                                                                                                                                   | `create-cli`                | yes                        | no   | no                  | fs-write                    | `{success,file_path}` \| diff                                |
| `Edit`                                                                                                                                     | `edit-cli`                  | yes                        | no   | no                  | fs-read, fs-write           | line diff                                                    |
| `ApplyPatch`                                                                                                                               | `apply-patch-cli`           | yes                        | no   | no                  | fs-read, fs-write           | string                                                       |
| `Execute`                                                                                                                                  | `execute-cli`               | yes                        | no   | no                  | process                     | `{output,exitCode,signal,stoppedProcesses,pid?,outputFile?}` |
| `Script`                                                                                                                                   | `script-cli`                | yes                        | no   | no                  | process                     | `ScriptRunResult`                                            |
| `WaitForScript`                                                                                                                            | `wait-for-script-cli`       | yes                        | no   | no                  | process                     | `ScriptWaitResult`                                           |
| `TodoWrite`                                                                                                                                | `todo_write`                | yes                        | no   | no                  | —                           | string                                                       |
| `Task`                                                                                                                                     | `task-cli`                  | yes (read-only exec: no)   | no   | no                  | process                     | string                                                       |
| `TaskOutput`                                                                                                                               | `task-output-cli`           | yes                        | no   | no                  | persistent-settings         | string                                                       |
| `TaskStop`                                                                                                                                 | `task-stop-cli`             | yes                        | no   | no                  | process                     | string                                                       |
| `Skill`                                                                                                                                    | `SKILL_CLI_TOOL_ID`         | yes                        | no   | no                  | fs-read                     | string                                                       |
| `ToolSearch`                                                                                                                               | `tool-search-cli`           | yes                        | no   | no                  | —                           | string                                                       |
| `StructuredOutput`                                                                                                                         | `structured-output-cli`     | gated                      | no   | no                  | —                           | string                                                       |
| `AskUser`                                                                                                                                  | ask-user id                 | yes                        | yes  | yes                 | —                           | answers                                                      |
| `ExitSpecMode`                                                                                                                             | `exit-spec-mode`            | spec mode                  | yes  | yes                 | fs-write                    | `{approved}`                                                 |
| `WebSearch`                                                                                                                                | `web_search`                | deferred                   | yes  | no                  | network                     | provider result union                                        |
| `FetchUrl`                                                                                                                                 | `fetch_url`                 | deferred                   | yes  | no                  | network                     | `{markdown,title,effectiveUrl,metadata,linkedUrls?}`         |
| `GenerateImage`                                                                                                                            | `generate-image`            | gated (image models)       | no   | no                  | network                     | image result                                                 |
| `DecisionModel`                                                                                                                            | `decision-model`            | flag `DecisionModels`      | yes  | no                  | network                     | decision result                                              |
| `ListSettings`                                                                                                                             | `list_settings`             | deferred                   | yes  | no                  | —                           | operation catalog                                            |
| `StageSettingsChanges`                                                                                                                     | `stage_settings_changes`    | deferred                   | yes  | no                  | —                           | staged-change result                                         |
| `SearchSessions`                                                                                                                           | `search-sessions-cli`       | flagged                    | yes  | no                  | fs-read, network            | string                                                       |
| `UpgradeSessionModel`                                                                                                                      | `upgrade-session-model-cli` | yes                        | no   | no                  | persistent-settings         | string                                                       |
| `ConnectApp`                                                                                                                               | connect-app id              | not airgapped, deferred    | yes  | no                  | external-service            | connect result                                               |
| `SlackPostFile`                                                                                                                            | slack id                    | explicit selection         | yes  | no                  | fs-read, external-service   | string                                                       |
| `SlackPostMessage`                                                                                                                         | slack id                    | explicit selection         | yes  | no                  | external-service            | string                                                       |
| `SlackCreateOrUpdateCodeChannel`                                                                                                           | slack id                    | explicit selection         | yes  | no                  | external-service            | string                                                       |
| `SlackArchiveCodeChannel`                                                                                                                  | slack id                    | explicit selection         | yes  | no                  | external-service            | string                                                       |
| `SlackListChannels`                                                                                                                        | slack id                    | explicit selection         | yes  | no                  | external-service            | string                                                       |
| `ListComputers` / `ListServiceAccounts`                                                                                                    | computers ids               | yes                        | yes  | no                  | —                           | list                                                         |
| `CreateAutomation`                                                                                                                         | automation id               | not airgapped              | yes  | yes                 | external-service            | automation                                                   |
| `ListAutomations` / `ReadAutomation` / `ListAutomationTemplates`                                                                           | automation ids              | not airgapped              | yes  | no                  | external-service            | list/record                                                  |
| `EditAutomation` / `DeleteAutomation` / `RunAutomation`                                                                                    | automation ids              | not airgapped              | yes  | see definition      | external-service            | record                                                       |
| `ReadAutomationFiles` / `EditAutomationFiles`                                                                                              | automation-file ids         | not airgapped              | yes  | no                  | fs-read(+write)             | file view / edit                                             |
| `SetAutomationRunOutcome`                                                                                                                  | automation outcome id       | not airgapped              | yes  | no                  | external-service            | string                                                       |
| `LinkWorkItem`                                                                                                                             | link-work id                | yes                        | yes  | no                  | external-service            | string                                                       |
| `SendInboxMessage`                                                                                                                         | inbox id                    | yes                        | yes  | yes                 | external-service            | string                                                       |
| `Loop`                                                                                                                                     | loop id                     | schedulable hosts          | yes  | no                  | external-service            | loop record                                                  |
| `ProposeMission` / `StartMissionRun` / `EndFeatureRun` / `DismissHandoffItems`                                                             | mission ids                 | mission mode               | yes  | ProposeMission yes  | fs/process per definition   | result                                                       |
| `SpawnAgent` / `ListAgents` / `SendMessage` / `InterruptAgent` / `RenameAgent` / `ArchiveAgent` / `CreateListener`                         | mission-v2 ids              | flag `MissionsV2`          | yes  | no                  | external-service            | result                                                       |
| `GenerateAgent`                                                                                                                            | `generate-agent-cli`        | yes                        | no   | no                  | external-service            | string                                                       |
| `GetAgentEffectivenessUsage` / `StoreAgentReadinessReport` / `RenderAgentEffectivenessReport`                                              | ids                         | command-gated              | no   | no                  | external-service / fs-write | report                                                       |
| `ListEvalRuns` / `ListDatasets` / `ReadDataset` / `ReadEvalRun` / `CreateEvalRun` / `ListEvalPresets` / `SaveEvalPreset` / `CreateDataset` | eval ids                    | flag `AutoEvalPipeline`    | yes  | no (create/run yes) | network/fs per definition   | eval records                                                 |
| `<server>___<tool>`                                                                                                                        | `mcp_<server>_<tool>`       | per server, maybe deferred | yes  | yes                 | external-service            | stringified result                                           |

Definitions: `@packages/core/src/tools/definitions/**`, registration
`@src/tools/tui.ts:200-570`, automation/mission/inbox ids
`@packages/core/src/tools/definitions/cli/automationCli.ts:29-35`,
`@packages/core/src/tools/definitions/cli/computersCli.ts:11-34`,
`@packages/core/src/tools/definitions/cli/linkWorkCli.ts:10`,
`@packages/core/src/tools/definitions/cli/sendInboxMessageCli.ts:11`,
`@packages/core/src/tools/definitions/cli/loopCli.ts:10`.

## Observable behaviour

### Registry and catalog

**B1 — Definition identity.** Every registered tool has a unique id and an llmId;
lookups by both exist, and several ids may share an llmId (registration order
decides which is returned first). Registration rejects a tool that omits
`sideEffects`, is not an array, or carries an unknown value, with
`Tool is missing sandbox side-effect metadata` /
`Tool has invalid sandbox side-effect metadata` (`@packages/core/src/tools/registry.ts:12-33`).

**B2 — Definition metadata is authoritative for names.** `displayName` comes from
the definition; the pre-hydration fallback map must mirror it. `createTool` derives
the model-facing JSON schema from the zod schema (or from `llmInputSchema` when the
model should see a narrower shape), sets `isMcpTool:false` and `source:'native'`,
and defaults output to the generic result schema
(`@packages/core/src/tools/create-tool.ts:23-56`).

**B3 — Catalog membership.** A turn advertises a tool only when it is registered,
enabled for the session (`isToolEnabled`), available for the active model, not
hidden, not excluded by `--only-tools`/`--remove-tools`, and either already loaded
or a deferred tool's loader. Deferred tools are advertised only through
`ToolSearch` (`@src/agent/tools.ts:1268-1312`, `@src/commands/resolveToolSelection.ts:316-323`).

**B4 — Two visibility axes.** `isTopLevelTool` = advertised to the model;
`isVisibleToUser` = shown in UI tool selection. File/shell tools are
model-facing but not user-selectable (`isVisibleToUser:false`), e.g. Read
(`@packages/core/src/tools/definitions/cli/readCli.ts:34-40`).

**B5 — Tool availability by autonomy (exec).** Without `--auto` or
`--skip-permissions-unsafe`, only the read-only set is advertised plus `Execute`,
`Script`, `WaitForScript`, `ToolSearch`, `Skill`; create/edit/apply-patch, `Task`,
Slack, readiness/effectiveness, session-model upgrade, image generation and mission
proposal tools are excluded. With either flag, all tool ids are admissible;
autonomy then governs only what `Execute` auto-approves
(`@src/exec/tool-groups.ts:69-117`, `@src/commands/resolveToolSelection.ts:316-323`).

**B6 — Internal tools.** `StructuredOutput`, `GenerateAgent`, tool-result and
report stores are registered but not user-selectable (`isVisibleToUser:false`);
they are still dispatchable when their gate is on
(`@packages/core/src/tools/definitions/cli/structuredOutput.ts:13-28`).

### Input validation

**B7 — Native tools are validated before execution.** A native call is checked
against its zod schema if one is attached, else against its JSON schema with Ajv
policy `{removeAdditional:true, useDefaults:true}`; MCP and connector tools are not
pre-validated because their servers validate their own arguments
(`@packages/core/src/tools/utils/constants.ts:21-25`,
`@src/agent/toolInputValidation.ts:74-84`).

**B8 — Validation failure text.** A rejected call returns an error result whose
text is the schema error followed by
`Tool "<toolId>" accepts the following parameters:` and one
`- <field>[ (required)]: <description>` line per property, ending
`Please retry with valid parameters.` (`@packages/core/src/tools/utils/validate-tool-parameters.ts:89-112`).

**B9 — Lenient fields.** `Execute`'s `summary`, `riskLevelReason`, `riskLevel` never
fail validation for a malformed value; a missing `riskLevel` is denied separately
with its own guidance (`@packages/core/src/tools/definitions/cli/schema.ts:1075-1090`,
`@src/agent/tools.ts:1629-1672`).

The denial this build prints for a missing `riskLevel` is fixed:
`Execute call rejected: missing required parameter "riskLevel". Declare the
command's impact as low, medium or high.` (`src/tools/shell/exec.ts`; regression:
`tests/unit/tools/exec.test.ts`). A malformed value of any of the three lenient
fields is accepted and ignored, never a refusal. `[observed]`

**B10 — Schema compile failure is not a refusal.** If a schema cannot compile, the
call proceeds and a once-per-tool warning is logged
(`@packages/core/src/tools/utils/validate-tool-parameters.ts:214-224`).

### Result budgets and truncation

**B11 — Two byte budgets.** A tool result is held to its declared
`modelResultBudgetBytes`, default 32 KiB (`MODEL_RESULT_BUDGET_BYTES`); content the
model asked for by name (Read, Task, TaskOutput, FetchUrl, Skill, `text()`) gets
64 KiB (`MODEL_TEXT_BUDGET_BYTES`) (`@packages/core/src/tools/utils/constants.ts:32-40`).

**B12 — Cut shape and the whole-output spill.** An over-budget result keeps its
head and tail around one notice, cut on UTF-8 code-point boundaries; the notice
is `[... <N> bytes cut from the middle of <M>; whole output: <where>]`. The
notice counts against the budget; if it cannot fit, only the notice is returned
(`@packages/core/src/tools/utils/large-output.ts:60-100`).

`Read` spills its whole result at the same threshold as the cut: a rendered
result — the selected lines plus any range/outline note — that fits the read
budget (B11's 64 KiB, or the budget the caller injects) is returned whole and
nothing is written. A result that would be cut is first written to
`<stateDir>/tool-outputs/<name>`, and `<where>` is that absolute path; the file
holds the exact UTF-8 bytes the cut counts describe (the whole result, not the
whole file). The name is content-addressed —
`<first 32 lowercase hex digits of the SHA-256 of the output>.txt` — so two
reads of the same output reuse one file and a notice stays valid across runs;
no session id and no timestamp in the name. The directory is created on first
use with mode `0700`; the file is written through a temp file and a rename with
mode `0600`, so nothing world-readable appears, and a concurrent identical read
finds the existing file and reuses it. The spill is capped at 32 MiB of UTF-8
(`MAX_INLINE_OUTPUT_BYTES`, B13). Nothing else is written and no older spill is
deleted. When the output exceeds the cap, the directory cannot be created or
written, or the rename fails, the call still succeeds with the cut and
`<where>` falls back to `<file_path> (read it with offset and limit)`
(`@src/tools/fs/spill.ts:1-111`, `:86-108`).

**B13 — Oversized program results are refused, not cut.** Inside `Script`, a nested
result over 32 MiB of text, or 32 MiB of JSON when it is many small records, is
rejected with a remedy instead of being truncated (`@packages/core/src/tools/definitions/cli/script/schema.ts:36-40`,
`@src/tools/executors/client/execute-cli.ts:286-303`).

### File tools

**B14 — `Read` input.** `file_path` (string, required, must be absolute);
`offset` (number, default 1, 1-based; negative counts from the end);
`limit` (number, default 2400, must be > 0; non-finite for program reads);
`line_numbers` (boolean, default false → each line rendered `N→text`);
`image_quality` (`default|high`, default `default`)
(`@packages/core/src/tools/definitions/cli/schema.ts:81-111`).

**B15 — `Read` text result.** A file of ≤200 lines is returned whole. A longer
file with no range parameter opens as a numbered outline when 8+ declaration lines
are recognised and they are ≤40% of the file; otherwise the whole file. Either way
an over-budget read is cut per B12. A ranged read appends
`[Showing lines <a>-<b> of <n> total lines]`; an outline appends
`[Outline: <k> declaration lines of <n>; files over 200
lines open as an outline. Read with offset (and limit) for the lines you need]`
(`@src/utils/truncate.ts:19-63`, `:67-137`).

**B16 — `Read` encodings and large files.** Encoding is detected from a BOM
(UTF-16LE, UTF-16BE) else from a BOM-less UTF-16 NUL-pattern heuristic, else UTF-8;
legacy charsets are detected only when the buffer is not valid UTF-8. Content is
returned LF-normalised with the BOM stripped. A text file over 8 MiB is scanned in
chunks and only the requested lines plus scrub context are loaded; a read whose
window would exceed 5 MiB of loaded lines is refused with a request for fewer
lines. UTF-16 text that large is refused with a conversion instruction
(`@packages/core/src/tools/utils/file-encoding.ts:1-20`, `:40-190`,
`@src/tools/executors/client/read-cli.ts:72-95`, `:214-270`).

**B17 — `Read` media.** A PNG or JPEG is returned as one image block: the file's
bytes base64-encoded, its media type (`image/png` or `image/jpeg`), and a
one-line text part `Read of <path>: <media type>, <n> bytes` where `n` is the
file's byte length. The decoded-byte ceiling is 3 MiB (3145728 bytes): 3 MiB of
image encodes to 4 MiB of base64, inside the 5 MB per-image base64 ceiling
providers apply and ACP's 8 MiB frame, while a turn-attachment-sized 5 MiB image
would exceed both. An image over the ceiling is refused before its bytes are
read, with a message naming the ceiling and pointing at Execute. A GIF and a PDF
are refused with `Read of <path>: <kind> content is not supported by this build;
supported media are PNG and JPEG images up to 3 MiB. Use Execute to convert it
to text.` where `<kind>` is `image/gif` or `PDF`. A file with no recognised
media signature stays on the text path (B15/B16), so other binary formats are
still decoded as text, exactly as before. `image_quality` is accepted and does
not change the bytes returned; a GIF's first frame and PDF text extraction are
not implemented (`src/tools/fs/read.ts`). `[observed]`

**B18 — `LS`.** Input `directory_path` (absolute; omitted or `.` = workspace root)
and `ignorePatterns` (glob names). Entries are sorted by name, without `.`/`..`,
each with `name`, `type` (`file|directory|symlink|other` from `lstat`) and `size`.
Denied entries are concealed when the sandbox is on, and the listing is refused
rather than shown unfiltered when entries cannot be enumerated
(`@packages/core/src/tools/definitions/cli/schema.ts:827-865`,
`@src/tools/executors/client/ls-cli.ts:140-250`).

**B19 — `Glob`.** `patterns` (string or string[]), `excludePatterns`, `folder`
(absolute). Runs embedded ripgrep `--files --hidden` with include globs, excludes,
then allowRead re-includes, then the credential-floor excludes last; at most 1000
paths. Missing/non-directory root and an empty pattern list are errors; an empty
match is `No matching files found`. Program reads receive absolute paths, users a
newline-joined list (`@packages/core/src/tools/definitions/cli/globSearchCli.ts:14-29`,
`@src/tools/executors/client/glob-search-cli.ts:29-233`).

**B20 — `Grep`.** Input as in `grepSearchCliToolSchema`: `pattern`, `path`, `glob_pattern`,
`output_mode` (`file_paths` default, `content`), `case_insensitive`, `type`,
`context_before/after/context`, `line_numbers`, `head_limit`, `multiline`,
`fixed_string`. The executor adds `--engine auto`, auto-enables multiline for a
pattern containing a newline, and in content mode limits per-file matches
(`--max-count`) to `head_limit`, or 500 when none was given, or 1 for a
non-positive limit. No match yields `No matching files found` / `No matches found`.
The `type` filter accepts these names, each mapping to the listed extensions:
`js` (`.js .mjs .cjs .jsx`), `ts` (`.ts .mts .cts .tsx`), `py` (`.py .pyi`),
`rust` (`.rs`), `go` (`.go`), `java` (`.java`), `cpp`
(`.cpp .cc .cxx .hpp .hh .hxx`), `c` (`.c .h`), `csharp` (`.cs`), `ruby`
(`.rb`), `php` (`.php`), `shell` (`.sh .bash .zsh`), `html` (`.html .htm`),
`css` (`.css .scss .sass`), `json` (`.json .jsonc`), `yaml` (`.yaml .yml`),
`toml` (`.toml`), `md` (`.md .mdx`). Any other name is refused as an unknown
type; the table is deliberately a subset of a general-purpose search tool's, and
adding to it is a spec change (`src/tools/fs/grep.ts`). `[observed]`
A program call whose result exceeds the 20 MB ripgrep buffer is refused with a
narrowing remedy (`@packages/core/src/tools/definitions/cli/schema.ts:896-980`,
`@src/tools/executors/client/grep-search-cli.ts:287-381`, `@src/utils/constants.ts:27-30`).

**B21 — `Create`.** `file_path` and `content` required; a missing content is an
error, a directory target is an error, and an existing file is overwritten. A
trailing newline is ensured; new files keep the model's line endings, overwrites
preserve the file's. The result is `{success:true,file_path}` for a new file or a
structured line diff for an overwrite, plus any new IDE diagnostics. The file is
snapshotted for rewind and a `SKILL.md` under a `.droide*` skills directory is
auto-registered (`@packages/core/src/tools/definitions/cli/schema.ts:1145-1150`,
`@src/tools/executors/client/create-cli.ts:78-285`).

**B22 — `Edit`.** `file_path`, `old_str`, `new_str` required; `change_all` default
false. The match runs against the secret-scrubbed view and splices into the
original bytes. The view replaces each credential-shaped span with the fixed
marker `[redacted]`: a `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE
KEY-----` block; an auth-scheme credential (`Bearer`, `Basic` or `Token` and an
opaque value of 16+ token characters); a provider-shaped key (`sk-…` and
`sk-ant-…` of 16+ key characters, `github_pat_…` of 20+, `ghp_`/`gho_`/`ghu_`/
`ghs_`/`ghr_` of 20+, `AKIA` and 16 uppercase-or-digit characters, `xox…-…`
of 10+, `AIza…` of 30+); a JWT (`eyJ` and three `.`-separated base64url
segments of 8+ each); the value of a `password`,
`passwd`, `pwd`, `secret`, `token`, `api_key`/`api-key`, `access_key`,
`client_secret` or `auth_token` assignment — quoted at 6+ characters, else an
unquoted opaque value of 12+; and every occurrence of the injected
environment's `DROIDE_API_KEY` value when it is 8+ characters. A match that
overlaps a marker is not a match, so an `old_str` that reproduces a secret (or
the part of a line inside one) is refused as text not found, and an `old_str`
outside every secret matches exactly as before. The marker exists only in the
matching view: the file is rewritten from the original bytes, and no refusal
message quotes file content — the not-found, ambiguous and line-join texts name
counts and the path, never the text. Refusals: empty `old_str` in a non-empty
file; text not found; more than one occurrence without `change_all`; `old_str`
ending in a newline while `new_str` does not when the match is not at EOF
(line-join guard). A file must have been read (or created) in the session, and
a file changed externally since that read is refused. Trailing-newline
convention is preserved (`@packages/core/src/tools/utils/file-tools-utils.ts:29-84`,
`@src/agent/file-edit/edit.ts:48-90`, `@src/agent/file-edit/utils.ts:302-353`,
`@src/tools/fs/secrets.ts:1-251`).

**B23 — `ApplyPatch`.** Input is one `input` string in the patch grammar:
`*** Begin Patch` … `*** End Patch`, with `*** Update File: `, `*** Add File: `,
`*** Delete File: `, `*** Move to: ` (only directly after an update header) and
`*** End of File`; `+`/`-`/space line prefixes. Malformed structure is a refused
call; sandbox precheck parses every header target before execution
(`@packages/core/src/tools/utils/constants.ts:1-18`,
`@src/sandbox/sandboxPreCheck.ts:1030-1075`).

**B24 — File-tool write guards.** Create/Edit/ApplyPatch refuse to touch: the
artifacts directory, mission system files (`state.json`, `progress_log.jsonl`,
`model-settings.json`), the automation state file, a run's own `memory/` or
`skills/` sections (while `AutomationMemoryTools` is on), `features.json` from a
mission worker/validator, and shared-space files the sync service protects. The
check runs both on the path as given and on the resolved write target; an
unresolvable symlink chain is itself a refusal (`@src/tools/executors/client/utils/protectedWritePath.ts:182-268`).

This build has no artifacts directory, mission system, automation runs or shared
space, so those guards have nothing to protect and are not implemented. What it
does guard, under the same rule — name relative to the state directory, checked
on the path as given and on the resolved target, with a credential file also
refused for reading — is: the trusted configuration files
(`settings.json`, `settings.local.json`, `mcp.json`, `host.json`), the credential
prefixes, and the whole state directory for writes from a tool
(`src/tools/fs/paths.ts`, `TRUSTED_CONFIG_FILES`, `CREDENTIAL_FILES`). `[observed]`

**B25 — Writes are atomic and bound to what was seen.** A write is temp-file +
rename, preserving symlinks and permissions, refused if the file appeared,
disappeared, or changed since the preview/approval (`@src/agent/file-edit/utils.ts:1069-1180`).

### Shell and execution

**B26 — `Execute` input.** `summary` (required; Sentence case, 3–8 words,
`^[A-Z]\S*(?:\s+\S+){2,7}$`), `command` (required), `timeout` (seconds, default
60), `riskLevelReason` (default `High risk command`), `riskLevel`
(default `high`), `fireAndForget` (default false), `pty` (boolean, default
false) (`@packages/core/src/tools/definitions/cli/schema.ts:1033-1077`,
`@packages/utils/src/toolCallSummary/constants.ts:3`).

A call is given a pseudo-terminal exactly when `pty` is `true` and the call is
not `fireAndForget`. `pty` is the whole condition: never inferred from the
command text, argv0 or the environment, because a terminal changes stdout
buffering, echo and signal delivery, and only the caller knows it wants those.
A background launch is never given one — it outlives the call and no reader
stays attached — so `pty: true` together with `fireAndForget` runs as a pipe
child and B27's `ptyFallbackReason` says why. The session is the native helper's
`pty.*` surface (`crates/droide-native`, `src/native/methods.ts`); spec 90
B13–B22 pins the daemon terminal's surface, which this build does not spawn.
When the helper is absent, fails its handshake, or refuses a PTY (a platform
without a backend), the command runs as a pipe child and the result carries the
reason. The permission decision and the sandbox profile are settled before
`run`, exactly as for a pipe child; the session is created only after both.

**B27 — `Execute` result.** Success or failure is carried by `exitCode` (null when
signalled), `signal`, `stoppedProcesses` (count of leftover processes stopped as
the call returned) and the output. Output within the Script result cap (32 MiB)
is returned inline as `output`; past it the result carries `outputBytes` and
`outputFile`, and the file is kept (`@packages/core/src/tools/definitions/cli/schema.ts:113-147`,
`@src/tools/executors/client/execute-cli.ts:278-305`).

A call that asked for a PTY (`pty: true`, B26) also reports which transport it
got: `transport` is `"pty"` when the helper granted a session and `"pipe"` when
it did not, and `ptyFallbackReason` names the fallback — the helper is not
installed, it failed or refused the platform, or the call was `fireAndForget`.
The fallback is never silent. Calls that did not ask for a PTY gain neither
field.

**B28 — Shell per OS.** POSIX: `spawn(script, [], {shell:'bash', detached:false})`
with stdin ignored, `TERM=dumb`, `PS1=''`, `DEBIAN_FRONTEND=noninteractive`.
Windows: PowerShell (Windows PowerShell preferred), always
`-NoLogo -NonInteractive -ExecutionPolicy Bypass`, `-NoProfile` only for FILE_API
callers, `shell:false`, stdin ignored, `windowsHide:true`. No `cmd.exe` fallback.
A shell-less fallback (`shell:true`) exists only for the no-shell path
(`@src/tools/executors/client/shell/shell-executor.ts:226-386`).

A foreground run keeps `detached:false` on POSIX, as above. The background path
is the one exception: it spawns with `detached:true` so the child leads its own
process group, which is what the B31 watchdog signals; its stdin is ignored and
its output is the log file. Windows never detaches — the wrapper is a normal
child that reports the inner PID (`src/tools/shell/exec.ts`). `[observed]`

**B29 — Shell environment.** The child inherits `process.env` plus
`PYTHONUNBUFFERED=1`, non-interactive git/ssh variables
(`GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, `SSH_ASKPASS=`, `GIT_ASKPASS=`, `SUDO_ASKPASS=`,
`GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new`), and
`PYTHONIOENCODING`/UTF-8 variables on Windows. Agent-scope overrides and per-call
overrides apply in that order; supervisor-only sandbox variables and runtime
settings markers are stripped; the embedded tool directory (and, for a bare `rg`,
the ripgrep directory) is prepended to `PATH`/`Path`
(`@src/tools/executors/client/shell/shell-executor.ts:420-475`, `@src/sandbox/env.ts:27-56`,
`@packages/utils/src/shell/constants.ts:6-15`).

**B30 — Timeout and kill.** Foreground execution polls output every ~50 ms and
kills the terminal on timeout, abort, or a detected interactive-TTY wait. The
timeout budget counts only observed running time: each observation contributes at
most 2500 ms, so a laptop suspend does not burn the budget. Kill order on POSIX is
the process group (`SIGTERM`, then `SIGKILL`); on Windows `taskkill /T` plus a
family sweep that adopts children orphaned by the dying wrapper. An
`agent-browser` command is capped at 600 s (`min(timeout, 600)`)
(`@src/tools/executors/client/execute-cli.ts:1228-1360`, `:1036-1041`,
`@src/services/TerminalService/LocalTerminalService.ts:1197-1320`).

**B31 — Streaming and background.** Output is streamed as throttled (200 ms)
status updates carrying the last two lines and, for detailed views, the full
output; 8 KiB is the display tail. `fireAndForget` returns a PID and a temp log
path; on POSIX it launches `exec nohup bash -c …` via a detached group with a
watchdog that kills the group when the CLI dies (unless
`preserveBackgroundProcesses`); on Windows it launches through `Start-Process
-WindowStyle Hidden -PassThru`, merging all streams into one UTF-8 log and
reporting the inner PID + creation time within 2 s
(`@src/tools/executors/client/execute-cli.ts:1196-1240`,
`@src/tools/executors/client/shell/shell-executor.ts:89-135`, `:297-362`, `:560-700`).

The watchdog is what makes "kills the group when the CLI dies" true for a CLI
that never runs shutdown cleanup: the background child leads its own process
group, and on a successful launch the CLI installs exactly one exit hook —
`process.once("exit", …)` by default, so it runs for a natural exit,
`process.exit` and an uncaught error, and not for a signal the process cannot
observe. The hook runs synchronously — no timer survives `process.exit` — and
sends `SIGKILL` to the group (`process.kill(-pid, …)`), so a torn-down CLI does
not leave a stray background command behind; the child's stdin is ignored and
its output already goes to the log file, so nothing of the child's remains
attached to the dying terminal. The hook is not installed at all when
`preserveBackgroundProcesses` is set: the `preserveBackgroundProcesses` option
when the caller passes it, otherwise `DROIDE_PRESERVE_BACKGROUND_PROCESSES`
being `1` or `true`. Both the exit hook and the signal function are injected
seams, so the watchdog is proven by running the handler, never by sleeping for
a grace period.

Windows reports the inner process, not the wrapper. The wrapper is one
PowerShell that starts the command with `Start-Process -NoNewWindow -PassThru`
and prints `$p.Id` and `$p.StartTime.ToFileTimeUtc()` on one line. The command
text never appears on that wrapper's command line: it is written to a
temporary `.ps1` file whose path alone is quoted into the wrapper, so no
untrusted string is interpolated into PowerShell. The result carries that
inner PID and the creation time (as `startToken`) as soon as the line arrives,
and normally within 2 s; a wrapper that printed something else stops the wait
at that budget, and one that neither answers nor exits is given up at a 10 s
hard cap. Both bounds are read on the injected clock, and a wrapper that exits
has its complete stdout parsed — without needing the trailing newline — before
anything is given up. When the shell cannot provide them — no line at all, or
a line that is not exactly `<pid> <filetime>` — the result falls back to the
wrapper PID with no `startToken`, and the launch is not retried. The same
watchdog applies: the exit hook stops the inner process with `taskkill /T /F`,
because Windows has no group signal.

**B32 — Output scrubbing.** Shell output passes through the secret scrubber over a
sliding 100-line window before it reaches the model; a scrub failure falls back to
raw output (`@src/tools/executors/client/shell/shell-executor.ts:835-900`).

**B33 — `Script` / `WaitForScript`.** `Script` input is a single `script` string:
optional leading directives (`// @script: {"startInBackground": true}`,
`// @input: name <<'TAG'`) then JavaScript with top-level `await`. Limits: 128
outstanding nested calls and 1 MiB aggregate input, 1024 output events and 5 MiB
emitted content, 32 MiB per nested result; observation window 250 s, after which
the call returns `status:"running"`. `WaitForScript` takes `toolCallId` and
`action` (`wait|status|kill`) (`@packages/core/src/tools/definitions/cli/script/schema.ts:5-40`,
`:184-203`).

**B34 — `TodoWrite`.** Input `todos`: a string of numbered lines
`N. [pending|in_progress|completed] text`, max 50 items, 500 chars each; the list
order is line order. Runtime schema also accepts an array for tolerance
(`@packages/utils/src/todo/schema.ts:3-37`,
`@packages/core/src/tools/definitions/todo/constants.ts:1-26`).

**B35 — `Task` family.** `Task` requires `subagent_type`, `description`, `prompt`;
optional `image_paths`, `complexity` (`light|medium|heavy`), `resume`, and
`machine_name` only when remote execution is enabled. `TaskOutput` takes
`task_id`, `block` (default true), `timeout` (default 30000 ms); `TaskStop` takes
`task_id` and sends SIGTERM then SIGKILL (`@packages/core/src/tools/definitions/cli/taskCli.ts:22-68`,
`@packages/core/src/tools/definitions/cli/taskOutputCli.ts:10-24`,
`@packages/core/src/tools/definitions/cli/taskStopCli.ts:9-13`).

**B36 — Web tools.** `WebSearch` (deferred) accepts the You.com shape
(`query`, `numResults` 1–20, `text`, `knowledge:"core"`) or, behind the Parallel
flag, `objective` + `searchQueries` + `numResults`; string-typed numbers and
booleans are coerced. `FetchUrl` (deferred) takes one absolute URL and returns
`{markdown, title, effectiveUrl, metadata{url,statusCode,error,title}, linkedUrls?}`
(`@packages/core/src/tools/definitions/web/schema.ts:100-247`).

**B37 — `AskUser`.** Two accepted shapes: a plain-text `questionnaire` (1–4
questions, 2–4 options, optional `(multi)`), and a structured questions shape for
Anthropic models; optional `blocking` and `context` are accepted in both. The tool
declares `requiresConfirmation:true` yet executes directly, waiting for answers
(`@packages/core/src/tools/definitions/cli/schema.ts:1169-1221`,
`@src/agent/shouldConfirmExecution.ts:1088-1090`).

**B38 — `ExitSpecMode`.** Input `title?`, `plan` (required, markdown, one concrete
plan); result `{approved:boolean}`. In non-interactive exec it needs no approval;
interactively it opens the plan approval. It refuses plans containing unresolved
`Option A/B` alternatives and blank plans
(`@packages/core/src/tools/definitions/cli/exitSpecMode.ts:11-47`,
`@src/agent/shouldConfirmExecution.ts:960-1030`).

**B39 — MCP-bridged tools.** Each server tool becomes a registry entry with
id `mcp_<server>_<tool>`, llmId `<server>___<tool>` (Claude Code name
`mcp__<server>__<tool>`), display name `[MCP] <server>:<tool>`, toolkit
`MCP:<server>`, `requiresConfirmation:true`, `sideEffects:['external-service']`,
`isMcpTool:true`, and the server's own input schema (empty object when absent).
Results are stringified; a declared output schema requires structured content.
Deferral is per server (`@src/services/mcp/McpService.ts:4429-4475`,
`@src/tools/executors/client/mcp/McpToolExecutor.ts:215-345`).

**B40 — `ToolSearch`.** Input `query` is either `select:<name>[,<name>…]` (exact
deferred names) or keywords with optional `+`-required terms; `max_results`
(positive int, default 5) applies to keyword queries only
(`@packages/core/src/tools/definitions/cli/schema.ts:1223-1239`).

### Permission decisions

**B41 — Declared confirmation is not the decision.** `requiresConfirmation` is
metadata; the actual prompt is computed per call by `shouldConfirmExecution`
(`@src/agent/tool-confirmation.ts`, `@src/agent/shouldConfirmExecution.ts:820-832`).
`skipsConfirmations()` short-circuits it to "no prompt"
(`@src/agent/shouldConfirmExecution.ts:826-828`).

**B42 — File edits auto-approve in Auto/Mission mode.** `Create`, `Edit` and
`ApplyPatch` require no prompt when the session is in Auto or Mission interaction
mode with autonomy ≠ `off`; otherwise each raises its own preview confirmation
(new content, diff, or parsed hunks). Reads, `LS`, `Glob`, `Grep`, `TodoWrite`,
`TaskOutput`, `TaskStop`, `Skill`, `ConnectApp` never prompt
(`@src/services/SessionService.ts:4515-4526`,
`@src/agent/shouldConfirmExecution.ts:836-905`).

**B43 — `Execute` decision order.** First the bypass (skip all → run). Then command
policy: `block` → hard refusal (never prompts), `allow` → run, `ask` → prompt with
impact `high`. Then a provably read-only search command (behind
`RollSearchIntoExecute`) → run. Otherwise the model's risk is compared with the
session's autonomy threshold: impact ≤ autonomy runs, impact > autonomy prompts;
an unparsable risk is `high` (`@src/agent/autonomy.ts:126-201`).

**B44 — Autonomy threshold mapping.** `none=0, low=1, medium=2, high=3` for impact
and `off=0, low=1, medium=2, high=3` for autonomy
(`@src/agent/autonomy.ts:188-196`). Consequently `--auto low` auto-runs low-risk
commands, `--auto medium` low+medium, `--auto high` everything not otherwise
blocked or asked.

**B45 — `--skip-permissions-unsafe`.** Sets the exec runtime's confirmation
bypass; `skipsConfirmations()` is true only while the organization's maximum
autonomy admits `high`; the effective level becomes `high` (clamped). It is
rejected together with `--auto`, and `--mission` requires either `--auto high` or
this flag (`@src/services/SessionService.ts:4418-4462`,
`@src/entrypoints/exec/help.ts:167-200`, `@src/entrypoints/exec/assertValidOptions.ts:189-193`).

**B46 — Non-interactive refusal.** In exec mode with no permission callback a call
that would prompt is not run: the batch is recorded as auto-denied, and for
`Execute`/`Script`/MCP the run ends early with
`Exec ended early: insufficient permission to proceed. <guidance>`
(or `Exec ended early: MCP tool <tool> requires higher autonomy to proceed.
<guidance>`). The guidance is selected by mode/level: `--auto medium or --auto
high` at low, `--auto high` at medium, `--skip-permissions-unsafe` at high, the
`--auto low|medium|high` sentence for spec/default, and the organization-maximum
sentence when a higher level is administratively impossible
(`@src/core/ToolExecutor.ts:829-878`, `:1052-1132`).

The sentences are fixed strings, quoted here so a change is a spec change
(`src/tools/permissions.ts`):

| situation                    | guidance                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| organization maximum reached | `This session cannot exceed the organization's maximum autonomy level (<level>). Ask an administrator to raise it.` |
| autonomy `off`               | `Re-run with --auto low, --auto medium or --auto high to allow this tool.`                                          |
| autonomy `low`               | `Re-run with --auto medium or --auto high. For destructive commands, use --skip-permissions-unsafe.`                |
| autonomy `medium`            | `Re-run with --auto high. For destructive commands, use --skip-permissions-unsafe.`                                 |
| autonomy `high`              | `Re-run with --skip-permissions-unsafe.`                                                                            |

`[observed]`

**B47 — Tool-level allowlists.** An exec session's `--only-tools` set is enforced at
dispatch: a call to a filtered-out tool returns
`Tool <name> is not permitted in this exec session. Available tools: <list>.`
(`@src/agent/tools.ts:577-584`).

### Sandbox

**B48 — Config shape and defaults.** `sandbox.enabled` (default false), `mode`
(default `per-command`), `filesystem.{allowWrite,allowRead,denyWrite,denyRead}`,
`network.{allowedDomains,deniedDomains,allowUnixSockets,allowAllUnixSockets,allowLocalBinding,httpProxyPort,socksProxyPort}`;
paths support `/abs`, `~/`, and cwd-relative prefixes and are symlink-realpathed;
`deniedDomains` rejects `*` (`@src/sandbox/buildSandboxConfig.ts:11-46`,
`@packages/common/src/settings/schema.ts:577-608`,
`@packages/runtime/settings/src/sandbox-paths.ts:31-76`).

**B49 — Read policy precedence.** (1) credential deny floor → denied,
non-promptable; (2) user/project `denyRead` unless the path is under `allowRead`
or a call-scoped Allow Once grant; (3) otherwise allowed
(`@src/sandbox/SandboxManager.ts:483-570`).

**B50 — Write policy precedence.** (1) deny floor (credentials, trusted config,
external org-managed settings file) → denied, non-promptable; (2) user/project
`denyWrite` → denied, promptable; (3) operational home subpaths, the workspace
root, and `allowWrite` → allowed; (4) anything else → denied, promptable. All deny
rules are evaluated before any allow rule
(`@src/sandbox/SandboxManager.ts:607-663`).

**B51 — Network policy.** Invalid hostnames and uncanonicalizable hosts are
denied; explicit `deniedDomains` (wildcard-aware) deny; an allowed domain (or `*`
as default-allow) admits; otherwise promptable. Managed-service control-plane
hosts are always in the effective allow list, and a customer-prem origin replaces them
(`@src/sandbox/SandboxManager.ts:702-760`, `:1262-1300`).

**B52 — Precheck, then guard.** Before execution the precheck maps each tool's
declared side effects to a policy handler and probes caller-supplied paths or URLs:
Read/LS/Glob/Grep/Edit/Create/ApplyPatch/SlackPostFile probe paths; FetchUrl and
WebSearch probe network; Execute/Script/Task and lifecycle tools are metadata-only;
an MCP tool's string arguments are walked for path- and URL-shaped values. An
unregistered tool, missing/invalid metadata, or a declared effect with no handler
is denied. At runtime the executor-side guard prompts, persists Allow Always
(parent directory, or the exact file for the file variant), and on refusal returns
`Sandbox: <operation> denied to <path>` or
`Sandbox: network access denied to <domain>`
(`@src/sandbox/sandboxPreCheck.ts:563-700`, `:700-1230`,
`@src/sandbox/sandboxGuard.ts:64-170`, `@src/sandbox/allowAlwaysPersistence.ts:1-20`).

**B53 — Per-command vs whole-process.** Per-command mode wraps each `Execute`
command through SRT with proxy environment variables; whole-process mode requires
Linux or macOS, refuses `allowAllUnixSockets`, and re-execs the CLI under the OS
sandbox. Windows is refused for whole-process mode with
`Whole-process sandbox is unsupported on this platform`
(`@src/tools/executors/client/execute-cli.ts:1014-1027`,
`@src/sandbox/wholeProcessSandbox.ts:1826-1862`).

**B54 — OS layers.** Linux: bubblewrap + network namespace + seccomp; macOS:
seatbelt (`/usr/bin/sandbox-exec`, checked explicitly); Windows: SRT's
`srt-win.exe` restricted token, job object and WFP filter keyed on a
discriminator group SID — network only, "Filesystem restrictions are NOT enforced
on Windows yet". Seatbelt deny rules are last-match-wins, so the deny floor is
prepended and wins over the cwd allow-write root; `allowPty` is enabled only in
whole-process mode so the TUI can repaint
(`@src/sandbox/SandboxManager.ts:1090-1120`, `:1330-1385`,
`@evidence/original-vendor/windows-x64/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js:1-24`).

**B55 — `apply-seccomp`.** On Linux only, the seccomp helper is materialised from
the SEA-bundled copy into
`~/.droide/sandbox-runtime/seccomp/apply-seccomp-<sha256>`, owner-only mode
`0700`, and re-hashed with `O_NOFOLLOW` before every reuse; a symlinked directory,
a non-regular file, or an empty embedded helper is refused. Its absence is a
whole-process-mode failure and a dependency-check warning on Linux
(`@src/utils/applySeccompEmbedded.ts:1-200`,
`@src/sandbox/SandboxManager.ts:112-120`, `:1377`).

**B56 — Whole-process verification is empirical.** Before running, the sealed child
probes every configured deny-read/deny-write path, the deny floor, a writable
scratch path, and a network target; any mismatch fails the seal with a named
reason (`denyRead_not_enforced`, `denyWriteFloor_not_enforced`,
`denyWriteBoundary_not_enforced`, `allowedScratch_not_writable`, …)
(`@src/sandbox/wholeProcessSandbox.ts:1060-1120`).

## Data & config

| Item                               | Location / key                                                                                                                                                                                                                   | Required   | Default                                                                                               | Notes                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| sandbox settings                   | `sandbox` in `settings.json`, `settings.local.json`, org-managed settings                                                                                                                                                        | no         | disabled, per-command                                                                                 | merged by the settings service; see `80-settings.md`                |
| sandbox mode                       | `sandbox.mode`                                                                                                                                                                                                                   | no         | `per-command`                                                                                         | `whole-process` on Linux/macOS only                                 |
| allow/deny paths                   | `sandbox.filesystem.*`                                                                                                                                                                                                           | no         | `[]`                                                                                                  | prefixes `/`, `~/`, relative                                        |
| network allow/deny                 | `sandbox.network.*`                                                                                                                                                                                                              | no         | `[]`, false                                                                                           | `*` only in `allowedDomains`                                        |
| user allow-always writes           | `~/.droide/settings.json` `sandbox.filesystem.allowWrite`/`allowRead`                                                                                                                                                            | no         | —                                                                                                     | written by the Allow Always answer                                  |
| command allow/deny/block           | `commandAllowlist`, `commandDenylist`, `commandBlocklist`, plus `permissionRules` behind `CliRulesEngine`                                                                                                                        | no         | see defaults                                                                                          | deny = always ask; block = never run                                |
| default allowlist                  | built-in                                                                                                                                                                                                                         | —          | `ls, pwd, dir, git status/diff/log/show/blame/ls-files`                                               | `@packages/common/src/settings/constants.ts:170-182`                |
| default denylist                   | built-in                                                                                                                                                                                                                         | —          | `rm -rf /`, `mkfs*`, `dd of=/dev…`, `shutdown`, fork bombs, `chmod -R 777 /`, Windows `Format-Volume` | `@packages/common/src/policy/constants.ts:25-56`                    |
| default blocklist                  | built-in                                                                                                                                                                                                                         | —          | empty                                                                                                 | orgs opt in                                                         |
| seccomp helper                     | `~/.droide/sandbox-runtime/seccomp/apply-seccomp-<sha256>`                                                                                                                                                                       | linux only | —                                                                                                     | 0700, content-addressed                                             |
| sandbox operational writable roots | `~/.droide/{logs,sessions,cache,temp,…}`                                                                                                                                                                                         | —          | —                                                                                                     | always writable                                                     |
| credential deny-read floor         | `~/.droide/{auth.v2.*,auth.encrypted,computer-identity,prem-auth,config.json,mcp-oauth.*}`                                                                                                                                       | —          | —                                                                                                     | never readable                                                      |
| trusted-config deny-write floor    | `~/.droide/{settings.json,settings.local.json,hooks.json,mcp.json,update-policy.json,org-managed-settings.json,host.json,computer.json,certs,bin,tools,sandbox-runtime,exit-spool,…}` + `DROIDE_ORG_MANAGED_SETTINGS_LOCAL_PATH` | —          | —                                                                                                     | never writable                                                      |
| background log                     | `os.tmpdir()/droide-bg-<epoch>-<uuid>.out`                                                                                                                                                                                       | —          | —                                                                                                     | fire-and-forget only                                                |
| tool output spill                  | `~/.droide/tool-outputs/<sha256[0:32]>.txt`                                                                                                                                                                                      | —          | —                                                                                                     | content-addressed; dir `0700`, file `0600`; named by the cut notice |

Flags: `--auto low|medium|high`, `--skip-permissions-unsafe`, `--only-tools`,
`--add-tools`, `--remove-tools`, `--use-spec` (`@src/entrypoints/exec/help.ts:96-125`).
Environment: `DROIDE_SANDBOXED`, `DROIDE_WHOLE_PROCESS_SANDBOX_GUARD_PATH`,
`DROIDE_WHOLE_PROCESS_SANDBOX_CONTROL_FD`, `DROIDE_WHOLE_PROCESS_NET_PROBE`,
`DROIDE_E2E_TOOLS_READY_GATE_FILE`, `DROIDE_ORG_MANAGED_SETTINGS_LOCAL_PATH`
(`@src/sandbox/constants.ts:1-50`).

## Errors

| Trigger                                | Model-visible text                                                                                                                                                                                                                           | Effect / retry                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| broken tool definition at registration | `Tool is missing sandbox side-effect metadata` / `Tool has invalid sandbox side-effect metadata`                                                                                                                                             | registration throws; tool absent; startup surface    |
| native input fails schema              | schema error + `accepts the following parameters:` guide + `Please retry with valid parameters.`                                                                                                                                             | nothing executed; safe to retry                      |
| `Execute.command` missing/empty        | `EXECUTE_INVALID_COMMAND_REJECTION` text                                                                                                                                                                                                     | nothing executed; safe to retry                      |
| `Execute` missing `riskLevel`          | missing-risk guidance naming the field                                                                                                                                                                                                       | nothing executed; model must resupply                |
| blocked command                        | `This command is blocked by your organization's security policy and can never be run (matched blocked-command rule "<pattern>"). Do not run this command again…`                                                                             | never executed; retrying is futile                   |
| sandbox file denial                    | `Sandbox: read denied to <path>` / `Sandbox: write denied to <path>` / `Sandbox: <op> denied to <path>`                                                                                                                                      | nothing written/read; retry after a grant is safe    |
| sandbox network denial                 | `Sandbox: network access denied to <domain>`                                                                                                                                                                                                 | nothing fetched                                      |
| sandbox tool policy                    | `Sandbox: tool policy denied for <tool>; <reason>` (`tool is unknown or unregistered`, `missing sandbox side-effect metadata`, `declared side effect <x> has no sandbox policy handler`, `malformed <field> cannot be dispatched unchecked`) | call refused before execution                        |
| non-interactive confirmation needed    | `Exec ended early: insufficient permission to proceed. <guidance>`                                                                                                                                                                           | run ends; the caller must re-run with a higher level |
| tool filtered by `--only-tools`        | `Tool <name> is not permitted in this exec session. Available tools: …`                                                                                                                                                                      | refused                                              |
| `Read` non-absolute path               | `file_path must be an absolute path, not a relative path`                                                                                                                                                                                    | refused                                              |
| `Read` limit ≤ 0                       | `limit must be a positive number`                                                                                                                                                                                                            | refused                                              |
| `Read` image > 5 MB                    | `Image file exceeds 5MB size limit. File size: <n>MB`                                                                                                                                                                                        | refused                                              |
| `Read` PDF unreadable                  | `Failed to read PDF: … could not extract text …`                                                                                                                                                                                             | refused                                              |
| `Edit` not read first                  | `Error: Cannot edit file that has not been read first. …`                                                                                                                                                                                    | refused                                              |
| `Edit` external change                 | `Error: File "<p>" has been modified externally since it was last read. …`                                                                                                                                                                   | refused                                              |
| `Edit` ambiguous match                 | `Error: Found <n> occurrences of the specified text, but change_all is false. …`                                                                                                                                                             | refused                                              |
| `Create` at a directory                | `Error: Cannot create file at "<p>" because a directory already exists there.`                                                                                                                                                               | refused                                              |
| protected write path                   | `Cannot <verb> files in artifacts directory…`, `Cannot <verb> mission system files…`, `Cannot <verb> features.json from a worker session`, `Cannot <verb> a path whose symlinks could not be resolved`                                       | refused before write                                 |
| `Glob` empty patterns                  | `At least one pattern is required for glob search. …`                                                                                                                                                                                        | refused                                              |
| `Grep` over buffer                     | `Grep matched more than the 20 MB ripgrep buffer holds, so the list would be incomplete. …`                                                                                                                                                  | refused (program calls only)                         |
| `Script` over a limit                  | call text over 128 outstanding / 1 MiB input throws where written; nested result over 32 MiB rejects                                                                                                                                         | partial work may have committed                      |
| whole-process unsupported              | `Whole-process sandbox is unsupported on this platform`                                                                                                                                                                                      | sandbox not engaged                                  |
| whole-process deps missing             | `Whole-process sandbox dependencies are unavailable` / `… secure seccomp dependencies are unavailable`                                                                                                                                       | sandbox not engaged                                  |
| seal verification failure              | reason names the failed probe (`denyRead_not_enforced`, …)                                                                                                                                                                                   | sealed child not run                                 |

## Acceptance tests

All tests are offline and deterministic: fixtures are synthesised JSON, no real
commands, no network, no credentials.

| Clause  | Test id                                     | Fixture                                                                                             |
| ------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| B1–B4   | `tests/tools/test_registry_identity`        | `fixtures/tools/registry_stub.json` (2 tools, duplicate llmId, one missing `sideEffects`)           |
| B5      | `tests/tools/test_exec_readonly_catalog`    | `fixtures/tools/registry_full.json`                                                                 |
| B6, B39 | `tests/tools/test_visibility_and_mcp_names` | `fixtures/tools/mcp_registration.json`                                                              |
| B7–B10  | `tests/tools/test_input_validation`         | `fixtures/tools/invalid_args/*.json` (one per tool)                                                 |
| B11–B13 | `tests/tools/test_result_budgets`           | `fixtures/tools/long_output.txt` (40 KiB), `fixtures/tools/nested_result_33mib.json`                |
| B14–B17 | `tests/tools/test_read`                     | `fixtures/files/{short,long,outline,utf16le,crlf}.txt`, `fixtures/files/{img_6mb.png,doc_120p.pdf}` |
| B18     | `tests/tools/test_ls`                       | `fixtures/files/tree/`                                                                              |
| B19–B20 | `tests/tools/test_search_tools`             | `fixtures/files/tree/` + pattern matrix                                                             |
| B21–B25 | `tests/tools/test_write_tools`              | `fixtures/files/edit_cases/*`, `fixtures/tools/patch_grammar/*.patch`                               |
| B26–B31 | `tests/tools/test_execute_model`            | `fixtures/tools/execute_env.json` (fake spawn recorder)                                             |
| B32     | `tests/tools/test_output_scrubbing`         | `fixtures/tools/secret_output.txt`                                                                  |
| B33     | `tests/tools/test_script_limits`            | `fixtures/tools/script_calls/*.ts`                                                                  |
| B34     | `tests/tools/test_todo_parse`               | `fixtures/tools/todo_lists/*.txt`                                                                   |
| B35     | `tests/tools/test_task_schemas`             | `fixtures/tools/task_args/*.json`                                                                   |
| B36–B40 | `tests/tools/test_web_spec_tools`           | `fixtures/tools/web_args/*.json`, `fixtures/tools/spec_calls/*.json`                                |
| B41–B47 | `tests/permissions/test_matrix`             | `fixtures/permissions/matrix.json`                                                                  |
| B48–B52 | `tests/sandbox/test_policy_decisions`       | `fixtures/sandbox/policy_cases.json`                                                                |
| B53–B55 | `tests/sandbox/test_profile_assertions`     | `fixtures/sandbox/profiles/*.json`                                                                  |
| B56     | `tests/sandbox/test_seal_reasons`           | `fixtures/sandbox/probe_failures.json`                                                              |

### Permission matrix

Rows are tools; columns are the session autonomy level. Cell = required user
action for a call whose target passes the sandbox. `WS/AW` = inside the workspace
root or an `allowWrite` path; `OUT` = outside both; `DW/FLOOR` = a `denyWrite` or
deny-floor path. Sandbox disabled means only the middle column applies (modulo
B24's protected paths).

| Tool                                        | off (interactive)                                   | `--auto low` | `--auto medium` | `--auto high` | `--skip-permissions-unsafe`       |
| ------------------------------------------- | --------------------------------------------------- | ------------ | --------------- | ------------- | --------------------------------- |
| Read / LS / Glob / Grep (any path class)    | run                                                 | run          | run             | run           | run                               |
| TodoWrite / ToolSearch / TaskOutput / Skill | run                                                 | run          | run             | run           | run                               |
| Create / Edit / ApplyPatch — WS/AW          | prompt                                              | run          | run             | run           | run                               |
| Create / Edit / ApplyPatch — OUT            | prompt                                              | run          | run             | run           | run                               |
| Create / Edit / ApplyPatch — DW/FLOOR       | refuse (protected/floor)                            | refuse       | refuse          | refuse        | refuse (floor) / prompt (user DW) |
| Execute, risk `low` (WS)                    | prompt unless policy-allow                          | run          | run             | run           | run                               |
| Execute, risk `medium`                      | prompt                                              | prompt       | run             | run           | run                               |
| Execute, risk `high`                        | prompt                                              | prompt       | prompt          | run           | run                               |
| Execute, policy `allow`                     | run                                                 | run          | run             | run           | run                               |
| Execute, policy `ask`                       | prompt                                              | prompt       | prompt          | prompt        | run                               |
| Execute, policy `block`                     | refuse                                              | refuse       | refuse          | refuse        | refuse                            |
| Script / Task (child calls re-checked)      | unavailable in read-only exec; prompt interactively | run          | run             | run           | run                               |
| WebSearch / FetchUrl                        | prompt only when sandbox denies                     | same         | same            | same          | same                              |
| MCP tool                                    | prompt (opaque impact)                              | prompt       | prompt          | prompt        | run                               |
| ExitSpecMode / AskUser                      | own modal                                           | own modal    | own modal       | own modal     | own modal                         |

Notes that the matrix pins:

- Every cell is a function of `shouldConfirmExecution` (B42–B43) and the sandbox
  (B48–B52); "run" still means the executor's own guards apply.
- `off` still runs allowlisted read-only `Execute` (policy `allow`, B43).
- Sandbox-disabled sessions do not prompt for `OUT` paths, but the deny floor does
  not exist without the sandbox: B50 is only active when `sandbox.enabled`.

### Sandbox-profile assertions (no command executed)

Each of these is a pure assertion over the profile/config document:

1. `sandbox.enabled=false` ⇒ no OS profile is requested and `checkFileAccess`
   returns `null` for every path.
2. `denyWrite` on the OS layer is the union `floor ∪ user denyWrite`, with the
   floor entries present even when `allowWrite` contains the workspace root;
   assertion is on set membership and on the documented last-match-wins ordering
   (B54).
3. `denyRead` always contains every credential path and never contains
   `allowRead`-carved user paths that are not credentials.
4. `allowWrite` always contains the workspace root and every operational home
   subpath, deduplicated.
5. `allowPty` is `true` only when `mode === 'whole-process'`.
6. `seccomp.applyPath` is present iff the platform is Linux and the embedded
   helper verified against its digest; absent on macOS/Windows.
7. Whole-process mode on `win32` throws `Whole-process sandbox is unsupported on
this platform` before any child is spawned.
8. A `deniedDomains` entry equal to `*` is rejected at settings parse time.

## Evidence

Every path below is relative to `evidence/original/windows-x64/` unless it starts
with `vendor:` (then `evidence/original-vendor/windows-x64/`).

| Evidence                                                                                       | Supports      | Method |
| ---------------------------------------------------------------------------------------------- | ------------- | ------ |
| `packages/sdk-core/src/protocol/tools/constants.ts:22-115`                                     | B1, B39       | read   |
| `packages/core/src/tools/registry.ts:12-140`                                                   | B1            | read   |
| `packages/core/src/tools/create-tool.ts:23-56`                                                 | B2            | read   |
| `packages/core/src/tools/enums.ts:1-71`                                                        | Terms, B52    | read   |
| `src/agent/tools.ts:1268-1312`                                                                 | B3            | read   |
| `src/commands/resolveToolSelection.ts:316-323`                                                 | B5            | read   |
| `src/exec/tool-groups.ts:35-117`                                                               | B5            | read   |
| `src/agent/toolInputValidation.ts:74-84`                                                       | B7, B9        | read   |
| `packages/core/src/tools/utils/validate-tool-parameters.ts:89-320`                             | B7, B8, B10   | read   |
| `packages/core/src/tools/utils/constants.ts:21-40`                                             | B11           | read   |
| `packages/core/src/tools/utils/large-output.ts:40-220`                                         | B12, B13      | read   |
| `packages/core/src/tools/definitions/cli/schema.ts:81-111`                                     | B14           | read   |
| `src/utils/truncate.ts:19-137`                                                                 | B15           | read   |
| `packages/core/src/tools/utils/file-encoding.ts:1-200`                                         | B16, B22      | read   |
| `src/tools/executors/client/read-cli.ts:72-800`                                                | B16, B17      | read   |
| `packages/core/src/tools/definitions/cli/schema.ts:827-980`                                    | B18–B20       | read   |
| `src/tools/executors/client/ls-cli.ts:140-250`                                                 | B18           | read   |
| `src/tools/executors/client/glob-search-cli.ts:29-233`                                         | B19           | read   |
| `src/tools/executors/client/grep-search-cli.ts:287-381`                                        | B20           | read   |
| `src/tools/executors/client/create-cli.ts:78-285`                                              | B21           | read   |
| `packages/core/src/tools/utils/file-tools-utils.ts:29-84`                                      | B22           | read   |
| `src/agent/file-edit/edit.ts:48-90`, `src/agent/file-edit/utils.ts:302-400`                    | B22           | read   |
| `src/tools/executors/client/utils/protectedWritePath.ts:182-268`                               | B24           | read   |
| `src/agent/file-edit/utils.ts:1047-1180`                                                       | B25           | read   |
| `packages/core/src/tools/definitions/cli/schema.ts:1033-1127`                                  | B26, B27      | read   |
| `src/tools/executors/client/shell/shell-executor.ts:226-475`                                   | B28, B29      | read   |
| `src/tools/executors/client/execute-cli.ts:1036-1360`                                          | B30, B31      | read   |
| `src/services/TerminalService/LocalTerminalService.ts:1197-1320`                               | B30           | read   |
| `src/tools/executors/client/shell/shell-executor.ts:560-900`                                   | B31, B32      | read   |
| `packages/core/src/tools/definitions/cli/script/schema.ts:5-203`                               | B33           | read   |
| `packages/utils/src/todo/schema.ts:1-45`                                                       | B34           | read   |
| `packages/core/src/tools/definitions/cli/task*.ts`                                             | B35           | read   |
| `packages/core/src/tools/definitions/web/schema.ts:100-247`                                    | B36           | read   |
| `packages/core/src/tools/definitions/cli/schema.ts:1169-1247`                                  | B37, B38, B40 | read   |
| `src/services/mcp/McpService.ts:4429-4475`                                                     | B39           | read   |
| `src/tools/executors/client/mcp/McpToolExecutor.ts:215-345`                                    | B39           | read   |
| `src/agent/shouldConfirmExecution.ts:820-1130`                                                 | B41–B43       | read   |
| `src/agent/autonomy.ts:60-201`                                                                 | B43, B44      | read   |
| `src/services/SessionService.ts:4418-4526`                                                     | B42, B44, B45 | read   |
| `src/entrypoints/exec/help.ts:96-200`                                                          | B26, B45      | read   |
| `src/entrypoints/exec/assertValidOptions.ts:185-195`                                           | B45           | read   |
| `src/core/ToolExecutor.ts:829-1132`                                                            | B41, B46      | read   |
| `src/agent/tools.ts:577-584`                                                                   | B47           | read   |
| `src/sandbox/buildSandboxConfig.ts:11-46`                                                      | B48           | read   |
| `packages/common/src/settings/schema.ts:577-608`                                               | B48           | read   |
| `packages/runtime/settings/src/sandbox-paths.ts:31-93`                                         | B48           | read   |
| `src/sandbox/SandboxManager.ts:262-760`                                                        | B49–B51       | read   |
| `src/sandbox/SandboxManager.ts:1080-1385`                                                      | B53–B55       | read   |
| `src/sandbox/sandboxPreCheck.ts:563-1230`                                                      | B52           | read   |
| `src/sandbox/sandboxGuard.ts:64-262`                                                           | B52           | read   |
| `src/sandbox/allowAlwaysPersistence.ts:1-245`                                                  | B52           | read   |
| `src/sandbox/wholeProcessSandbox.ts:1060-1120`, `:1826-1862`                                   | B53, B56      | read   |
| `src/utils/applySeccompEmbedded.ts:1-200`                                                      | B55           | read   |
| `vendor:node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js:1-24` | B54           | read   |
| `vendor:node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js:332-380`    | B53, B54      | read   |

Clauses B15's outline thresholds, B29's env list, B30's
2500 ms observation clamp, B33's numeric limits and B46's guidance strings are
`[observed]`. B17's 3 MiB image cap is `[derived]` here from base64 inflation
and the ACP frame size, because this build returns PNG and JPEG only; the
upstream GIF-first-frame, PDF-document and 5 MB/3 MB limits are not reproduced.
The mapping "`--auto` level X auto-runs risk ≤ X" is `[derived]` from
the numeric comparison plus the enum order; the platform statement "Windows has no
filesystem enforcement" is `[observed]` in the vendored SRT comment and therefore
`[derived]` as a CLI-visible contract.

## Open questions

1. **`autonomy off` in the TUI.** `--auto` accepts only low/medium/high, and the
   default exec level is `low`, but `AutonomyLevel.Off` exists and gates
   file-edit auto-approval. Where Off can be selected interactively (a keybinding
   rather than a flag) is not established here. Settle by reading
   `src/components/HelpPopup.tsx` and the session-settings catalog. Blocks the
   `off` column of the permission matrix from being a CLI contract.
2. **Automatic Allow-Once scope for reads.** The scoped grant is threaded as
   `scopedAllowReadPaths` into Read/LS/Edit/Create/Glob/Grep, but whether a read
   denial's Allow Once also widens `Glob`/`Grep` re-includes within the same call
   is not proven. Blocks a claim about cross-tool grant reuse.
3. **Complete automation/evaluation schemas.** B-inventory entries for those
   families name their fields at the level of the schema file's top-level keys;
   the mission-v2 (`spawnAgent` etc.) and evaluation argument lists were not read
   field by field. Blocks a "complete field list" claim for those tools.
4. **`ApplyPatch` result shape.** The executor's streaming schema mentions legacy
   top-level fields from the first applied file; the exact non-streaming result
   was not read. Blocks an exact output-contract clause.
5. **Windows whole-process gap.** SRT reports Windows as supported for
   per-command sandboxing while the CLI refuses whole-process there. Whether the
   per-command Windows path enforces any filesystem rule the CLI relies on (vs.
   only network) is stated by the vendored comment as "not enforced"; the CLI's own
   app-level checks are the only filesystem guard. Confirming this on a Windows
   run is out of scope for this spec.

## Clean-room notes

**Contract a conforming build must reproduce**

- The llmId set, the id↔llmId split, the six side-effect classes and their
  validation, and per-tool metadata (`requiresConfirmation` as metadata only,
  `isTopLevelTool` vs `isVisibleToUser`, `deferred`).
- The tool schemas: field names, types, defaults and constraints exactly as
  tabulated for the file, search, shell, todo, task, web, spec and
  settings/mission tools; the `Read` outline/range behaviour and its two notices;
  the `Edit` five refusals; the `ApplyPatch` grammar markers; `Execute`'s
  `summary` regex and risk enum.
- The two result budgets (32 KiB / 64 KiB) and the middle-cut notice text.
- The permission algebra: policy `block > ask > allow`, then read-only-search
  shortcut, then risk-vs-autonomy numbers; file edits auto-approved in Auto/
  Mission with autonomy ≠ off; `--skip-permissions-unsafe` as a bypass bounded by
  the org maximum, mutually exclusive with `--auto`; exec-mode early exit message
  and its level-specific guidance.
- The sandbox precedence rules (deny-before-allow, credential floor
  non-promptable, deny-floor non-overridable), the always-writable operational
  roots and workspace root, allow-always persistence to user settings (parent dir;
  exact file for the file variant), the precheck-per-declared-effect rule, and the
  refusal strings.
- The shell model: bash on POSIX, PowerShell with the stated flags on Windows,
  non-interactive env set, stdin ignored, observed-time timeout accounting,
  process-group/tree kill, 32 MiB inline cap with an output-file fallback, and
  8 KiB streaming tail.
- Platform confinement claims: Linux bwrap+netns+seccomp with a digest-verified
  `apply-seccomp`; macOS seatbelt with deny-last ordering and `allowPty` in
  whole-process mode; Windows network-only confinement via SRT's helper, with
  CLI-level file checks as the only filesystem guard.

**Explicitly not part of the contract**

- The private helper names, class layout and SRT wrapper internals; the wire shape
  between the CLI and `srt-win.exe`; the seccomp filter's syscall list.
- Exact prompt copy and colours of the confirmation UI, the i18n keys behind the
  guidance strings (the English text is the contract; translations are not).
- The pre-hydration display-name fallback map's ordering, the memoization
  internals (`decisionMemo`, `compileOutcomes`), and log/telemetry identifiers
  (`COMMAND_BLOCKED`, `[Tool] …` breadcrumbs).
- The exact regexes used to _recognise_ declaration lines for the `Read` outline,
  provided the documented thresholds, exclusions (`.md`, `.mdx`), and fallbacks
  (return the whole file when the outline would be poor) hold.
- Discovery/space-sync side channels (`queueDynamicContext`, `SpaceSyncService`)
  except where they produce a documented refusal.
