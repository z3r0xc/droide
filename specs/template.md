# Spec template

Copy to `<subsystem>.md`. Keep the section order. Delete a section only if it is
genuinely empty, and say in Scope why. Header fields are required.

---

# <Subsystem>

- **Target:** the `droide` CLI shipped from this repository
- **Status:** draft | review | stable | blocked
- **Owner:** <role>
- **Related:** <ADR ids, other specs, tool ids>

## Purpose

One paragraph: what this subsystem is responsible for, in terms of what a user
or a collaborating subsystem can observe. Why it exists, not how it is built.

## Scope

What this spec covers, and explicitly what it does not — naming the spec that
covers the neighbouring concern instead. List anything deliberately deferred and
why.

## Terms

Every domain term used below, defined once. Prefer the vocabulary the evidence
establishes; otherwise say the term is ours. Note
spelling, casing, and on-disk key names exactly as they appear.

## Observable behaviour

The contract, as numbered clauses `B1`, `B2`, … so tests and evidence can refer
to them. Each clause states:

- the trigger or precondition,
- the required result, including ordering where it matters,
- any allowed variation (platform, configuration) and what selects it.

Rules for clauses:

- Say what can be seen: outputs, files, state transitions, exit status, log or
  error identity.
- No implementation detail that a caller could not observe.
- One behaviour per clause; if a sentence contains "and then", split it.
- Mark a clause `UNSUPPORTED` rather than guessing, and mirror it in Open
  questions.

## Data & config

Persisted shapes, file locations, formats, environment variables, CLI flags, and
precedence between them. For each: required vs optional, default, type and
domain, and what happens when it is absent, empty, or malformed. Give literal
names, not paraphrases. State where two sources conflict and which wins.

## Errors

Failure modes with their identity as observed (message text, code, exit status),
the condition that triggers each, and the observable effect on state — what is
written, what is left untouched, whether a retry is safe. Group by trigger, not
by message wording.

## Acceptance tests

A table mapping each behavioural clause to the test ids that pin it, plus the
fixture each test needs:

| Clause | Test id                    | Fixture           |
| ------ | -------------------------- | ----------------- |
| B1     | `tests/<area>/test_<name>` | `fixtures/<name>` |

Every clause above must appear at least once. Fixtures are synthesised, never
copies of a proprietary artefact.

## Evidence

Ledger ids backing the clauses, with the clause they support and the method that
produced them:

| Evidence         | Supports | Method                      |
| ---------------- | -------- | --------------------------- |
| `ev_<topic>_<n>` | B1, B2   | <tool, command, or reading> |

Anything "derived" or "inferred" per `evidence/README.md` is labelled as such.
A clause whose only support is inferred stays `draft`.

## Open questions

Each question as a numbered item: what is unknown, what evidence or decision
would settle it, and which clauses are blocked meanwhile. Remove the item when
settled, recording the outcome in Evidence.
