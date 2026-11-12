# Implementation plan

Spec-driven (SDD), architecture-driven (ADD), test-driven (TDD). Every milestone
is shippable, gated by tests that exist before the code, and traceable to spec
sections and ADRs.

## Rules of the road

- A milestone starts only when its spec file exists and is reviewed.
- No milestone is "done" until `npm test`, `npm run test:parity` and
  `npm run test:tools` pass in a clean checkout (no `evidence/`, no `raw/`).
- Params and wire shapes are validated at boundaries (see `src/…/schema.ts`
  once they exist) — never trusted because they came from our own code.
- Any behaviour the specs do not pin is not implemented. Add it to the spec
  first, then implement.

## Status (2026-11-12)

| Milestone | State |
|---|---|
| M0 evidence & recovery | done |
| M1 CLI surface | **done** — 20/20 parity cases green, 47 unit tests, curated `exec --help` page |
| M2 settings & paths | in progress |
| M3 session store | in progress |
| M4 transport & auth | in progress |
| M6 tools core | **done** — registry, validators, permission matrix, fs/shell/todo |
| M7 exec streams | **done** (protocols); end-to-end run in progress |
| M8 extensions core | config/skills/plugins **done**; MCP client in progress |
| M10a native contract | **done** — client with bounds, timeouts, typed failures |
| M12 doctor | **done** — catalogue, six real probes, text/JSON reports |
| M10b native Rust | blocked (toolchain, `docs/rust-setup.md`) |
| M5 agent loop, M9 daemon, M11 UI | specified, not started (specs `20`, `70`, `95`) |

## Milestones

| # | Milestone | Spec gate | Acceptance gate |
|---|---|---|---|
| M0 | Evidence & recovery (done) | — | `tools/*` test suites green; recovery manifest reproducible |
| M1 | CLI surface: root command, `--version`, `--help`, subcommand help, non-TTY refusal, argument classification | `specs/10-cli-surface.md` | `tests/parity/run.mjs --check` green (13 cases today, extended as specs land) |
| M2 | Settings & paths: config resolution order, env vars, project config, `--settings` merge, worktree/cwd anchoring | `specs/10-cli-surface.md`, `specs/40-sessions-and-storage.md` | unit tests for precedence matrix; parity cases for `droid doctor`-style read-only paths |
| M3 | Session store: SQLite schema at head, migrations, transcript append/read, tags, search index | `specs/40-sessions-and-storage.md` | migrate-empty-db snapshot test, append/read round-trip, search fixture |
| M4 | Provider transport & auth: base-URL resolution, headers, SSE parsing, error mapping, token handling | `specs/50-transport-and-auth.md` | SSE fixture tests, error-mapping table test, no network in CI |
| M5 | Agent loop: message model, tool-call cycle, permissions, context assembly, compaction | `specs/20-agent-loop.md`, `specs/30-tools-and-sandbox.md` | scripted-provider transcript tests; permission matrix |
| M6 | Tools: filesystem, search, shell/exec, todo/task; permission enforcement | `specs/30-tools-and-sandbox.md` | per-tool schema tests; sandbox profile assertions |
| M7 | Non-interactive mode and stream formats (`exec`) | `specs/80-exec-and-streaming.md` | golden stdout line sequences per scripted run |
| M8 | Extensions: MCP client, plugins, skills, ACP | `specs/60-extensions-mcp-and-skills.md` | config merge tests, collision rules, skill discovery |
| M9 | Daemon and remote control | `specs/70-daemon-and-remote-control.md` | handshake/version negotiation, single-instance lock |
| M10a | Native **contract** in TypeScript: JSON-lines client, response validation, failure mapping | `specs/90-native-layer.md` | stub-helper integration tests; no leaked child processes |
| M10b | Native **implementation** in Rust: search, sandbox, paths, protocol (pty and secrets next) | `specs/90-native-layer.md`, `crates/` | `cargo test --workspace` locally and in CI — toolchain fixed, see `docs/rust-setup.md` |
| M11 | Terminal UI | `specs/95-terminal-ui.md` | frame tests for a fixed terminal size; no flake on time |

## Definition of done (each milestone)

1. Spec section(s) updated first, with `[observed]/[derived]/[inferred]` labels.
2. Tests written and failing for the documented behaviour (red).
3. Implementation added; tests pass (green); no retries, no sleeps, no network.
4. `npm run format:check` clean; `tsc --noEmit` clean.
5. Commit on `re/factory-droid-v1.9.0` with `feat(<area>): …`; PR opened when a
   milestone completes, with the spec diff and test names in the description.

## Parallelism

Slices are disjoint by file ownership: one owner per spec, one owner per source
directory, one owner per test suite. Integration (package.json, tsconfig, CI,
shared types in `src/contracts/`) is owned by the orchestrator only.

## Known risks

- **Proprietary text leakage.** Help strings and error messages are contract
  data and appear verbatim in specs and goldens. The published artefact is
  checked for uniqueness markers before any release (ADR 0003).
- **Recovery gaps.** Re-export barrels and type-only modules are absent from the
  maps (`docs/architecture/README.md`). Any spec claim that depends on a missing
  file must say so and be marked `[inferred]`.
- **Rust toolchain.** Repaired: `.cargo/config.toml` pins rust-lld with Rust's
  self-contained libraries, so `cargo test --workspace` runs locally. The
  remaining native work (pty, secrets) needs audited `unsafe` FFI modules.
- **Version drift.** The subject is pinned at v1.9.0; a newer release means a
  new recovery run and a golden re-record, never silent behaviour changes.
