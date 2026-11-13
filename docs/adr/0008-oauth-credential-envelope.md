# ADR 0008 — MCP OAuth credentials are sealed by the OS, not by a hand-rolled file pair

- Status: accepted
- Date: 2026-11-12
- Deciders: orchestrator (architecture), pending implementation in a later slice

## Context

`specs/60-extensions-mcp-and-skills.md` §B29 requires per-server OAuth credentials
with the issuing issuer, the registered client-metadata subset, tokens, a
`revision` and `updatedAt`, and **tombstones** so a stale write cannot resurrect
a cleared credential. The reference build stores them as an encrypted file pair
(`mcp-oauth.v2.file` + `mcp-oauth.v2.key`).

Two facts constrain the choice here:

1. We have a native layer with an audited DPAPI path (`crates/droide-native`),
   already proven by `npm run test:native`.
2. Writing our own key file next to the ciphertext is exactly the design that
   fails review: the key sits beside the lock, and a copied directory is
   readable. The reference build accepts that trade-off because its key file is
   additionally protected by the OS; copying only the pair still leaks.

## Decision

1. **Schema is the contract; the envelope is ours.** The credential document
   keeps every field and semantic the spec pins — issuer, client metadata,
   tokens, `revision`, `updatedAt`, and tombstones
   `{serverName, serverUrl, revision, deletedAt}` — so behaviour (staleness,
   clearing, per-server identity) is identical.
2. **Sealing goes through the native helper.** The serialised document is sealed
   with `secrets.protect` (DPAPI on Windows; a platform store on macOS/Linux when
   that lands) and written to `<state dir>/mcp-oauth.v2.sealed` plus a small
   plaintext header `{schemaVersion, updatedAt, revision}` used for fast staleness
   checks. No plaintext token ever touches disk.
3. **No fallback.** Where the helper cannot seal (no DPAPI, missing binary), the
   flow refuses with a typed error naming the platform. Writing tokens in
   plaintext "temporarily" is not an option.
4. **One writer.** A single process-level mutex plus a compare-and-set on
   `revision` serialises writes; a tombstone with a higher revision always wins,
   which is what makes a stale refresh harmless.
5. **Revocation is a tombstone, not a delete.** Deleting the sealed blob without
   a tombstone would let an in-flight refresh re-create the file.

## Consequences

- The credential file is bound to the OS user account: copying the directory to
  another machine or account yields an unreadable blob, which is the intended
  behaviour and differs from the reference build's portable-key design.
- Tests never seal real secrets: they use the fake helper for the envelope and a
  DPAPI round-trip only where the platform supports it (`npm run test:native`).
- A future export/import feature must re-seal, never copy the blob.

## Alternatives considered

- **Copy the reference build's file pair**: hashes and keys are not behaviour,
  and the design is weaker; rejected.
- **Store tokens in the settings file**: the settings file is plaintext and
  user-editable; rejected outright.
- **No persistence (re-authenticate every run)**: hostile to users on every
  server call; rejected.
