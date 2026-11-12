# CLI surface — the `droid` command line

- **Target:** Factory AI `droid` 1.9.0
- **Status:** draft
- **Owner:** CLI
- **Related:** `00-context.md`; specs for `exec` runtime, TUI, daemon, MCP,
  plugin, doctor, search, update; parity suite `tests/parity/`.

## Purpose

`droid` is a commander-routed single executable. This spec fixes the whole
command-line contract a user or a script can observe: the root usage line, the
help and version surfaces, every option and subcommand (including the hidden
ones that other Factory surfaces invoke), how a bare word is classified as a
command or as prompt text, what the process exits with, and which of the four
configuration sources wins when they disagree. It exists because the CLI is the
only stable integration point for shells, editors, CI jobs, the desktop app and
the daemon supervisor.

## Scope

**Covers:** argv→dispatch semantics; the root program surface; every visible and
hidden command with its arguments, options, aliases and defaults; help-text
shape (as recorded); exit codes; the non-TTY refusal; the flag → env → settings →
project precedence chain where it is decided on the command line.

**Does not cover:** what each command *does* once dispatched (own specs). In
particular the exec agent loop, TUI rendering and session model, daemon wire
protocol, MCP server lifecycle, plugin installation rules, doctor check
semantics and update download mechanics are named here only as far as the CLI
must know them to parse and dispatch. Whole-process sandbox re-exec is a
dispatch precondition and is noted (B30) but specified with the sandbox.

**Deferred:** the localized variants of every error string (only English is
recorded; five locales ship — `packages/i18n/src/constants.ts:8-14`).

## Terms

Citations are abbreviated: `orig/…` = `evidence/original/windows-x64/…`,
`vendor/…` = `evidence/original-vendor/windows-x64/…`. A bare `src/…` inside a
citation means `orig/src/…`.

| Term | Meaning |
|---|---|
| **root program** | The single `Command` named `droid` that owns `[prompt...]`, the twelve startup options and every subcommand (`orig/src/cli.ts:427-480`). |
| **startup options** | The twelve options returned by `makeTuiOptions()`; the root program and `resume` both accept them (`orig/src/entrypoints/tui/options.ts:10-53`). |
| **dispatch chain** | The root program plus each command nested down to the one whose action runs, root first (`orig/src/cli.ts:97-106`). |
| **default command** | The hidden `tui` command registered with `{ isDefault: true }` (`orig/src/cli.ts:478`); it runs when no word matches a command. |
| **prompt parts** | The operands the dispatched `tui`/`resume` action receives; joined with a single space and trimmed to form the initial prompt (`orig/src/entrypoints/tui/run.ts:538-544`). |
| **prompt word** | `promptParts[0]`, the token named in the non-TTY refusal (`orig/src/entrypoints/tui/command.ts:167`). |
| **launch directory** | `process.cwd()` at process start, before `--cwd` is entered. |
| **launch path** | An option or argument value marked with `markLaunchPath`, which is made absolute at the launch directory when the run moves (`orig/src/utils/commanderParsers.ts:88-98`). |
| **hidden** | Registered with `{ hidden: true }` or `.hideHelp()`: absent from every help page but still dispatchable. |
| **flag-gated** | A hidden command admitted only when a Factory feature flag is on; otherwise it fails as an unknown command (`orig/src/entrypoints/bootstrap/gatedCommand.ts:16-40`). |

## Observable behaviour

### Root program surface

**B1** `droid --help` (also `-h`, and `droid help`) writes the root help page to
stdout and exits 0. It is byte-exact in `tests/parity/expected/help.json`. The
first line is `Usage: droid [options] [command] [prompt...]`, produced from the
program name, its options, its subcommands and its `[prompt...]` argument
(`orig/src/cli.ts:428-431`). `[observed]`

**B2** The one-line description under the usage line is
`Droid - Factory's AI coding agent in your terminal`
(`orig/src/cli.ts:428`). `[observed]`

**B3** `-v` / `--version` prints the version and exits 0. The value is
`process.env.CLI_VERSION`, or the literal `unknown` when unset; the recorded
build prints `1.9.0` (`orig/src/cli.ts:429`;
`tests/parity/expected/version.json`). `[observed]`

**B4** The help page ends with an `Examples:` block of six lines followed by the
line `For more details, see: https://docs.factory.ai/cli/getting-started/overview`
and a final newline; the block is attached with `addHelpText('after', …)` and
contains no other trailing text (`orig/src/cli.ts:432-446`;
`tests/parity/expected/help.json`). `[observed]`

**B5** The root `Options:` section lists, in this order: `-v, --version`;
`--settings <path>`; `--append-system-prompt <text>`;
`--append-system-prompt-file <path>`; `-r, --resume [sessionId]`; `--last`;
`--fork <sessionId>`; `--cwd <path>`; `-w, --worktree [name]`;
`--worktree-dir <path>`; `--auto <level>`; `--use-spec`;
`--disable-builtin-skills`; `-h, --help`
(`orig/src/cli.ts:449-451`, `orig/src/entrypoints/tui/options.ts:10-53`).
None of the twelve startup options declares a default, so all are absent
(`undefined`) unless typed. `[observed]`

**B6** The root `Commands:` section lists exactly the nine visible commands in
registration order — `resume`, `exec`, `daemon`, `search|find`, `update`, `mcp`,
`plugin`, `computer`, `doctor` — followed by commander's built-in
`help [command]`. No hidden command appears (`orig/src/cli.ts:453-476`;
`tests/parity/expected/help.json`). `[observed]`

**B7** The root usage line advertises `[prompt...]`, so a bare operand is part of
the documented grammar even though no command word is involved
(`orig/src/cli.ts:431`). `[observed]`

### Dispatch and argument classification

**B8** The first operand that names a command (or one of its aliases) dispatches
that command; the remaining operands become its arguments. Aliases that dispatch
are `find` → `search` (`orig/src/entrypoints/search/command.ts:9-10`), `i` →
`plugin install` and `remove` → `plugin uninstall`
(`orig/src/entrypoints/plugin/command.ts:73-88`). `[observed]`

**B9** An operand that names no command is routed to the default `tui` command
and becomes prompt text, not an error: `tui` sets `.allowUnknownOption(true)`
and `.allowExcessArguments(true)`, so option-shaped tokens are operands too
(`orig/src/entrypoints/tui/command.ts:159-166`). `[observed]`

**B10** Because of B9, `droid definitely-not-a-command` and
`droid --definitely-not-a-flag` both reach the same refusal path with the token
in the prompt word, and the recorded goldens differ only in that word
(`tests/parity/expected/unknown-command.json`,
`tests/parity/expected/unknown-flag.json`). `[observed]`

