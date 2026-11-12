# Shared context for spec authors

Must be read before writing any spec. It is the same for every slice; do not
duplicate it inside spec files.

## Repo

`C:/Users/handona/Documents/AI/Harnesses/droid-re` (GitHub `z3r0xc/droide`), branch `feat/production-wave-1`.
**Never run git commands** — the orchestrator commits.

## Subject

Factory AI `droid` CLI v1.9.0, shipped as a Bun single-file executable. Its
original TypeScript was recovered from source maps embedded in the binary and
lives **untracked and proprietary** at:

    evidence/original/windows-x64/                src/… (app) + packages/<name>/src/…
    evidence/original-vendor/windows-x64/         the same, including node_modules sources

Packages: `@factory/{common,runtime,utils,droid-core,daemon-core,daemon-sdk,droid-sdk-core,droid-sdk-ext,logging,updater,environment,crypto,i18n,droid-sdk}`.
Two layouts: `packages/<pkg>/src/…` and meta-packages `packages/runtime/<feature>/src/…`
(so `@factory/runtime/auth` → `packages/runtime/auth/src`). Re-export barrels and
type-only modules were elided by the bundler and are **absent** — when a claim
depends on one, say so and mark it `[inferred]`.

## Ready-made artefacts

| artefact | what it gives |
|---|---|
| `docs/architecture/README.md` | layer map, package roles, hubs, entry points |
| `evidence/arch/graph.json` | per-file internal imports, external deps, package edges |
| `evidence/cli/help.txt` | captured `droid --help` |
| `tests/parity/cases/`, `tests/parity/expected/` | recorded CLI goldens (help texts, exit codes, error strings) |
| `evidence/extracted/windows-x64/` | the raw bundle: 783 JS chunks plus assets (`SKILL*.md`, `*.sql` migrations, native blobs) |
| `specs/template.md`, `specs/README.md` | the required spec structure |

## Rules (strict)

1. **Every behavioural claim cites a source location**: `evidence/original/windows-x64/<path>:<line>`
   or `:<line>-<line>`. No citation → the claim belongs in Open questions.
2. **Label claims** `[observed]` (read directly), `[derived]` (computed from
   several observations), `[inferred]` (judgement). Never dress an inference as
   an observation.
3. **No code dumps.** Quote at most 5 lines, only where the exact text is the
   contract: flag names, file paths, JSON keys, error strings, SQL DDL.
4. **Acceptance tests are deterministic**: no network, no credentials, no wall
   clock, no dependence on the original binary. Name each test, give input and
   expected output.
5. **Running the original is allowed only** as
   `raw/factory/windows-x64/droid.exe --help` or `<subcommand> --help`, with
   `HOME`/`USERPROFILE` pointed at a temp dir. Nothing else — no prompts, no
   interactive session, no network-touching commands.
6. Read efficiently: `rg`/`grep -n` first, then read the small files whole.
   Never read the 28 MB bundles in `evidence/extracted/`.
7. **Touch only your assigned spec file.** One owner per file.

## Required spec shape

Follow `specs/template.md`: Purpose / Scope / Terms / Observable behaviour /
Data & config / Errors / Acceptance tests / Evidence / Open questions, then a
final `## Clean-room notes` section: what a reimplementation must reproduce
(the contract) and which details are explicitly not part of it.

## Reporting

Reply with: spec path, a 10-line summary, the 5 most important contract points,
and every open question. Terse.