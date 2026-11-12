# droid-re

A specification-first reverse engineering of the Factory AI `droid` CLI, version
1.9.0, followed by a clean-room reimplementation with tests.

## Goal

Produce a written, evidence-backed specification of what `droid` does — its
observable behaviour, its data and configuration surface, and its failure modes
— and then implement that specification independently, with a deterministic
test suite that maps back to it.

The specification is the deliverable. The reimplementation is the check that
the specification is complete and unambiguous enough to build from.

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
   network dependency, and fixtures are synthesised rather than copied from the
   proprietary binaries. See `tests/README.md`.

Analysis happens in `tools/` and produces evidence, never conclusions on its
own: see `evidence/README.md` for the ledger conventions that tie an observation
to a spec clause.

## Current status

**Phase 1: extraction.**

The target artefacts are staged but untracked under `raw/`
(`docs/vendored-artifacts.md` records exactly what, with checksums). The current
work is recovering the JavaScript bundle embedded in the Bun single-file
executables, per `docs/adr/0001-bun-standalone-extraction.md`, and building the
deterministic extractor in `tools/` that phase 2 (behavioural enumeration and
spec writing) will draw on.

No subsystem spec has been written yet. No reimplementation code exists yet.

## Layout

| Path | Contents |
|---|---|
| `docs/` | Project overview, vendored-artefact provenance, ADRs |
| `specs/` | One specification per subsystem, plus the spec template |
| `tests/` | Acceptance tests and fixtures, mapped to spec clauses |
| `tools/` | Deterministic analysers and extractors, each with tests |
| `evidence/` | The evidence ledger: what was observed, derived, or inferred |
| `raw/` | Untracked vendored upstream artefacts (binaries, reference sources) |

## Documents

| File | Purpose |
|---|---|
| `plan.md` | milestones, gates, definition of done |
| `status.md` | living dashboard: what works, what is in flight, known gaps |
| `gaps.md` | every `TODO(spec …)` marker, generated from code (`npm run gaps`) |
| `release.md` | versioning, release gates, artefacts, rollback |
| `rust-setup.md` | how the Rust toolchain is configured on this workstation |
| `adr/` | architecture decisions, one file per decision |
| `architecture/README.md` | evidence-derived map of the subject we reimplement |
