# CLI snapshot suite

Declarative CLI cases plus snapshots recorded from **our** build. See
`docs/adr/0010-own-brand-and-snapshot-harness.md`.

## Layout

- `cases/*.json` — one case per behaviour: `argv`, optional `stdin`, `files`
  fixture, and an `expect` block. Every case runs against our build in the same hermetic sandbox.
- `expected/<case>.json` — snapshot captured from our build with `--record`: exit code, stdout, stderr (home/cwd paths redacted) and, when the
  case asks for it, sha256 of every file the run left behind.

## Running

```sh
node tests/parity/run.mjs --check                    # our implementation
node tests/parity/run.mjs --check --filter help      # subset
node tests/parity/run.mjs --record
```

`--check` is the CI contract: it must pass with no proprietary artifact
present. `--record` is a reviewed act — goldens are tracked text, so drift
shows up in diffs.

## Invariants

- Every case runs in a fresh temp sandbox used as `HOME`, `USERPROFILE`,
  `APPDATA`, `XDG_CONFIG_HOME`, `TMPDIR` and cwd.
- Environment is pinned: `TZ=UTC`, `LANG=C`, `TERM=dumb`, `NO_COLOR=1`, no
  colour, unroutable proxy.
- No case may depend on wall clock, network, credentials, or another case.
- A case the sandbox cannot serve is reported `skipped(reason)`, never silently
  passed.
