# ADR 0002 — Hybrid implementation: Rust for the native layer, TypeScript for the product layer

- Status: accepted
- Date: 2026-11-12
- Deciders: project owner (chose "Rust + TypeScript"), orchestrator

## Context

The reference build ships as a Bun single-file executable whose application
layer is TypeScript (2,889 files across the `app:src` tree and eleven workspace
packages) and whose native layer is a set of helper
blobs embedded beside it: `rust_pty` (`.dll`/`.so`/`.dylib` per platform),
`keytar` (credential storage), `libsqlite3`, a ripgrep-style search binary, a
fuzzy-file-finder C library (`fff_c`), an `agent-browser` executable, a
WebAssembly module, and a 54 MB `script-runtime`.

The build must reach behavioural agreement with the recorded cases, including
native effects: pseudo-terminal sessions, keychain secrets, SQLite, fast file
search and the process sandbox.

## Decision

Two layers, one repository:

1. **`src/` — TypeScript product layer** (Node 24 target, ESM): CLI parsing,
   session store orchestration, agent loop, provider transport, tool dispatch,
   MCP, skills, daemon control, terminal UI. Chosen over Bun for a stable
   runtime already present on the machine; the build target is a plain
   `node`-runnable package with a thin launcher.
2. **`crates/` — Rust native layer** as a Cargo workspace exposing narrow,
   versioned interfaces through one JSON-over-stdio helper binary (the shape the
   reference build uses for its helpers):
   - `pty` — terminal sessions, resize, process-tree teardown;
   - `search` — ripgrep-compatible walking/matching with the same output
     records the TypeScript layer formats;
   - `secrets` — OS credential storage (DPAPI / Keychain / libsecret);
   - `sandbox` — per-platform confinement descriptors (seccomp+landlock,
     seatbelt profile, Windows restricted token/job object).

Interfaces are contracts first: `specs/` defines each helper's request and
response records; the Rust side implements them, the TypeScript side validates
them at the boundary.

## Consequences

- Two toolchains and two test suites; the boundary must be versioned and
  validated on every call (schema check, not trust).
- Native behaviour the reference build hides inside prebuilt blobs (e.g. PTY
  quirks) becomes our responsibility; each such difference needs a spec entry
  and a test.
- Distribution stays simple: one `npm` package plus one helper binary per
  platform.

## Alternatives considered

- **TypeScript only** (node-pty, chokidar, better-sqlite3): fastest start, but
  inherits third-party native modules we cannot specify or pin at the level the
  reference build does, and adds supply-chain surface.
- **Rust only**: strongest parity for native effects and single-binary
  distribution, but the product layer is ~33 MB of TypeScript with heavy
  dynamic shapes (tool schemas, provider streams); re-writing it in Rust would
  slow the specification work rather than accelerate parity.
- **Bun runtime for the TypeScript layer**: closest to the reference packaging
  (`bun build --compile`), rejected only because Bun is not installed here and
  because the CLI cases must run on the same Node the rest of the repo uses.
