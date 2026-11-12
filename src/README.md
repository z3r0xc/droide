# src/ — TypeScript product layer

Everything the user sees or the CLI directly drives. Node 24, ESM, typed and
strict; no build step (type stripping), no runtime dependency beyond
`commander`.

## Module map

| Path | Responsibility | Spec |
|---|---|---|
| `main.ts` | Process entry: hands `argv` to the router, nothing else | `10-cli-surface.md` |
| `app/` | Startup wiring: build the context once (environment, settings, paths) | `10`, `40` |
| `cli/router.ts` | Parses and dispatches; converts Commander exits into exit codes | `10-cli-surface.md` |
| `cli/brand.ts` | Product name, version, docs link — the only place they appear | ADR 0005 |
| `cli/help.ts` | Static help blocks (aligned examples, footers) | `10-cli-surface.md` |
| `cli/tty.ts` | Non-interactive refusal text | `10-cli-surface.md` |
| `cli/commands/*` | One module per command group; options mirror the subject | `10-cli-surface.md` |
| `cli/exec-help.ts` | The curated `exec --help` page | `80-exec-and-streaming.md` |
| `cli/models.ts` | Model catalogue shown in help and selection | `20-agent-loop.md` |
| `config/` | Settings schema, resolution chain, paths | `10`, `40` |
| `session/` | SQLite schema, migrations, transcript store, search | `40-sessions-and-storage.md` |
| `native/` | Client for the Rust helper (protocol, timeouts, errors) | `90-native-layer.md` |
| `transport/` | Backend HTTP client and auth | `50-transport-and-auth.md` |
| `agent/` | Turn loop, message model, context assembly | `20-agent-loop.md` |
| `tools/` | Tool registry and implementations | `30-tools-and-sandbox.md` |
| `exec/` | Non-interactive mode and stream writers | `80-exec-and-streaming.md` |
| `extensions/` | MCP, plugins, skills, ACP | `60-extensions-mcp-and-skills.md` |
| `daemon/` | Daemon client and remote control | `70-daemon-and-remote-control.md` |
| `ui/` | Terminal UI: theme tokens, layout, renderers, keys | `95-terminal-ui.md` |
| `contracts/` | Shared types and validators at layer boundaries | headers above |

Directories appear only when their spec reaches `review`; the table is the plan,
not an inventory of empty folders.

## Boundary rules

- `cli/` may import everything below it; nothing below may import `cli/`.
- `config/` is the only reader of `process.env`, `os.homedir()` and `process.cwd()`.
  Every other module takes an injected `Environment`.
- `native/` and `transport/` treat everything they receive as untrusted input:
  parse, validate, then use. No `as` on external data.
- Domain errors are typed classes (one `errors.ts` per area); `cli/` is the only
  layer that decides how an error is printed.
- No module writes to stdout except through the CLI presentation layer, so
  machine-readable output stays clean (`80-exec-and-streaming.md`).