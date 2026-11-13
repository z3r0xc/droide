# droide — engineering handbook

How Droide is specified, decided and built. The product itself is described in
the [README](../README.md); this directory holds the process.

## Goal

Droide is a terminal coding agent. Its observable behaviour — the command
surface, the data and configuration it reads and writes, and its failure modes —
is written down in `specs/` before it is implemented, and every clause carries a
citation and at least one deterministic test.

The specification is the deliverable. The implementation is the check that the
specification is complete and unambiguous enough to build from.

## Method

Three disciplines, applied in this order:

1. **SDD — spec driven development.** Every subsystem gets one spec file under
   `specs/`. A spec states the observable contract, cites the evidence it rests
   on, and lists acceptance tests. Nothing is implemented that is not specified,
   and nothing is specified without evidence. See `specs/README.md`.
2. **ADD — architecture driven design.** Decisions that constrain structure are
   recorded as ADRs under `docs/adr/`, in the MADR-lite format given by
   `docs/adr/0000-template.md`. The ADR is written when the decision is made,
   not reconstructed afterwards.
3. **TDD — test driven development.** Every acceptance criterion in a spec maps
   to at least one deterministic test. Tests run offline, without a clock or
   network dependency, and fixtures are synthesised rather than copied from a
   proprietary artefact. See `tests/README.md`.

Analysis happens in `tools/` and produces evidence, never conclusions on its
own: see `evidence/README.md` for the ledger conventions that tie an observation
to a spec clause.

## Provenance policy

Evidence, contract and implementation are kept apart
([ADR 0003](./adr/0003-evidence-first-clean-room-policy.md)):

- raw inputs, extracted bundles and recovered sources live untracked under
  `raw/` and `evidence/`, and are never committed or shipped;
- `specs/` states behaviour in prose and tables, with a citation per claim;
- `src/` and `crates/` are written against the spec, not against the evidence.

## Layout

| Path        | Contents                                                        |
| ----------- | --------------------------------------------------------------- |
| `docs/`     | Project overview, vendored-artefact provenance, ADRs            |
| `specs/`    | One specification per subsystem, plus the spec template         |
| `tests/`    | Acceptance tests and fixtures, mapped to spec clauses           |
| `tools/`    | Deterministic analysers and extractors, each with tests         |
| `evidence/` | The evidence ledger: what was observed, derived, or inferred    |
| `raw/`      | Untracked reference artefacts (binaries, upstream source trees) |

## Documents

| File                     | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `plan.md`                | milestones, gates, definition of done                             |
| `status.md`              | living dashboard: what works, what is in flight, known gaps       |
| `gaps.md`                | every `TODO(spec …)` marker, generated from code (`npm run gaps`) |
| `release.md`             | versioning, release gates, artefacts, rollback                    |
| `rust-setup.md`          | how the Rust toolchain is configured on this workstation          |
| `adr/`                   | architecture decisions, one file per decision                     |
| `architecture/README.md` | evidence-derived layer map of the reference tree                  |
