<p align="center">
  <img src="./docs/assets/hero.svg" width="100%"
       alt="Droide — a terminal coding agent rebuilt from its specification: TypeScript product layer, Rust native helper, spec-first method">
</p>

**Droide** is a clean-room reimplementation of the `droid` CLI v1.9.0: the same
command surface, help pages, refusals and exit codes, rebuilt from a written
specification instead of copied source.

The product layer is TypeScript — Node 24, ESM, types stripped at load, no build
step. The native layer is Rust, behind one JSON-lines child process. Both are
written against a single contract: [`specs/`](./specs/README.md).

## Why this exists

The specification is the deliverable. The reimplementation is the check that the
specification is complete and unambiguous enough to build from.

- **SDD — spec first.** Every subsystem has one document under `specs/`, and
  nothing is implemented before it is specified. Clauses are labelled
  `[observed]`, `[derived]` or `[inferred]`, and each carries a citation — a
  recovered file and line, or a recorded golden.
- **ADD — decisions as records.** Anything that constrains structure is an ADR
  in [`docs/adr/`](./docs/adr/0000-template.md), written when the decision is
  made. The split into two runtimes is
  [ADR 0002](./docs/adr/0002-hybrid-rust-typescript-layers.md); the rule that no
  subject code is copied is
  [ADR 0003](./docs/adr/0003-evidence-first-clean-room-policy.md).
- **TDD — clauses compile to tests.** Every behavioural clause names at least one
  deterministic test: no network, no credentials, no wall clock. Where the build
  is narrower than its clause, the code says so with a `TODO(spec …)` marker and
  [`docs/gaps.md`](./docs/gaps.md) lists it.

`docs/status.md` is the live dashboard; `docs/plan.md` holds the milestones and
their gates.

## Status

What actually runs today, verified by running it:

| Surface | Today |
| --- | --- |
| `--version`, `--help`, subcommand help | works — 20/20 recorded parity cases against the subject (goldens are local, see [ADR 0004](./docs/adr/0004-parity-harness-with-optional-oracle.md)) |
| `doctor` | works — 12 checks: six real probes (config, environment, system, binaries, filesystem, git), six names still report `skip` |
| `search` / `find` | works — queries the local session store, text and `--json`, documented exit codes |
| `exec` | works for `text`, `json` and `stream-json` output, with a prompt or `--input-format stream-json` on stdin; `stream-jsonrpc`, ACP, `--mission` and `--list-tools` are refused |
| native helper | 8 JSON-line methods, 57 Rust tests — implemented and tested, **not yet dispatched from the CLI** |
| `npm test` | 653 tests: 652 pass, 1 skipped |

Declared, in flight:

| Surface | State |
| --- | --- |
| bare `droide` (interactive TUI) | the Ink shell renders header, transcript, composer, status line and footer and is frame-tested at 80×24 and 120×40 — but it has no key handling, so the command exits 64 rather than pretend |
| `resume`, `daemon`, `update`, `mcp`, `plugin`, `computer` | options parse, help prints, every action fails loudly |
| native PTY spawn and read loop; macOS/Linux credential stores | only quoting, chunking and Windows DPAPI exist |
| context compaction; session index | not implemented; the literal scan is recorded as a deviation |

The failure is deliberate, and it is observable — exit 64 for a command that is
specified but not built, exit 1 for an option:

```console
$ node bin/droide.mjs
droide: the "interactive" command is specified but not implemented in this build.

$ node bin/droide.mjs exec --list-tools
--list-tools is not implemented in this build.
```

Current shape of the tree: 11 numbered specification documents (9,181 lines),
102 TypeScript files under `src/` (25,062 lines), 8 Rust files under
`crates/droide-native/`, 6 ADRs, 653 TypeScript tests and 57 Rust tests.

## Quick start

Node 24 or newer, and a Rust toolchain for the native layer.

```sh
npm ci                          # install once; there is no build step
node bin/droide.mjs --version   # 1.9.0
node bin/droide.mjs --help
node bin/droide.mjs doctor      # 12 checks, text or --json
npm test                        # 653 tests
cargo test --workspace          # 57 tests
```

That is the real version output:

```console
$ node bin/droide.mjs --version
1.9.0
```

`exec` is the machine-facing surface (`text`, `json`, `stream-json`). It needs a
model credential, and without one it refuses instead of guessing:

```console
$ node bin/droide.mjs exec -o json "hi"
Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.
```

## Architecture

<p align="center">
  <img src="./docs/assets/architecture.svg" width="100%"
       alt="Architecture: TypeScript product layer under src/ calls one Rust helper process over JSON lines, protocol version 1">
</p>

- **`src/` — product layer, TypeScript.** `cli/` parses arguments and owns help
  and refusals; `agent/` the turn loop and message model; `tools/` the registry,
  validators, permission matrix and fs/shell/todo tools; `session/` the store,
  migrations, transcript and search; `transport/` SSE, LLM deltas and error
  identity; `ui/` the token tables, components and frame renderer.