**B11** The root program sets `enablePositionalOptions()`, so root options are
read only before the first operand; from the command word (or prompt) onward the
tokens belong to the dispatched command (`orig/src/cli.ts:430`). Consequence: a
startup option typed after a root prompt belongs to `tui` and, under B9, joins
the prompt text. `[derived]` — see Q1.

**B12** Exactly two argv words are short-circuited before dispatch:
`git-ai-checkpoint-hook` and `push-git-ai-notes` as `argv[2]`. When either is
the first word, stdin is drained when it is not a TTY and the process returns
without routing (exit 0, no output) (`orig/src/cli.ts:492-506`). `[observed]`

**B13** The word `deployment` as `argv[2]` is intercepted by the process
entrypoint before the router exists and runs its own commander program, so it
never appears in or reaches the root dispatch
(`orig/src/index.ts:119-126`, `orig/src/entrypoints/deployment/command.ts:92-112`). `[observed]`

**B14** `droid help <command>` prints that command's help and exits 0. For a
flag-gated command the shortcut fails closed: the admission check is attached to
`beforeHelp`, so `droid help space` reports the command as unknown when the flag
is off (`orig/src/entrypoints/bootstrap/gatedCommand.ts:16-40`). `[observed]`

### The default command and the non-TTY refusal

**B15** `tui` is registered last, hidden, as the default command
(`orig/src/cli.ts:478`). Its argument is `[prompt...]`, described as
`Inline prompt to start the session with`
(`orig/src/entrypoints/tui/command.ts:159-162`). `[observed]`

**B16** If a prompt word is present and `process.stdin.isTTY` is falsy, the
process writes the refusal to **stderr** and exits **1**; nothing is started
(`orig/src/entrypoints/tui/command.ts:33-49,167-170`). `[observed]`

**B17** The refusal is composed of these lines, in this order
(`orig/src/entrypoints/tui/command.ts:37-47`; English catalogue
`evidence/extracted/windows-x64/chunk-j2hk0tf4.js` key `tui`): `[observed]`

```
droid requires a terminal for interactive mode, but stdin is not one.
  • Over SSH, add -t to allocate one: ssh -t <host> droid
  • To run a prompt without a terminal, use droid exec: droid exec "<prompt>"
  • "<word>" is not a droid command, so droid read it as a prompt. Run droid --help to list commands.
```

**B18** When `process.env.TERM_PROGRAM === 'mintty'` a fourth-shaped hint line is
inserted before the `notACommand` line, naming Windows Terminal
(`orig/src/entrypoints/tui/command.ts:39-41`). `[observed]`

**B19** When the refusal comes from `resume` (a prompt after the session id), the
`notACommand` line is omitted because there is no prompt word to name; only the
`requiresTerminal` line (plus the mintty hint) is written
(`orig/src/entrypoints/tui/command.ts:43-44,215-217`). `[observed]`

**B20** A launch with **no** prompt parts is never refused, TTY or not: the TUI
starts and waits for input (`orig/src/entrypoints/tui/command.ts:167-169`, whose
condition requires `promptWord !== undefined`). `[observed]`

**B21** The refusal's language comes from the user's local settings files alone,
resolved before any other startup work (`orig/src/entrypoints/tui/command.ts:35-37`;
`orig/src/i18n/localeDetection.ts`). `[derived]`

### `resume`

**B22** `droid resume [sessionId] [prompt...]` resumes the named session, opens
the session picker when no id is given, and sends any remaining operands as the
prompt. Usage line:
`droid resume [options] [sessionId] [prompt...]`
(`orig/src/entrypoints/tui/command.ts:184-190`;
`tests/parity/expected/help-resume.json`). `[observed]`

**B23** Its option list is the two contextual flags `--fork` (boolean) and
`--last`, then the whole startup set minus `--resume`, `--fork` and `--last`,
in registration order (`orig/src/entrypoints/tui/command.ts:191-208`;
`tests/parity/expected/help-resume.json`). `[observed]`

**B24** `resume <id> --fork` is exactly `droid --fork <id>`: the id is moved into
the root `fork` slot and the TUI runs (`orig/src/entrypoints/tui/command.ts:225-234`). `[observed]`

**B25** Root `--settings` and `--cwd` are inherited by `resume` when `resume` was
given neither (`orig/src/entrypoints/tui/command.ts:218-224`). `[observed]`

### `exec`

**B26** `droid exec [options] [prompt]` runs non-interactively. Its help is
**curated text**, not commander's rendering: `.helpOption(false)` is set and
`-h, --help` is an ordinary option whose action loads local state and prints
`printExecHelp()` (`orig/src/entrypoints/exec/command.ts:47-51,237-252`;
`orig/src/entrypoints/exec/help.ts:81-183`). `[observed]`

**B27** The curated help prints exactly the option lines in
`tests/parity/expected/help-exec.json` and, below them, the sections
`Stream JSON-RPC Mode:`, `Autonomy Levels:`, `Mission Mode:`, `Session Flags:`,
`Tool Controls:`, `Available Models:`, `Model details:`, `Pinning the Latest
Model:`, `Authentication:` and `Examples:`
(`orig/src/entrypoints/exec/help.ts:115-303`). `[observed]`

**B28** The `-m, --model` line's `(default: …)` is computed at help time from
`resolveDefaultFactoryModel` over the models available to the signed-in
identity; the recorded build shows `gpt-6.1-sol`. The parsed option itself has no
default (`orig/src/entrypoints/exec/help.ts:81-113`;
`orig/src/entrypoints/exec/command.ts:99`). `[observed]`

**B29** `--output-format` defaults to `text`; `--list-tools`, `--mission`,
`--worker-model`, `--validator-model`, `--tag` and the tool-selection flags are
documented as above; the exact default set is the one in B27's golden.
`[observed]`

**B30** `exec` also registers options that commander's renderer or the curated
page never show: `--tool-execution-mode <direct-only|script-only>`,
`--allow-subagents-in-scripts`, `--no-allow-subagents-in-scripts`,
`--enabled-tools`, `--additional-tools`, `--disabled-tools`,
`--restrict-tools` (all `.hideHelp()`), plus `--request-id`, `--depth`,
`--init-session-id`, `--calling-session-id`, `--calling-tool-use-id` and
`--session-title` (registered but omitted from the curated page)
(`orig/src/entrypoints/exec/command.ts:63-190`). `[observed]`

