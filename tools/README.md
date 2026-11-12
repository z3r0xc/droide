# Tools

Deterministic analysers that turn artefacts from `raw/` into evidence. A tool
here answers a question about bytes; it does not interpret them into
conclusions — that is the spec's job.

## Rules

1. **Deterministic and replayable.** Same input bytes and same tool version
   produce the same output bytes. Sort every collection by a stable key before
   writing. No timestamps in output, no absolute host paths, no parallelism whose
   completion order leaks into results.
2. **Read-only on inputs.** Never modify `raw/`. Never execute any part of a
   target artefact — no `exec`, no `dlopen`, no emulation of its entry point.
   Parsing bytes is the whole allowed surface.
3. **No network.** No downloads, no lookups, no telemetry. A tool that needs an
   outside resource is not admissible here.
4. **Every tool has a test suite.** Tests use synthesised fixtures that exercise
   the parser's edge cases (truncation, bad magic, size fields that overflow,
   empty sections). A proprietary binary is never a fixture. Tests run offline
   and assert exact output bytes.
5. **Output is content-addressed.** Each run writes a manifest containing the
   input path, its SHA-256, the tool name and version, the arguments, and the
   digest of every output file. Output lands under `evidence/extracted/` and is
   untracked; the manifest is what gets cited.
6. **Fail loudly.** A malformed input produces a non-zero exit and a diagnostic
   naming the offset and the violated expectation. No partial output is left
   where a full run would write; never guess a missing field.
7. **Bump the version on output change.** Consumers cite tool version with the
   manifest, so a change in output is a version change.

## Conventions

- One directory per tool, with its own tests beside it.
- Tools take an explicit input path and an explicit output directory; they never
  discover inputs implicitly.
- Language follows whatever the reimplementation uses, so tooling stays in one
  ecosystem.

## Registry

| Tool | Question it answers | Version | Tests |
|---|---|---|---|
| _none yet_ | | | |

The first entry is the Bun single-file extractor decided in
`docs/adr/0001-bun-standalone-extraction.md`.
