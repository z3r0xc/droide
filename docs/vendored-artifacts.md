# Vendored artefacts

Everything under `raw/` is upstream material kept for analysis. It is **not
tracked by git** (`.gitignore` excludes `raw/` wholesale) and must not be
modified: it is the reference copy against which extracted evidence is checked.
This file is the provenance record that takes its place in history.

## 1. Factory CLI `droid` binaries — `raw/factory/`

Six single-file executables of Factory AI's `droid` CLI, version **1.9.0**, one
per platform, staged here as the reference copy. The vendor installers preserved
beside them in `raw/factory/installers/` define how release 1.9.0 is published:
they pin the version and the download layout that the checksums below correspond
to. How these particular copies were fetched is not recorded; the digests are
the identity that matters.

| Path | Bytes | SHA-256 |
|---|---:|---|
| `raw/factory/windows-x64/droid.exe` | 345861856 | `f29e590a0c69bd0bbf332d3824b84701dd8f63ee99311db73fe3c147974a3ee3` |
| `raw/factory/windows-arm64/droid.exe` | 251554016 | `9114dc6fe390b91830dc50875a681326d23e2f11d9c3ac32edbb693462b02011` |
| `raw/factory/linux-x64/droid` | 343759024 | `4669a1012a9b9f0b5f5ae92bf98715808fa445d5c9e531ec6a50e30413fb323c` |
| `raw/factory/linux-arm64/droid` | 335662072 | `a5e5c1f0465d4ee73fbac38e444716f5dcafe68afb862a846a978a93f8c0ae97` |
| `raw/factory/darwin-x64/droid` | 329831600 | `533eeaec54246c377fdfba2b35ccbe1e3216dc853b6e242dbb64a40adc8867af` |
| `raw/factory/darwin-arm64/droid` | 313907504 | `b62ce8de0ed7ffaada1abb2a017fe182021003694e85fe7f3b1136ad43628a5d` |

Each binary has a sibling `*.sha256` file containing the published digest, copied
verbatim. The values above match those files.

### Where they came from

The vendor installers in this directory define the download endpoints. Per
`installers/install-unix.sh` and `installers/install-windows.ps1`, release
`1.9.0` is served from:

```
https://downloads.factory.ai/factory-cli/releases/1.9.0/<platform>/<arch>/droid[.exe]
https://downloads.factory.ai/factory-cli/releases/1.9.0/<platform>/<arch>/droid[.exe].sha256
```

with `<platform>` in `windows | linux | darwin` and `<arch>` in
`x64 | x64-baseline | arm64`. Both installers fall back from `x64` to
`x64-baseline` when the host CPU lacks AVX2.

The vendored set covers the six `<platform>-<arch>` combinations with no
`-baseline` suffix. Those baseline variants are **not** present in `raw/`; if a
spec clause turns out to depend on instruction-set-specific behaviour, the
baseline build would have to be obtained separately.

### Integrity check

`raw/factory/verify.sh` re-hashes every binary against its sidecar and prints
`OK <sha256> <bytes>` per file. It requires `sha256sum` and must be run from
`raw/factory/`. It is the check to run after any copy or move of `raw/`.

### Format notes

Preliminary, from reading bytes only (the binaries have never been executed in
this project):

- All three inspected samples (`linux-x64/droid`, `windows-x64/droid.exe`,
  `darwin-arm64/droid`) contain the string `.bun` and the string
  `Bun v1.4.4`. They are therefore treated as Bun single-file executables for
  the extraction work described in `docs/adr/0001-bun-standalone-extraction.md`.
- Nothing beyond that has been established yet: section offsets, bundle
  encoding, bytecode-vs-source form, and the presence of source maps are all
  open questions for phase 1.

## 2. Reference source trees — `raw/codex/`, `raw/oh-my-pi/`, `raw/opencode/`

Full upstream checkouts of three other terminal coding agents, kept as
comparative references for behaviour that `droid` shares with the category
(session handling, tool execution, configuration). They contain no `droid`
code and are not a source of truth for `droid`'s contract; a spec clause may
only cite them for a convention that is independently corroborated.

| Path | Origin | Commit | Branch | Size (approx.) |
|---|---|---|---|---|
| `raw/codex/` | `https://github.com/openai/codex.git` | `d0edb0b1fa55e74486c5dd8a0a4fbcf75410ec79` (2026-11-12) | `main` | 848 MB |
| `raw/oh-my-pi/` | `https://github.com/can1357/oh-my-pi.git` | `aece16f78fad7e9e777b4aeaa1ca583544a17723` (2026-11-12) | `main` | 1006 MB |
| `raw/opencode/` | `https://github.com/anomalyco/opencode.git` | `ec263d62b6e3bfd7df6e5a256d1148b0b277bc1e` (2026-11-12) | `dev` | 895 MB |

Each directory retains its own `.git`, so the commit above is reproducible with
`git -C raw/<name> log -1`. Package identities as found in each root
`package.json`: `codex-monorepo`, `omp`, and `opencode` (version `2.2.7`).

## Why untracked

The four directories total roughly 4.5 GB, dominated by six 250–350 MB binaries
plus three full source histories. Committing them would make every clone
enormous and would place third-party code and proprietary binaries into this
repository's history. They are inputs, not deliverables: the deliverables are
the specs, the analysers that regenerate extracted evidence, and the
reimplementation. Checksums and commit ids here are sufficient to re-obtain and
verify them.

Anything derived from these artefacts that needs to be durable — a string
table, a recovered bundle, a decompiled function — is stored under
`evidence/extracted/` (also untracked, because it is regenerable) and cited by
id in the spec that relies on it.