**B31** Prompt source precedence is: `--file` (error if a prompt argument is also
given), then non-TTY stdin, then the prompt argument. With none of the three the
command fails; a `-` prompt argument is refused with a migration message
(`orig/src/entrypoints/exec/handler.ts:325-379`). `[observed]`

**B32** `--input-format stream-json` / `stream-jsonrpc` require the matching
`--output-format`, and a prompt argument or `--file` is refused in those modes
(`orig/src/entrypoints/exec/assertValidOptions.ts:142-175,354-367`). `[observed]`

**B33** Structural conflicts are refused before any model or network work, each
with its own message: `--auto` with `--skip-permissions-unsafe`; `--session-id`
with `--fork`; `--fork` with `--worktree`; `--worktree` with `--cwd`;
`--session-id`/`--fork` with `--use-spec`/`--spec-model`; `--mission` without
`--auto high` or `--skip-permissions-unsafe`; `--mission` with `--use-spec`,
`--spec-model`, `--session-id`, `--fork` or a streaming input format; and any
`--worker-*`/`--validator-*` flag without `--mission`
(`orig/src/entrypoints/exec/assertValidOptions.ts:90-300`). `[observed]`

**B34** Under `--input-format stream-jsonrpc` twelve flag groups are still
validated but have no effect, and a warning naming the ones that are set goes to
stderr (`orig/src/entrypoints/exec/constants.ts:11-53`;
`orig/src/entrypoints/exec/handler.ts:319-330`). The list is printed in the
curated help (`tests/parity/expected/help-exec.json`). `[observed]`

### `daemon`

**B35** `droid daemon [options]` exposes
`-p, --port <number>`, `--host <address>` (default `127.0.0.1`),
`--unix <path>`, `-d, --debug` (default `false`),
`--listen <websocket|ipc>` (default `websocket`), `--droid-path <path>`,
`--liveness-fd <fd>`, `--parent-pid <pid>`, `--remote-control`,
`--remote-access` (default `false`) and `--settings <path>`
(`orig/src/entrypoints/daemon/command.ts:20-83`;
`tests/parity/expected/help-daemon.json`). `[observed]`

**B36** `--port`, `--liveness-fd` and `--parent-pid` are parsed with
`parseInt`; `--listen` is restricted to the two declared choices, so any other
value is a commander invalid-argument error
(`orig/src/entrypoints/daemon/command.ts:22-45`;
`orig/src/entrypoints/daemon/constants.ts:3-6`). `[observed]`

**B37** `--remote-control` implies `remoteAccess: true`; `--enable-child-ipc` is
registered as a hidden no-op so existing units keep working
(`orig/src/entrypoints/daemon/command.ts:44-74`). `[observed]`

**B38** `daemon` forwards the root `--settings` when it was given none itself,
and exports the surviving value as `FACTORY_RUNTIME_SETTINGS_PATH` for the
children it spawns (`orig/src/entrypoints/daemon/command.ts:85-95`). `[observed]`

### `search` / `find`

**B39** `droid search|find [options] <query>` requires the `query` argument; the
help's usage line renders the alias as `search|find`
(`orig/src/entrypoints/search/command.ts:9-13`;
`tests/parity/expected/help-search.json`). `[observed]`

**B40** Defaults: `--kind all`, `--limit-sessions 20`, `--limit-hits 3`,
`--context-chars 80`; `--limit-sessions`/`--limit-hits` accept integers ≥ 1 and
`--context-chars` accepts integers ≥ 0, digits only; `--json`, `--reindex`,
`--include-archived`, `--exclude-children`, `--include-hidden` are booleans
(`orig/src/entrypoints/search/command.ts:14-51`;
`orig/src/utils/commanderParsers.ts:16-33`). `[observed]`

### `update`

**B41** `droid update [options]` takes `-c, --check` and
`-v, --version <version>` (`tests/parity/expected/help-update.json`;
`orig/src/entrypoints/update/command.ts:4-13`). The `-v` here shadows the root
`-v` version flag inside that command. `[observed]`

**B42** An empty or non-semver `--version` value fails the run with exit code 1
and a message naming the invalid format; a valid one is normalized by stripping a
leading `v` (`orig/src/entrypoints/update/run.ts:148-166`). `[observed]`

### `mcp`

**B43** `droid mcp` groups `add`, `remove`, `list`, `auth` and `permissions`
(`orig/src/entrypoints/mcp/command.ts:8-113`;
`tests/parity/expected/help-mcp.json`). `[observed]`

**B44** `mcp add <name> <urlOrCommand...>` takes `--type <type>`, repeatable
`--env <KEY=VALUE>`, repeatable `--header <KEY: VALUE>` and `--no-oauth`;
`--type` has no commander default because the handler needs to know whether it
was given (`orig/src/entrypoints/mcp/command.ts:18-47`). `[observed]`

**B45** `mcp permissions` groups `list`, `revoke <server> [tool]` and
`clear --confirm` (`orig/src/entrypoints/mcp/command.ts:79-113`). `[observed]`

### `plugin`

**B46** `droid plugin` groups `marketplace` (`add <url>`, `remove <name>`,
`list`, `update [name]`), `install|i <plugin>`, `uninstall|remove <plugin>`,
`update [plugin]` and `list`; every install/uninstall/update/list accepts
`-s, --scope <user|project>` (`orig/src/entrypoints/plugin/command.ts:13-119`;
`tests/parity/expected/help-plugin.json`). `[observed]`

### `computer`

**B47** `droid computer` groups `register [name]` (`-y, --yes`),
`remove` (`-y, --yes`), `list`, `ssh <computer-name> [command...]`
(`--debug`, `--proxy`, `--port <port>` default `22`) and
`port-forward <computer-name> <mappings...>` (`--address <addr>` default
`127.0.0.1`, `--debug`) (`orig/src/entrypoints/computer/command.ts:12-93`;
`tests/parity/expected/help-computer.json`). `[observed]`

**B48** `computer` also registers a hidden `trust-repos <dirs...>` subcommand
used by managed-computer provisioning; it bootstraps with `skipAuth`
(`orig/src/entrypoints/computer/command.ts:12-27,95-104`). `[observed]`

### `doctor`

**B49** `droid doctor [options]` takes `--json`, `--verbose`,
`--timeout <ms>` and `--checks <names>`, and appends a four-line trailer after
its option list (`orig/src/entrypoints/doctor/command.ts:49-72`;
`tests/parity/expected/help-doctor.json`). `[observed]`

