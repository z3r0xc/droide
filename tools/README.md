# tools/

Scripts that belong to the **implementation** (formatting, code generation,
local verification helpers). Anything that analyses the subject binary lives in
the untracked `.work/` workspace instead, so no reverse-engineering artefact is
committed.

## Layout

```
tools/            our own developer tooling (tracked)
.work/            untracked analysis workspace, never committed
├── tools/        extractors and analysers for the subject payload
└── parity/       recorded parity cases and goldens
```

## Rules

- A tool here must be deterministic and dependency-light: `node`, `npm` or
  `python` from the repository's own scripts, nothing global.
- If a tool writes files, it writes them under `.work/` or a temp directory.
- Machine-local paths are never hard-coded; read them from the environment.
