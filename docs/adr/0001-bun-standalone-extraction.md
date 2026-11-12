# 0001 — Recover the embedded JavaScript bundle before decompiling native code

- **Status:** accepted
- **Date:** 2026-11-12
- **Deciders:** project maintainers
- **Related:** `docs/vendored-artifacts.md`, `docs/README.md`

## Context

The six vendored `droid` 1.9.0 binaries are Bun single-file executables. Two
byte-level observations support that, made without executing anything: the
string `.bun` occurs in the section-name area of the Linux, Windows, and macOS
samples, and each contains the string `Bun v1.4.4`. Exact section offsets and
the encoding of the payload are not yet established; identifying the binaries
as Bun-built is the only claim being relied on here.

A Bun single-file executable is a normal platform binary (ELF, PE, or Mach-O)
with the application's module graph appended in a `.bun` section. Depending on
how the executable was built, that payload holds a mix of compiled JavaScript
bytecode for the entrypoint and source text for other modules. Recovering it is
therefore the shortest path from binary to something a human can read and
specify.

The project needs a source of truth for behaviour that is (a) static — the
binaries must never be executed — (b) high fidelity, so spec clauses can quote
real control flow rather than guesses from strings, and (c) reproducible, so a
reviewer can regenerate it from `raw/` and check the same bytes.

The question: which extraction route do we invest in first?

## Decision

We recover the JavaScript payload from the `.bun` section of the vendored
binaries first, and treat the recovered payload as the primary evidence for
phase 2 behavioural enumeration.

Concretely:

1. A deterministic extractor is built under `tools/` that reads a binary, parses
   its container format (ELF/PE/Mach-O) to locate the `.bun` section, validates
   the payload's own structure, and writes the recovered modules plus a manifest
   of offsets and SHA-256 digests. It touches no network and executes no part of
   the target.
2. Raw output goes to `evidence/extracted/`, which is untracked. Every spec
   clause that relies on it cites the manifest entry (or a ledger id derived
   from it), never a bare file path.
3. Native code analysis is used only where the JavaScript payload delegates to
   native code or where a behaviour is fixed by the runtime rather than the
   application — not as the first pass.

The extractor is tested against synthesised fixtures that model the container
layout; no proprietary binary is committed as a test fixture.

## Consequences

Good:

- The bulk of `droid`'s behaviour — prompts, tool contracts, config parsing,
  session state, error text — lives in JavaScript. Recovering it yields
  semantics directly, at a cost that does not scale with binary size.
- Six platform builds can be compared. Where they disagree, the platform
  difference is itself a spec fact; where they agree, the shared payload is
  corroborated six times.
- Extraction is a pure function of a hashed input, so any spec claim can be
  replayed.

Costs and risks:

- The payload may be partially or wholly compiled to JavaScriptCore bytecode,
  which is not source. If the executable was built that way, the JS-first route
  loses its main advantage and this ADR must be revisited. Determining which
  form each module is in is the first task of phase 1.
- Recovered code is minified and bundled: module names, comments, and type
  information are gone. Module boundaries have to be reconstructed from the
  bundle's module table, and symbol names from string and property usage.
- Reading recovered proprietary code creates a provenance hazard for a
  clean-room implementation. Policy: extracted code stays in
  `evidence/extracted/`, is cited by id, and is never copied into the
  reimplementation. The implementation is written against spec clauses; a spec
  clause may describe behaviour, not transcribe code.
- The JavaScript payload does not cover embedded native assets (search binaries,
  terminal helpers, database engines). Those need their own analysis, deferred
  until a spec clause depends on them.
- The extractor is container-format-specific. Three formats and six binaries
  mean three parsers and a cross-build comparison step, all of which must be
  tested.

Follow-up work: implement and test the extractor; report the payload form per
module; then open the first subsystem specs.

## Alternatives

**Decompile the native binary first (Rizin/Ghidra).** Rejected as the primary
route. A 250–350 MB binary embeds a full JavaScript engine; most recovered
native functions would be runtime internals rather than `droid` logic, and the
application-level semantics would have to be reconstructed from calling
conventions and string references. It is orders of magnitude more work per
established fact, and it is not deterministic across engine versions. Kept as a
targeted tool for native shims.

**Runtime tracing or instrumentation.** Rejected. It requires executing the
vendor binary, which this project forbids, and it observes only the paths that
are exercised, so coverage is neither complete nor reproducible. It also cannot
see configuration schemas or error branches that a run does not hit.

**Recover source from a published package or source map.** Not adopted as a
plan, because no such publication is established for this CLI. If one is found
and its version can be tied to these checksums, it would be admissible as
corroboration, not as a replacement for what the shipped binary contains.

**Black-box CLI probing only.** Rejected as a primary route for the same
execution constraint, and because observable output cannot distinguish internal
contracts — defaults, precedence rules, migration behaviour — that a spec has to
pin down.