**B50** `--timeout` must be a safe integer in `1…2147483647`; `--checks` accepts
a comma-separated subset of `config, environment, system, binaries, updates,
filesystem, git, custom-models, proxy, certs, connectivity, auth, daemon,
inference, mcp, exec`, accumulates across repeats, and accepts `all`. An unknown
name is refused before any check starts
(`orig/src/entrypoints/doctor/command.ts:8-47,63-67`;
`orig/src/entrypoints/doctor/constants.ts:61-159`). `[observed]`

**B51** A hidden `--all` and one hidden boolean flag per category
(`--config`, `--system`, `--binaries`, `--updates`, `--filesystem`, `--git`,
`--customModels`, `--proxy`, `--certs`, `--connectivity`, `--auth`, `--daemon`,
`--inference`, `--mcp`, `--exec`) are registered but never rendered
(`orig/src/entrypoints/doctor/command.ts:68,74-79`). `[observed]`

### Hidden commands

All of these are registered with `{ hidden: true }` (or through
`addFlagGatedCommand`, which adds them hidden) and none appears in any help page
(`orig/src/cli.ts:463-478`). `[observed]`

**B52** `tui [prompt...]` — the default interactive entry; hidden because the
root program already advertises `[prompt...]` and naming it would offer a second
spelling of the same thing (`orig/src/entrypoints/tui/command.ts:159-166`). `[observed]`

**B53** `space` — flag-gated (`MissionsV2`): explore shared-context spaces,
documents, session transcripts, comments and local sync; subcommands `list`,
`create`, `get`, `doc {list,get,create,update,edit,write,delete}`,
`session {list,get,register,append,push,read}`, `comment {…}`,
`attach`, `detach`, `sync`, `status`, plus a global `--base-url` and a
`--session` per subcommand. Hidden because it is an internal surface whose JSON
output only builtin skills consume (`orig/src/entrypoints/space/command.ts:14-507`). `[observed]`

**B54** `dataset` — flag-gated (`AutoEvalPipeline`): `check <repo>` and
`verify <repo>` for Harbor dataset tasks, with `--tasks-dir`, `--task`,
`--all`, `--sample`, `--seed`, `--solution`, `--expect-pass`, `--expect-fail`.
Hidden because it is machine-driven and prints unlocalized JSON
(`orig/src/entrypoints/dataset/command.ts:8-96`). `[observed]`

**B55** `automation` — flag-gated (`AutomationMemoryTools`): `memory
{list,read,edit,write,append,delete}` over an automation's `memory/` files,
every subcommand taking the automation as `[automation]` (defaulting to
`FACTORY_AUTOMATION_ID`) and `--json`. Hidden because its callers are automation
scripts (`orig/src/entrypoints/automation/command.ts:1-9,36-163`). `[observed]`

**B56** `wiki-read`, `wiki-search`, `wiki-upload` — read, search and upload wiki
pages (`--repo-url`, `--wiki-run-id`, `--page` / `--query`, `--limit`, `--json` /
`--session-id`, `--wiki-dir`, `--cleanup`, `--check`, `--upload-to`,
`--copy-from-wiki-run-id`). Hidden because they are invoked by the wiki
generation flow, not by hand (`orig/src/entrypoints/wiki-read/command.ts:4-19`,
`orig/src/entrypoints/wiki-search/command.ts:4-20`,
`orig/src/entrypoints/wiki-upload/command.ts:6-40`). `[observed]`

**B57** `pull-request` — internal pull-request manifest workflows:
`manifest-begin`, `manifest-generate`, `manifest-validate`, `manifest-submit`,
`manifest-read`. Hidden as an internal, machine-readable surface
(`orig/src/entrypoints/pull-request/command.ts:5-97`). `[observed]`

**B58** `record-triage-input` — reports the consumed-message count for a triage
run (Software Factory SIGNAL metric) with required `--automation-id`,
`--run-id`, `--messages-consumed` and optional `--occurred-at`. Hidden because a
platform automation invokes it (`orig/src/entrypoints/record-triage-input/command.ts:4-24`). `[observed]`

**B59** `exit-courier` — delivers the network work exited sessions handed off,
then exits. Hidden because the TUI spawns it at exit
(`orig/src/entrypoints/exit-courier/command.ts:5-27`;
`orig/src/services/exitCourier/constants.ts:2`). `[observed]`

**B60** `statusline-probe` — runs the configured status line command once under
the same budget the TUI enforces. Hidden because a prompt/status-line
configuration invokes it (`orig/src/entrypoints/statusline-probe/command.ts:4-17`). `[observed]`

**B61** `session-index-refresh` — rebuilds the local session index once and
exits; the TUI spawns it detached. Hidden because it is an implementation detail
of search (`orig/src/entrypoints/session-index-refresh/command.ts:8-27,39-60`). `[observed]`

**B62** `rules` — `check` validates Execute-command permission rules, runs
self-tests and optionally previews a command (`--file`, `--command`, `--json`);
the command appends its own examples block. Hidden because it is a debugging
entry for the permission engine
(`orig/src/entrypoints/rules/command.ts:6-51`). `[observed]`

**B63** A flag-gated command whose flag is off fails as
`unknown command '<name>'` (no `error:` prefix, because it is written through
`program.error` with an explicit message), exit 1, before help, argument
validation or the action runs; `beforeHelp` makes `help <name>` fail the same way
(`orig/src/entrypoints/bootstrap/gatedCommand.ts:16-40`;
`vendor/node_modules/commander/lib/command.js:1940-1958`). `[observed]`

### argv provenance and launch-path anchoring

**B64** The router re-reads argv token by token, remembering each token's index
in `process.argv` (starting at 2), and lets each command on the dispatch chain
parse only the tokens its parent left unread. Operands are handed down as
commander hands them: a named subcommand gets its parent's operands after its
name, the default command — named nowhere — gets them all
(`orig/src/cli.ts:258-289`). `[observed]`

**B65** When `--cwd` or `--worktree` is given anywhere on the dispatch chain,
every launch path is resolved against the launch directory and written back into
the parsed option/argument **and** into the argv token it came from, in the
spelling it was typed (`--x v`, `--x=v`, `-x v`, `-xv`, or an operand), before
the process moves (`orig/src/cli.ts:290-426`). `[observed]`

**B66** The run then enters `--cwd`, taking the deepest non-empty value on the
chain; an empty value names no directory and falls back to the parent's
(`orig/src/cli.ts:396-426`). `process.argv` itself is never rewritten. `[observed]`

