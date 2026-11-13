# ADR 0010 — Droide is its own product; the CLI harness records our snapshots

- Status: accepted (supersedes ADR 0004 and ADR 0005)
- Date: 2026-11-13
- Deciders: project owner

## Context

Two earlier decisions assumed the project would present itself as a
reimplementation of someone else's CLI:

- **ADR 0004** recorded goldens from that binary and diffed our output against
  it, with an optional mode that replayed the comparison against the binary.
- **ADR 0005** kept the other product's name in user-facing text and normalised
  our program name back to it during comparison, and printed the other
  product's version from `--version`.

The owner has since decided the repository is **Droide**: our own public
product, with its own name, version, documentation link and tagline. Behaviour
was derived clean-room with the process in ADR 0003 (evidence stays untracked),
but the shipped artefact must not claim to be, or point at, another product.

## Decision

1. **One identity.** `src/cli/brand.ts` is the only place the program name, the
   display name, the tagline, the version and the docs URL appear. `--version`
   prints `PRODUCT_VERSION`, which equals `package.json` and is checked by a
   test. The docs link points at this repository.
2. **No cross-product normalisation.** The old mechanism that rewrote our name
   into another product's is deleted, together with the constant naming that
   product. A user-visible string that mentions another product is now a defect,
   and `tests/unit/cli/brand-contract.test.ts` fails on it.
3. **The CLI harness becomes a snapshot harness.** `tests/parity/run.mjs` keeps
   its declarative cases and hermetic sandbox, but `--record` captures **our**
   build; `--check` compares against those snapshots. It is a regression net for
   our own output — help text, exit codes, error strings — not a claim of
   equivalence with anything.
4. **Snapshots never ship.** They stay in the untracked workspace
   (`tests/parity/expected/`), which are tracked, so CI always runs the harness,
   before.
5. **Behaviour derived from evidence stays evidence.** The specifications still
   describe observed behaviour and cite the untracked corpus; ADR 0003 is
   unchanged on provenance, and no recovered source is published.

## Consequences

- `--version`, `--help` and every error string now belong to Droide; a snapshot
  records them so a change is visible in review.
- Nothing in the harness reaches for another binary: re-recording is a
  deliberate act against our build, so a regression cannot be laundered into a
  new golden by pointing the recorder somewhere else.
- The specifications keep neutral provenance language ("the reference build")
  and cite the untracked corpus; nothing in them names another product.

## Alternatives considered

- **Keep the other product's version for "compatibility"**: dishonest — we are
  not that product, and `update --check` compares against our own releases.
- **Drop the harness entirely**: loses the cheap regression net over the CLI
  surface, which is the part users notice first.
- **Keep an optional cross-product mode**: reintroduces the comparison the owner
  asked to remove, and makes "pass" depend on an artefact we no longer
  reference.
