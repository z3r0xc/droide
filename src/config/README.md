# Configuration and paths

Contract: `specs/10-cli-surface.md` B77-B79 and "Settings files";
`specs/40-sessions-and-storage.md` Terms and "On-disk layout".

## Precedence

Highest priority first; org policy sits above the runtime overlay
(`specs/10-cli-surface.md` B78). A lower layer fills only keys the layers above
it left absent; lists and scalars are replaced whole.

1. **org policy** — remote; injected as `orgSettings`.
2. **runtime overlay** — `--settings <path>`, else
   `FACTORY_RUNTIME_SETTINGS_PATH`; trimmed, `~` expanded, anchored at the
   launch dir (B65/B68), blank flag falls through. Unreadable paths are
   _dropped_ and recorded (B79); invalid content throws.
3. **project** — `<cwd>/.factory/settings.json`.
4. **user** — `<base>/settings.json`.

## Files

`<base>` is `<home>/.factory` in production, `<home>/.factory-dev` otherwise
(`FACTORY_ENV`), with `<home>` from `FACTORY_HOME_OVERRIDE` else the OS home.

| Path                                  | Purpose                                         |
| ------------------------------------- | ----------------------------------------------- |
| `<base>/settings.json`                | user settings                                   |
| `<cwd>/.factory/settings.json`        | project settings                                |
| `<base>/sessions/`                    | transcripts, `<project key>/<session id>.jsonl` |
| `<base>/cache/session-index/index.db` | session index                                   |
| `<base>/worktrees/`                   | default `worktreeDirectory` root                |
| `<base>/temp/`, `<base>/logs/`        | scratch and logs                                |

## Boundaries

`paths.ts` is the only module that reads `process.*` / `os.homedir()`; every
other module takes an injected `Environment` (`env`, `home`, `platform`,
`cwd`), so tests never touch a real home. `schema.ts` rejects a wrong type with
`InvalidSettingsError` naming the dotted key path; unknown keys are ignored
there because the subject's zod objects strip them.