**B67** If the directory cannot be entered, every command is refused before any
entrypoint initializes, with `Error changing to directory: <path>` followed by
the operating system's reason, through commander's error path (exit 1)
(`orig/src/cli.ts:544-558`;
`evidence/extracted/windows-x64/chunk-j2hk0tf4.js` key
`exec.errorChangingDirectory`). `[observed]`

**B68** Launch-relative environment variables (including
`FACTORY_RUNTIME_SETTINGS_PATH`) are made absolute at the launch directory before
the first configuration read, so a parent's relative paths keep their meaning
after the move (`orig/src/environment.ts:484-521`;
`orig/src/index.ts:180-190`). `[observed]`

### Exit codes

**B69** Help and version: exit 0, output on stdout, stderr empty
(`tests/parity/expected/help*.json`, `version.json`). `[observed]`

**B70** The non-TTY refusal (B16) and every commander usage error — unknown
option, invalid option-argument, missing required argument, missing required
option — exit 1 with the text on stderr
(`orig/src/cli.ts:570-592`;
`vendor/node_modules/commander/lib/command.js:2035,2058-2060,2114-2136,721`). `[observed]`

**B71** A command group invoked with no subcommand (`droid mcp`, `droid plugin`,
`droid computer`, `droid doctor` is excluded because it has an action) prints its
help to **stderr** and exits 1, because commander treats a command with children
and no action as a usage error (`vendor/node_modules/commander/lib/command.js:1632-1635,2622-2633`). `[derived]` — see Q2.

**B72** `exec` exits 0 on a completed run and 1 on a refused invocation or a run
whose result carries an error; an interrupt during the run cleans up and exits 0
(`orig/src/entrypoints/exec/run.ts:580-590,660-680`;
`orig/src/entrypoints/exec/handler.ts:1294-1316`;
`orig/src/utils/command-wrapper.ts:63-110`). `[observed]`

**B73** `search` exits 0 on success, 1 on a rejected query or a failure, and 130
when the search is aborted (`orig/src/entrypoints/search/run.ts:150-172`). `[observed]`

**B74** `doctor` exits 1 when its report is not ok, through `process.exitCode`,
which the router preserves on the natural-exit path
(`orig/src/entrypoints/doctor/command.ts:88-93`;
`orig/src/cli.ts:575-583`). `[observed]`

**B75** `update` exits 1 for an invalid `--version` value and when the install
fails; a successful or "already up to date" check exits 0
(`orig/src/entrypoints/update/run.ts:148-176,240-270`). `[observed]`

**B76** `deployment` normalizes any non-zero commander exit to 1 and returns 0
on success (`orig/src/entrypoints/deployment/command.ts:96-112`). `[observed]`

### Precedence between configuration sources

**B77** For the runtime-settings overlay there are exactly two sources on the
command line's side of the chain: the `--settings` flag, then the inherited
`FACTORY_RUNTIME_SETTINGS_PATH` environment variable. Each entrypoint resolves
`options.settings ?? getRuntimeSettingsPathFromEnv()`
(`orig/src/entrypoints/exec/run.ts:320-325`;
`orig/src/entrypoints/daemon/run.ts:275-282`;
`orig/src/entrypoints/tui/bootstrap.ts:373-378`). `[observed]`

**B78** The overlay file, when it resolves, becomes the `Runtime` level of the
settings hierarchy and sits directly beneath org policy and above the automation
folder, `.factory` folders, project settings, user settings, dynamic config and
builtin defaults — in that order (`orig/packages/runtime/settings/src/SettingsManager.ts:3923-4013`). `[observed]`

**B79** A path that does not exist, is not a regular file or is unreadable does
not abort: the overlay is dropped (`setRuntimeSettingsPathOverride(undefined)`,
so no child inherits it) and the failure is recorded
(`orig/src/utils/runtimeSettingsBootstrap.ts:98-140`). `[observed]`

**B80** `--append-system-prompt` / `--append-system-prompt-file` win over the
inherited `FACTORY_APPEND_SYSTEM_PROMPT`; the process then re-exports the
resolved text to its children. File contents precede the inline text, joined by a
blank line (`orig/src/entrypoints/exec/run.ts:306-318`;
`orig/src/utils/appendSystemPromptArgs.ts:68-91`). `[observed]`

**B81** `--worktree-dir` is deprecated in favour of the settings key
`worktreeDirectory`: the flag still parses, and the help text for both the root
and `exec` says so (`orig/src/entrypoints/tui/options.ts:40-43`;
`orig/src/entrypoints/exec/help.ts:126`). `[observed]`

## Data & config

### Flag inventory

Value shapes: `<v>` required value, `[v]` optional value (bare use yields
`true`), boolean otherwise. "hidden" means not rendered anywhere.

**Root (startup) options** — `orig/src/entrypoints/tui/options.ts:10-53`

| Option | Shape | Default | Launch path |
|---|---|---|---|
| `-v, --version` | boolean | — | no |
| `--settings <path>` | path, trimmed, `~` expanded | none | yes |
| `--append-system-prompt <text>` | text | none | no |
| `--append-system-prompt-file <path>` | path | none | yes |
| `-r, --resume [sessionId]` | optional value | none | no |
| `--last` | boolean | false | no |
| `--fork <sessionId>` | required value | none | no |
| `--cwd <path>` | path, `~` expanded | none | yes |
| `-w, --worktree [name]` | optional value | none | no |
| `--worktree-dir <path>` | path | none | no |
| `--auto <level>` | `low\|medium\|high` | none | no |
| `--use-spec` | boolean | false | no |
| `--disable-builtin-skills` | boolean | false | no |
| `-h, --help` | boolean | — | no |

`--auto` is validated by the TUI after parsing, not by an arg parser
(`orig/src/entrypoints/tui/autonomyFlag.ts:6-20`).

**`resume`** — `--fork`, `--last` (both boolean), then the startup set without
`--resume`, `--fork`, `--last`.

**`exec`** — see B27's golden for the documented set and B30 for the undocumented
options. Notable shapes: `-o, --output-format <text|json|stream-json|stream-jsonrpc|acp>`
default `text` (zod-validated at action time, not by choices);
`--input-format <stream-json|stream-jsonrpc>`; `-f, --file <path>` (launch path);
`--only-tools`/`--add-tools`/`--remove-tools <ids>` split on `[\s,]+`, accumulate,
refuse an empty list; `--tag <spec>` accumulates; `--depth <number>` `parseInt`
(`orig/src/entrypoints/exec/command.ts:24-45,52-190`).

**`daemon`**, **`search`**, **`update`**, **`mcp`**, **`plugin`**, **`computer`**,
**`doctor`** — as enumerated in B35–B51.

