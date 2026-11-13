# Changelog

The CLI's `--version` reports `PRODUCT_VERSION` from `src/cli/brand.ts`, which a
unit test keeps equal to the package version; a release bumps both. The recorded
CLI cases check the version line by shape, not by number. See `docs/release.md`.

## 0.4.0 — 2026-11-13

### Added

- **`mcp auth` end to end**: protected-resource and authorization-server discovery,
  RFC 7591 dynamic registration (or a configured client id), PKCE S256, the
  loopback callback with state validation, the code exchange, and a credential
  written to the OS-sealed store with its issuer, client metadata and a
  compare-and-set revision (ADR 0008). A server that needs no authentication is
  reported and the command exits 0.
- **Native helper behind the tool runtime**: a `native-backend` seam
  (`search.walk`, `search.text`, `path.resolve`) beside the existing TypeScript
  implementations, selected conservatively and degrading to `local` with a
  diagnostic when the helper fails — proven by backend-parity tests.
- **`update` installation** (ADR 0009): the release's assets are resolved, the
  archive is streamed to a staging directory while being hashed and compared with
  `timingSafeEqual`, the swap is two renames in one directory, a single probe
  runs the new binary, and a failed probe restores `.old-<version>`. An `O_EXCL`
  lock prevents concurrent installs; a non-writable directory is refused with the
  exact path and no elevation.
- `doctor --checks updates` compares the running version with the release feed.
- A command-tree smoke net: every command group must answer `--help`, unknown
  words are refused as prompts, and a declared-but-unbuilt mode fails loudly.
- CI is live (the repository is public): six jobs — typescript,
  typescript-windows, rust, rust-windows, supply-chain, parity.

### Changed

- **The product is Droide** (ADR 0010): `--version` reports `0.4.0`, the help
  tagline and the docs link are ours, and the CLI harness records our own
  snapshots instead of comparing against another build.
- **Our own state directory and environment variables** (ADR 0011): `~/.droide`,
  `<cwd>/.droide`, `.droide-plugin/`, `DROIDE_API_KEY`,
  `DROIDE_HOME_OVERRIDE`, `DROIDE_RUNTIME_SETTINGS_PATH`, `DROIDE_ENV`. Nothing
  is migrated from the previous layout: 0.4.0 is the first release under these
  names, and no earlier installation is in use.
- The specifications keep neutral provenance language: behaviour is cited from an
  untracked evidence corpus (ADR 0003), and no document names another product,
  its version or its vendor.

### Fixed

- The config-context fixture used a hard-coded platform, so it passed on Windows
  and failed on the Linux CI runner.
- `docs/gaps.md` is regenerated only together with the sources it describes.

## 0.3.0 — 2026-11-13

### Added

- **Agent turns in the interactive shell**: submitted lines run a turn, assistant
  text is coalesced per frame, tool rows go `pending → success/error`, thinking is
  collapsed, R11 approvals offer the three documented choices (single call,
  session, deny), Esc cancels, quit disposes the driver — no provider request,
  `AbortController` or timer survives.
- **Plugin marketplaces and installation**: `known_marketplaces.json`, git-backed
  `marketplace add|remove|list|update` with the manifest validated before
  adoption, `plugin install|uninstall|update` into either scope through an
  injected git runner, atomic registry merges, collision and reference refusals.
- **Session transcript index**: migration 10 (`transcript_index`,
  `transcript_index_value`, three indexes, three triggers), pragmas and shape
  validation, corrupt-file quarantine, a pure refresh planner (insert/update/
  skip/delete by mtime+size), and search served from the index with a _proving_
  fallback to the literal scan (`--reindex` refreshes).
- **PTY in the native helper**: ConPTY on Windows and `openpty` on Unix behind one
  session registry (`pty.spawn|read|write|resize|kill|close`), typed TypeScript
  wrappers, and a contract test that spawns a real process through the compiled
  binary.
- **MCP OAuth building blocks**: PKCE (RFC 7636 vector), the loopback callback
  with state validation and a 4-minute window, token exchange and refresh with
  typed errors, and a sealed credential store with revisions and tombstones
  (ADR 0008). The `mcp auth` command itself is not wired yet.
- `doctor --checks mcp` connects to enabled servers and reports tool counts;
  `computer list` reports registration scope; `exec` honours
  `--append-system-prompt[-file]` and `--disable-builtin-skills`.

### Fixed

- `exec` no longer ignores `--disable-builtin-skills` silently.
- Sandbox path validation accepts paths absolute on the _target_ platform.

## 0.2.0 — 2026-11-12

### Added

- `resume`: session listing, id and session-link parsing, continuation through the
  `exec -s` path, `--fork`, and typed refusals for unknown/archived/misused ids.
- `mcp add` / `mcp remove`: surgical JSONC edits (comments, key order and
  indentation preserved), atomic writes, alias-aware duplicate refusal.
- `mcp permissions list|revoke|clear`: nested `persistentPermissions`, legacy key
  migration on read, server revoke cascading to tools.
- Context compaction: token estimate with a documented basis, strict threshold
  plus hard ceiling, tool-pair preservation, `user_only` exclusion, a summariser
  port, and a `compaction` turn event — wired into the loop and into `exec`.
- Typed, validating wrappers for all nine native helper methods, plus
  `npm run test:native` (builds the crate, runs the contract against the binary).
- `doctor` probes: proxy validation, `NODE_EXTRA_CA_CERTS` readability,
  credential presence reported by length only.
- README in Russian and Simplified Chinese with a language switcher; ADR 0007
  (update channel); SECURITY.md, CONTRIBUTING.md, release process, PR/issue
  templates.

### Fixed

- Sandbox path validation now accepts a path that is absolute on the **target**
  platform (`C:\…`, `\\server\…`) instead of requiring POSIX form.
- The permission-denial guidance text matches the specification verbatim.
- The process-tree test no longer fails on Windows cleanup (`rmSync` retries).

## 0.1.0 — 2026-11-12

### Added

- CLI surface with recorded parity goldens (20/20): root options, every visible
  and hidden command, help rendering, non-TTY refusal.
- `exec` with `text`, `json` and `stream-json` output, session continuation and
  streaming input.
- `search|find` over the session store; `doctor` with text and `--json` reports;
  `update --check` against this repository's releases.
- SQLite session store with migrations, transcript records and search.
- Daemon: WebSocket transport, JSON-RPC protocol, authenticate gate, single
  instance, ordered shutdown.
- Interactive Ink shell with tokens from the spec, key handling and teardown.
- Rust helper: protocol, safe paths, file search, sandbox profiles, PTY quoting,
  DPAPI secrets — 57 tests.
