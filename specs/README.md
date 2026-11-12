# Specifications

This directory holds the specification of `droid` 1.9.0: one file per
subsystem, written before any reimplementation of that subsystem exists.

A spec is the contract the reimplementation is built against and judged by. If
the implementation needs a behaviour the spec does not state, the spec is
incomplete; fix the spec first.

## Rules

1. **One file per subsystem**, named `<subsystem>.md` in lower kebab case
   (`config-precedence.md`, `session-store.md`). A spec may reference another;
   it may not restate it.
2. **Every claim is observable.** A clause describes something a caller, a file,
   or a log can see: inputs, outputs, ordering, persisted shapes, exit codes,
   error identities. Internal structure is described only where it is part of
   the contract.
3. **Every clause carries evidence.** Cite ledger ids (`ev_<topic>_<n>`, see
   `evidence/README.md`) in the Evidence section, mapped to the clauses they
   support. A clause with no evidence is marked `UNSUPPORTED` and blocks
   implementation of that clause.
4. **Every clause has an acceptance test.** The Acceptance tests section names
   at least one test per behavioural clause, by test id. A clause with no test
   is not done. See `tests/README.md` for the determinism rules those tests must
   meet.
5. **Separate observation from inference.** Where the evidence does not fully
   determine behaviour, write the narrowest clause the evidence supports and
   record the remainder under Open questions. Never smooth a gap with a guess.
6. **State the version.** A spec describes `droid` 1.9.0 and says so in its
   header. Behaviour attributed to a different version belongs in a different
   spec file or is out of scope.
7. **Open questions are first class.** Each one names what would settle it — an
   extractor change, a specific evidence topic, a decision — and stays until it
   is closed or explicitly deferred with a reason.

## Template

Start from `template.md`. Keep the section order; delete a section only if it is
genuinely empty and say why in Scope.

## Status vocabulary

Each spec header carries a status:

| Status | Meaning |
|---|---|
| `draft` | Being written; clauses may be incomplete |
| `review` | All clauses have evidence and tests named; awaiting check |
| `stable` | Implemented and its tests pass; changes need a new clause |
| `blocked` | Waiting on an open question or missing evidence |

## Index

_No subsystem specs exist yet. Phase 1 is extraction; the first specs are
opened once the recovered payload has been mapped._