### Environment variables read by the surface

| Variable | Read where | Effect |
|---|---|---|
| `CLI_VERSION` | `orig/src/cli.ts:429` | version string, else `unknown` |
| `FACTORY_RUNTIME_SETTINGS_PATH` | `orig/src/environment.ts:530-534` | overlay path when `--settings` is absent |
| `FACTORY_APPEND_SYSTEM_PROMPT` | `orig/src/environment.ts:558-562` | inherited append text |
| `TERM_PROGRAM` | `orig/src/entrypoints/tui/command.ts:39` | adds the mintty hint to the refusal |
| `FACTORY_SESSION_ID` | `orig/src/entrypoints/space/command.ts:16-18` | default `--session` for `space` |
| `FACTORY_AUTOMATION_ID` | `orig/src/entrypoints/automation/command.ts:5-8` | default `[automation]` |

### Settings files

`--settings` names one JSON/JSONC object; its readable keys are merged as the
`Runtime` level (`orig/../../packages/runtime/settings/src/RuntimeSettingsOverlay.ts:22-29`).
The hierarchy merges, lowest priority last-wins order, Org → Runtime → automation
folder → `.factory` folders → project settings → project `.agent` → project
plugins → user settings → user `.agent` → user plugins → dynamic config → builtin
defaults (`orig/packages/runtime/settings/src/SettingsManager.ts:3923-4013`).

## Errors

| # | Trigger | Message (exact where recorded) | Exit | State |
|---|---|---|---|---|
| E1 | prompt given, stdin not a TTY | `droid requires a terminal for interactive mode, but stdin is not one.` + two hints + `"<word>" is not a droid command, so droid read it as a prompt. Run droid --help to list commands.` on stderr | 1 | nothing initialized |
| E2 | `resume <id> <prompt>`, stdin not a TTY | first line + hints only | 1 | nothing initialized |
| E3 | unknown option on a command that does not allow it | `error: unknown option '--x'` (plus `Did you mean …?` suggestion) | 1 | untouched |
| E4 | option value refused by an arg parser | `error: option '<flags>' argument '<value>' is invalid. <parser message>` | 1 | untouched |
| E5 | missing required argument | `error: missing required argument '<name>'` | 1 | untouched |
| E6 | missing required option | `error: required option '<flags>' not specified` | 1 | untouched |
| E7 | flag-gated command with flag off | `unknown command '<name>'` (no `error:` prefix) | 1 | untouched |
| E8 | `--cwd` cannot be entered | `Error changing to directory: <path>` + `<os reason>` | 1 | nothing initialized |
| E9 | `exec` with no prompt, no `-f`, TTY stdin | `No prompt provided. Usage:` + three example lines | 1 | no session |
| E10 | `exec -f` and a prompt argument | `Cannot specify both a file (-f/--file) and a prompt argument.` + three options | 1 | no session |
| E11 | `exec -f <missing>` / empty file / unreadable | `Prompt file not found: <path>` / `Prompt file is empty: <path>` / `Permission denied reading prompt file: <path>` / `Could not read prompt file <path>: <message>` | 1 | no session |
| E12 | `exec` piped stdin empty | `No prompt received on stdin (the input was empty). …` | 1 | no session |
| E13 | `exec` prompt in a streaming input mode | `Cannot use prompt argument in streaming mode. Messages are read from stdin.` | 1 | no session |
| E14 | `exec --auto x` with a bad level | `Invalid --auto value. Allowed values: low, medium, high.` | 1 | no session |
| E15 | `exec` flag conflict (B33) | `Invalid flags: …` (one message per pair) | 1 | no session |
| E16 | `exec` model blocked by org policy | `Model blocked by organization policy: …` | 1 | no session |
| E17 | `doctor --timeout 0` | `error: option '--timeout <ms>' argument '0' is invalid. Timeout must be a positive integer no greater than 2147483647 milliseconds.` | 1 | no check ran |
| E18 | `doctor --checks nope` | `… is invalid. Unknown doctor check. Use --help for the supported check names.` | 1 | no check ran |
| E19 | `update --version ''` | invalid-version message, then a valid-semver hint on stdout | 1 | no download |
| E20 | `search` query rejected | `queryRejected` message | 1 | index untouched |
| E21 | `search` aborted | none | 130 | — |
| E22 | command group with no subcommand | its help page, on stderr | 1 | no bootstrap |

Retry safety: every error above occurs before a session, index write or download
exists, so re-running after fixing the input is safe. E8 leaves the process in
the launch directory (the move failed), so a retry with a valid `--cwd` is also
safe.

## Acceptance tests

Every clause maps to at least one test. `fixtures/` items are synthesized (temp
`HOME`, `TZ=UTC`, `LANG=C`, `TERM=dumb`, `NO_COLOR=1`, unroutable proxy), matching
the parity harness invariants (`tests/parity/README.md`).

| Clause | Test id | Fixture |
|---|---|---|
| B1, B4, B5, B6 | `tests/cli/test_root_help_exact` | `tests/parity/expected/help.json` |
| B2, B7 | `tests/cli/test_root_usage_line` | — |
| B3 | `tests/cli/test_version_flag` | `tests/parity/expected/version.json` |
| B8 | `tests/cli/test_alias_dispatch` | `fixtures/session-corpus` |
| B9, B10 | `tests/cli/test_bare_words_become_prompt` | `tests/parity/expected/unknown-*.json` |
| B11 | `tests/cli/test_positional_options` | — |
| B12 | `tests/cli/test_hook_words_shortcircuit` | — |
| B13 | `tests/cli/test_deployment_prerouter` | — |
| B14, B63 | `tests/cli/test_gated_help_fails_closed` | `fixtures/flags-off` |
| B15–B20 | `tests/cli/test_non_tty_refusal_matrix` | `fixtures/no-tty` |
| B21 | `tests/cli/test_refusal_locale` | `fixtures/settings-ja` |
| B22–B25 | `tests/cli/test_resume_command` | `tests/parity/expected/help-resume.json` |
| B26–B29 | `tests/cli/test_exec_help_exact` | `tests/parity/expected/help-exec.json` |
| B30 | `tests/cli/test_exec_undocumented_options` | — |
| B31 | `tests/cli/test_exec_prompt_sources` | `fixtures/prompts` |
| B32, B34 | `tests/cli/test_exec_streaming_modes` | `fixtures/stream-jsonrpc` |
| B33 | `tests/cli/test_exec_flag_conflicts` | — |
| B35–B38 | `tests/cli/test_daemon_options` | `tests/parity/expected/help-daemon.json` |
| B39, B40 | `tests/cli/test_search_options` | `tests/parity/expected/help-search.json` |
| B41, B42, B75 | `tests/cli/test_update_options` | `tests/parity/expected/help-update.json` |
| B43–B45 | `tests/cli/test_mcp_tree` | `tests/parity/expected/help-mcp.json` |
| B46 | `tests/cli/test_plugin_tree` | `tests/parity/expected/help-plugin.json` |
| B47, B48 | `tests/cli/test_computer_tree` | `tests/parity/expected/help-computer.json` |
| B49–B51, B74 | `tests/cli/test_doctor_options` | `tests/parity/expected/help-doctor.json` |
| B52–B62 | `tests/cli/test_hidden_commands_absent` | `fixtures/flags-on` |
| B64 | `tests/cli/test_dispatch_token_provenance` | — |
| B65–B68 | `tests/cli/test_launch_path_anchoring` | `fixtures/nested-dirs` |
| B69–B73, B76 | `tests/cli/test_exit_codes` | — |
| B77–B81 | `tests/cli/test_precedence_chain` | `fixtures/settings-layers` |

