# Droide

A clean-room reimplementation of the `droid` CLI v1.9.0 — same observable
behaviour and the same terminal design, built from a written specification
instead of the original source.

**TypeScript** is the product layer (CLI, agent loop, tools, sessions,
transport). **Rust** is the native layer (pty, search, secrets, sandbox), behind
one JSON-lines helper process. Both live in one tree and share one contract:
`specs/`.

## Layout

```
.
├── src/                     TypeScript product layer (Node 24, ESM, type-stripped)
│   ├── main.ts              process entry
│   └── cli/                 argument parsing, help, branding, refusals
│       └── commands/        one module per command group
├── crates/                  Rust native layer (Cargo workspace)
│   └── droide-native/       JSON-lines helper: version, hashing, (later) pty/search/secrets/sandbox
├── specs/                   clean-room specifications — the source of truth
├── docs/
│   ├── adr/                 architecture decisions
│   ├── architecture/        evidence-derived map of the subject
│   └── plan.md              milestones, gates, definition of done
├── tests/
│   ├── parity/              declarative CLI harness (goldens are local)
│   ├── unit/                fast, hermetic unit tests
│   └── integration/         tests that cross a process boundary
└── tools/                   notes on the local (untracked) analysis workspace
```

Untracked by design: `raw/` (vendored binaries), `evidence/` (recovered code and
extracted bundles), `.work/` (analysers, recorded goldens, scratch).

## Quick start

```sh
npm ci
npm run cli -- --help          # or: node src/main.ts --help
npm run typecheck
npm test                       # unit + integration
npm run test:parity            # needs .work/parity goldens (local only)
cargo test --workspace         # native layer
```

## Method

- **SDD.** `specs/` states observable behaviour, each claim labelled
  `[observed]`, `[derived]` or `[inferred]`, with a citation. Nothing is
  implemented before it is specified.
- **ADD.** Every structural choice is an ADR under `docs/adr/`.
- **TDD.** Each acceptance criterion in a spec maps to a deterministic test that
  runs without network, credentials or wall-clock dependence.

See `docs/plan.md` for milestones and their gates, and `docs/status.md` for the
current dashboard.

## Licensing

The reimplementation is original work written from the specification. No code
from the subject is copied, and no proprietary artefact is tracked in this
repository (see `docs/adr/0003-evidence-first-clean-room-policy.md`).