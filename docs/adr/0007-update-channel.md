# ADR 0007 — Updates come from this repository's releases, never from the subject's channel

- Status: accepted
- Date: 2026-11-12

## Context

The subject's `droid update` checks `downloads.factory.ai` and replaces its own
binary. A reimplementation must not call the original vendor's distribution
endpoint: it would misappropriate their release channel, and the artefact it
installed would not be ours.

`specs/10-cli-surface.md` §B75 pins the *command surface* (`-c/--check`,
`-v/--version <v>`) and the exit-code behaviour, but not the transport — the
endpoint is an implementation choice of the original build.

## Decision

1. **Source of truth:** the GitHub Releases API of this repository
   (`https://api.github.com/repos/<owner>/<repo>/releases/latest`), read
   anonymously, with a bounded response and a short timeout. No token, no
   telemetry, no query parameters carrying environment data.
2. **`--check` is read-only and truthful.** It reports one of:
   - `current` — the running version is the newest published release;
   - `available` — a newer release exists, with its version and page URL;
   - `unavailable` — the check could not be completed (offline, rate-limited,
     no releases yet), with the reason and a distinct exit code.
3. **Installation is not implemented yet.** `update` without `--check` refuses
   with the documented message and a `TODO(spec B75)` marker: replacing a running
   installation safely (permissions, atomic swap, rollback) is a separate slice
   with its own ADR.
4. **Version comparison is semver-only.** A tag that is not `vX.Y.Z` is ignored
   with a warning rather than "upgrading" on a lexicographic accident.

## Consequences

- `update --check` works in CI and offline deterministically: the HTTP client is
  injected, so tests never open a socket.
- Users are never pointed at the vendor's binaries, and the installed artefact
  is always built from this repository.
- Until installation lands, the command is honest about being read-only.

## Alternatives considered

- **Call the subject's endpoint**: appropriates another vendor's channel and
  installs an artefact that is not this project. Rejected.
- **No update command at all**: leaves a documented command permanently
  unimplemented; the CLI surface is part of the contract.
- **Self-replace via npm**: viable later, but it needs the same atomicity work
  and its own ADR.