### argv → parse-result table

Deterministic; no network, no credentials, no TTY assumptions except where the
column says so.

| argv | dispatched | arguments | options set | exit |
|---|---|---|---|---|
| `[]` | `tui` (default) | `[]` | — | TUI starts |
| `["--help"]` | — | — | — | 0, help.json |
| `["-h"]` | — | — | — | 0, help.json |
| `["help"]` | `help` | `[]` | — | 0, help.json |
| `["help","exec"]` | `help` | `["exec"]` | — | 0, exec help |
| `["--version"]` / `["-v"]` | — | — | — | 0, `1.9.0\n` |
| `["exec","hi"]` | `exec` | `["hi"]` | — | run |
| `["exec","-f","p.txt"]` | `exec` | `[]` | `file="p.txt"` | run |
| `["exec","--model","m","hi"]` | `exec` | `["hi"]` | `model="m"` | run |
| `["exec","--auto","high","--mission"]` | `exec` | `[]` | `auto="high"`, `mission=true` | run |
| `["find","needle"]` | `search` | `["needle"]` | `kind="all"` | 0 |
| `["search"]` | `search` | — | — | 1, `missing required argument 'query'` |
| `["resume","abc","do","it"]` | `resume` | `["abc",["do","it"]]` | — | run |
| `["resume","--last"]` | `resume` | `[]` | `last=true` | run |
| `["resume","abc","--fork"]` | `resume` | `["abc"]` | `fork=true` → root `fork="abc"` | run |
| `["--resume"]` | `tui` | `[]` | `resume=true` | run (picker) |
| `["--resume","abc","--last"]` | `tui` | `[]` | `resume="abc"`, `last=true` | 1, E15 |
| `["--fork","x","--worktree"]` | `tui` | `[]` | `fork="x"`, `worktree=true` | 1, E15 |
| `["daemon","--port","3000","--listen","ipc"]` | `daemon` | `[]` | `port=3000`, `listen="ipc"` | run |
| `["daemon","--listen","tcp"]` | `daemon` | — | — | 1, E4 |
| `["computer","ssh","box","--","ls","-la"]` | `computer ssh` | `["box",["ls","-la"]]` | `port="22"` | run |
| `["plugin","i","p@m"]` | `plugin install` | `["p@m"]` | — | 0/1 |
| `["mcp","permissions","clear","--confirm"]` | `mcp permissions clear` | `[]` | `confirm=true` | 0/1 |
| `["doctor","--checks","config,mcp","--json"]` | `doctor` | `[]` | `checks=["config","mcp"]`, `json=true` | 0/1 |
| `["definitely-not-a-command"]` | `tui` | `["definitely-not-a-command"]` | — | 1, E1 |
| `["--definitely-not-a-flag"]` | `tui` | `["--definitely-not-a-flag"]` | — | 1, E1 |
| `["git-ai-checkpoint-hook"]` | none | — | — | 0, no output |
| `["deployment","set","--factory"]` | `deployment` | — | `factory=true` | 0/1 |
| `["space","list"]` (flag off) | — | — | — | 1, E7 |

### Non-TTY refusal permutations

stdin is a pipe in every row; `word` is `promptParts[0]`.

| argv | TERM_PROGRAM | stderr lines | exit |
|---|---|---|---|
| `[]` | any | none — TUI starts | — |
| `["hi"]` | unset | `requiresTerminal` (3 lines) + `"hi" is not a droid command …` | 1 |
| `["hi","there"]` | unset | same, word `hi` | 1 |
| `["--definitely-not-a-flag"]` | unset | same, word `--definitely-not-a-flag` | 1 |
| `["hi"]` | `mintty` | 3 lines + mintty hint + `"hi" is not a droid command …` | 1 |
| `["resume"]` | any | none — picker starts | — |
| `["resume","abc"]` | any | none | — |
| `["resume","abc","hi"]` | unset | 3 lines only, no `notACommand` | 1 |
| `["resume","abc","hi"]` | `mintty` | 3 lines + mintty hint | 1 |
| `["exec","hi"]` | any | no refusal (non-interactive path) | 0/1 by run |

### Help-text invariants

1. `droid --help` stdout is byte-identical to `tests/parity/expected/help.json`,
   exit 0, stderr empty.
2. Its last line is
   `For more details, see: https://docs.factory.ai/cli/getting-started/overview`
   followed by exactly one newline.
3. `droid <cmd> --help` is byte-identical to each recorded golden for
   `resume`, `exec`, `daemon`, `search`, `update`, `mcp`, `plugin`, `computer`,
   `doctor`; exit 0 and stderr empty in every case.
