<p align="center"><a href="./README.md">English</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.zh-CN.md">中文</a></p>

<div align="center">
  <img src="./docs/assets/hero.svg" width="100%"
       alt="Droide — a terminal coding agent; one real chain from the repository, spec to code to test">
</div>

**Droide** is a terminal coding agent for your repository: one command surface
for prompts, sessions, tools, MCP servers, plugins and a local daemon, driven
from a terminal.

The product layer is TypeScript — Node 24, ESM, types stripped at load, no build
step. The native layer is Rust, behind one JSON-lines child process. Both are
written against a single contract: [`specs/`](./specs/README.md).

## How it is built

The specification is the deliverable. The implementation is the check that the
specification is complete and unambiguous enough to build from.

- **SDD — spec first.** Every subsystem has one document under `specs/`, and
  nothing is implemented before it is specified. Clauses are labelled
  `[observed]`, `[derived]` or `[inferred]`, and each carries a citation — a
  source location, or a recorded case.
- **ADD — decisions as records.** Anything that constrains structure is an ADR
  in [`docs/adr/`](./docs/adr/0000-template.md), written when the decision is
  made. The split into two runtimes is
  [ADR 0002](./docs/adr/0002-hybrid-rust-typescript-layers.md); the rule that
  recovered material never enters the build is
  [ADR 0003](./docs/adr/0003-evidence-first-clean-room-policy.md).
- **TDD — clauses compile to tests.** Every behavioural clause names at least one
  deterministic test: no network, no credentials, no wall clock. Where the build
  is narrower than its clause, the code says so with a `TODO(spec …)` marker and
  [`docs/gaps.md`](./docs/gaps.md) lists it.

## Status

What runs today, run against this tree:

| Surface                                                                                    | Today                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--version`, `--help`, subcommand help                                                     | works — reports `0.6.0`; 20 recorded CLI cases replay green (snapshots are tracked in `tests/parity/expected/`, see [ADR 0010](./docs/adr/0010-own-brand-and-snapshot-harness.md))                                                                                                                                                       |
| `doctor`                                                                                   | works — 16 named checks, twelve of them by default: config, environment, system, binaries, updates, filesystem, git, proxy, certs, connectivity, auth, daemon; `--checks all` adds custom-models, inference, mcp and exec, which start servers or spend money. A check that cannot run reports `skip` with a reason                      |
| `search` / `find`                                                                          | works — served from a local transcript index with a proving fallback to the literal scan; `--reindex` refreshes it                                                                                                                                                                                                                       |
| `mcp list`, `mcp add`, `mcp remove`, `mcp permissions`                                     | work — merged configuration, surgical JSONC edits that keep comments, atomic writes, permission list/revoke/clear                                                                                                                                                                                                                        |
| `plugin list`, `plugin marketplace`, `plugin install`, `plugin uninstall`, `plugin update` | work — git-backed marketplaces validated before adoption, atomic registry merges, collision and reference refusals                                                                                                                                                                                                                       |
| `exec`                                                                                     | works for `text`, `json` and `stream-json` with a prompt, `-f` or stdin, session continuation and streaming input; `--list-tools` prints the tools for the selected model with no credential; `stream-jsonrpc`, ACP and `--mission` refuse                                                                                               |
| `resume`                                                                                   | works — lists sessions, accepts a UUID or link, continues through the `exec -s` path, forks with `--fork`                                                                                                                                                                                                                                |
| `update`, `update --check`, `update -v <version>`                                          | work — the check reads this repository's release feed; an install streams the archive to staging while hashing it, swaps it atomically and rolls back when the single probe fails                                                                                                                                                        |
| `daemon`                                                                                   | works locally — WebSocket transport, JSON-RPC, auth gate, single instance, ordered shutdown; Remote Control and the port proxy are declared, not built                                                                                                                                                                                   |
| `droide` with no arguments                                                                 | launches the interactive shell on a TTY pair; a typed prompt runs an agent turn with streamed rows, approvals and Esc-cancel                                                                                                                                                                                                             |
| native helper                                                                              | 15 JSON-line methods (including PTY sessions), typed and validated on the TypeScript side, 69 Rust tests, plus a contract test that spawns a real process through the compiled binary (`npm run test:native`); the tool runtime uses it for discovery when the binary is present and degrades to the TypeScript implementation otherwise |
| test suite                                                                                 | 1383 tests in 138 files: 1375 pass, 7 skipped, plus 69 Rust tests                                                                                                                                                                                                                                                                        |

`exec` needs a model credential. Without one it refuses instead of guessing:

```console
$ node bin/droide.mjs exec -o json "hi"
Authentication failed. Please log in using /login or set a valid DROIDE_API_KEY environment variable.
```

Declared, in flight:

| Surface                                                      | State                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `computer register\|remove\|ssh\|port-forward`               | options parse, help prints, every action refuses with exit 64              |
| macOS/Linux credential stores                                | only Windows DPAPI exists; the store refuses rather than writing plaintext |
| Remote Control, relay and port proxy; the interactive picker | declared in `specs/70` and `specs/10`; `docs/gaps.md` names every clause   |

The failure is deliberate, and it is observable — exit 64 for a command that is
specified but not built, exit 1 for an option that is not:

```console
$ node bin/droide.mjs computer register
droide: the "computer register" command is specified but not implemented in this build.

