# ADR 0000 — Template

MADR-lite. Copy this file to `NNNN-<slug>.md`, number it in sequence, and fill
every section. Keep it short: one page is the target. An ADR records a decision
that constrains later work, together with the reasons that would otherwise be
lost.

---

# NNNN — <short decision title>

- **Status:** proposed | accepted | superseded by ADR-NNNN | deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** <who or which role>
- **Related:** <spec files, ADRs, evidence ids>

## Context

What forces a decision here. State the facts that are established, with their
evidence ids, and mark anything still assumed. Include the constraints that
bound the choice — scope, tooling available, what the project forbids — and the
question this ADR answers, in one sentence.

## Decision

The choice, in the active voice: "We recover X by doing Y." Be specific enough
that a reader could implement it and a reviewer could tell whether the work
follows it. If the decision has parts that are conditional, say under what
condition each applies.

## Consequences

What follows, both good and bad, including costs that must be paid now and
constraints imposed on future work. Name the follow-up work it creates and the
risks it accepts. If it makes some earlier option unavailable, say so.

## Alternatives

Each alternative that was seriously considered, with the reason it lost. An
alternative dismissed without a reason is not recorded here. Include "do
nothing" when it was a real option.

## Notes

Optional. Links, measurements, or observations that informed the decision but
do not belong in Context.
