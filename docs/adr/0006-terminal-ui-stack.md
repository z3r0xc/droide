# ADR 0006 — Terminal UI is React + Ink, tokens from the spec

- Status: accepted
- Date: 2026-11-12
- Deciders: project owner (design must match one-to-one), orchestrator

## Context

The reference build's interactive surface is a React component tree rendered to
a terminal (`src/components/**`, 340 files, plus `src/repl/**`), and
`specs/95-terminal-ui.md` pins its appearance as data: a palette table, a glyph
set, spacing constants, row budgets, key bindings and the capability matrix for
16-colour and `TERM=dumb` terminals.

Writing a terminal layout engine by hand would put the *design contract* behind
hand-written cursor arithmetic, and every spacing rule would be a place to
drift.

## Decision

1. **React + Ink** for the interactive UI. Ink is the same rendering model the
   reference build uses (flexbox-ish layout, components, hooks), so a spec clause
   about "a 6-column transcript inset" maps to one style property instead of
   custom escape-sequence code. Both are MIT-licensed third-party libraries, not
   recovered code.
2. **The spec owns the pixels.** `src/ui/tokens.ts` transcribes the palette,
   glyphs and spacing from `specs/95-terminal-ui.md` as typed constants; no
   component may hard-code a colour or glyph. A unit test asserts the token
   table against the spec values.
3. **Frames are tested, not eyeballed.** A test renders the shell to a fake
   stdout at fixed sizes (80×24, 120×40) and compares against a golden frame
   stored under `tests/unit/ui/frames/`. Wrapping and truncation rules from the
   spec are asserted on the rendered text, not on internal components.
4. **No UI on non-TTY.** `TERM=dumb`, a missing TTY, or `CI=1` selects the
   documented degradation path (plain text), which is what the CLI's non-TTY
   refusal already guarantees for prompts.

## Consequences

- Two dependencies appear in `package.json` (`ink`, `react`), with `@types/react`
  in dev dependencies. They are the only runtime dependencies beyond `commander`.
- Component code is testable without a terminal, but snapshot frames are
  sensitive to Ink's layout engine version: the version is pinned exactly and
  upgraded deliberately, with frames re-recorded in the same commit.
- The UI never owns business logic: it renders state from `src/agent` and sends
  intents back, so every behaviour remains testable headlessly.

## Alternatives considered

- **Hand-written ANSI renderer**: full control, but every layout rule becomes
  bespoke code and the 1:1 design requirement becomes untestable.
- **Blessed/neo-blessed**: mature, but its widget model does not match the
  reference build's component structure, so the spec's renderer-by-renderer
  clauses would need translation.
- **No interactive UI (exec-only)**: would leave the primary product surface
  unimplemented; rejected by the owner's requirement.