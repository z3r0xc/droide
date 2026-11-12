# Release process

## Versioning

Semantic versioning on the product surface (`src/cli`):

- **major** — a documented CLI behaviour changes incompatibly (flag removed,
  output contract broken, spec clause withdrawn).
- **minor** — a command or behaviour from a spec becomes implemented.
- **patch** — fixes that keep every documented contract intact.

The CLI's `--version` reports `PRODUCT_VERSION` from `src/cli/brand.ts`, and a
unit test keeps it equal to the *package* version (`package.json`). A release
bumps both in the same commit; never "fix" one on its own.

## Gates before a release

```sh
npm run typecheck && npm run format:check && npm test
npm run test:parity          # требует локальных goldens
npm run gaps:check
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Then, in order:

1. `docs/status.md` updated (numbers, milestone board, known gaps).
2. `docs/gaps.md` regenerated (`node tools/gaps.mjs`).
3. PR merged with a green CI run on the branch.
4. Tag on `main`: `git tag -a vX.Y.Z -m "…"` and push the tag.
5. Publish only if the release includes the `files` allowlist from
   `package.json`; the package is `private` until the first intended publish.

## What must never ship

- anything from `raw/`, `evidence/`, `.work/` (git-ignored, and CI asserts the
  tracked tree stays small);
- a spec citation that points at a file no longer present in the repository;
- a command in the README that was not executed against the released tree.

## Artefacts

- npm package: `src/**/*.ts` + `bin/` + README + LICENSE (no tests, no specs).
- native helper: `cargo build --release -p droide-native`, one binary per
  platform, shipped beside the npm package and selected at runtime by
  `src/native/client.ts`.

## Rollback

A bad release is rolled back by publishing the previous tag (`npm dist-tag`),
never by rewriting tags on `main`. The recorded cases check the version line by
shape, so a rollback cannot silently change what they compare.