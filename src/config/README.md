# Configuration and paths

Contract: `specs/10-cli-surface.md` B77-B79 and "Settings files";
`specs/40-sessions-and-storage.md` Terms and "On-disk layout".

## Precedence

Highest priority first. A lower layer fills only keys the layers above it left
absent; lists and scalars are replaced whole.

1. **org policy** — remote; injected as `orgSettings`.
2. **runtime overlay** — `--settings <path>`, else
   `FACTORY_RUNTIME_SETTINGS_PATH`. An unreadable path is _dropped_ and
   recorded (B79), never fatal; invalid content throws.
3. **project** — `<cwd>/.factory/settings.json`.
4. **user** — `<base>/settings.json`.

The overlay path is trimmed, `~` expanded and resolved at the launch directory
(B65/B68). A blank `--settings` falls through to the environment variable.

## Files

`<base>` is `<home>/.factory` in production, `<home>/.factory-dev` otherwise
(`FACTORY_ENV`), with `<home>` from `FACTORY_HOME_OVERRIDE` else the OS home.

| Path                                  | Purpose                                         |
| ------------------------------------- | ----------------------------------------------- |
| `<base>/settings.json`                | user settings                                   |
| `<cwd>/.factory/settings.json`        | project settings                                |
| `<base>/sessions/`                    | transcripts, `<project key>/<session id>.jsonl` |
| `<base>/cache/session-index/index.db` | session index                                   |
| `<base>/worktrees/`                   | default `general.worktreeDirectory` root        |
| `<base>/temp/`, `<base>/logs/`        | scratch and logs                                |

## Boundaries

`paths.ts` is the only module that reads `process.*` / `os.homedir()`; every
other module takes an injected `Environment` (`env`, `home`, `platform`,
`cwd`), so tests never touch the real home. `schema.ts` validates without
coercion: a wrong type is `InvalidSettingsError` naming the dotted key path, an
unknown key is `UnknownSettingError`. A `settings.local.json` beside either
level's file is a separate local source and is not part of this chain.