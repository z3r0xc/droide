# src/extensions — MCP, plugins, skills

Reads and resolves the extension configuration a session sees. Contract:
`specs/60-extensions-mcp-and-skills.md`. Nothing here connects to a server,
runs a plugin or spawns a process: paths, file readers and clocks are injected,
and every name is derived deterministically.

| Mechanism | Config and assets                                                                                | Merge direction                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP       | `<factoryDir>/mcp.json`, `<projectRoot>/.factory/mcp.json` (`mcpServers.<name>`)                 | Levels lowest-first; the first in `MCP_SETTINGS_LEVELS_HIGHEST_FIRST` wins. Whole entry per raw name (no field merge), then re-keyed by canonical name; the higher alias wins.    |
| Plugins   | `.factory-plugin/plugin.json`, falling back to `.claude-plugin/plugin.json`                      | Manifest is optional JSONC; only `hooks` is read. Enablement (`general.enabledPlugins`) belongs to settings resolution.                                                           |
| Skills    | `<settingsFolder>/skills/<name>/SKILL.md`, `.agent/skills`, `.agents/skills`, `<mission>/skills` | Eleven buckets highest-first; the first bucket to claim a sanitized name wins; within a bucket the first input wins. The `disabledSkills` ledger is a union: it can only disable. |

## Modules

- `mcp/naming.ts` — server-name canonicalization, `mcp_<server>_<tool>` ids,
  llmId sanitization/truncation, deterministic collision suffixes and the
  unambiguous `mcp__<server>__<tool>` alias.
- `mcp/config.ts` — the two config files, JSONC tolerance, transport schema,
  merge with provenance, and the org allowlist policy.
- `skills/discovery.ts` — strict YAML-subset frontmatter, bucket discovery,
  collision/shadow resolution, the disable ledger, the listing budget and the
  activation payload.
- `plugins/manifest.ts` — plugin-id parsing, manifest lookup and `hooks`
  validation.
- `jsonc.ts`, `guards.ts` — shared JSONC scanner and the untrusted-object guard.

## Rules

- Untrusted documents are parsed once at the boundary, never cast; failures are
  typed (`McpNamingError`, `PluginError`, `JsoncParseError`) with spec-pinned
  identities.
- Merge and naming functions are pure; filesystem access is injectable so tests
  synthesise fixtures in a temporary directory.
- Where the spec does not pin a behavior, the code says `TODO(spec): <clause>`
  instead of guessing.
