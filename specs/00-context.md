# Shared context for spec authors

Must be read before writing any spec. It is the same for every slice; do not
duplicate it inside spec files.

## Repo

The checkout this tree was read in (GitHub `z3r0xc/droide`), on branch
`feat/production-wave-5`.
**Never run git commands** — the orchestrator commits.

## The reference build

The behaviour these specs pin was first written down from **one reference
build**: a terminal coding agent shipped as a single-file Bun executable. Below,
_the reference build_ means that artefact and _the CLI_ means the program it
ships, whichever platform slice a clause was observed on.

Its original TypeScript was recovered from source maps embedded in the binary and
lives **untracked and proprietary** at:

    evidence/original/windows-x64/                src/… (app) + packages/<name>/src/…
    evidence/original-vendor/windows-x64/         the same, including node_modules sources

Two layouts: `packages/<pkg>/src/…` and meta-packages `packages/<pkg>/<feature>/src/…`.
Re-export barrels and type-only modules were elided by the bundler and are
**absent** — when a claim depends on one, say so and mark it `[inferred]`.

Citations keep the evidence tree's own layout and line ranges. Two elisions are
applied so a spec never prints a vendor or product name:

| In the evidence tree                                          | In a spec                                   |
| ------------------------------------------------------------- | ------------------------------------------- |
| `packages/<vendor>-core/…`                                    | `packages/core/…`                           |
| `packages/<vendor>-sdk-core/…`, `packages/<vendor>-sdk-ext/…` | `packages/sdk-core/…`, `packages/sdk-ext/…` |
| `@<vendor>/<pkg>` package scope                               | the bare package name                       |
| a file or symbol whose name begins with the vendor's          | the same name with that prefix elided       |

Everything else — directory shape, file name, `:line` or `:line-range` — is
reproduced verbatim, so a claim can still be walked back to the byte range it
rests on.

## Ready-made artefacts

| artefact                                        | what it gives                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs/architecture/README.md`                   | layer map, package roles, hubs, entry points                                              |
| `evidence/arch/graph.json`                      | per-file internal imports, external deps, package edges                                   |
| `evidence/cli/help.txt`                         | captured `--help`                                                                         |
| `tests/parity/cases/`, `tests/parity/expected/` | recorded CLI cases (help texts, exit codes, error strings)                                |
| `evidence/extracted/windows-x64/`               | the raw bundle: 783 JS chunks plus assets (`SKILL*.md`, `*.sql` migrations, native blobs) |
| `specs/template.md`, `specs/README.md`          | the required spec structure                                                               |

## Rules (strict)

1. **Every behavioural claim cites a source location**: `evidence/original/windows-x64/<path>:<line>`
   or `:<line>-<line>`. No citation → the claim belongs in Open questions.
2. **Label claims** `[observed]` (read directly), `[derived]` (computed from
   several observations), `[inferred]` (judgement). Never dress an inference as
   an observation.
3. **No code dumps.** Quote at most 5 lines, only where the exact text is the
   contract: flag names, file paths, JSON keys, error strings, SQL DDL.
4. **Acceptance tests are deterministic**: no network, no credentials, no wall
   clock, no dependence on the reference binary. Name each test, give input and
   expected output.
5. **Running the reference build is allowed only** as
   `raw/reference/windows-x64/cli.exe --help` or `<subcommand> --help`, with
   `HOME`/`USERPROFILE` pointed at a temp dir. Nothing else — no prompts, no
   interactive session, no network-touching commands.
6. Read efficiently: `rg`/`grep -n` first, then read the small files whole.
   Never read the 28 MB bundles in `evidence/extracted/`.
7. **Touch only your assigned spec file.** One owner per file.

## Voice

A spec states **our** contract: what the CLI does, in the present tense, and
what a conforming build must reproduce. Provenance is a citation, never a
narrative: a clause does not explain where the behaviour was copied from, and it
does not name the vendor, the product or a release number. The program is
`droide` in commands and code spans, `Droide` in prose; `${PROGRAM}`,
`${DISPLAY}`, `${VERSION}` and `${DOCS_URL}` may stand for the constants in
`src/cli/brand.ts`. The policy behind this is `docs/adr/0003`.

## Required spec shape

Follow `specs/template.md`: Purpose / Scope / Terms / Observable behaviour /
Data & config / Errors / Acceptance tests / Evidence / Open questions, then a
final `## Clean-room notes` section: what a conforming build must reproduce
(the contract) and which details are explicitly not part of it.

## Reporting

Reply with: spec path, a 10-line summary, the 5 most important contract points,
and every open question. Terse.

## Licence and provenance

`docs/adr/0003` is the binding policy: evidence is untracked, the contract is
tracked, and the implementation is written against the contract. A clause may
describe behaviour; it never transcribes source.
