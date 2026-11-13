# src/app — startup wiring

The only place that knows the order in which the process becomes usable.

```
argv ──▶ cli/router.ts ──▶ commander program
                              │  (parses flags, prints help/version, exits)
                              ▼
                        app/context.ts        environment + settings + paths
                              │
                              ▼
                        command action        (exec, daemon, doctor, tui …)
```

## Rules

- **Parsing never resolves configuration.** `--version`, `--help` and argument
  errors must work with a broken settings file, so the context is built after
  the router has decided to run a command.
- **One context per process.** It carries the merged settings, the layers that
  produced them (for `doctor`), the overlays that were rejected, and every
  derived path. Nothing below re-reads `process.env`.
- **`--cwd` moves the project layer, not the user layer.** The home directory
  stays the real one; only the project settings file and project paths follow
  the flag.
- **Failures are typed.** A malformed settings file aborts the run with
  `InvalidSettingsError` (naming the file); an unreadable `--settings` overlay is
  dropped and recorded in `droppedOverlays`, because the contract tolerates it.

## Adding a subsystem

A new area (daemon client, UI, transport) receives the `AppContext` rather than
constructing its own environment. That keeps one source of truth for paths and
one seam to fake in tests (`tests/integration/app/context.test.ts`).