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
| Tests | 1057 TypeScript tests (1053 pass, 4 skipped) + 69 Rust tests |
| CLI parity | 20/20 recorded cases against the subject |
| Native (Rust) | `crates/droide-native`: protocol (9 methods), safe paths, file search, sandbox profiles, PTY quoting, DPAPI secrets — 57 tests, clippy `-D warnings`, builds locally |

## Command surface

| Command | State |
|---|---|
| `--version`, `--help`, subcommand help | **done** — 20/20 parity cases, including the curated `exec --help` page |
| `doctor` | **done** — ten real probes (config, environment, system, binaries, filesystem, git, proxy, certs, auth, mcp), text and `--json` reports; the remaining names report `skip` |
| `search\|find` | **done** — store query, text and `--json` output, documented exit codes |
| `mcp list` | **done** — merged configuration, per-server transport/state, diagnostics, exit 1 on a broken file; never starts a server |
| `mcp add\|remove` | **done** — surgical JSONC edits that keep comments and key order, atomic write, duplicate/unknown/alias refusals, user scope only |
| `mcp permissions list\|revoke\|clear` | **done** — persistent permissions read/validated, server revoke cascades to tools, `clear --confirm` |
| `plugin list` | **done** — user and project registries merged (project shadows), highest version per id, enablement from settings, `--scope` |
| `plugin marketplace add\|remove\|list\|update`, `plugin install\|uninstall\|update` | **done** — git-backed marketplaces through an injected runner, manifest validated before adoption, atomic registry merges, collision refusals, uninstall blocked while a settings file references the plugin |
| `computer list` | **done** — reads `host.json`, reports a registration that belongs to another user or organization as inert; registration/removal need the backend and stay refused |
| `update --check` | **done** — read-only check against this repository's GitHub releases (ADR 0007); installing is refused with exit 2 |
| `exec` | **done** for `text`/`json`/`stream-json` with custom and managed models; streaming input, mission, ACP and `--list-tools` are refused loudly |
| `daemon` | **local transport/protocol/lifecycle done** (132 tests); Remote Control, relay and the port proxy are `TODO(spec B28/B29/B32/B33)` |
| `resume` | **done** — lists recent sessions, accepts a UUID or session link, continues through the same path as `exec -s`, forks with `--fork`, and refuses unknown/archived/invalid ids; the interactive picker is `TODO(spec 10 B22)` |
| `mcp auth`, `computer register\|remove\|ssh\|port-forward`, `update` without `--check` | help and option parsing only; actions fail loudly (no silent success) |
| bare `droide` | **launches the interactive shell on a TTY pair and runs turns**; a prompt argument still exits 64 |

## Specs

| Spec | Status | Implemented |
|---|---|---|
| `10-cli-surface.md` | stable | yes — root, subcommands, help, refusals, exit codes |
| `20-agent-loop.md` | stable | message model, turn loop, provider adapter, system-prompt assembly, context compaction |
| `30-tools-and-sandbox.md` | stable | registry, validators, permission matrix, fs/shell/todo tools |
| `40-sessions-and-storage.md` | stable | migrations 1–10, store, transcript, literal search served from a local index with a proving fallback |
| `50-transport-and-auth.md` | stable | URL/header/error/SSE/LLM delta layers |
| `60-extensions-mcp-and-skills.md` | stable | MCP config merge, tool naming, skill discovery, plugin manifests |
| `70-daemon-and-remote-control.md` | review | not started |
| `80-exec-and-streaming.md` | stable | record types, writer, one-shot runner, validation |
| `90-native-layer.md` | stable | TypeScript client with typed, validated wrappers for every method including the PTY session calls; Rust helper: search, sandbox, paths, PTY quoting, **ConPTY/openpty sessions**, DPAPI secrets (69 tests); `npm run test:native` proves all of it against the compiled binary |
| `95-terminal-ui.md` | review | tokens D1–D13, capability ladder, shell with header/transcript/composer/status line/footer, golden frames at 80×24 and 120×40 |

## Known gaps and their owners

| Gap | Why | Next step |
|---|---|---|
| `droid` interactive mode | Ink shell exists and is frame-tested, but has no key handling yet; dispatching to a UI that ignores input would be worse than the loud refusal, so the CLI still exits 64 | M11: keys, setup, dispatch |
| Bare `droide` invocation | fails loudly with exit 64 instead of starting the TUI | removes itself when M11 lands |
| Native PTY spawn/read loop; macOS/Linux credential stores | only quoting/chunking and DPAPI exist today | next increment of M10b |


| Narrower-than-spec behaviour in 20 places | each is marked `TODO(spec …)` in code | `docs/gaps.md` lists every one with its clause |

## Gates

A change is mergeable when all of these pass:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm test`
4. `npm run test:parity` (local goldens present)
5. `cargo test --workspace` (CI)
6. the spec clause it implements is cited in the commit message or the PR body