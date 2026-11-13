# Implementation plan

Spec-driven (SDD), architecture-driven (ADD), test-driven (TDD). Every milestone
is shippable, gated by tests that exist before the code, and traceable to spec
sections and ADRs.

## Rules of the road

- A milestone starts only when its spec file exists and is reviewed.
- No milestone is "done" until `npm test`, `npm run test:parity` and
  `npm run test:native` pass in a clean checkout (no `evidence/`, no `raw/`).
- Params and wire shapes are validated at boundaries (see `src/…/schema.ts`
  once they exist) — never trusted because they came from our own code.
- Any behaviour the specs do not pin is not implemented. Add it to the spec
  first, then implement.

## Status (2026-11-13)

| Milestone | State |
|---|---|
| M0 evidence & recovery | done |
| M1 CLI surface | **done** — 20/20 parity cases green, curated `exec --help` page |
| M2 settings & paths | in progress |
| M3 session store | in progress |
| M4 transport & auth | in progress |
| M6 tools core | **done** — registry, validators, permission matrix, fs/shell/todo |
| M7 exec streams | **done** (protocols); end-to-end run in progress |
| M8 extensions core | config/skills/plugins **done**; MCP client and `mcp auth` **done**; ACP not started |
| M10a native contract | **done** — client with bounds, timeouts, typed failures |
| M12 doctor | **done** — 16 named checks, twelve by default (config, environment, system, binaries, updates, filesystem, git, proxy, certs, connectivity, auth, daemon), text/JSON reports |
| M10b native Rust | **done** — 69 tests, `npm run test:native` against the compiled binary (`docs/rust-setup.md`) |
| M5 agent loop, M9 daemon, M11 UI | **done locally** — turn loop and compaction (spec `20`), local daemon (spec `70`), Ink shell running turns (spec `95`); the session picker and Remote Control remain |

## Milestones

| # | Milestone | Spec gate | Acceptance gate |
|---|---|---|---|
| M0 | Evidence & recovery (done) | — | `tools/*` test suites green; recovery manifest reproducible |
| M1 | CLI surface: root command, `--version`, `--help`, subcommand help, non-TTY refusal, argument classification | `specs/10-cli-surface.md` | `tests/parity/run.mjs --check` green (20 cases today, extended as specs land) |
| M2 | Settings & paths: config resolution order, env vars, project config, `--settings` merge, worktree/cwd anchoring | `specs/10-cli-surface.md`, `specs/40-sessions-and-storage.md` | unit tests for precedence matrix; parity cases for `droide doctor`-style read-only paths |
| M3 | Session store: SQLite schema at head, migrations, transcript append/read, tags, search index | `specs/40-sessions-and-storage.md` | migrate-empty-db snapshot, append/read round-trip, index planner, indexed-vs-literal search parity |
| M4 | Provider transport & auth: base-URL resolution, headers, SSE parsing, error mapping, token handling | `specs/50-transport-and-auth.md` | SSE fixture tests, error-mapping table test, no network in CI |
| M5 | Agent loop: message model, tool-call cycle, permissions, context assembly, compaction | `specs/20-agent-loop.md`, `specs/30-tools-and-sandbox.md` | scripted-provider transcript tests; permission matrix |
| M6 | Tools: filesystem, search, shell/exec, todo/task; permission enforcement | `specs/30-tools-and-sandbox.md` | per-tool schema tests; sandbox profile assertions |
| M7 | Non-interactive mode and stream formats (`exec`) | `specs/80-exec-and-streaming.md` | golden stdout line sequences per scripted run |
| M8 | Extensions: MCP client, plugins, skills, ACP | `specs/60-extensions-mcp-and-skills.md` | client, config merge, skills, plugin marketplaces and install, and `mcp auth` **done**; ACP not started |
| M9 | Daemon and remote control | `specs/70-daemon-and-remote-control.md` | local transport, protocol, auth gate, single instance, ordered shutdown **done (123 tests)**; Remote Control, relay and the port proxy are `TODO(spec B28/B29/B32/B33)` |
| M10a | Native **contract** in TypeScript: JSON-lines client, response validation, failure mapping | `specs/90-native-layer.md` | stub-helper integration tests; no leaked child processes |
| M10b | Native **implementation** in Rust: protocol, paths, search, sandbox, PTY sessions (ConPTY/openpty), Windows DPAPI | `specs/90-native-layer.md`, `crates/` | 69 tests, clippy `-D warnings`, `npm run test:native` against the compiled binary; macOS/Linux credential stores remain |
| M11 | Terminal UI | `specs/95-terminal-ui.md` | shell, tokens, golden frames, keys, setup/teardown, TTY dispatch **and agent turns with approvals and cancel done** |

## Definition of done (each milestone)

1. Spec section(s) updated first, with `[observed]/[derived]/[inferred]` labels.
2. Tests written and failing for the documented behaviour (red).
3. Implementation added; tests pass (green); no retries, no sleeps, no network.
4. `npm run format:check` clean; `tsc --noEmit` clean.
5. Commit on `feat/<slug>` with `feat(<area>): …`; PR opened when a milestone
   completes, with the spec diff and test names in the description.

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
- **Version drift.** A behaviour change means a new clause, a re-recorded case
  and a release bump — never a silent change.
