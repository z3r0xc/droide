# ADR 0011 — Our own on-disk layout and environment variable names

- Status: accepted (completes the identity change of ADR 0010)
- Date: 2026-11-13
- Deciders: project owner ("свой бренд"), orchestrator

## Context

ADR 0010 gave the product its own name, version and docs link. Two layers of the
surface still carried the other vendor's names, because the behaviour was derived
from that build:

- the state directory (`~/.factory`, `<cwd>/.factory`, `.factory-dev`) and the
  plugin manifest directory (`.factory-plugin/`);
- environment variables (`FACTORY_API_KEY`, `FACTORY_HOME_OVERRIDE`,
  `FACTORY_RUNTIME_SETTINGS_PATH`, `FACTORY_ENV`).

Shipping them means our product writes into another vendor's directory, reads
their variables, and looks like a clone on disk. That contradicts the brand
decision and creates a real conflict: a user running both products would have
two applications fighting over one state directory.

## Decision

1. **State directory is ours.**
   - production: `~/.droide`
   - development: `~/.droide-dev` (selected by `DROIDE_ENV=development`)
   - project: `<cwd>/.droide`
   - worktrees: `<state>/worktrees`, sessions `<state>/sessions`, index
     `<state>/sessions/index/index.db`, logs `<state>/logs`, plugins
     `<state>/plugins`, credentials `<state>/mcp-oauth.v2.sealed`,
     installation root `<state>/install` — every path keeps its *shape*, only the
     root name changes.
2. **Environment variables are ours.** `DROIDE_API_KEY`,
   `DROIDE_HOME_OVERRIDE`, `DROIDE_RUNTIME_SETTINGS_PATH`, `DROIDE_ENV`,
   `DROIDE_NATIVE_BIN`. No variable of the other vendor is read, ever.
3. **Plugin layout is ours.** `.droide-plugin/marketplace.json` and
   `.droide-plugin/plugin.json`. The foreign manifest directory is not read; a
   marketplace that only publishes it is refused with the documented error rather
   than silently accepted.
4. **No migration from the other directory.** We do not import its settings,
   sessions or credentials: doing so would read another product's data without
   the user asking. A user who wants their settings can copy the JSON by hand.
5. **One place owns it.** `src/config/paths.ts` holds the directory names and the
   variable names as constants; nothing else hard-codes them. Tests build their
   fixtures from those constants.

## Consequences

- Existing installations of *this* build (0.4 and earlier) would lose their
  state; there are none in use, and the CHANGELOG says so.
- The specifications that quoted the other product's paths and variables are
  updated to ours; where a clause's *meaning* depends on the foreign name (a
  documented refusal of a foreign layout), it stays as a labelled note.
- `pq`-style tooling and docs that referenced `~/.factory` are rewritten.

## Alternatives considered

- **Keep `.factory` for compatibility**: keeps a conflict with a product we are
  not, and publishes their identity under our name.
- **Support both, preferring ours**: doubles the surface, and the "fallback"
  quietly reads another product's data — rejected on the same ground as point 4.
- **Neutral name (`~/.config/droide`)**: XDG-correct on Linux but splits the
  layout per platform; the reference layout is a single home directory and keeping
  that shape minimises the diff.