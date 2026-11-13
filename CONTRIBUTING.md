# Contributing

## The gate

`npm run verify` runs the TypeScript gates in order, plus the parity snapshots;
`npm run verify:rust` runs the Rust side, including the contract test against the
compiled helper. `npm run brand:check` is a separate step, which CI runs on its
own line.

Every change must pass, in this order:

```sh
npm run typecheck      # tsc --noEmit
npm run format:check   # prettier over src/tests/json
npm test               # unit + integration (node --test)
npm run test:parity    # CLI snapshots recorded from this build (local only)
npm run gaps:check     # docs/gaps.md matches the TODO(spec …) markers in src/
npm run brand:check    # no other product's name, release number or vendor host
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs all of it except the parity suites that need recorded goldens (those are
recorded locally and never committed — see
`docs/adr/0010-own-brand-and-snapshot-harness.md`).

## Spec first

1. Find the clause in `specs/` that describes the behaviour. If it is missing,
   add the clause **first**, with a citation and an acceptance test, and have it
   reviewed.
2. Write the failing test.
3. Make it pass.
4. If you cannot implement a clause, leave a `TODO(spec <clause>): …` marker and
   run `node tools/gaps.mjs`. A silent narrowing is a defect.

Never invent behaviour to fill a gap: `docs/gaps.md` exists so the distance
between the specification and the build is visible.

## Provenance

Recovered reference sources, extracted binaries and recorded cases live under
`raw/`, `evidence/` and `.work/`, which are git-ignored. Nothing from those trees
may be committed, pasted into `src/`, or cited as a source in a commit message.
Specs cite them; code does not copy them (`docs/adr/0003-…`).

## Branches and pull requests

- Work on `feat/<slug>` or `fix/<slug>`.
- Commit messages: `feat(area): …`, `fix(area): …`, `docs: …`, `chore: …`,
  `test(area): …`.
- Open a PR with `gh pr create`; the description names the spec clauses touched
  and the tests that prove them.
- Merge only with a green gate. Squash-merge keeps `main` linear.

## Adding a dependency

Runtime dependencies are deliberately few (`commander`, `ink`, `react`). A new
one needs an ADR in `docs/adr/` stating what it replaces and why a local
implementation is worse.
