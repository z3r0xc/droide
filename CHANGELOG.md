# Changelog

The CLI's `--version` reports the subject's version (`1.9.0`) so parity stays
meaningful; the package version below tracks this implementation. See
`docs/release.md`.

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
