# ADR 0003 — Evidence-first clean-room policy

- Status: accepted
- Date: 2026-11-12

## Context

The subject's original TypeScript is recoverable from source maps embedded in
the shipped binary (`tools/bunsmap/recover.py`). That creates a licensing and
provenance hazard: recovered code is proprietary, and a reimplementation that
copies it inherits the original's licence obligations and is not a clean-room
work at all.

At the same time, the project exists to reach behavioural parity, which
requires precise knowledge of behaviour, not guesses.

## Decision

Separate *evidence* from *contract* from *implementation*:

1. **Evidence (untracked).** Raw binaries, extracted bundles, recovered source,
   decoded maps and generated indexes live under `evidence/` and `raw/`, which
   are git-ignored. They never enter the repository or the published package.
2. **Contract (tracked).** `specs/*.md` state observable behaviour in prose and
   tables, with a citation to the evidence location (`file:line`) for each
   claim and an explicit `[observed] / [derived] / [inferred]` label. Specs are
   written by the analyst, reviewed, and are the only input the implementation
   is allowed to follow.
3. **Implementation (tracked).** Written against the spec by a developer who is
   not copying the recovered source. Short identifiers such as a flag name, a
   file path, a JSON key or an error string are contract data and may appear
   verbatim; functions, control flow and comments are not.
4. **Tests (tracked).** Every acceptance criterion in a spec maps to at least
   one deterministic test. Fixtures are synthesised. Tests may *observe* the
   original binary (see ADR 0004) but must not depend on it to pass by default.

A change that breaks parity must fail a test that names the spec section it
contradicts.

## Consequences

- Reviewers can audit every tracked claim back to a byte range or line, without
  the recovered source being in the repository.
- The recovered tree may be incomplete (barrel modules elided by the bundler,
  type-only files absent). Specs record the boundary of what was examined, and
  gaps become open questions rather than assumptions.
- The published artefact contains no proprietary text. `npm pack` output is
  checked in CI for strings unique to the original implementation.

## Alternatives considered

- **Publish recovered code as a fork**: legally and ethically unacceptable, and
  it is not a reimplementation.
- **Black-box only (no source recovery)**: would take far longer and produce a
  weaker specification, since observable surfaces (internal flags, protocol
  shapes, schema) are not all reachable from the CLI.
