# ADR 0004 — Declarative parity cases with an optional oracle

- Status: accepted
- Date: 2026-11-12

## Context

The owner authorised running the original binary for behavioural diffing
("оффлайн, без логина"). Screenshot-style comparisons do not scale to a CLI
with dozens of commands and flags, and ad-hoc shell scripts cannot be replayed
in CI. We need one mechanism that (a) pins behaviour in a reviewable form,
(b) can be executed against our implementation alone, and (c) can be re-recorded
against the original when it changes.

## Decision

Every parity expectation is a **declarative case**, stored in
`tests/parity/cases/*.json` (JSON, not YAML: the runner takes no dependencies),
executed by `tests/parity/run.mjs`:

```json
{
  "name": "version",
  "argv": ["--version"],
  "expect": { "exit_code": 0, "stdout_lines": 1,
              "stdout_matches": "^\\d+\\.\\d+\\.\\d+$", "stderr_empty": true }
}
```

Runner contract:

- **Hermetic sandbox.** Each case runs in a fresh temp dir used as `HOME`,
  `USERPROFILE`, `XDG_CONFIG_HOME` and cwd; a fixed `PATH`, `TZ=UTC`,
  `NO_COLOR=1`, `TERM=dumb`; network denied by an unroutable proxy env; wall
  clock independent assertions only.
- **Two targets.** `--target ours` (default) runs `src/` via node.
  `--target oracle` runs the binary named by `DROID_ORACLE`, and is refused
  unless that file exists and the case declares `oracle: true` (some cases —
  help text, version, argument errors — are safe; anything that could contact
  the backend is excluded by construction).
- **Three modes.** `--record` writes `expected/` golden files from the oracle
  (redacted: home paths → `<HOME>`, version strings normalised on request);
  `--check` (default) compares our output to the golden files; `--update` is
  never implicit.
- **No silent skips.** A case whose fixture cannot be built fails loudly. A
  case needing the oracle is reported as `skipped(no-oracle)` in the summary
  and is not counted as passing.
- **Deterministic assertions only**: exit code, stdout/stderr bytes (with the
  documented redactions), created/modified file set under the fixture dir
  (paths and hashes), and exit-time absence of leftover child processes.
- **Side effects are part of the contract.** Files a command writes (config,
  session DB, worktree) are compared by path and, where text, by redacted
  content.

## Consequences

- The suite runs in CI against our implementation with no proprietary artifact.
- Recording against the oracle is an explicit, reviewed act; goldens are
  tracked text, so drift is visible in diffs.
- Cases encode behaviour, not implementation: refactoring our code cannot break
  them, but changing behaviour must change a case and the spec section it names.

## Alternatives considered

- **Snapshot the whole terminal (VCR-style)**: brittle against ANSI, locale and
  timing; rejected for the default path. Interactive TUI behaviour gets a small
  number of dedicated frame tests instead.
- **Only unit tests**: cannot detect flag-precedence or error-text drift, which
  is exactly where CLI parity lives.