4. `droid doctor --help` ends with **two** newlines (the appended trailer ends in
   `\n`, plus the renderer's).
5. No help page contains any of these strings: `tui`, `space`, `dataset`,
   `automation`, `wiki-read`, `wiki-search`, `wiki-upload`, `pull-request`,
   `record-triage-input`, `exit-courier`, `statusline-probe`,
   `session-index-refresh`, `rules`, `deployment`, `trust-repos`,
   `--enable-child-ipc`, `--tool-execution-mode`, `--session-title`,
   `--request-id`, `--enabled-tools`, `--all`.
6. `droid exec --help` names `-m, --model` with a `(default: …)` suffix and
   contains the ten section headings of B27.
7. Every `Usage:` line begins `Usage: droid` and repeats the command path; the
   `search` and `plugin install`/`uninstall` pages render aliases as
   `search|find`, `install|i`, `uninstall|remove`.

## Evidence

| Evidence | Supports | Method |
|---|---|---|
| `ev_cli_1` | B1–B7, B69 | `orig/src/cli.ts:427-480`, `orig/src/entrypoints/tui/options.ts:10-53`; `tests/parity/expected/help.json` |
| `ev_cli_2` | B8–B11, B64 | `orig/src/entrypoints/tui/command.ts:159-166`, `orig/src/cli.ts:258-289`; goldens `unknown-command`, `unknown-flag` |
| `ev_cli_3` | B12–B14, B76 | `orig/src/cli.ts:492-506`, `orig/src/index.ts:119-126`, `orig/src/entrypoints/bootstrap/gatedCommand.ts:16-40` |
| `ev_cli_4` | B15–B21 | `orig/src/entrypoints/tui/command.ts:33-49,167-170,215-217`; English catalogue `chunk-j2hk0tf4.js` |
| `ev_cli_5` | B22–B25 | `orig/src/entrypoints/tui/command.ts:184-238`; `help-resume.json` |
| `ev_cli_6` | B26–B34, B72 | `orig/src/entrypoints/exec/command.ts:24-271`, `help.ts:81-303`, `assertValidOptions.ts:23-367`, `handler.ts:325-379,1280-1333`, `constants.ts:11-53` |
| `ev_cli_7` | B35–B38 | `orig/src/entrypoints/daemon/command.ts:20-127`, `constants.ts:3-6` |
| `ev_cli_8` | B39, B40, B73 | `orig/src/entrypoints/search/command.ts:9-66`, `run.ts:150-172`, `orig/src/utils/commanderParsers.ts:16-33` |
| `ev_cli_9` | B41, B42, B75 | `orig/src/entrypoints/update/command.ts:4-20`, `run.ts:130-178,240-270` |
| `ev_cli_10` | B43–B48 | `orig/src/entrypoints/mcp/command.ts:8-113`, `plugin/command.ts:13-119`, `computer/command.ts:12-105`; their goldens |
| `ev_cli_11` | B49–B51, B74 | `orig/src/entrypoints/doctor/command.ts:8-93`, `constants.ts:61-159` |
| `ev_cli_12` | B52–B63 | `orig/src/cli.ts:463-478` and each `*/command.ts` listed in the clause |
| `ev_cli_13` | B65–B68 | `orig/src/cli.ts:272-420,544-558`, `orig/src/environment.ts:484-521`, `orig/src/index.ts:174-190` |
| `ev_cli_14` | B70, B71 | `vendor/node_modules/commander/lib/command.js:533-539,1632-1635,1940-1958,2035-2160,2622-2633` |
| `ev_cli_15` | B77–B81 | `orig/src/entrypoints/exec/run.ts:300-325`, `daemon/run.ts:275-282`, `tui/bootstrap.ts:373-378`, `orig/src/utils/runtimeSettingsBootstrap.ts:60-140`, `orig/packages/runtime/settings/src/SettingsManager.ts:3923-4013`, `RuntimeSettingsOverlay.ts:22-29` |

## Open questions

1. **Trailing root options after a prompt.** B11 predicts that
   `droid "fix it" --auto high` treats `--auto high` as prompt text because
   `enablePositionalOptions()` stops root option parsing at the first operand and
   `tui` allows unknown options. Settle by running the original with a TTY and
   inspecting the resulting session's autonomy level, or by a unit test of the
   router. Blocks the `[derived]` part of B11 only.
2. **`droid mcp` / `droid plugin` / `droid computer` with no subcommand.** B71 is
   derived from commander's `else if (this.commands.length) help({ error: true })`
   branch. A run of the original with no TTY would confirm both the stream
   (stderr) and exit 1. Blocks B71.
3. **Locale resolution for E1/E2.** B21 is inferred from
   `initI18nFromLocalSettings()`; the exact locale files consulted (user settings
   only, or user + project) is unconfirmed. Blocks the precision of B21.
4. **Whether `--auto` accepts the documented `low|medium|high` only, or also the
   reasoning tiers.** `autonomyFlag.ts` says three; `exec`'s zod schema uses the
   `AutonomyLevel` enum. If `AutonomyLevel` grows, the two diverge. Blocks
   nothing today.
5. **Version output when `CLI_VERSION` is unset.** The code path yields
   `unknown`; no golden records it. Settle by recording a case with the variable
   cleared.

## Clean-room notes

**Must reproduce (contract):**

- The literal root usage line, description, option order, command order and the
  examples-and-URL trailer.
- Every visible command's name, aliases, arguments, options, values and
  defaults exactly as recorded in B27–B51's goldens, including the curated
  (not generated) `exec` help page and its computed model default.
- The classification rule: a word matching a command or alias dispatches it;
  anything else becomes prompt text on the default command, including
  option-shaped tokens.
- The non-TTY refusal text, its line order, the mintty variant, the `resume`
  variant without the `notACommand` line, and exit 1.
- Exit codes: 0 for help/version/successful commands; 1 for usage errors, the
  refusal, refused invocations and failed runs; 130 for an aborted search.
- Hidden commands must remain dispatchable but invisible, and flag-gated ones
  must fail closed — including through `help <name>` — with
  `unknown command '<name>'` and exit 1.
- The two legacy hook words and the `deployment` pre-router interception.
- Launch-path anchoring and `--cwd` entry semantics, including the
  `Error changing to directory:` refusal and the argv-token rewriting that lets a
  sealed child be re-executed from the new directory.
- The precedence `--settings` → `FACTORY_RUNTIME_SETTINGS_PATH` → runtime overlay
  level inside the settings hierarchy, and
  `--append-system-prompt[-file]` → `FACTORY_APPEND_SYSTEM_PROMPT`.

**Explicitly not part of the contract:**

- Column alignment inside help pages beyond what the goldens record, and any
  wording in sections the goldens do not contain (`Autonomy Levels`, `Mission
  Mode`, `Available Models`, `Model details`, `Pinning the Latest Model`,
  `Authentication`) is fixed only by B27's golden, not by prose in this spec.
- The internal commander plumbing (token replay, `Object.create` probe) — only
  its observable effect (B64–B66) is required.
- The full text of every validation message for `exec` flag conflicts; only the
  `Invalid flags: …` shape and the traffic-light conditions are contract.
- Localization of messages other than the refusal.
- Any behaviour of `droid exec` once the run starts (agent loop, streaming
  frames, tool selection resolution) — see the exec spec.