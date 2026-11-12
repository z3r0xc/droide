# Status

Living dashboard. Updated at each milestone gate; numbers are reproducible with
the commands shown.

```sh
ls specs/*.md | wc -l                    # specs
find src -name '*.ts' | wc -l            # product layer size
node --test "tests/**/*.test.ts"         # test suite
node tests/parity/run.mjs --check        # CLI parity (local goldens)
cargo test --workspace                   # native layer (CI only here)
```

## Snapshot

| Area | State |
|---|---|
| Specifications | 11 subsystem specs + shared context, ~8.2k lines, all clauses cited and mapped to tests |
| TypeScript product layer | 75 files, ~17k lines: CLI, app, config, session, agent, transport, exec, extensions, tools, native client |
| Tests | 56 test files; 489 tests (488 pass, 1 skipped) |
| CLI parity | 20/20 recorded cases against the subject |
| Native (Rust) | protocol crate + tests; builds only in CI (see `docs/rust-setup.md`) |

## Command surface

| Command | State |
|---|---|
| `--version`, `--help`, subcommand help | **done** — 20/20 parity cases, including the curated `exec --help` page |
| `doctor` | **done** — catalogue, six real probes (config, environment, system, binaries, filesystem, git), text and `--json` reports; the other ten names report `skip` |
| `search\|find` | **done** — store query, text and `--json` output, documented exit codes |
| `exec` | protocols, validation and record writers **done**; end-to-end wiring in progress |
| `resume`, `daemon`, `update`, `mcp`, `plugin`, `computer` | help and option parsing only; actions fail loudly (no silent success) |
| bare `droide` | refuses with exit 64 until the interactive UI lands |

## Specs

| Spec | Status | Implemented |
|---|---|---|
| `10-cli-surface.md` | stable | yes — root, subcommands, help, refusals, exit codes |
| `20-agent-loop.md` | review | message model, turn loop, LLM provider adapter; context assembly pending |
| `30-tools-and-sandbox.md` | stable | registry, validators, permission matrix, fs/shell/todo tools |
| `40-sessions-and-storage.md` | stable | migrations, store, transcript, search |
| `50-transport-and-auth.md` | stable | URL/header/error/SSE/LLM delta layers |
| `60-extensions-mcp-and-skills.md` | stable | MCP config merge, tool naming, skill discovery, plugin manifests |
| `70-daemon-and-remote-control.md` | review | not started |
| `80-exec-and-streaming.md` | stable | record types, writer, one-shot runner, validation |
| `90-native-layer.md` | stable | TypeScript client + fake-helper tests; Rust helpers pending |
| `95-terminal-ui.md` | review | tokens, frame, header/transcript/composer/status line (in progress) |

## Known gaps and their owners

| Gap | Why | Next step |
|---|---|---|
| `droid` interactive mode | TUI is being built on React + Ink (`docs/adr/0006`); the CLI does not dispatch to it yet | M11 |
| Bare `droide` invocation | fails loudly with exit 64 instead of starting the TUI | removes itself when M11 lands |
| Native helpers (pty/search/secrets/sandbox) | local Rust linker broken (`docs/rust-setup.md`) | repair toolchain, then M10b |
| Session search | literal scan instead of the subject's index planner (documented deviation) | revisit with `40` §B45–B51 |
| Context compaction | not implemented | M5 remainder (`20` §B35–B45) |
| Narrower-than-spec behaviour in 20 places | each is marked `TODO(spec …)` in code | `docs/gaps.md` lists every one with its clause |

## Gates

A change is mergeable when all of these pass:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm test`
4. `npm run test:parity` (local goldens present)
5. `cargo test --workspace` (CI)
6. the spec clause it implements is cited in the commit message or the PR body