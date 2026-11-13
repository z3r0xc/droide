# Native layer (non-JS payload)

- **Target:** the `droide` CLI shipped from this repository
- **Status:** draft
- **Owner:** native/bundled-runtime owner
- **Related:** `specs/00-context.md`; session-index spec (SQLite schema/search semantics); tools spec (Grep/Glob/Script tool surfaces); daemon spec (JSON-RPC transport and terminal callers); agent-browser tool/skill spec

## Purpose

`droide` ships a single Bun executable plus eight kinds of non-JavaScript
payload: a PTY library, a Rust browser-automation CLI, a ripgrep binary, an
fuzzy-finder shared library, a V8 script worker, a N-API keyring addon, a pinned
SQLite library and two WebAssembly modules. This spec fixes the _boundary_ at
each of them — how it is located, extracted, started, fed and torn down, and
what a user sees when it is missing or broken — so that a conforming build
can swap any one of them for an equivalent without changing observable CLI
behaviour.

## Scope

Covers the payloads inventoried in §Data & config, their on-disk placement under the
state root, the environment variables that override or redirect them, the
wire contracts at each boundary (FFI symbol table, child-process argv/stdio
framing, WASM instantiation) and the failure text those boundaries produce.

Does **not** cover: what the payloads _compute_ (fuzzy-ranking quality, the SQL
schema and search semantics of the session index, the Script language itself,
agent-browser's own CLI), which belong to the session-index/tools/agent-browser
specs; the JSON-RPC transport that carries terminal notifications (daemon
spec); and the SEA packaging format. `apply-seccomp` (Linux helper) appears only
as a doctor row because the artefact is empty in this extraction — see
Open questions.

## Terms

**Citation base.** `src/…`, `packages/…` are relative to
`evidence/original/windows-x64/`; `vendor:…` is relative to
`evidence/original-vendor/windows-x64/node_modules/`; `X:…` is relative to
`evidence/extracted/windows-x64/`.

| Term                     | Meaning                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **state root**           | `homePath()` + `dirName()` (vendor prefix elided); `~/.droide` in production tier (`src/utils/ripgrepEmbedded.ts:48-56`).                                    |
| **bin dir**              | `<state root>/bin` — every extracted native payload except the script worker's own directory lives here.                                                     |
| **PTY library**          | `bun-pty`'s Rust `.dll`/`.so`/`.dylib`; exports `bun_pty_*` (X:`rust_pty-fazdxkv2.dll`, `librust_pty-*`).                                                    |
| **PTY handle**           | Non-negative `i32` returned by `bun_pty_spawn`; `-1`-style negative values mean failure (`vendor:bun-pty/src/terminal.ts:165-172`).                          |
| **Bundled binary state** | One of `current`, `stale`, `modified`, `missing`, `removed`, `override`, `override-ignored`, `not-bundled` (`src/utils/enums.ts:270-290`).                   |
| **fff**                  | The fuzzy finder engine (`libfff_c` / `fff_c.dll`), `@ff-labs/fff-bun` in a compiled binary (`packages/daemon-core/src/utils/file-search/index.ts:236-284`). |
| **slot**                 | A string of ≥16 KiB UTF-8 lifted out of a Script frame header into a trailing byte buffer (`src/repl/protocol/constants.ts:24-29`).                          |
| **worker**               | The extracted `script-runtime` process that evaluates a Script (`src/repl/worker/nativeBinary.ts:53-69`).                                                    |
| **ipc frame**            | `u32le` header length + JSON header + slot buffers (`src/repl/protocol/frame.ts:21-25`).                                                                     |

## Observable behaviour

### PTY (`rust_pty`)

**B1** — At process start, before `bun-pty` is imported, the CLI selects one
library by `process.platform`+`process.arch` and assigns its embedded path to
`BUN_PTY_LIB`; an unsupported pair leaves `BUN_PTY_LIB` unset and logs
`Warning: No embedded library found for platform=<p> arch=<a>`
(`src/embed-native-libs.ts:28-49`).

**B2** — Five artefacts exist, one per target: Windows x64 (`rust_pty.dll`),
Linux x64/arm64 (`librust_pty.so`, `librust_pty_arm64.so`), macOS x64/arm64
(`librust_pty.dylib`, `librust_pty_arm64.dylib`). All five export exactly
`bun_pty_spawn`, `bun_pty_write`, `bun_pty_read`, `bun_pty_resize`,
`bun_pty_kill`, `bun_pty_get_pid`, `bun_pty_get_exit_code`, `bun_pty_close`
(`src/embed-native-libs.ts:18-26`; X:ELF/dylib export tables; X:PE export table).

**B3** — Loading is FFI, not a child process: `dlopen(libPath, …)` declares
`spawn(cstring,cstring,cstring,i32,i32)->i32`,
`write(i32,pointer,i32)->i32`, `read(i32,pointer,i32)->i32`,
`resize(i32,i32,i32)->i32`, `kill(i32)->i32`, `get_pid(i32)->i32`,
`get_exit_code(i32)->i32`, `close(i32)->void`. A load failure is logged
`Failed to load lib` and the module still loads (`vendor:bun-pty/src/terminal.ts:97-128`).

**B4** — Library resolution order: `BUN_PTY_LIB` when it exists; else a
statically-analysable `require` of the build's own relative path; else the
first existing of three `rust-pty/target/release` layouts. Nothing found throws
`librust_pty shared library not found.` followed by `Checked:` and the
`BUN_PTY_LIB` value plus each candidate path (`vendor:bun-pty/src/terminal.ts:31-95`).

**B5** — Spawn: `file` and every element of `args` are single-quote quoted and
joined with spaces into one command line; the Rust side re-splits it with
shell-words. `cwd` defaults to the caller's cwd. `env` is serialised as
`K=V` records joined by NUL with two trailing NULs (`K=V\0K2=V2\0\0`); absent,
the env block is a single NUL. `cols`/`rows` default to 80/24
(`vendor:bun-pty/src/terminal.ts:10-13,147-171`).

**B6** — A negative handle from `bun_pty_spawn` throws `PTY spawn failed`; a
successful spawn then reads the child pid once (`vendor:bun-pty/src/terminal.ts:172-175`).

**B7** — Output framing is **raw byte chunks, not lines**: a background loop
calls `bun_pty_read` into a 4096-byte buffer, decodes UTF-8 in streaming mode
so a multi-byte sequence split across reads is not corrupted, and delivers each
non-empty decode as one `onData(string)` callback
(`vendor:bun-pty/src/terminal.ts:225-239`).

**B8** — Exit: read returning `-2` means the child exited — the decoder is
flushed, `bun_pty_get_exit_code(handle)` is read once and `onExit({exitCode})`
fires, ending the loop. Any other negative return flushes the decoder and stops
the loop **without** firing `onExit`. A zero-length read sleeps 8 ms and retries
(`vendor:bun-pty/src/terminal.ts:240-259`).

**B9** — `write(data)` sends the UTF-8 bytes and ignores the FFI return value
(no partial-write retry, no error); after `kill` it is a no-op
(`vendor:bun-pty/src/terminal.ts:202-206`).

**B10** — `resize(cols, rows)` updates the accessor values first, then calls the
FFI; a resize failure is not observable (`vendor:bun-pty/src/terminal.ts:208-213`).

**B11** — `kill(signal = "SIGTERM")` marks the terminal closing, calls
`bun_pty_kill` then `bun_pty_close`, and synchronously fires
`onExit({ exitCode: 0, signal })`. The signal is **not** transmitted to the
child and the real exit code is never read on this path — a user-initiated close
is always reported as exit code 0 with signal `SIGTERM`
(`vendor:bun-pty/src/terminal.ts:215-221`).

**B12** — `pid`/`cols`/`rows` report the last known values and `process` is the
constant string `"shell"`; no process title is ever read
(`vendor:bun-pty/src/terminal.ts:180-191`).

### Daemon terminal surface (the only caller of the PTY)

**B13** — `daemon.create_terminal` takes `{terminalId, cols?, rows?, cwd?,
env?}`; a second create for a live or pending id returns
`{success:false, error:"TerminalIdExists"}`, never an error frame
(`packages/sdk-core/src/protocol/daemon/schemas/terminal.ts:15-49`;
`packages/daemon-core/src/server/handlers/terminal-request-handler.ts:298-315`).

**B14** — Shell selection: a configured shell is accepted only from
`/bin/{bash,sh,zsh,dash}`, `/usr/bin/{bash,sh,zsh}`, `cmd.exe`,
`powershell.exe`, `pwsh.exe`; on Windows the value is reduced to its lowercased
basename first. Anything else logs `Untrusted shell detected, using default` and
falls back to `/bin/bash` (linux), `/bin/zsh` (darwin), `/bin/sh` (bsd/sunos/aix)
or `cmd.exe` (win32/win64) (`packages/daemon-core/src/terminal/terminal-manager.ts:29-52,92-118`).

**B15** — Child environment = the daemon login-shell environment (or
`process.env`) ∪ caller `env` minus a fixed blocklist
(`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, `TMPDIR`, `SUDO_USER`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
`GPG_AGENT_INFO`), then the daemon's `getChildEnvironment` hook. `PATH` is
deliberately overridable (`packages/daemon-core/src/terminal/terminal-manager.ts:144-175`;
`src/entrypoints/daemon/handler.ts:559-571`).

**B16** — `spawn(workload.command, workload.args, {name:'xterm-256color', cols,
rows, cwd, env})` is called with the cwd canonicalised to an existing
directory; any throw is wrapped as `Failed to spawn terminal with shell`. The
`name` option is accepted and **ignored** by bun-pty, so `TERM` is only whatever
the inherited environment carries (`packages/daemon-core/src/terminal/terminal-manager.ts:131-198`;
`vendor:bun-pty/src/terminal.ts:147-152`).

**B17** — Each `onData` chunk updates `lastActivity`, is fed to the terminal
state tracker, and is emitted as `daemon.terminal_data`
`{type, terminalId, data}`; nothing is coalesced or re-framed
(`packages/daemon-core/src/terminal/terminal-manager.ts:232-239`;
`…/schemas/terminal.ts:157-161`).

**B18** — `onExit` emits `daemon.terminal_exit` `{type, terminalId, exitCode,
signal}` with `signal` defaulting to `SIGTERM`, then drops the terminal from the
id→terminal and terminal→session maps; a non-zero code or any signal increments
`DAEMON_TERMINAL_ABNORMAL_EXIT_COUNT`
(`packages/daemon-core/src/terminal/terminal-manager.ts:241-264`;
`…/schemas/terminal.ts:163-168`).

**B19** — `write`/`resize`/`close` on an unknown id return `false` at the
manager and the request handler answers `Terminal not found`
(`packages/daemon-core/src/terminal/terminal-manager.ts:267-324`;
`…/terminal-request-handler.ts:325-388`).

**B20** — A write that throws is logged, the terminal is closed, and the call
returns `false` (`packages/daemon-core/src/terminal/terminal-manager.ts:276-285`).

**B21** — `list_terminals` returns `{id, pid, cols, rows, createdAt,
state:{serialized, plainText, cols, rows, timestamp, cursorHidden?}}` per live
terminal, from the state tracker snapshot — not from the process
(`packages/daemon-core/src/terminal/terminal-manager.ts:330-349`).

**B22** — A terminal whose client disconnects is kept for a 30 s grace period
before cleanup; orphan sweeps are opt-in by interval
(`packages/daemon-core/src/terminal/terminal-manager.ts:48,533-572`).

### ripgrep (`rg`)

**B23** — Resolution order: `DROIDE_RIPGREP_PATH` → `DROIDE_NPM_MODULES_DIR`
sub-path (`@vscode/ripgrep/bin/rg[.exe]`) → non-production: symlink
`~/.droide/bin/rg` to `which rg` (never on Windows) → production: extract the
embedded binary and stamp `.rg-version` with `CLI_VERSION`. An override that is
not an absolute, existing, regular (and on POSIX executable) file is logged and
ignored (`src/utils/ripgrepEmbedded.ts:93-110,139-215`;
`src/utils/npmDepResolver.ts:41-49,72-133`).

**B24** — Extraction writes `rg.<pid>.tmp` beside the target and renames it into
place, then writes the version stamp; a failure unlinks the temp file, logs
`Failed to extract ripgrep binary` and rethrows
(`src/utils/ripgrepEmbedded.ts:179-212`).

**B25** — A missing binary is retried at most 3 times per process. While
retries remain the user sees `Ripgrep binary not found. Initialization failed
but retries are still available — subsequent calls may succeed.`; once
exhausted: `Ripgrep binary not found and could not be restored after retries.
Do NOT retry Grep or Glob tools — they will continue to fail this session. Use
the Execute tool with shell commands (e.g. find, grep) as alternatives.` Both
carry kind `unavailable`, `exitCode: null`, `stderr: ''`
(`src/utils/grep-utils.ts:78-122,475-502`).

**B26** — Daemon file listing: `rg --files --no-messages --null
--path-separator / [--hidden] --glob '!**/<dir>/**'… --glob
'!**/<excludedFile>' .` in the target cwd, `timeout` 10 s. Defaults are
`maxBuffer` 100 MB; the `daemon.list_files` RPC passes 6 MiB output buffer,
`maxFiles` 25 000 and `maxBytes` 4 MiB because the reply travels over the
daemon frame limit (`packages/daemon-core/src/utils/file-listing.ts:23-26,91-110,174-180`;
`packages/daemon-core/src/server/handlers/request-handler.ts:9834-9854`).

**B27** — Listing output is NUL-terminated records with a leading `./` stripped
and no reordering. When a cap is hit, the list is sorted shallowest-first, cut,
and `truncated: true` is set (the byte cap additionally reports `capped`). Exit
1 yields an empty listing; exit 2 with stdout merges the surviving prefix with a
bounded breadth-first walk (25 000 entries, depth 8, 5 s) and marks the result
truncated; an exit before any output yields `{files: [], totalFiles: 0}`
(`packages/daemon-core/src/utils/file-listing.ts:112-130,136-215`;
`packages/daemon-core/src/utils/file-listing-utils.ts:71-78`).

**B28** — Agent search: `rg --no-config <output flags> <caller args> <exclusions>
-- <pattern> <paths…>` with `timeout` 10 s and `maxBuffer` 20 MB. Output flags
are exactly `--json` (LF-framed JSON records) or `--null --path-separator /`
(NUL-framed paths). Exclusions (`!.git`, plus macOS home-folder noise) are
appended after caller globs so they cannot be re-included
(`src/utils/grep-utils.ts:156-164,415-529`; `src/utils/constants.ts:27-30`).

**B29** — Search outcomes: exit 0 → `{stdout, stderr, truncated:false}`; exit 1
→ empty result, no error; exit 2 with at least one match record → the partial
results are returned with the sanitised diagnostics; exit 2 with no match →
kind `reported-errors`, `Ripgrep reported errors and returned no results`;
killed by the runner's timeout → kind `timed-out`, `Search timed out after
<n>s. …`; terminated by another signal → kind `signaled`; exit >2 → kind
`exited`; maxBuffer before any complete record → kind `output-overflow`;
maxBuffer with complete records → results returned and
`[Results truncated: output exceeded maximum buffer size.…]` appended to stderr
(`src/utils/grep-utils.ts:536-682`).

**B30** — stderr is sanitised (secrets scrubbed, first 20 lines and 4 000 chars,
then `… N more lines`) before it reaches an error or a tool result
(`src/utils/grep-utils.ts:124-154`).

### fff (`fff_c`) — primary fuzzy file search

**B31** — fff serves a request only when: the cwd canonicalises to a git
workspace root (nearest ancestor with `.git`, file or directory), and the query
is empty or matches `^[\w./-]+$`. Otherwise the request goes to ripgrep
(`packages/daemon-core/src/utils/file-search/index.ts:193,355-385,656-663`).

**B32** — The library is loaded lazily and once: under Bun `@ff-labs/fff-bun`
(`FileFinder.ensureLoaded()`), then `@ff-labs/fff-node`. Every failure — missing
or AV-blocked binary, unsupported platform — permanently disables fff for the
process and logs `[Daemon] File search native library unavailable, using
ripgrep path` (`packages/daemon-core/src/utils/file-search/index.ts:236-291`).

**B33** — An instance is created with `create({ basePath: <git root>, aiMode:
true })`; creation failure logs
`[Daemon] File search failed to create file finder, using ripgrep path` and
negative-caches the root (`…/file-search/index.ts:387-424`).

**B34** — A request waits at most 250 ms for the initial scan
(`waitForScan(30_000)` in the background). Not ready → this request falls back
to ripgrep. A scan still unfinished 30 s after creation destroys the instance
and negative-caches the root for 10 minutes
(`…/file-search/index.ts:154-174,677-699`).

**B35** — Registry: at most 4 live instances keyed by git root, idle entries
destroyed after 30 min, evicted LRU-first on access; `destroy()` is called on
every eviction and on process reset
(`…/file-search/index.ts:171-174,293-329,426-457`).

**B36** — Query mapping: a plain `cwd` sub-path becomes a ranking hint
`"<subpath>/ "` prefixed to the query; the hint is omitted when the sub-path
contains anything outside `[\w./-]`. Correctness comes from re-basing every
result path onto the cwd and dropping paths outside it
(`…/file-search/index.ts:464-472,704-714`).

**B37** — Records: `mixedSearch(query, {pageSize: 400, pageIndex: <item
offset>})` returns `items[].item.relativePath` plus `items[].type`
(`"directory"` marks a directory) and `totalMatched`. Directories are rendered
with a trailing `/`. Paging stops at 12 pages or when a page is short
(`…/file-search/index.ts:76-101,505-566`).

**B38** — An empty query is served directories-first: `directorySearch` then
`mixedSearch` filtered to non-directories, filling up to `maxResults` with no
duplicates (`…/file-search/index.ts:740-779`).

**B39** — `totalFiles` is the count of indexed items that survive the same
filters, computed by paging the whole index once per `${cwdPrefix}\0${showHidden}`
and cached until the watcher reports a change (`…/file-search/index.ts:597-649`).

**B40** — A single failed native search destroys the instance, negative-caches
the root and returns `undefined` so the caller re-runs on ripgrep; the watcher
subscription is established lazily once `isWatcherReady` is true
(`…/file-search/index.ts:573-595,781-808`).

**B41** — `searchFiles` is fff-first, ripgrep-second: an `undefined` from fff
means "load the ripgrep listing (15 s TTL, at most 4 listings) and rank with
Fuse at threshold 0.5"; a ripgrep listing failure yields
`{files: [], totalFiles: 0}` (`…/file-search/index.ts:811-871`;
`…/file-search/ripgrep-listing.ts:20-22,103-152`).

**B42** — fff's ABI is the versioned options struct: `FileFinder.create` fills a
release-fixed `FffCreateOptions` buffer (version, base/frecency/history/log
paths, mmap-cache, content-indexing, watch, ai-mode, log level, three cache
budgets, fs-root/home-dir flags) and calls `fff_create_instance_with(ptr)`
returning a result envelope with `success`/`handle`/`error`
(`vendor:@ff-labs/fff-bun/src/ffi.ts:531-599`; `…/finder.ts:129-146`).

### agent-browser

**B43** — `agent-browser` is **never spawned by the CLI for work**. It is a Rust
CLI (`agent-browser/0.37.1`) extracted once, put on the child `PATH`, and then
invoked by the model through the shell tool; the CLI only (a) extracts it lazily,
(b) injects `AGENT_BROWSER_*` defaults, (c) cleans stale sockets at startup
(`X:agent-browser-wcst4wbn` strings; `src/tools/executors/client/shell/shell-executor.ts:428-453`).

**B44** — Extraction targets `<bin dir>/agent-browser(.exe)` plus
`<state root>/tools/agent-browser/skill-data/*`; it is triggered by a SHA-256
mismatch against the build's recorded digest **or** an absent skill-data dir,
guarded by `<tool dir>/.extracting.lock` (`wx`). A loser waits up to 30 s and
then, if either artefact is still absent, throws
`agent-browser extraction by another process did not complete successfully`
(`src/utils/agentBrowserEmbedded.ts:155-179,198-303`).

**B45** — On POSIX the binary is written to a UUID temp name, chmodded and
renamed (new inode for code-signing/ETXTBSY reasons); on Windows an existing
file is removed first. Stale `tools/agent-browser/{bin,dist}` and
`.agent-browser-sha256.json` are deleted as part of extraction
(`src/utils/agentBrowserEmbedded.ts:232-285`).

**B46** — Invocation detection (which drives extraction, `PATH` and env
injection) matches `agent-browser` at the start of a command or after a shell
operator/whitespace/bracket, ignoring lines that begin with
`echo|printf|cat|grep|awk|sed|read` unless the token follows `;|&`
(`src/tools/executors/client/shell/shell-executor.ts:195-206`).

**B47** — Every detected invocation also sets
`AGENT_BROWSER_SKILLS_DIR=<state root>/tools/agent-browser/skill-data` and
prepends `<bin dir>` to `PATH` (Windows: a single `Path` key, all casings
removed first) (`src/tools/executors/client/shell/shell-executor.ts:428-484`;
`src/services/TerminalService/LocalTerminalService.ts:1411-1412`).

**B48** — Unless the user set it, named `--idle-timeout`, or the command
attaches to another browser, an `agent-browser` command gets
`AGENT_BROWSER_IDLE_TIMEOUT_MS=1800000` (30 min)
(`packages/utils/src/agent-browser/desktopCdp.ts:17,127-151`).

**B49** — For the desktop's CDP proxy URL
`ws://127.0.0.1:<DROIDE_DESKTOP_CDP_PORT>/devtools/browser/<id>` the CLI
derives `AGENT_BROWSER_CDP` (adding `?session=`, `?agent=`) and
`AGENT_BROWSER_SESSION="fcdp-<port>-<16 hex of sha256([sessionId, agentSessionId])>"`;
an unrecognised identity shape yields no settings at all
(`packages/utils/src/agent-browser/desktopCdp.ts:19-73`).

**B50** — Pinning discovery only happens when `AGENT_BROWSER_CDP` is the desktop
proxy, `DROIDE_DESKTOP_CDP_IDENTITY=1`, no
`AGENT_BROWSER_{PIN_TAB,PROVIDER,PROFILE,AUTO_CONNECT,ENGINE,CONFIG}` is set and
the command's connection is unambiguous; a `read <url>`-only command then runs
without `AGENT_BROWSER_CDP`, otherwise `AGENT_BROWSER_PIN_TAB=1`. A command that
names another browser gets session suffix `-ext`
(`packages/utils/src/agent-browser/desktopCdp.ts:88-220`;
`packages/utils/src/agent-browser/invocation.ts:288-436`).

**B51** — A foreground `agent-browser` command is capped at 10 minutes
(`AGENT_BROWSER_FOREGROUND_TIMEOUT_SECONDS`); background (`fireAndForget`)
invocations are exempt (`src/tools/executors/client/execute-cli.ts:115-120,1037-1041`).

**B52** — Startup cleanup scans the agent-browser runtime directory —
`$AGENT_BROWSER_SOCKET_DIR`, else `$XDG_RUNTIME_DIR/agent-browser`, else
`~/.agent-browser`, scoped under `namespaces/<sanitised>/run` — and unlinks only
sockets whose `connect` is refused within 250 ms and whose inode is unchanged.
It is a no-op on Windows (`src/utils/agentBrowserCleanup.ts:30-109,117-141`).

**B53** — `DROIDE_AGENT_BROWSER_PATH` accepts an absolute file or the package
root; on Windows arm64 the x64 binary
(`agent-browser/bin/agent-browser-win32-x64.exe`) is an accepted fallback. Any
unusable override is reported by doctor as
`<VAR>=<value> is not usable` / `is missing` (`src/utils/npmDepResolver.ts:50-60,192-260`;
`src/entrypoints/doctor/checks/binaries.ts:264-273`).

### script-runtime (Script worker)

**B54** — The worker is content-addressed: bytes of the embedded
`script-runtime` are hashed and extracted to
`<state root>/bin/script-runtime-<sha256>/script-runtime(.exe)` with mode
0700, staged as `<uuid>.tmp` and renamed. The installed copy is verified by byte
equality, never by a stamp; concurrent callers share one extraction and a failed
attempt is forgotten (`src/repl/worker/nativeBinary.ts:53-135`).

**B55** — If the embedded asset cannot be read the user sees
`The isolated Script runtime is not installed. Rebuild or reinstall Droide.`
(`src/repl/worker/nativeBinary.ts:95-104`).

**B56** — Start: the absolute binary path is quoted and handed to
`sandbox.wrapCommandArgv`, which returns the argv (just `[binary]` when nothing
sandboxes, a wrapper otherwise) and the child environment; `wrapWorkloadCommand`
may then prefix a Linux cgroup launcher. It is spawned with `shell:false`,
`stdio:['pipe','pipe','pipe']`, `windowsHide:true`, `detached` on POSIX and an
environment reduced to `LANG, LANGUAGE, SystemRoot, SYSTEMROOT, TEMP, TMP,
TMPDIR, TZ, WINDIR` plus every `LC_*`. No `PATH`, no user variables
(`src/repl/worker/processClient.ts:122-132,235-248,1368-1391`;
`src/services/SandboxService.ts:661-682`).

**B57** — Handshake: the worker must send `{"type":"ready","protocolVersion":2}`
within 10 s and before any other frame. A second `ready`, or any frame before
it, fails the transport. A first byte of `{` on the stream is read as a v1
NDJSON worker and fails as a protocol mismatch
(`src/repl/protocol/schema.ts:253-260`; `src/repl/worker/processClient.ts:69,824-849`;
`src/repl/protocol/frame.ts:456-476`).

**B58** — Framing (both directions): `u32le` header byte length, the UTF-8 JSON
header, then each declared slot's bytes in order. A slot is
`{"path":[…],"bytes":n}` with a non-empty path of string/array-index parts; the
value at that path must be JSON `null`, and the received bytes are installed
there, so `"slots"` never reaches the receiving side
(`src/repl/protocol/frame.ts:21-25,304-360,418-500`).

**B59** — Strings of ≥16 KiB UTF-8 are lifted into slots when the host encodes a
tool result; everything below stays inline. Slot entries are accounted to the
byte in the header budget, and each string is serialized exactly once
(`src/repl/protocol/constants.ts:24-29`; `src/repl/protocol/frame.ts:236-267,273-297`).

**B60** — Frame ceilings: header ≤ 2 × 128 MiB (268 435 456 B), slots ≤
max(output budget 5 MiB, input budget 1 MiB) = 5 MiB; exceeding either fails the
stream with `Script protocol frame too large` **before** buffering the bytes. A
malformed header or slot path fails with `Invalid Script protocol frame`. A
terminal Script result returned inline by WaitForScript is capped at 64 KiB
(`src/repl/protocol/constants.ts:18-22,42-61`;
`packages/core/src/tools/definitions/cli/script/schema.ts:23-32`;
`src/repl/protocol/frame.ts:469-487`).

**B61** — Inbound `evaluate` carries `{type, code (transpiled), bindings[],
inputs?, mission?:{enabled:true}, limits:{heldBytes,inputBytes,outstandingCalls,
outputBytes,outputItems,heapBytes,slotBytes}}`; the worker refuses a mission that
is not enabled, and the host sends `tool_result` with
`{type, toolUseId, isError, heldElsewhere, content?, slots?}`
(`src/repl/protocol/schema.ts:208-250`; `src/repl/protocol/constants.ts:31-40`).

**B62** — Evaluation must be acknowledged by `evaluation_started` within 10 s or
the run fails (`evaluation_start_timeout`). The parent dispatches at most 8
inner tool calls concurrently (a Task takes no slot) and may queue up to 64 MiB
of unsent results on the worker's stdin; the worker itself refuses beyond
`outstandingCalls: 128`, 1 MiB of input per call and 5 MiB / 1 024 items of
output per evaluation (`src/repl/worker/processClient.ts:70,101-120`;
`packages/core/src/tools/definitions/cli/script/schema.ts:23-32`).

**B63** — Teardown `abort`: kill the whole process group with `SIGKILL`
immediately, drop content dispatches. `complete`: end stdin, then
`SIGTERM` → `SIGKILL` at 500 ms steps, then a forced child kill on Windows, and
one final group `SIGKILL` even after a clean leader exit
(`src/repl/worker/processClient.ts:574-649`).

**B64** — A worker that cannot start produces
`Script worker could not start.<mismatch detail> Use direct tools instead;
Script is disabled until Droide restarts.` and disables the Script tool for the
process; a protocol mismatch's own message is appended
(`src/repl/worker/processClient.ts:1441-1450`).

**B65** — Only two things start a worker: the Script run path
(`createReplWorkerClient` at `src/repl/ScriptRuns.ts:2704-2707`) and the TUI's
prewarm (`prewarmReplWorker`, `src/entrypoints/tui/bootstrap.ts:556-562`;
`src/services/SessionService.ts:283`). `droide doctor` runs the binary with
`--check-sandbox` and expects the exact line `V8 memory sandbox enabled`
(`src/entrypoints/doctor/checks/binaries.ts:142-150`; X:script-runtime strings).

### keytar (keyring)

**B66** — The addon is a node-keytar N-API build (`_register_keytar_`
export; `napi_*` imports; `node-keytar/src/main.cc` in its PDB path) exposing
`getPassword(service, account)`, `setPassword(service, account, value)` and
`findCredentials` (`X:keytar-hqpjzrak`; `src/utils/keytarEmbedded.ts:131-139`).

**B67** — Resolution order: `DROIDE_KEYTAR_PATH` → `DROIDE_NPM_MODULES_DIR` +
`keytar/build/Release/keytar.node` → extract the embedded copy to
`<bin dir>/keytar.node` (mode 0755) stamped with the embedded SHA-256 in
`<bin dir>/.keytar-sha256`. Re-extraction happens only when the stamp differs
(`src/utils/keytarEmbedded.ts:35-128,156-186`; `src/utils/npmDepResolver.ts:61-65`).

**B68** — Loading is `process.dlopen({exports:{}}, path)` (no `require`), cached
for the process; any failure logs `Failed to load keytar native module via
dlopen` and resolves to `null`, never throws
(`src/utils/keytarEmbedded.ts:131-152,165-186`).

**B69** — Keyring calls always use a service name and an account: default
service `Droide CLI`, default account `auth-encryption-key`, suffixed `-dev`
when the build is not production tier, or the macOS `security`-CLI variant
`auth-encryption-key-security-cli`; Prem uses
`<keyringAccount|"prem-auth">-<sha256(directory) hex>`
(`packages/runtime/auth/src/credentials/CredentialsStorage.ts:56-69,148-192`;
`packages/runtime/auth/src/auth/prem/storage.ts:85-113`).

**B70** — With the module unavailable, `get` throws `Cannot read from keyring:
keytar module unavailable. Credentials cannot be read securely.` and `set`
throws `Cannot save to keyring: keytar module unavailable. Credentials cannot be
stored securely.` — reads and writes **fail**, they never look like missing data
(`packages/runtime/auth/src/storage/keyring/KeyringClient.ts:179-231`).

**B71** — Concurrent `get`s for one account share a single OS call; concurrent
`set`s for one account are serialised in issue order so a later value is never
silently dropped. Both swallow nothing: each waiting `set` gets its own attempt
and its own error (`…/KeyringClient.ts:134-157,204-231`).

**B72** — The stored envelope key is base64 of a 32-byte key. A missing or
wrong-length key marks secure storage failed for the process and falls back to
the keyfile (`auth.v2.key`); a failed store never triggers creating a
replacement key (`CredentialsStorage.ts:334-408`). `DROIDE_DISABLE_KEYRING`
disables the keyring path entirely (`packages/environment/src/constants/index.ts:111`).

### SQLite

**B73** — The session index opens through one driver: `bun:sqlite` under Bun,
`node:sqlite` (`DatabaseSync`) elsewhere; every connection is read-only-immutable
when opened as a snapshot, otherwise read-write
(`packages/runtime/session-index/src/driver.ts:193-221`).

**B74** — macOS only, and before the first `Database` in the process, the CLI
pins the bundled amalgamation: the file is extracted to
`<bin dir>/libsqlite3-<first 16 hex of sha256>.dylib` via a staged write +
atomic rename and handed to `Database.setCustomSQLite`. A non-digest `.sha256`
placeholder means "no library". Any failure selects `libsqlite3.dylib` again and
leaves the runtime's library in place; every failure degrades to "no pin"
(`src/utils/sqliteEmbedded.ts:43-148`; `packages/runtime/session-index/src/driver.ts:141-191`).

**B75** — Open sequence: read `PRAGMA auto_vacuum`, set incremental only when it
differs, then run `journal_mode=WAL`, `wal_autocheckpoint=0`,
`journal_size_limit=<limit>`, `synchronous=NORMAL`, `busy_timeout=<default>`,
`foreign_keys=ON`, then report `sqlite_version()`
(`packages/runtime/session-index/src/driver.ts:854-868`;
`packages/runtime/session-index/src/constants.ts:334-341`).

**B76** — Under Bun only, one `SELECT sqlite_version()` runs per open and is
logged with whether the pin took (`bundled`/`runtime`); a version below 3.51.3
is logged once as `Session index SQLite version is below the minimum`, **not**
refused, and the index keeps running
(`packages/runtime/session-index/src/driver.ts:236-278`;
`packages/runtime/session-index/src/constants.ts:60-70`).

**B77** — Migrations live in `schema_migrations(version, name, checksum,
applied_at)`. Each pending migration runs in one `BEGIN IMMEDIATE` transaction
covering the ledger re-read, the DDL and its ledger row; the checksum is the
first 16 hex of sha256 over `version\0name\0normalised-sql`. A checksum
disagreement for a _known_ version throws
`Session index migration checksum mismatch`; a ledger that is merely ahead is
tolerated. A file with nothing pending is not written to at all
(`packages/runtime/session-index/src/migrate.ts:172-229,296-359`).

**B78** — The database path is `<state dir>/cache/session-index/index.db`; the
directory is marked `.metadata_never_index`. An unusable file is moved into
`quarantine/<timestamp>-<pid>/` beside it and a fresh file is created — never
deleted, and never unlinked from under a peer
(`packages/runtime/session-index/src/cache.ts:19-65`;
`packages/runtime/session-index/src/driver.ts:649-800`).

### WebAssembly

**B79** — SVG rasterisation uses the resvg WASM module in-process: `initWasm`
is called at most once per process with the embedded bytes, and a second call
would throw `Already initialized.`; fonts are handed over as the two bundled
TTF buffers because the WASM build reads no system fonts. Every render frees
the `Resvg` and `RenderedImage` handles
(`src/utils/images/svg.ts:668-704`; `X:index_bg-904m1xk3.wasm` exports
`resvg_new`, `resvg_render`, `renderedimage_asPng`, `renderedimage_pixels`;
`vendor:@resvg/resvg-wasm/index.mjs:548-550`).

**B80** — An SVG with no determinable size fails with `SVG has no size to
fit`; the rasteriser is always fitted to the requested box, never rendered at
the document's own size (`src/utils/images/svg.ts:672-687`).

**B81** — The int8 dot-product kernel is a WASM module over
`env.memory`: `dots(queryPtr, rowsPtr, count, dimensions, resultsPtr)`.
The module is accepted only if `WebAssembly.validate` accepts it; otherwise the
scalar implementation computes the same sums. Layout per matrix is the query
widened to int16, then the rows, then one int32 result per row, and the memory
never grows (`packages/runtime/session-index/src/int8-dot.ts:23-107`).

### Discovery surface

**B82** — `droide doctor --checks binaries` inspects every payload without
extracting: `current`/`stale`/`override` are probed; `missing` reports
`not extracted yet` (plus a folder-writability warning for ripgrep);
`removed` reports `removed after extraction`; `modified` reports `does not match
this build; Droide replaces it before use` (and is not executed); `not-bundled`
reports `not bundled for <platform> <arch>`; `override-ignored` names the
variable and value (`src/entrypoints/doctor/installationLayers.ts:603-629`;
`src/entrypoints/doctor/checks/binaries.ts:222-295`).

## Data & config

### Shipped artefacts (Windows x64 extraction of this build)

| Artefact in `X:`                        | Size         | Format / arch                 | Becomes                                                 |
| --------------------------------------- | ------------ | ----------------------------- | ------------------------------------------------------- |
| `rust_pty-fazdxkv2.dll`                 | 492 032 B    | PE32+ DLL, x86-64             | `BUN_PTY_LIB` (Windows)                                 |
| `librust_pty-6h2x94h6.so`               | 610 024 B    | ELF shared, x86-64            | `BUN_PTY_LIB` (Linux x64)                               |
| `librust_pty_arm64-kkpzdzzv.so`         | 555 704 B    | ELF shared, aarch64           | `BUN_PTY_LIB` (Linux arm64)                             |
| `librust_pty-0ydm4m2h.dylib`            | 516 976 B    | Mach-O dylib, x86_64          | `BUN_PTY_LIB` (macOS x64)                               |
| `librust_pty_arm64-b7hv765h.dylib`      | 504 576 B    | Mach-O dylib, arm64           | `BUN_PTY_LIB` (macOS arm64)                             |
| `keytar-hqpjzrak`                       | 707 584 B    | PE32+ DLL (N-API), x86-64     | `bin/keytar.node`                                       |
| `fff_c-43ptfmbb.dll`                    | 13 906 944 B | PE32+ DLL, x86-64, 91 exports | dlopen'd from the embedded `$bunfs` path, no extraction |
| `rg-56avgsjb`                           | 4 919 520 B  | PE32+ console, x86-64         | `bin/rg.exe` + `.rg-version`                            |
| `agent-browser-wcst4wbn`                | 13 942 272 B | PE32+ console, x86-64         | `bin/agent-browser.exe`                                 |
| `script-runtime-m53sgqc3`               | 54 478 336 B | PE32+ console, x86-64         | `bin/script-runtime-<sha256>/script-runtime.exe`        |
| `index_bg-904m1xk3.wasm`                | 2 478 606 B  | WASM v1 (resvg, wasm-bindgen) | instantiated in-process                                 |
| `libsqlite3-vvvada9m.dylib` + `.sha256` | 0 B / 0 B    | (empty in this extraction)    | `bin/libsqlite3-<16 hex>.dylib` on macOS                |
| `apply-seccomp-vvvada9m`                | 0 B          | (empty in this extraction)    | Linux seccomp helper — out of scope                     |

Only the Windows PTY DLL is present for `win32`; a Windows arm64 host therefore
hits B1's warning and B4's missing-library error.

### Environment variables

| Name                                                                     | Payload           | Required | Semantics                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUN_PTY_LIB`                                                            | PTY               | no       | Absolute path to the PTY library; set by the CLI at boot, honoured only if the file exists (`vendor:bun-pty/src/terminal.ts:31-33`).                                              |
| `DROIDE_RIPGREP_PATH`                                                    | rg                | no       | Absolute file or package root; validated (absolute, file, regular, +x on POSIX) (`src/utils/npmDepResolver.ts:41-49,192-230`).                                                    |
| `DROIDE_AGENT_BROWSER_PATH`                                              | agent-browser     | no       | Same validation; package root resolves `bin/agent-browser(-win32-<arch>[.exe])` (`…/npmDepResolver.ts:50-60`).                                                                    |
| `DROIDE_KEYTAR_PATH`                                                     | keytar            | no       | Same validation; package root resolves `build/Release/keytar.node` (`…/npmDepResolver.ts:61-65`).                                                                                 |
| `DROIDE_NPM_MODULES_DIR`                                                 | all three         | no       | Absolute existing directory; each dep resolved at its canonical sub-path; per-dep overrides win (`src/utils/npmDepResolver.ts:141-184`).                                          |
| `CLI_VERSION`                                                            | rg, agent-browser | no       | Stamped into `.rg-version`; absent → sentinel `unknown` (`src/utils/ripgrepEmbedded.ts:44-46`).                                                                                   |
| `DROIDE_ENV`                                                             | rg                | no       | Anything but `production` enables the dev symlink path and skips stamp checks (`src/utils/ripgrepEmbedded.ts:104,152`).                                                           |
| `DROIDE_DISABLE_KEYRING`                                                 | keytar            | no       | Truthy disables the keyring path (`packages/environment/src/constants/index.ts:111`; `…/CredentialsStorage.ts:320-322`).                                                          |
| `AGENT_BROWSER_*`                                                        | agent-browser     | no       | Read/passed through; the CLI injects `CDP`, `SESSION`, `PIN_TAB`, `IDLE_TIMEOUT_MS`, `SKILLS_DIR` — never overwriting a user value (`src/utils/agentBrowserEmbedded.ts:101-144`). |
| `DROIDE_DESKTOP_CDP_PORT`, `DROIDE_DESKTOP_CDP_IDENTITY`                 | agent-browser     | no       | Gate desktop identity/pinning (`packages/utils/src/agent-browser/desktopCdp.ts:40-48,161-181`).                                                                                   |
| `AGENT_BROWSER_SOCKET_DIR`, `XDG_RUNTIME_DIR`, `AGENT_BROWSER_NAMESPACE` | agent-browser     | no       | Runtime-dir precedence and namespace scoping for cleanup (`src/utils/agentBrowserCleanup.ts:30-55`).                                                                              |

### On-disk locations (all under `<state root>`)

| Path                                                                                                                     | Payload       | Notes                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------- |
| `bin/rg[.exe]` + `bin/.rg-version`                                                                                       | rg            | mode 0755, version-stamped.             |
| `bin/agent-browser[.exe]` + `tools/agent-browser/skill-data/` + `tools/agent-browser/.extracting.lock`                   | agent-browser | digest-verified, lock-guarded.          |
| `bin/keytar.node` + `bin/.keytar-sha256`                                                                                 | keytar        | mode 0755, SHA stamped.                 |
| `bin/script-runtime-<sha256>/script-runtime[.exe]`                                                                       | script worker | content-addressed, mode 0700.           |
| `bin/libsqlite3-<16 hex>.dylib`                                                                                          | SQLite        | macOS only.                             |
| `cache/session-index/index.db` (+ `-wal`, `-shm`), `cache/session-index/.metadata_never_index`, `quarantine/<ts>-<pid>/` | SQLite        | WAL mode.                               |
| `tools/agent-browser/skill-data/`                                                                                        | agent-browser | exported as `AGENT_BROWSER_SKILLS_DIR`. |

Precedence everywhere is: per-dep env override → `DROIDE_NPM_MODULES_DIR`
sub-path → extracted/embedded copy; a configured-but-unusable override is
ignored and reported, never fatal.

## Errors

| Trigger                                      | Identity                                                                                                                                             | Observable effect                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No PTY library found for the platform        | `librust_pty shared library not found.` + `Checked:` list                                                                                            | Every `daemon.create_terminal` fails; `console.warn` at boot when the arch is unsupported (`src/embed-native-libs.ts:46-49`).          |
| `bun_pty_spawn` returns a negative handle    | `PTY spawn failed`                                                                                                                                   | The create request fails with `Failed to spawn terminal with shell`; the terminal is not registered (`…/terminal-manager.ts:181-198`). |
| Read loop sees a non-`-2` negative           | none (silent)                                                                                                                                        | No exit notification; the terminal stays in the registry until the client closes it.                                                   |
| ripgrep unresolvable, retries left           | `Ripgrep binary not found. Initialization failed but retries are still available — subsequent calls may succeed.`                                    | Grep/Glob fail for that call only.                                                                                                     |
| ripgrep unresolvable, 3 attempts spent       | `Ripgrep binary not found and could not be restored after retries. Do NOT retry Grep or Glob tools — …`                                              | Grep/Glob/Glob-suggestions stay broken for the process (daemon listing throws its own `Ripgrep is unavailable`).                       |
| ripgrep killed by the 10 s cap               | kind `timed-out`, `Search timed out after <n>s. Narrow the pattern, …`                                                                               | Results of that run are discarded.                                                                                                     |
| ripgrep exit 2 in the daemon listing         | none                                                                                                                                                 | Partial stdout merged with a bounded walk; `truncated:true`.                                                                           |
| fff library/instance/scan failure            | `[Daemon] File search … , using ripgrep path` (log only)                                                                                             | Request silently served by ripgrep; no user-visible error.                                                                             |
| fff index creation failure                   | same log + negative cache                                                                                                                            | 10 min of ripgrep for that root.                                                                                                       |
| agent-browser extraction lock never released | `agent-browser extraction by another process did not complete successfully`                                                                          | The shell command that triggered extraction fails.                                                                                     |
| agent-browser `--version` non-zero           | `agent-browser availability check failed: exit code <n>: <stderr>`                                                                                   | (Only reachable through `ensureAgentBrowserAvailable`, currently uncalled — see Open questions.)                                       |
| Script runtime asset unreadable              | `The isolated Script runtime is not installed. Rebuild or reinstall Droide.`                                                                         | Script tool reports the worker-startup failure.                                                                                        |
| Script worker fails to start                 | `Script worker could not start. Use direct tools instead; Script is disabled until Droide restarts.`                                                 | `isReplWorkerAvailable()` false for the process.                                                                                       |
| Worker speaks v1 / wrong version             | `ScriptProtocolMismatchError` (message appended to the startup error)                                                                                | Same as above; fix is reinstalling the build.                                                                                          |
| Frame over its cap                           | `Script protocol frame too large`                                                                                                                    | The whole worker transport fails; the run errors.                                                                                      |
| keytar module unavailable                    | `Cannot read from keyring: keytar module unavailable. Credentials cannot be read securely.` / `Cannot save to keyring: … cannot be stored securely.` | Reads/writes fail distinctly from "no credential"; the caller falls back to the keyfile path.                                          |
| SQLite pin/extract failure                   | `Could not extract the bundled SQLite library; using the system SQLite` (log once)                                                                   | Index runs on the runtime's SQLite; version reported in doctor/log.                                                                    |
| Migration checksum disagreement              | `Session index migration checksum mismatch`                                                                                                          | The open fails; the file is left in place (not quarantined).                                                                           |
| Corrupt database file                        | quarantine + fresh file                                                                                                                              | User data is the JSONL transcripts, not the index.                                                                                     |
| SVG with no measurable size                  | `SVG has no size to fit`                                                                                                                             | The image read that requested the preview fails; no partial image.                                                                     |

## Acceptance tests

Every test is deterministic: stub executables/libraries are built from fixtures
in the repo, no network, no wall-clock dependence beyond injected timers, and no
use of the original binary.

| Clause             | Test id                                                    | Fixture                                                              |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| B1, B2, B4         | `tests/native/test_pty_library_selection_and_missing`      | `fixtures/native/pty/` (empty dir) + `BUN_PTY_LIB` unset             |
| B4                 | `tests/native/test_pty_missing_library_message`            | `fixtures/native/pty/` empty, `BUN_PTY_LIB` unset                    |
| B3, B5             | `tests/native/test_pty_spawn_argv_env_block`               | `fixtures/native/stub_pty` (echoes received argv/env)                |
| B6                 | `tests/native/test_pty_spawn_failure_throws`               | `fixtures/native/stub_pty_neg`                                       |
| B7                 | `tests/native/test_pty_data_streaming_utf8`                | `fixtures/native/stub_pty_chunks`                                    |
| B8, B12            | `tests/native/test_pty_exit_code_and_accessors`            | `fixtures/native/stub_pty_exit7`                                     |
| B9, B10, B11       | `tests/native/test_pty_kill_write_resize`                  | `fixtures/native/stub_pty_exit7`                                     |
| B13, B19           | `tests/native/test_daemon_terminal_duplicate_and_unknown`  | in-memory manager                                                    |
| B14, B15, B16      | `tests/native/test_daemon_terminal_shell_and_env`          | `fixtures/native/stub_pty`                                           |
| B17, B18           | `tests/native/test_daemon_terminal_notifications`          | `fixtures/native/stub_pty_chunks`                                    |
| B20, B21, B22      | `tests/native/test_daemon_terminal_close_and_list`         | stub + fake clock                                                    |
| B23, B24           | `tests/native/test_ripgrep_resolution_order`               | `fixtures/native/rg_stub.sh`                                         |
| B25                | `tests/native/test_ripgrep_missing_error_text`             | none (resolver returns undefined)                                    |
| B26, B27           | `tests/native/test_file_listing_args_and_framing`          | `fixtures/native/rg_stub.sh` recording argv/stdout                   |
| B28, B29, B30      | `tests/native/test_ripgrep_runner_outcomes`                | `fixtures/native/rg_stub.sh` modes: ok/no-match/timeout/overflow/err |
| B31, B32, B33      | `tests/native/test_fff_eligibility_and_missing`            | `fixtures/native/fff_stub`                                           |
| B34, B35, B40      | `tests/native/test_fff_readiness_and_eviction`             | `fixtures/native/fff_stub_slow`, fake clock                          |
| B36, B37, B38, B39 | `tests/native/test_fff_query_mapping_and_paging`           | `fixtures/native/fff_stub_pages`                                     |
| B41                | `tests/native/test_file_search_fallback_order`             | fff stub failing + rg stub                                           |
| B42                | `tests/native/test_fff_options_struct_layout`              | `fixtures/native/fff_reader`                                         |
| B43, B44, B45      | `tests/native/test_agent_browser_extract_layout`           | `fixtures/agent-browser/` fake binary + digest                       |
| B44                | `tests/native/test_agent_browser_missing_after_lock`       | `fixtures/agent-browser/lock_only/` (lock present, no binary)        |
| B46, B47           | `tests/native/test_agent_browser_detection_and_path`       | none                                                                 |
| B48, B49, B50      | `tests/native/test_agent_browser_env_defaults`             | none                                                                 |
| B51, B52, B53      | `tests/native/test_agent_browser_timeout_cleanup_override` | `fixtures/agent-browser/sockets/`                                    |
| B54, B55           | `tests/native/test_script_runtime_extract_and_missing`     | `fixtures/native/fake-runtime`                                       |
| B55                | `tests/native/test_script_runtime_missing_message`         | none (embedded-asset read forced to fail)                            |
| B56                | `tests/native/test_worker_env_allowlist`                   | `fixtures/native/fake-runtime` (dumps env)                           |
| B57, B64           | `tests/native/test_worker_ready_handshake`                 | `fixtures/native/fake-runtime` modes: none/twice/v1/premature        |
| B58, B59, B60      | `tests/native/test_frame_roundtrip_and_caps`               | none                                                                 |
| B61, B62, B63      | `tests/native/test_worker_evaluate_and_teardown`           | `fixtures/native/fake-runtime`                                       |
| B65                | `tests/native/test_script_worker_starters`                 | `fixtures/native/fake-runtime`                                       |
| B66, B67, B68      | `tests/native/test_keytar_resolution_and_stamp`            | `fixtures/native/fake-keytar.node`                                   |
| B69, B72           | `tests/native/test_keyring_accounts_and_keyfile_fallback`  | temp `<state dir>`                                                   |
| B68, B70           | `tests/native/test_keyring_missing_module_errors`          | loader returning `null`                                              |
| B71                | `tests/native/test_keyring_get_dedup_set_order`            | fake keytar with promises                                            |
| B73, B75, B76      | `tests/native/test_sqlite_open_pragmas`                    | temp db, injected sqlite module                                      |
| B74                | `tests/native/test_sqlite_pin_darwin_only`                 | temp `<state dir>`, fake platform                                    |
| B77, B78           | `tests/native/test_sqlite_migrations_and_quarantine`       | `fixtures/sqlite/` migrations                                        |
| B79, B80           | `tests/native/test_resvg_single_init`                      | `fixtures/svg/` inputs                                               |
| B81                | `tests/native/test_int8_dot_kernel_and_fallback`           | generated 16-dim rows                                                |
| B82                | `tests/native/test_doctor_binary_states`                   | temp `<state dir>` per state                                         |

Each helper's "missing payload" case is covered by its own row (`B4`, `B25`,
`B32/B33`, `B44`, `B55`, `B67/B70`, `B74`), and each asserts the exact
user-visible string listed in §Errors rather than "an error was thrown".

## Evidence

Method legend: **PE/ELF header** = `file`, `objdump -h`; **exports** = `objdump
-p` (PE) or `rizin -N -q -c 'iE'` (ELF/Mach-O); **strings** = `strings -n` +
`rg`; **reading** = direct source read; **WASM parse** = section/import/export
walk of the module bytes.

| Evidence                                                                                                                                         | Supports          | Method                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `X:rust_pty-fazdxkv2.dll`, `X:librust_pty-*`                                                                                                     | B2                | PE32+ x86-64 DLL / ELF x86-64 & aarch64 / Mach-O x86_64 & arm64; exports exactly the eight `bun_pty_*` symbols     |
| `X:rust_pty-fazdxkv2.dll` strings (`conpty.dll`, `portable-pty-0.8.1`, `failed to create psuedo console`, `this system does not support conpty`) | B2, B16           | strings                                                                                                            |
| `src/embed-native-libs.ts`                                                                                                                       | B1, B2            | reading                                                                                                            |
| `vendor:bun-pty/src/terminal.ts`, `interfaces.ts`                                                                                                | B3–B12            | reading                                                                                                            |
| `packages/daemon-core/src/terminal/terminal-manager.ts`                                                                                          | B13–B22           | reading                                                                                                            |
| `packages/sdk-core/src/protocol/daemon/schemas/{terminal,enums}.ts`                                                                              | B13, B17, B18     | reading                                                                                                            |
| `src/utils/ripgrepEmbedded.ts`, `src/utils/npmDepResolver.ts`                                                                                    | B23, B24, B25     | reading                                                                                                            |
| `packages/daemon-core/src/utils/{file-listing,file-search/*}.ts`                                                                                 | B26, B27, B31–B41 | reading                                                                                                            |
| `src/utils/grep-utils.ts`, `src/utils/constants.ts`, `src/utils/enums.ts`                                                                        | B25, B28–B30      | reading                                                                                                            |
| `vendor:@ff-labs/fff-bun/src/{ffi,finder,embedded,platform}.ts`                                                                                  | B32, B42          | reading                                                                                                            |
| `X:fff_c-43ptfmbb.dll`                                                                                                                           | B42               | PE32+ x86-64, 91 `fff_*` exports incl. `fff_create_instance_with`, `fff_search_mixed`, `fff_watch_events_get_path` |
| `X:agent-browser-wcst4wbn`                                                                                                                       | B43               | PE32+ console, x86-64; strings `agent-browser/0.37.1`, `src/native/interaction.rs`, `agent-browser.plugin.v1`      |
| `src/utils/agentBrowserEmbedded.ts`, `src/utils/agentBrowserCleanup.ts`, `packages/utils/src/agent-browser/*`                                    | B43–B53           | reading                                                                                                            |
| `src/tools/executors/client/{shell/shell-executor,execute-cli}.ts`                                                                               | B46, B47, B51     | reading                                                                                                            |
| `src/repl/worker/{nativeBinary,processClient}.ts`, `src/repl/protocol/*`                                                                         | B54–B65           | reading                                                                                                            |
| `X:script-runtime-m53sgqc3`                                                                                                                      | B65               | PE32+ x86-64, 54 MB; strings `V8 memory sandbox enabled`, `src\protocol.rs`, `Script protocol frame too large`     |
| `X:keytar-hqpjzrak`                                                                                                                              | B66               | PE32+ DLL; single export `_register_keytar_`; `napi_*` imports; PDB path `node-keytar/build/Release/keytar.pdb`    |
| `src/utils/keytarEmbedded.ts`, `packages/runtime/auth/src/**`                                                                                    | B66–B72           | reading                                                                                                            |
| `src/utils/sqliteEmbedded.ts`, `packages/runtime/session-index/src/{driver,migrate,cache,constants}.ts`                                          | B73–B78           | reading                                                                                                            |
| `X:index_bg-904m1xk3.wasm`                                                                                                                       | B79               | WASM v1, 2 478 606 B; imports `wbg.*`, exports `resvg_new`, `resvg_render`, `renderedimage_asPng/pixels`           |
| `src/utils/images/svg.ts`, `packages/runtime/session-index/src/int8-dot.ts`                                                                      | B79–B81           | reading                                                                                                            |
| `src/entrypoints/doctor/{checks/binaries,installationLayers}.ts`, `src/utils/enums.ts`                                                           | B82               | reading                                                                                                            |
| `X:libsqlite3-vvvada9m.{dylib,sha256}`, `X:apply-seccomp-vvvada9m`                                                                               | —                 | **extraction gap**: both are 0 bytes, so no digest or code claim is made from them                                 |

## Open questions

1. **PTY return-code ABI beyond `-2`.** The front-end names `-2` as
   `CHILD_EXITED` and treats every other negative as a silent stop; the Rust
   source is not in the evidence set, so the full code table (and whether a
   `0` return is genuinely "no data" rather than EOF) is unverified. Settle by
   disassembling `bun_pty_read`/`bun_pty_spawn` in `X:rust_pty-fazdxkv2.dll`
   against a controlled child, or by obtaining `rust-pty`'s source. Blocks the
   silent-stop clause B8's error half.
2. **Whether the daemon surfaces a stuck terminal after a read error.** B8
   implies a terminal can remain listed with a dead child. No evidence shows
   whether a later write or the orphan sweep reclaims it; affects B19/B22.
3. **`ensureAgentBrowserAvailable` is exported but has no caller in the
   recovered tree.** Either the barrel/entry it served was elided, or the
   `--version` gate runs only from an elided module. Blocks the "availability
   check" half of B43 and the corresponding error row.
4. **`fff_create_instance2` is declared (13 cstring/bool/u64 args) but unused;
   the live path is `fff_create_instance_with`. B42 documents the latter only.
   If a future build switches back to `instance2`, the options struct contract
   changes; no clause covers it.
5. **`KeytarModule`'s declaration file is missing** from the recovered tree
   (`packages/runtime/auth/src/storage/common/types.ts` absent). The interface in
   B66 is inferred from two call sites plus the addon's export list; `findCredentials`
   is attested only by a DLL string. Marked `[inferred]`.
6. **`libsqlite3` digest and contents are unavailable** (both artefacts are 0
   bytes in `X:`), so B74's filename derivation is sourced from the TS only; the
   shipped SQLite version cannot be confirmed here.
7. **Shell-vs-skill precedence for agent-browser.** `AGENT_BROWSER_PIN_TAB`
   etc. are injected per command, but the builtin `agent-browser` SKILL.md is
   elided from the recovered tree, so the documented user-visible workflow the
   model follows cannot be quoted. Affects B50's wording only.
8. **Whether an unhandled PTY write error closes the child.** B20 documents the
   manager closing the terminal; whether the OS child survives `bun_pty_close`
   alone (no kill) is not observable from the sources.

## Clean-room notes

A conforming build **must** reproduce:

- One library per platform with the eight `bun_pty_*` symbols and the exact
  call signatures in B3; `BUN_PTY_LIB` honoured first; the documented
  `librust_pty shared library not found.` text.
- Command-line quoting + `cwd` + NUL-joined env block + `(cols, rows)` spawn
  arguments, and `PTY spawn failed` on a negative handle.
- 4096-byte reads, streaming UTF-8 decode, chunk-per-`onData` delivery, `-2`
  meaning exit with `get_exit_code`, 8 ms idle sleep.
- Synthetic exit on `kill`: `{exitCode: 0, signal}` and no signal delivery.
- The daemon's shell allowlist, blocked env vars, `TerminalIdExists`,
  `daemon.terminal_data` / `daemon.terminal_exit` shapes, 30 s disconnect grace.
- ripgrep resolution order, the exact `--files` and `--no-config` argv shapes,
  NUL vs LF record framing, exit-code mapping (0/1/2), the three-attempt rule
  and both "binary not found" texts.
- fff eligibility rules (git root + plain-path query), the 250 ms readiness
  race, 30 s give-up, 10 min negative cache, 4-instance LRU + 30 min idle,
  400-item pages / 12-page cap, `type: "directory"`, and the versioned
  `FffCreateOptions` struct.
- agent-browser extraction layout, digest verification, lock file and 30 s
  wait, `PATH` and `AGENT_BROWSER_SKILLS_DIR` injection, the 30 min idle default
  and 10 min foreground cap, `fcdp-<port>-<16 hex>` session naming, `-ext`
  suffix, and non-Windows socket cleanup.
- Script worker content-addressed path, 0700 mode, env allowlist, `ready`/
  protocol version 2 handshake inside 10 s, `u32le` + JSON + slot framing,
  16 KiB slot threshold, frame caps and their error strings, and the
  abort/complete teardown ladder.
- keytar resolution order + SHA stamp, `process.dlopen` loading, `Droide CLI`
  service with environment-scoped accounts, the two "module unavailable"
  messages, per-account get dedup and set serialisation, keyfile fallback.
- The SQLite driver's module choice, macOS-only pin with digest-named file, the
  six open pragmas in order, the `schema_migrations` ledger with 16-hex
  checksums, `BEGIN IMMEDIATE` per migration, ahead-ledger tolerance, quarantine
  and `.metadata_never_index`.
- resvg initialised once with embedded bytes and bundled fonts; int8 dot module
  validated before use with a scalar fallback; identical arithmetic.
- Doctor's eight binary states and their exact sentences.

Explicitly **not** part of the contract:

- The Rust/C internals of any payload (ranking algorithm, PTY backend choice,
  ConPTY version requirements, V8 heap tuning, SQLite amalgamation version).
- Artefact build provenance (PDB paths, crate versions, `rustc` hashes) beyond
  what doctor prints.
- The SEA asset naming in `X:` (`…-<suffix>`) — an packaging detail of the
  extraction, not of the deployed layout.
- The `apply-seccomp` helper and Linux cgroup workload placement
  (`wrapWorkloadCommand` reduces to identity off daemon hosts).
- Interning/placement of the wasm modules: only their observable API and
  fallbacks are contractual.
