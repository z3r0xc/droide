# Tests

Three suites, one rule: **deterministic**. No network, no credentials, no wall
clock, no dependence on any external binary, no shared state between tests.

| Suite | Location | Runs | Purpose |
|---|---|---|---|
| Unit | `tests/unit/**/*.test.ts` | `npm test` | Pure functions and modules: parser, help rendering, config precedence, store SQL, protocol framing |
| Integration | `tests/integration/**/*.test.ts` | `npm test` | Things that cross a process or file boundary: spawning our CLI, migrating a real database file, the native helper over stdio |
| Snapshots | `tests/parity/run.mjs` | `npm run test:parity` | Compares our CLI's observable output against snapshots recorded from this build (snapshots are local, in `.work/parity/`, never committed) |

## Conventions

- Runner: Node's built-in `node --test`. Files are `*.test.ts`, executed via
  type stripping — no transpile step, no test framework dependency.
- File names describe the behaviour under test, not the module:
  `refusal-with-prompt-word.test.ts`, not `tty.test.ts`.
- One behaviour per test. The test name states the expectation; the assertion
  proves it.
- Fixtures are created in a temp directory (`fs.mkdtemp`) and removed. A test
  never writes to the repository, to the user's home, or to `.work/`.
- Time and randomness are injected. If a module needs a clock, it takes one.
- A test that must observe a process uses an argument array (never a shell
  string) and a pinned environment (`TZ=UTC`, `NO_COLOR=1`, `TERM=dumb`).

## What not to test

Wiring that the type system already proves, echo behaviour of a literal, and
anything whose failure cannot be observed by a user. Tests exist to catch
plausible regressions, not to raise a count.

## Parity goldens

`tests/parity/cases/*.json` are declarations (tracked locally only, in
`.work/parity/`); the harness supports `--record` against our own build and
`--check` against ours. See `docs/adr/0010-own-brand-and-snapshot-harness.md`.
A case that needs the oracle is reported `skipped`, never silently passed.