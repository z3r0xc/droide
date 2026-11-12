# Unit tests

Files live under `tests/unit/<area>/` and are named for the behaviour they pin,
not the module they happen to import: `cli/refusal-lines.test.ts` covers the
refusal composition in `src/cli/tty.ts`, and `cli/process-help.test.ts` covers
the help pages as a spawned process. Every file is `*.test.ts`, uses `node:test`
with `node:assert/strict`, and runs through Node's type stripping — no transpile
step and no test-framework dependency. Tests are hermetic: no network, no wall
clock, no shared mutable state, and a process is always spawned from an argument
array with a pinned environment (`NO_COLOR=1`, `TERM=dumb`, `COLUMNS=80`).

Run everything with `npm test` (that is
`node --test tests/unit/ tests/integration/`), one area with
`node --test tests/unit/cli/`, or a single file with
`node --test tests/unit/cli/refusal-lines.test.ts`. Shared, non-test helpers sit
beside the tests and are excluded by the runner because their names lack the
`.test.ts` suffix.