$ node bin/droide.mjs exec --mission "build it"
--mission is not implemented in this build.
```

Current shape of the tree: 11 numbered specification documents — shared context
plus ten subsystem specs, 9,414 lines under `specs/` — 147 TypeScript files
under `src/` (52,048 lines), 9 Rust files under `crates/droide-native/src/`,
9 ADRs, 1266 TypeScript tests and 69 Rust tests. Every place where the build is
narrower than the clause it cites is marked `TODO(spec …)` in the code and
counted in [`docs/gaps.md`](./docs/gaps.md), which `npm run gaps` regenerates.

## Quick start

Node 24 or newer, and a Rust toolchain for the native layer.

```sh
npm ci                          # install once; there is no build step
node bin/droide.mjs --version   # 0.6.0
node bin/droide.mjs --help
node bin/droide.mjs doctor      # 12 named checks by default (--checks all: 16)
node bin/droide.mjs mcp list
node bin/droide.mjs search x --json
npm test                        # 1383 tests
npm run typecheck
npm run test:parity             # 20/20
cargo test --workspace          # 69 tests
```

`exec` is the machine-facing surface (`text`, `json`, `stream-json`):

```sh
node bin/droide.mjs exec "review app.tsx"
node bin/droide.mjs exec -o json "review app.tsx"
node bin/droide.mjs exec -f prompt.txt --auto low
```

## Architecture

<div align="center">
  <img src="./docs/assets/architecture.svg" width="100%"
       alt="Architecture: the TypeScript product layer under src/ calls one Rust helper process over UTF-8 JSON lines, protocol version 1">
</div>

- **`src/` — product layer, TypeScript.** `cli/` parses arguments and owns help
  and refusals; `agent/` the turn loop and message model; `tools/` the registry,
  validators, permission matrix and fs/shell/todo tools; `session/` the store,
  migrations, transcript and search; `transport/` SSE, LLM deltas and error
  identity; `ui/` the token tables, components and frame renderer; `app/` the
  wiring between them.
- **The boundary is one child process and one line per message.** Requests are
  `{"id","method","params"}`, answers are `{"id","result"}` or
  `{"id","error":{"code","message"}}`, UTF-8, protocol version 1, request lines
  capped at 1 MiB. The client (`src/native/client.ts`) matches answers by id and
  treats every answer as untrusted input.
- **`crates/droide-native/` — native layer, Rust.** `main.rs` is a stdio loop
  that flushes one frame per request; `protocol.rs` frames and dispatches;
  `paths.rs` enforces containment; `search.rs` walks and searches; `sandbox.rs`
  describes bubblewrap, seatbelt or "no confinement" profiles; `pty.rs` quotes
  the command line the way the shell re-splits it; `secrets.rs` stores secrets
  with DPAPI on Windows.
- The fifteen methods are `native.version`, `hash.sha256`, `search.walk`,
  `search.text`, `path.resolve`, `sandbox.profile`, `pty.quote`, `pty.spawn`,
  `pty.read`, `pty.write`, `pty.resize`, `pty.kill`, `pty.close`,
  `secrets.protect`, `secrets.unprotect`. The TypeScript client validates every
  response shape, the helper has its own tests, and `npm run test:native` runs the
  contract against the compiled binary. The tool layer still reaches the helper
  through nothing but the fake, so wiring is the next step.

## Specifications and decisions

| Document                                                                     | Subject                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`00-context.md`](./specs/00-context.md)                                     | shared context: terms, evidence policy and citation rules |
| [`10-cli-surface.md`](./specs/10-cli-surface.md)                             | commands, options, help, refusals, exit codes             |
| [`20-agent-loop.md`](./specs/20-agent-loop.md)                               | message model, turn loop, provider adapter                |
| [`30-tools-and-sandbox.md`](./specs/30-tools-and-sandbox.md)                 | tool registry, validators, permissions, sandbox           |
| [`40-sessions-and-storage.md`](./specs/40-sessions-and-storage.md)           | session files, migrations, transcript, search             |
| [`50-transport-and-auth.md`](./specs/50-transport-and-auth.md)               | URLs, headers, SSE, error identity, auth                  |
| [`60-extensions-mcp-and-skills.md`](./specs/60-extensions-mcp-and-skills.md) | MCP servers, tool naming, skills, plugins                 |
| [`70-daemon-and-remote-control.md`](./specs/70-daemon-and-remote-control.md) | daemon RPC surface and remote control                     |
| [`80-exec-and-streaming.md`](./specs/80-exec-and-streaming.md)               | non-interactive runs and stream formats                   |
| [`90-native-layer.md`](./specs/90-native-layer.md)                           | the helper process and its methods                        |
| [`95-terminal-ui.md`](./specs/95-terminal-ui.md)                             | tokens, capabilities, shell layout, frames                |

Status vocabulary — `draft`, `review`, `stable`, `blocked` — is defined in
[`specs/README.md`](./specs/README.md); per-spec state lives in
[`docs/status.md`](./docs/status.md), and the milestones and their gates in
[`docs/plan.md`](./docs/plan.md). The evidence-derived layer map of the reference
tree is in [`docs/architecture/README.md`](./docs/architecture/README.md), and
the ledger conventions in [`evidence/`](./evidence/README.md).

Decisions that shaped the build:

| ADR                                                         | Decision                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| [0001](./docs/adr/0001-bun-standalone-extraction.md)        | recover the embedded JavaScript bundle before decompiling native code   |
| [0002](./docs/adr/0002-hybrid-rust-typescript-layers.md)    | Rust for the native layer, TypeScript for the product layer             |
| [0003](./docs/adr/0003-evidence-first-clean-room-policy.md) | evidence-first clean-room policy                                        |
| [0006](./docs/adr/0006-terminal-ui-stack.md)                | the terminal UI is React + Ink, with tokens from the spec               |
| [0007](./docs/adr/0007-update-channel.md)                   | updates come from this repository's releases                            |
| [0008](./docs/adr/0008-oauth-credential-envelope.md)        | MCP OAuth credentials are sealed by the OS, never by a key file         |
| [0009](./docs/adr/0009-update-installation.md)              | updates are staged, digest-verified, swapped atomically and rolled back |
| [0010](./docs/adr/0010-own-brand-and-snapshot-harness.md)   | Droide is its own product; the harness records our own snapshots        |
| [0011](./docs/adr/0011-own-disk-layout-and-env.md)          | our own state directory, plugin layout and environment variable names   |

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first. A change is mergeable when
these gates pass:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm test`
4. `npm run test:parity` (compares against `tests/parity/expected/`)
5. `cargo test --workspace`
6. `npm run gaps:check`
7. `npm run brand:check`
8. the spec clause it implements is cited in the commit message or PR body

Two rules keep the method intact: nothing is implemented before it is specified,
and no behaviour is smoothed over with a guess. Where the build is narrower than
its clause, mark it `TODO(spec …)`; `npm run gaps` regenerates
[`docs/gaps.md`](./docs/gaps.md) and `npm run gaps:check` fails when it is stale.

Tests live in [`tests/`](./tests/README.md): `unit/` is fast and hermetic,
`integration/` crosses a process boundary, `parity/` replays recorded CLI cases.

## Licence

MIT — see [`LICENSE`](./LICENSE). No third-party code is copied, and no
proprietary artefact is tracked here
([ADR 0003](./docs/adr/0003-evidence-first-clean-room-policy.md)).