- **The boundary is one child process and one line per message.** Requests are
  `{"id","method","params"}`, answers are `{"id","result"}` or
  `{"id","error":{"code","message"}}`, UTF-8, protocol version 1, request lines
  capped at 1 MiB. The client (`src/native/client.ts`) matches answers by id and
  treats every answer as untrusted input.
- **`crates/droide-native/` — native layer, Rust.** `main.rs` is a stdio loop
  that flushes one frame per request; `protocol.rs` frames and dispatches;
  `paths.rs` enforces containment; `search.rs` walks and searches; `sandbox.rs`
  describes bubblewrap, seatbelt or "no confinement" profiles; `pty.rs` quotes
  the command line the way the subject re-splits it; `secrets.rs` stores secrets
  with DPAPI on Windows.
- The eight methods are `native.version`, `search.walk`, `search.text`,
  `path.resolve`, `sandbox.profile`, `pty.quote`, `secrets.protect`,
  `secrets.unprotect`. The client and the helper are each tested; the CLI does
  not dispatch to the helper yet.

## Specifications and decisions

| Document | Subject |
| --- | --- |
| [`00-context.md`](./specs/00-context.md) | shared context: the subject, its evidence and vocabulary |
| [`10-cli-surface.md`](./specs/10-cli-surface.md) | commands, options, help, refusals, exit codes |
| [`20-agent-loop.md`](./specs/20-agent-loop.md) | message model, turn loop, provider adapter |
| [`30-tools-and-sandbox.md`](./specs/30-tools-and-sandbox.md) | tool registry, validators, permissions, sandbox |
| [`40-sessions-and-storage.md`](./specs/40-sessions-and-storage.md) | session files, migrations, transcript, search |
| [`50-transport-and-auth.md`](./specs/50-transport-and-auth.md) | URLs, headers, SSE, error identity, auth |
| [`60-extensions-mcp-and-skills.md`](./specs/60-extensions-mcp-and-skills.md) | MCP servers, tool naming, skills, plugins |
| [`70-daemon-and-remote-control.md`](./specs/70-daemon-and-remote-control.md) | daemon RPC surface and remote control |
| [`80-exec-and-streaming.md`](./specs/80-exec-and-streaming.md) | non-interactive runs and stream formats |
| [`90-native-layer.md`](./specs/90-native-layer.md) | the helper process and its methods |
| [`95-terminal-ui.md`](./specs/95-terminal-ui.md) | tokens, capabilities, shell layout, frames |

Status vocabulary — `draft`, `review`, `stable`, `blocked` — is defined in
[`specs/README.md`](./specs/README.md); per-spec state lives in
[`docs/status.md`](./docs/status.md). How each part of the subject was recovered
is mapped in [`docs/architecture/README.md`](./docs/architecture/README.md) and
the [`evidence/`](./evidence/README.md) ledger.

Decisions that shaped the build:

| ADR | Decision |
| --- | --- |
| [0001](./docs/adr/0001-bun-standalone-extraction.md) | recover the embedded JavaScript bundle before decompiling native code |
| [0002](./docs/adr/0002-hybrid-rust-typescript-layers.md) | Rust for the native layer, TypeScript for the product layer |
| [0003](./docs/adr/0003-evidence-first-clean-room-policy.md) | evidence-first clean-room policy |
| [0004](./docs/adr/0004-parity-harness-with-optional-oracle.md) | declarative parity cases with an optional oracle |
| [0005](./docs/adr/0005-project-name-and-parity-normalisation.md) | the project is `droide`; the CLI design stays identical |
| [0006](./docs/adr/0006-terminal-ui-stack.md) | the terminal UI is React + Ink, with tokens from the spec |

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first. A change is mergeable when
the gates in [`docs/status.md`](./docs/status.md) pass:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm test`
4. `npm run test:parity` (needs the local goldens under `.work/parity`)
5. `cargo test --workspace`
6. the spec clause it implements is cited in the commit message or PR body

Two rules keep the method intact: nothing is implemented before it is specified,
and no behaviour is smoothed over with a guess. Where the build is narrower than
its clause, mark it `TODO(spec …)`; `npm run gaps` regenerates
[`docs/gaps.md`](./docs/gaps.md) and `npm run gaps:check` fails when it is stale.

Tests live in [`tests/`](./tests/README.md): `unit/` is fast and hermetic,
`integration/` crosses a process boundary, `parity/` replays recorded CLI cases.

## Licence

MIT — see [`LICENSE`](./LICENSE). No code from the subject is copied, and no
proprietary artefact is tracked here
([ADR 0003](./docs/adr/0003-evidence-first-clean-room-policy.md)).