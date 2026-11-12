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
| TypeScript product layer | 61 files, ~14.3k lines: CLI, config, session, agent loop, transport, exec, extensions, tools, native client |
| Tests | 338 tests across 38 files (unit + integration) |
| CLI parity | 20/20 recorded cases against the subject |
| Native (Rust) | protocol crate + tests; builds only in CI (see `docs/rust-setup.md`) |

## Specs

| Spec | Status | Implemented |
|---|---|---|
| `10-cli-surface.md` | stable | yes — root, subcommands, help, refusals, exit codes |
| `20-agent-loop.md` | review | message model + turn loop (ports injected); context assembly pending |
| `30-tools-and-sandbox.md` | review | registry, validators, permissions, fs/shell/todo tools |
| `40-sessions-and-storage.md` | review | migrations, store, transcript, search |
| `50-transport-and-auth.md` | review | URL/header/error/SSE/LLM delta layers |
| `60-extensions-mcp-and-skills.md` | draft | MCP config merge, tool naming, skill discovery, plugin manifests |
| `70-daemon-and-remote-control.md` | review | not started |
| `80-exec-and-streaming.md` | review | record types, writer, one-shot runner, validation |
| `90-native-layer.md` | review | TypeScript client + fake-helper tests; Rust helpers pending |
| `95-terminal-ui.md` | draft | not started |

## Known gaps and their owners

| Gap | Why | Next step |
|---|---|---|
| `droid` interactive mode | TUI not implemented (M11) | implement `95-terminal-ui.md` |
| Bare `droide` invocation | fails loudly with exit 64 instead of starting the TUI | removes itself when M11 lands |
| Native helpers (pty/search/secrets/sandbox) | local Rust linker broken (`docs/rust-setup.md`) | repair toolchain, then M10b |
| Session search | literal scan instead of the subject's index planner (documented deviation) | revisit with `40` §B45–B51 |
| Context compaction | not implemented | M5 remainder (`20` §B35–B45) |

## Gates

A change is mergeable when all of these pass:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm test`
4. `npm run test:parity` (local goldens present)
5. `cargo test --workspace` (CI)
6. the spec clause it implements is cited in the commit message or the PR body