# ADR 0009 — Installing an update: download, verify, swap, roll back

- Status: accepted
- Date: 2026-11-13
- Deciders: orchestrator (architecture), pending implementation in this wave

## Context

`update --check` reads this repository's releases (ADR 0007). Installation was
left out because self-replacement is the one operation that can brick an
installation, and the obvious implementations are wrong:

- overwriting the running executable fails on Windows (the image is locked) and
  risks a half-written binary elsewhere;
- trusting the download because it came over HTTPS ignores transit substitution
  and a compromised mirror;
- "copy over the old one" leaves no recovery path if the new build cannot start.

## Decision

1. **Only this repository's releases are installable.** The asset must be
   published by the release the check just read, and the CLI refuses when the
   feed and the asset disagree on version.
2. **Verify before swap.** The release must publish a `sha256` asset; the
   download is hashed while streaming and compared in constant time. No digest,
   no install — there is no "trust me" path.
3. **Stage, then swap.** Download to `<factory>/update/<version>/`, verify, then
   rename the current installation aside (`<dir>/.old-<version>`) and move the
   staged files into place. A rename inside the same directory is atomic on both
   NTFS and POSIX; a cross-device move is refused rather than attempted.
4. **Roll back on failure to start.** After the swap, run the new binary with
   `--version` once, bounded to 15 s. If it fails or prints the wrong version,
   restore `.old-<version>` and report the rollback; the user is never left with
   a non-starting installation.
5. **Never elevate.** If the installation directory is not writable, the command
   fails with the documented message and the exact path; it does not try `sudo`
   or a user-writable shadow copy.
6. **One writer.** A lock file in the update directory (O_EXCL, stale after 1 h)
   prevents two concurrent installs from interleaving.
7. **No silent network.** Everything goes through the injected `fetch`, so tests
   run against a local server and CI never touches the real release feed.

## Consequences

- A release without a `sha256` asset is not installable by this build. That is a
  release-process requirement, documented in `docs/release.md`.
- The rollback probe executes the newly installed binary once; on a platform
  where that is impossible (read-only image), the probe is skipped and the
  command says so.
- The install path stays a normal directory tree, so a package manager that owns
  it will still work: the command writes files, it does not register anything.

## Alternatives considered

- **npm-only updates** (`npm i -g droide@latest`): reasonable for npm users but
  not for a standalone binary install; it also cannot verify a checksum itself.
- **In-place write without staging**: fails on Windows and has no rollback.
- **Self-update by spawning a helper**: safer in theory, but it needs a second
  binary we do not ship yet; revisit if the swap proves fragile in practice.