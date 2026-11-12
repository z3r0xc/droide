# ADR 0005 — Project name is `droide`; CLI design stays identical

- Status: **superseded by [ADR 0010](./0010-own-brand-and-snapshot-harness.md)** (one identity, no cross-product normalisation)
- Status: superseded
- Date: 2026-11-12
- Deciders: project owner

## Context

The owner asked for a name similar to the subject's ("Droid") while keeping the
CLI/TUI design one-to-one. A different program name changes every place the
subject prints its own name: the usage line, the non-TTY refusal, hints that say
`ssh -t <host> droid`, and the `droid exec` suggestions.

Parity goldens recorded from the subject therefore contain a token that our
build must not print verbatim.

## Decision

1. **Name.** The project, package and binary are `droide` (`Droide` in prose).
   It reads as the subject's name in Romance languages, is short, and does not
   collide with the analytics products that own "Druid".
2. **Design is unchanged.** Layout, wording, colours, spacing, key bindings and
   every user-visible string are reproduced exactly, with one substitution: the
   program token. `specs/` records text as the subject prints it and marks the
   token as `${PROGRAM}`.
3. **Parity normalisation.** `tests/parity/run.mjs` rewrites our program token to
   the subject's before comparing against a golden, and the substitution is
   restricted to whole-word matches of the configured names. Nothing else is
   normalised: any other difference is a failure.
4. **No hidden aliasing.** We do not ship a `droid` binary or symlink. The name
   appears in user-facing text only through one constant (`src/cli/brand.ts`).

## Consequences

- Goldens stay byte-exact against the subject; our build differs only in the
  program token, and that difference is mechanical and reviewable.
- Error strings that embed the program name must be templated, never hard-coded,
  so a future rename is one constant.
- The TUI design spec (`specs/95-terminal-ui.md`) is binding: replicating the
  subject's appearance is a requirement, not a preference.

## Alternatives considered

- **Keep the name `droid`**: collides with the original product, its docs and its
  update channel; unacceptable for a distributable reimplementation.
- **Free-form rename with no normalisation**: would drift the help/error text and
  make parity failures noisy, hiding real regressions.