# ADR 0007 — Updates come from this repository's releases

- Status: accepted
- Date: 2026-11-12

## Context

An updater that replaces the running binary is the one command that can install
code from somewhere we do not control. Pointing it at another vendor's
distribution endpoint would misappropriate that vendor's release channel, and the
artefact it installed would not be ours.

`specs/10-cli-surface.md` §B75 pins the _command surface_ (`-c/--check`,
`-v/--version <v>`) and the exit-code behaviour, but not the transport — the
endpoint is our choice to make.

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
3. **Installation is specified separately.** `update` without `--check` installs
   per **ADR 0009** (staged download, digest verification, atomic swap, rollback).
   This ADR keeps only the feed decision: where the version comes from.
4. **A private repository is expected to answer 404.** Anonymous clients cannot
   see it, so `--check` reports "no release feed visible to an anonymous client"
   rather than pretending the project has no releases. Authenticating would mean
   storing a token, which this command must not do.
5. **A rate limit is named as one.** An anonymous client is limited per
   address, and the same `403` arrives from a blocked network. Both are
   temporary, so the reason says "the release feed is rate-limited" and, when
   `x-ratelimit-reset` is present, how many minutes to wait — a bare status
   reads like a broken feed. The install path reports it the same way.
6. **Version comparison is semver-only.** A tag that is not `vX.Y.Z` is ignored
   with a warning rather than "upgrading" on a lexicographic accident.

## Consequences

- `update --check` works in CI and offline deterministically: the HTTP client is
  injected, so tests never open a socket.
- Users are never pointed at another vendor's binaries, and the installed
  artefact is always built from this repository.
- Until installation lands, the command is honest about being read-only.

## Alternatives considered

- **Call another vendor's endpoint**: appropriates that vendor's channel and
  installs an artefact that is not this project. Rejected.
- **No update command at all**: leaves a documented command permanently
  unimplemented; the CLI surface is part of the contract.
- **Self-replace via npm**: viable later, but it needs the same atomicity work
  and its own ADR.
