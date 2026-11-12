# Extensions: MCP, Plugins & Marketplaces, Skills, ACP

- **Target:** Factory AI `droid` 1.9.0
- **Status:** draft
- **Owner:** extensions surface (MCP / plugins / skills / ACP)
- **Related:** `specs/00-context.md`, `docs/architecture/README.md`; the settings-resolution, tool-catalog, agent-loop and CLI specs own the neighbouring concerns named in Scope.

## Purpose

Droid is extended from outside its own code: users configure external tool servers (MCP), install
packaged bundles of prompt assets (plugins and the marketplaces that distribute them), and write
reusable instruction documents (skills) that the model or the user can activate. Separately, Droid can
be driven by an editor through the Agent Client Protocol (ACP) instead of a terminal UI. This spec pins
what a user or a collaborating program can observe on all four surfaces: which files are read, in what
order, how names collide, what reaches the model, and what the wire looks like.

## Scope

Covers: `src/mcp/**`, `src/services/mcp/**`, `src/commands/mcp/**`, `src/entrypoints/mcp/**`,
`packages/runtime/auth/src/mcp-oauth/**`, `packages/common/src/mcp-oauth/**`,
`packages/utils/src/mcp/**`; `packages/runtime/plugins/**`, `packages/runtime/settings/src/Plugin*`,
`src/entrypoints/plugin/**`; `src/skills/**`, skill loading in `packages/runtime/frontmatter/**` and
`packages/runtime/settings/**`, `src/tools/executors/SkillExecutor.ts`; `src/acp/**`,
`src/exec/acpDaemonRunner.ts`.

Does **not** cover: the general settings precedence rules for non-extension keys (settings-resolution
spec), the sandbox/network policy engine (sandbox spec), the hook execution model beyond what a plugin
contributes (hooks spec), the tool-catalog filtering rules for `--only-tools/--add-tools` (tool-selection
spec), or the daemon JSON-RPC surface that ACP reuses internally (daemon spec). MCP **catalog
prewarming** by the daemon (`src/mcp/prewarmMcpCatalogs.ts`) is listed as an open question because its
preconditions are policy-gated.

## Terms

- **MCP server** — an external process or endpoint speaking the Model Context Protocol, declared in an
  `mcp.json` file under `mcpServers.<name>`.
- **transport type** — the `type` discriminator of a server config: `stdio` (default), `http`
  (streamable HTTP), `sse` (remote SSE).
- **normalized server name** — `normalizeServerName()` output: whitespace/slashes/most punctuation
  collapse to `-`, characters outside `[a-zA-Z0-9_-]` are dropped, repeats collapse, ends trimmed,
  maximum 32 characters, `invalid-server-name` when empty
  (`evidence/original/windows-x64/packages/utils/src/mcp/normalizeServerName/index.ts:15-54`).
- **llmId** — the provider-facing tool name; for an MCP tool `<server>___<tool>` where `___` is
  `MCP_TOOL_NAME_SEPARATOR` (`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/tools/constants.ts:110-111`).
- **Claude Code name** — the compatibility alias `mcp__<server>__<tool>`
  (`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/tools/constants.ts:113-115`).
- **plugin** — a directory with prompt components; **plugin id** is `plugin-name@marketplace`
  (`evidence/original/windows-x64/packages/runtime/plugins/src/pluginId.ts:1-37`).
- **marketplace** — a git/npm/local source carrying `.factory-plugin/marketplace.json`; its name is
  derived from the source (`evidence/original/windows-x64/packages/runtime/plugins/src/getMarketplaceNameFromSource.ts:48-99`).
- **plugin scope** — where a plugin is enabled/installed: `org`, `project`, `user`, precedence
  `org > project > user` (`evidence/original/windows-x64/packages/runtime/plugins/src/constants.ts:26-39`).
- **skill** — a frontmatter+markdown document (`SKILL.md` or an in-code builtin) with a name; a **skill
  bucket** is the source class it was discovered from; the **ledger** is the merged `disabledSkills`
  name set.
- **reminder** — CLI-authored text inside a system-reminder envelope that lists skill names and triggers.
- **ACP** — Agent Client Protocol; **turn** — one `session/prompt`; **session update** — a
  server→client `session/update` notification.

## Observable behaviour

### MCP configuration

**B1 — Server config file locations.** Droid reads exactly two MCP config files for a session:
`<factoryDir>/mcp.json` where the factory dir is `getFactoryHome()` joined with the deployment's factory
dir name (`~/.factory` by default), and `<projectRoot>/.factory/mcp.json`, where `projectRoot` is the git
root when there is one and the agent working directory otherwise
(`evidence/original/windows-x64/src/services/mcp/mcpConfigPresence.ts:73-81`).

**B2 — Config syntax and tolerance.** `mcp.json` is parsed as JSONC. A parse error, an unreadable file,
or a non-object document contributes no servers from that file; a missing file is not an error
(`evidence/original/windows-x64/packages/runtime/settings/src/FactorySettingsFolder.ts:1286-1310`).
The document shape is `{ mcpServers, persistentPermissions? }`
(`evidence/original/windows-x64/packages/common/src/settings/schema.ts:2359-2362`).

**B3 — Server shape per transport.** `type` is optional and defaults to `stdio`. `stdio` requires
`command`, and accepts `args` (default `[]`) and `env` (string map). `http` and `sse` require `url`,
and accept `headers` (string map) and `oauth`. All transports accept `disabled` (default `false`),
`enabledTools` and `disabledTools` (string arrays), `timeout` and `connectTimeout` (positive integers
≤ 2147483647, milliseconds) (`evidence/original/windows-x64/packages/common/src/settings/schema.ts:2254-2321`).

**B4 — Merge order and precedence.** Levels are merged lowest-first, so the **first** entry in this
highest-first list wins: org settings (remote), org plugins, `--settings` runtime overlay, automation
skills folder, ancestor folder settings, project settings, project `.agent/`, project plugins, user
settings, user `~/.agent/`, user plugins, dynamic config, builtin defaults
(`evidence/original/windows-x64/packages/runtime/settings/src/SettingsManager.ts:3923-4053`,
`evidence/original/windows-x64/packages/runtime/settings/src/SettingsResolver.ts:286-305`).
Per server name the override is **whole-entry**: the higher level replaces the lower entry, and no field
is merged (`evidence/original/windows-x64/packages/runtime/settings/src/mergeMcp.ts:7-28`).

**B5 — Name canonicalization and aliases.** After merging, the server map is re-keyed by normalized
name; when two raw keys normalize identically the later entry (higher precedence) wins, and the earlier
raw spelling is lost from the canonical view
(`evidence/original/windows-x64/packages/utils/src/mcp/normalizeServerName/index.ts:56-72`). `droid mcp add`
normalizes the name it writes, and an existing server under any alias of that name makes the add fail
(`evidence/original/windows-x64/src/commands/mcp/add.ts:57-99`, `:214-241`).

**B6 — `droid mcp add` writes to the user file.** A successful add writes the server at
`SettingsLevel.User` — that is, into `<factoryDir>/mcp.json` — after the org MCP policy check. `--type`
defaults to `stdio`; `--env` is rejected for remote types, `--header` for stdio; a bare URL without
`--type` is rejected; stdio `command`/`args` are parsed with shell quoting; `--no-oauth` disables OAuth
for header-authenticated remote servers (`evidence/original/windows-x64/src/entrypoints/mcp/command.ts:17-46`,
`evidence/original/windows-x64/src/commands/mcp/add.ts:25-52`, `:196-235`).

**B7 — Org MCP policy.** `general.mcpPolicy` is `{ enabled, allowlist? }` with `enabled` defaulting to
`false` (`evidence/original/windows-x64/packages/common/src/settings/schema.ts:546-549`). While
`mcpPolicy.enabled` is false every server is allowed. While it is true: an empty allowlist allows
nothing; `http`/`sse` entries match by hostname (exact, dotted-suffix, or `*` wildcard pattern, matched on
decoded hostnames); `stdio` entries match when the normalized allowlist token is a substring of the
normalized `command` or any `args` element. Disallowed servers are filtered out of the enabled set, and
`mcp add` refuses to write them
(`evidence/original/windows-x64/packages/runtime/settings/src/McpSettingsManager.ts:119-135`, `:193-270`).

**B8 — Credential references.** `headers` and `env` values may contain `${NAME}` and `${NAME:-default}`.
They are resolved at connect time, not load time; `${NAME}` with the variable unset throws
`MCP server credential references an unset environment variable "<NAME>"`, and `${NAME:-}` falls back
when the variable is unset **or empty**. A plugin server's path variables resolve before the ambient
environment (`evidence/original/windows-x64/src/mcp/resolveMcpSecretReferences.ts:8-80`).

**B9 — Sandboxed stdio environments.** When the sandbox is active, a stdio server's child environment is
filtered to an allowlist plus keys explicitly configured in `mcp.json`; proxy variables, Droid's sandbox
marker, and exported shell functions are always dropped. Unavailable parent sandbox settings make the
stdio launch fail closed (`evidence/original/windows-x64/src/mcp/sandbox.ts:77-150`).

### MCP connection, discovery and invocation

**B10 — Connect budgets.** Default connect timeout is 10 s, 30 s for stdio; a configured
`connectTimeout` replaces the budget for that server, and a caller deadline caps every attempt. The
2026-07-28 era probe runs as a grace before the budget on stdio with a 10 s cap and the whole connect
timeout on HTTP (`evidence/original/windows-x64/src/mcp/constants.ts:34`, `:48`, `:75-78`).

**B11 — Protocol era negotiation.** A connect may probe with `server/discover` and use revision
`2026-07-28` when offered, otherwise fall back to the 2025 `initialize` handshake (auto); may run
legacy only (SSE transports and when modern negotiation is off); may be pinned; or may be a modern
"rescue" after a 2025 handshake is refused with error code `-32022` naming `2026-07-28`
(`evidence/original/windows-x64/src/mcp/enums.ts:103-153`, `evidence/original/windows-x64/src/mcp/constants.ts:104-124`).

**B12 — Legacy verdict cache.** A legacy verdict is cached per server for 24 h at
`cache/mcp/protocol-eras/v1/<sha256 key>.json` holding `{version: 1, checkedAt}`; a record over 1 KiB,
a non-regular file, unparseable JSON or an unrecognized shape is ignored; a verdict dated in the future
is distrusted. Modern verdicts are never stored
(`evidence/original/windows-x64/src/mcp/protocolEra.ts:1-84`, `evidence/original/windows-x64/src/mcp/constants.ts:83-90`).

**B13 — Tool listing deadline.** A server's `tools/list` gets 15 s by default, override via
`FACTORY_MCP_LIST_TOOLS_TIMEOUT_MS`; the strict listing is retried leniently inside the same window so
the two attempts cannot stack. Distinct failures are negative-cached for 60 s, and manual recovery
(retry, reconnect, `tools/list_changed`, config change) clears the entry immediately
(`evidence/original/windows-x64/src/mcp/constants.ts:23-33`, `evidence/original/windows-x64/src/mcp/McpToolList.ts:29-62`).

**B14 — Listing tolerance.** A strict `tools/list` that fails schema validation is retried with per-tool
validation, and a single non-conforming tool does not discard the listing. On a 2025 server, a tool whose
`outputSchema.type` is not `object` is skipped and reported rather than registered
(`evidence/original/windows-x64/src/mcp/schema.ts:43-50`, `evidence/original/windows-x64/src/mcp/McpToolList.ts:99-121`).

**B15 — Tool filtering by config.** `enabledTools`, when present and non-empty, is a restrictive
allowlist; `disabledTools` always wins. Entries match either the bare tool name or the joined
`<server>___<tool>` name (`evidence/original/windows-x64/packages/utils/src/mcp/toolConfig.ts:5-20`,
applied at `evidence/original/windows-x64/src/mcp/McpHub.ts:1762-1776`).

**B16 — Registration identity.** A registered MCP tool has id `mcp_<server>_<tool>`, display name
`[MCP] <server>:<tool>`, `toolkit` `MCP:<server>`, `source: 'mcp'`, `requiresConfirmation: true`, and is
conservatively declared as an `ExternalService` side effect so it fails closed under a sandbox
(`evidence/original/windows-x64/src/services/mcp/McpService.ts:4429-4480`).

**B17 — Tool-name sanitization and collisions.** The llmId is the joined name sanitized for providers:
characters outside `[a-zA-Z0-9_-]` become `_`, and a name longer than 64 characters becomes
`<first 55>_<sha256(name)[0..8]>`. When two raw names on one server sanitize to the same string
(`plugin.tool` vs `plugin_tool`), the name that is already provider-safe keeps the clean llmId, and each
mutated sibling gets a deterministic hash suffix derived from its raw llmId; the result is stable across
sessions and tool-list orderings. A Claude Code name is emitted only when it can be read back
unambiguously (no `___`, server segment round-trips)
(`evidence/original/windows-x64/packages/droid-core/src/llms/client/tool-call-ids.ts:13-70`,
`evidence/original/windows-x64/packages/droid-core/src/llms/client/constants.ts:85`,
`evidence/original/windows-x64/src/mcp/utils.ts:115-117`, `:255-305`).

**B18 — Registration lifecycle.** Registering a server's tools replaces that server's previous set;
unregistering removes exactly the ids it registered. A **seeded** registration (from a persisted catalog
before the server connects) is replaced by the first live listing, and is dropped outright when the live
listing fails, whereas a live registration survives a failed refresh
(`evidence/original/windows-x64/src/services/mcp/McpService.ts:4198-4262`, `:4264-4310`).

**B19 — Persisted catalogs.** Tool catalogs are cached at `cache/mcp/catalogs`, format version 1,
one file per server, capped at 4 MiB; a file of any other version is ignored and replaced by the next
live list (`evidence/original/windows-x64/src/mcp/constants.ts:55-67`,
`evidence/original/windows-x64/src/mcp/schema.ts:13-35`).

**B20 — Call timeout.** A tool call is bounded by the server's configured `timeout`, else 180 s
(`MCP_CALL_TOOL_TIMEOUT_MS`, which is three times the SDK default). Time spent waiting for a user's
approval is not charged; time already spent on admission is subtracted
(`evidence/original/windows-x64/src/mcp/constants.ts:6`, `evidence/original/windows-x64/src/mcp/McpHub.ts:2258-2268`).

**B21 — Cancellation.** Every call takes an `AbortSignal`; aborting settles the call with the abort
reason rather than waiting for the server. A stdio call that failed because the transport closed is
classified as `not_sent` (the pre-send `Not connected` error, and nothing was ever sent on an attached
transport) or `in_flight` (anything else), and the distinction is reported
(`evidence/original/windows-x64/src/mcp/McpHub.ts:2230-2256`,
`evidence/original/windows-x64/src/mcp/utils.ts:200-230`,
`evidence/original/windows-x64/src/mcp/enums.ts:20-27`).

**B22 — Result marshalling.** A successful `CallToolResult` is converted to text/image blocks. Text is
re-indented as JSON for the model and passed through verbatim for a program destination. An empty
content array with `structuredContent` renders that JSON (any type); otherwise it renders
`[No content returned]`. An `isError` result renders `Error: <first text block>`, or
`Error: <structuredContent>` when no content blocks exist, or `Error: Unknown error occurred`. Oversized
images are compressed; an unsupported image MIME type is replaced by a textual placeholder
(`evidence/original/windows-x64/src/tools/executors/client/mcp/formatMcpResult.ts:12-125`,
`evidence/original/windows-x64/src/tools/executors/client/mcp/McpToolExecutor.ts:40-110`).

**B23 — Output-schema validation errors are rewritten.** When the SDK reports one of the three
structured-output validation markers, the result text becomes
`MCP tool <server>/<tool> returned structured output that does not match its output schema. Contact the MCP server owner to fix the schema or response.`
(`evidence/original/windows-x64/src/tools/executors/client/mcp/formatMcpResult.ts:23-47`).

**B24 — Persistent permissions.** `persistentPermissions` is `{ servers?: {name: entry},
tools?: {server: {tool: entry}} }` with `entry = { approvedAt, impactLevel, serverIdentity? }`. A
persisted approval applies only when the requested impact is ≤ the approved impact, the current server
transport fingerprint equals `serverIdentity` when both are set, and the requested impact is within the
org `maxAutonomyLevel` ceiling. The fingerprint covers only `type + command + args` (stdio) or
`type + url` (http/sse). Legacy flat `server___tool` keys are migrated to the nested shape on load
(`evidence/original/windows-x64/packages/common/src/settings/schema.ts:2325-2355`,
`evidence/original/windows-x64/src/services/mcp/McpPermissionService.ts:1-35`, `:196-260`).

**B25 — CLI surface.** `droid mcp` exposes `add`, `remove`, `list`, `auth`, and
`permissions {list, revoke <server> [tool], clear --confirm}`; `remove` without a name offers the
removable servers, and `clear` requires `--confirm`
(`tests/parity/expected/help-mcp.json`,
`evidence/original/windows-x64/src/entrypoints/mcp/command.ts:49-112`).

### MCP OAuth

**B26 — OAuth configuration.** A remote server may set `oauth: false` (never authenticate) or an options
object `{ resource?, authorizationServerIssuer?, clientMetadataUrl?, clientId?, clientSecret?,
callbackPort?, tokenEndpointAuthMethod? }`. `clientMetadataUrl` may not be combined with configured
client credentials and requires public token-endpoint auth; configured client credentials require
`authorizationServerIssuer`; every rejection is a validation issue on `mcp.json` load
(`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/settings/schema.ts:96-160`).

**B27 — Redirect and client identity.** The loopback callback server starts at port 54621 and tries up to
100 consecutive ports. The published client metadata is `https://api.factory.ai/mcp/oauth-client` with
the loopback redirect set, the hosted `/mcp/oauth/callback` set, and dynamic-registration redirect
coverage for all 100 loopback ports
(`evidence/original/windows-x64/packages/common/src/mcp-oauth/constants.ts:3-74`).

**B28 — Authorization window.** An interactive authorization is bounded at 4 minutes, deliberately below
the 5-minute authenticate RPC timeout so the failure is an actionable OAuth error rather than an opaque
timeout (`evidence/original/windows-x64/src/mcp/constants.ts:49-54`).

**B29 — Credential persistence.** Credentials are stored per server with the issuing issuer, the
registered client metadata subset, tokens, `revision`, and `updatedAt`; deletion writes a tombstone
`{serverName, serverUrl, revision, deletedAt}` so a stale auth/refresh write that observed an older
revision cannot resurrect a cleared credential. The store is the encrypted file pair
`mcp-oauth.v2.file` / `mcp-oauth.v2.key`
(`evidence/original/windows-x64/packages/runtime/auth/src/mcp-oauth/schema.ts:111-174`,
`evidence/original/windows-x64/packages/runtime/auth/src/mcp-oauth/constants.ts:75-77`).

**B30 — Authentication failures surface as auth, not errors.** A remote tool call whose message matches
the auth-failure patterns (`invalid access token`, `unauthorized`, `token expired`, …) triggers a
background "auth required" notification for that server instead of being retried as a generic failure
(`evidence/original/windows-x64/src/mcp/utils.ts:170-188`, `evidence/original/windows-x64/src/mcp/McpHub.ts:2300-2310`).

### Plugins and marketplaces

**B31 — On-disk layout.** Plugin state lives under `<scopeRoot>/plugins/`, where `<scopeRoot>` is the
factory dir (user) or `<project>/.factory` (project): `known_marketplaces.json` plus `known_marketplaces/`,
`installed_plugins.json` plus `installed_plugins/`, `marketplaces/` (checked-out marketplaces), `cache/`
(installed plugin copies) and `data/<plugin slot>` (persistent plugin data). Only
`known_marketplaces/` and `installed_plugins/` are hot-watched
(`evidence/original/windows-x64/packages/runtime/plugins/src/constants.ts:5-21`,
`evidence/original/windows-x64/packages/runtime/plugins/src/PluginRegistry.ts:57-58`, `:283-300`, `:791-815`).

**B32 — Marketplace manifest.** Every marketplace reader prefers `.factory-plugin/marketplace.json` and
falls back to `.claude-plugin/marketplace.json`. The document is
`{ name, description?, owner?{name,email?,url?}, plugins: [{ name, description?, source, category?,
homepage?, tags? }] }`; the name is stripped of non-printable characters. A manifest whose `name` or
`plugins` array is missing, or whose plugin entry has an unknown-typed but known-shaped `source`,
is rejected (`evidence/original/windows-x64/packages/common/src/settings/schema.ts:490-523`,
`evidence/original/windows-x64/packages/runtime/plugins/src/MarketplaceService.ts:639-680`).

**B33 — Plugin root and manifest.** A plugin root is a directory containing `.factory-plugin/` or
`.claude-plugin/`, or (for archives) one of the component markers `skills`, `commands`, `agents`,
`droids`, `hooks`, `output-styles`, `mcp.json`, `.mcp.json`. `.factory-plugin/plugin.json` is optional
JSONC; the only key Droid reads from it is `hooks`, which may be an inline event map, a list of event
maps, or a list of hook-file paths. A document declaring `$schema` starting with
`https://agent-plugins.org/schemas/` is recognized as an Agent Plugins document
(`evidence/original/windows-x64/packages/runtime/plugins/src/archivePluginInstaller.internals.ts:438-486`,
`evidence/original/windows-x64/packages/runtime/plugins/src/pluginHooks.ts:37-45`, `:192-240`,
`evidence/original/windows-x64/packages/runtime/plugins/src/PluginLoader.ts:86-90`).

**B34 — Source kinds.** A marketplace or plugin source is one of `github {repo, ref?, sha?}`,
`url {url, ref?, sha?}`, `local {path}`, `git-subdir {url, path, ref?, sha?}`,
`npm {package, version?, registry?, authTokenEnvVar?}`, `archive {url, sha256?, authTokenEnvVar?}`.
`git-subdir` without `path` is rejected. `archive` limits match Claude Code's published limits
(256 MiB download, 120 s, 5 redirects, 100 000 entries, 512 MiB per file, 1 GiB total, compression ratio
50) (`evidence/original/windows-x64/packages/common/src/settings/schema.ts:243-311`,
`evidence/original/windows-x64/packages/runtime/plugins/src/constants.ts:71-88`).

**B35 — Verification.** An `archive` source whose `sha256` is set must match the downloaded bytes or the
install fails with `checksum-mismatch`; a malformed `sha256` is refused before download. An npm source
records the resolved `spec`, `version`, `resolved` and `integrity` so auto-update can detect a new
publish and the installed identity ties to the npm version. An installed plugin's `marketplaceSourceHash`
and `externalSource` record the provenance the load path re-authorizes
(`evidence/original/windows-x64/packages/runtime/plugins/src/archivePluginInstaller.ts:82`, `:160-175`,
`evidence/original/windows-x64/packages/common/src/settings/schema.ts:184-189`, `:313-345`).

**B36 — Enablement settings.** Plugin enablement is `general.enabledPlugins` (`plugin-id → boolean`), with
`strictEnabledPlugins`, `extraKnownMarketplaces` (`name → {source}`), `strictKnownMarketplaces`
(source allowlist) and `pluginTokenHosts` (`host → env var name`) alongside it. `extraKnownMarketplaces`
declares marketplaces that may be auto-registered; `strictKnownMarketplaces` narrows what may be
configured at all; `pluginTokenHosts` is honored from user and org settings only
(`evidence/original/windows-x64/packages/common/src/settings/schema.ts:1457-1489`).

**B37 — Install flow.** `droid plugin install <plugin@marketplace> [-s user|project]` parses the id on
the first `@` at index ≥ 1, defaults the scope to `user`, looks the plugin up in the registered
marketplace, refuses a marketplace whose recorded source no longer matches its configured source
(`Marketplace "X" does not match its configured source`), refuses a source denied by org policy
(`Installing plugins from "X" is not allowed by organization policy`), and only then clones/copies into
the install cache and writes the enablement map
(`evidence/original/windows-x64/src/entrypoints/plugin/install.ts:11-49`,
`evidence/original/windows-x64/packages/runtime/settings/src/PluginMarketplaceManager.ts:1707-1795`).

**B38 — Uninstall flow.** Without `-s`, uninstall resolves the scope by looking for the plugin at user
scope first, then project; it fails with a "not installed" message when neither holds it. The
enablement entry is removed rather than set to `false`
(`evidence/original/windows-x64/src/entrypoints/plugin/uninstall.ts:16-45`,
`evidence/original/windows-x64/packages/runtime/settings/src/PluginMarketplaceManager.ts:2172-2200`, `:3900-3910`).

**B39 — Update flow.** `droid plugin update [plugin] [-s scope]` updates one plugin or all and reports
one line per success (`(short-version)`) and one per failure; an empty result set reports "nothing to
update" for the named plugin or for all
(`evidence/original/windows-x64/src/entrypoints/plugin/update.ts:11-66`).

**B40 — Marketplace CLI.** `droid plugin marketplace add <url> | remove <name> | list | update [name]`
maps onto the same manager: `add` parses the source (a local path with `~` is expanded), `list` prints a
table with terminal-safe values, `update` refreshes one or all
(`evidence/original/windows-x64/src/entrypoints/plugin/command.ts:24-70`,
`evidence/original/windows-x64/src/entrypoints/plugin/marketplace.ts:25-112`).

**B41 — Component merge into the runtime.** An enabled plugin contributes `droids/*.md`, `skills/*/SKILL.md`,
`commands/*`, `output-styles/*`, `hooks` and `mcp.json` servers. Each scope's plugins are loaded, then
their components merged **within that scope** by the same merge helpers the settings hierarchy uses:
droids, skills and commands keep the first-loaded plugin's entry for a name (`higher` is the accumulated
result), hooks concatenate per event, output styles merge, and MCP servers merge per name with the
**later** plugin in load order overriding (`{...existing, ...incoming}`)
(`evidence/original/windows-x64/packages/runtime/plugins/src/PluginLoader.ts:355-380`, `:283-296`,
`evidence/original/windows-x64/packages/runtime/settings/src/mergeDroids.ts:10-37`,
`evidence/original/windows-x64/packages/runtime/settings/src/mergeMcp.ts:15-27`). The result becomes one hierarchy level per scope —
org plugins below org settings, project plugins below project settings and the project `.agent/` dir, user
plugins below user settings and the user `.agent/` dir — so a scope's own `mcp.json`/`settings.json`
entry always wins over that scope's plugins, and the whole level still loses to higher scopes
(`evidence/original/windows-x64/packages/runtime/settings/src/SettingsManager.ts:3923-4053`).
Plugin skills carry `pluginId` and `pluginScope`, and their `SkillLocation` is derived from the scope
(`evidence/original/windows-x64/packages/runtime/plugins/src/PluginLoader.ts:515-560`).

**B42 — Claude Code layout translation.** A plugin directory shipping `.claude-plugin/` is copied to
`.factory-plugin/`, `agents/` to `droids/`, and `.mcp.json` to `mcp.json`; the Claude MCP document is
wrapped into `{ "mcpServers": … }` and the translation is refused if the result grows past the source
size plus the wrapper bytes. A plugin that authors both `mcp.json` and `.mcp.json` keeps `mcp.json`
(`evidence/original/windows-x64/packages/runtime/plugins/src/pluginCopy.ts:196-250`).

**B43 — Plugin path variables.** `${CLAUDE_PLUGIN_ROOT}` / `$CLAUDE_PLUGIN_ROOT` (and the `DROID_`
spellings) expand to the plugin root, `*_PLUGIN_DATA` to the plugin data directory, in plugin-authored
text; a missing data directory stays as written. In a plugin MCP server's `env`/`headers` the variables
are braced so the connection-time resolver reads them from the plugin's paths
(`evidence/original/windows-x64/packages/utils/src/settings/pluginEnvVars.ts:1-60`).

**B44 — Hook attribution.** A plugin hook handler is tagged `<name>@<marketplace>` so a plugin's copy of a
handler stays separate from the user's; only event keys are carried, never the `hooksDisabled` /
`showHookOutput` preferences of the user's levels
(`evidence/original/windows-x64/packages/runtime/plugins/src/pluginHooks.ts:60-90`).

**B45 — No plugin "tools".** A plugin contributes MCP servers and slash-command assets; it has no
separate tool type, and the archive root markers enumerate exactly those components
(`evidence/original/windows-x64/packages/runtime/plugins/src/archivePluginInstaller.internals.ts:438-452`,
`evidence/original/windows-x64/packages/runtime/plugins/src/PluginLoader.ts:69-75`).

### Skills

**B46 — Discovery sources.** A skill is discovered into exactly one of **eleven** buckets, joined in this
descending priority: `OrgPlugin`, `Runtime`, `Mission`, `Automation`, `FolderDir`, `ProjectDir`,
`ProjectPlugin`, `UserDir`, `UserPlugin`, `Dynamic`, `Builtin`
(`evidence/original/windows-x64/src/skills/constants.ts:31-44`). Settings origins map onto buckets, not
one-to-one: `ProjectSettings` and `ProjectAgentDir` both feed `ProjectDir`; `UserSettings` and
`UserAgentDir` both feed `UserDir`; `Runtime` and `RuntimeGenerated` both feed `Runtime`; org remote
settings and dynamic config contribute no skills array at all
(`evidence/original/windows-x64/src/skills/builtin/index.ts:363-435`, `:570-600`).

**B47 — On-disk skill layout.** Skills load from `<settingsFolder>/skills/<name>/SKILL.md` for every
settings-bearing folder, from `~/.agent/skills` / `~/.agents/skills` and the project `.agent`/`.agents`
counterparts, and from `<missionDir>/skills/`. A folder with no `SKILL.md` contributes nothing for that
name (`evidence/original/windows-x64/packages/runtime/settings/src/FactorySettingsFolder.ts:1455-1487`,
`evidence/original/windows-x64/packages/runtime/settings/src/AgentSettingsFolder.ts:33-40`, `:105-140`,
`evidence/original/windows-x64/src/skills/builtin/index.ts:131-155`).

**B48 — Frontmatter keys.** `name` (required) and `description` (required) are the agentskills.io fields;
optional: `license`, `compatibility`, `metadata`, `allowed-tools` (string or list), `version` (non-string
degrades to absent), and the Factory extensions `tools` (deprecated alias of `allowed-tools`), `enabled`
(default `true`), `user-invocable` (default `true`), `disable-model-invocation` (default `false`)
(`evidence/original/windows-x64/packages/common/src/settings/schema.ts:2396-2420`).

**B49 — Validation.** A skill is invalid when `name` is missing, contains anything outside
`[a-z0-9-]`, or sanitizes to empty, or when the markdown body is empty. A description over 200
characters, a non-semver `version`, or a non-string tool entry produce warnings only
(`evidence/original/windows-x64/packages/utils/src/frontmatter/parseSkillFrontmatter.ts:73-118`).

**B50 — Collision resolution.** Within one bucket the first input for a sanitized name wins and the
duplicate is recorded as a collision. Across buckets the first bucket in priority order to claim a name
wins; later same-name skills become `shadowed` and are not activatable. A name that sanitizes to `''`
never wins, never shadows, and surfaces as invalid (`evidence/original/windows-x64/src/skills/resolveEffectiveSkills.ts:76-196`).

**B51 — Disable ledger.** `general.disabledSkills` is a union across levels: once a name is listed at any
level it stays disabled, with no lower-level re-enable. Frontmatter `enabled: false` also disables. A
disabled winner is reported as `disabled` with its cause (`ledger` or `frontmatter`) and other skills of
the same name remain shadowed by it (`evidence/original/windows-x64/src/skills/resolveEffectiveSkills.ts:168-193`, `:222-240`;
union semantics documented at `evidence/original/windows-x64/packages/common/src/settings/schema.ts:1473-1480`).

**B52 — Builtin skills are code, not user files.** Builtins are parsed once from embedded `SKILL.md` text
(or built from code constants) on first use; a builtin's `filePath` is `builtin:<name>` unless its bundle
is materialized to disk (`evidence/original/windows-x64/src/skills/builtin/loadBuiltinSkill.ts:89-110`).
Eight builtins have no `SKILL.md` asset at all and exist only as prompt constants: `mission-planning`,
`define-mission-skills`, `refactoring-playbook`, `tui-application-playbook`, `tuistory`,
`mission-worker-base`, `scrutiny-validator`, `user-testing-validator`
(`evidence/original/windows-x64/src/skills/builtin/builtinSkillDefinitions.ts:186-247`).
`agent-browser` is a hybrid: its body is the embedded `SKILL.md` with the frontmatter stripped, while its
name and description (and the desktop-pane description variant selected by
`FACTORY_DESKTOP_CDP_PORT` + `AGENT_BROWSER_CDP`) come from code
(`evidence/original/windows-x64/src/skills/builtin/agent-browser/prompt.ts:1-4`,
`evidence/original/windows-x64/src/skills/builtin/index.ts:157-180`).

**B53 — How markdown enters the prompt.** The model never receives skill bodies up front. Each turn the
system prompt carries one reminder whose header is
`Available skills (name: when to use it; activate one by exact name with the Skill tool, which returns its full instructions):`
followed by one line per model-invocable skill, `name: trigger` or the bare name; `disable-model-invocation`
skills are omitted. The Skill tool's description is the stable sentence
`Activate one skill by exact name from the latest system reminder. Use a relevant skill proactively, but never invent a name or reactivate an active skill.`
(`evidence/original/windows-x64/src/skills/constants.ts:3-9`,
`evidence/original/windows-x64/src/skills/availableSkillsReminder.ts:27-96`).

**B54 — Listing budget.** Entries reserve every name first, then spend the remaining budget on triggers:
1.5 % of the working token limit at 4 chars/token (fallback 8000 chars). Builtin and automation skills
always keep their trigger; the rest are upgraded in priority order (personal above plugin) and rendered
in input order. A trigger is one safe line capped at 200 code points with a `…` cut
(`evidence/original/windows-x64/src/skills/skillListingRenderer.ts:9-11`, `:88-169`, `:21-38`).

**B55 — Mid-session changes are append-only.** Skills that appear or whose trigger changes mid-session
are announced in a delta reminder under
`Additional skills now available (they extend the earlier skills list, and a name listed again replaces its earlier entry; activate by exact name with the Skill tool):`,
and names the earlier list showed that can no longer be activated are announced under
`Skills no longer available (drop them from the earlier skills list; the Skill tool no longer activates these names):`.
A baseline is never rewritten (`evidence/original/windows-x64/src/skills/constants.ts:11-26`,
`evidence/original/windows-x64/src/skills/availableSkillsReminder.ts:99-140`,
`evidence/original/windows-x64/src/core/AgentLoop.ts:4622-4650`).

**B56 — Activation.** The `Skill` tool takes `{ skill }`, resolves it by sanitized name among the
effective skills, and refuses with a not-found, disabled, or invalid error identity. On success it
returns `Skill "<name>" is now active.` followed by `<skill name="…" filePath="…">` wrapping the full
markdown, with `filePath` escaped; an on-disk skill also offers its file as the whole-artifact seam
(`evidence/original/windows-x64/src/tools/executors/SkillExecutor.ts:66-175`).

**B57 — Slash commands.** Every user-invocable, valid, enabled skill becomes `/<name>`; a skill whose name
matches an existing command name (case-insensitive) is skipped
(`evidence/original/windows-x64/src/commands/skills/SkillCommandsLoader.ts:20-60`,
`evidence/original/windows-x64/src/commands/skills/BuildSlashCommandsForSkills.ts:274-290`).

**B58 — `--disable-builtin-skills`.** The flag sets a session/process flag so the builtin bucket resolves
to empty: builtins disappear from the reminder, from the effective list, from slash commands, and from
the visible count, while file/plugin/mission skills are untouched. A skill command that is a builtin
becomes a no-op when the flag is set. The flag is rejected in ACP output modes with
`Invalid flags: --disable-builtin-skills is not supported in ACP modes.`
(`evidence/original/windows-x64/src/services/SessionService.ts:10884-10898`,
`evidence/original/windows-x64/src/skills/builtin/index.ts:526-536`, `:204-215`,
`evidence/original/windows-x64/src/commands/skills/BuildSlashCommandsForSkills.ts:289-296`,
`evidence/original/windows-x64/src/entrypoints/exec/assertValidOptions.ts:166-175`).

**B59 — Interaction with `--use-spec`.** Spec mode does not change skill discovery or the listing: it
restricts tools. A turn in spec mode may only modify files under `.factory/specs` (or `.factory-dev/specs`),
and automation memory/skill/run-outcome write tools are refused outright, so any skill instruction that
writes such files fails at the tool boundary. `--use-spec` / `--spec-model` also cannot be combined with
`--mission`, `--session-id`, or `--fork`
(`evidence/original/windows-x64/src/agent/tools.ts:1979-2036`,
`evidence/original/windows-x64/src/entrypoints/exec/assertValidOptions.ts:194-243`).

### Bundled skill inventory

Every bundled `SKILL*.md` asset in the extracted bundle, with the flags its frontmatter sets
(`NU` = `user-invocable: false`, `NM` = `disable-model-invocation: true`). Names and descriptions are as
shipped; the table is the required inventory, not an exhaustive behaviour description.

| # | name | flags | purpose (first line of `description`) | asset |
|---|---|---|---|---|
| 1 | `agent-browser` | — | Automates browsers and Electron desktop apps for testing, form filling, screenshots, data extraction | `SKILL-g9mxfkpy.md` |
| 2 | `automation-memory` | — | Inspect/reset what an automation remembers between runs, and the skills it carries | `SKILL-ep3wc2nz.md` |
| 3 | `browse-wiki` | NU | Search and read wiki documentation for a repository | `SKILL-gbdd199q.md` |
| 4 | `build-ios-apps` | — | Build, run, test, debug iOS apps in the Simulator with the Factory desktop mirror | `SKILL-jhwpbkqk.md` |
| 5 | `cve-remediation` | — | Continuous CVE remediation in a workstream | `SKILL-f0vnm661.md` |
| 6 | `dataset-create` | — | Create and publish an evaluation dataset of Harbor tasks | `SKILL-dgqkwhk5.md` |
| 7 | `dataset-maintenance` | — | Keep an evaluation dataset healthy (broken/flaky/too-easy tasks) | `SKILL-aza89ye8.md` |
| 8 | `dataset-update` | — | Publish a new version of an existing evaluation dataset | `SKILL-y7k0jwxt.md` |
| 9 | `deep-security-review` | NU | Correctness-first, depth-first security audit of one repository (`/security-review`) | `SKILL-zp7gc6js.md` |
| 10 | `eval-hillclimb` | — | Improve a skill/prompt/setting via controlled eval experiments | `SKILL-8zwg7vja.md` |
| 11 | `eval-runs` | — | Answer any question about an eval run (status, score, trials, transcript) | `SKILL-r5eawrmy.md` |
| 12 | `excel` | — | Produce polished Excel spreadsheets as real `.xlsx` | `SKILL-1g9nn1va.md` |
| 13 | `handoff-to-droid-computer` | — | Hand this session's task to a remote droid computer | `SKILL-v8mzxg6g.md` |
| 14 | `incident` | NU | RCA runbook for alerts | `SKILL-4fmdpwyt.md` |
| 15 | `init` | NM | Generate `AGENTS.md` contributor guidelines for a repository | `SKILL-85xzpb50.md` |
| 16 | `install-code-review` | — | Install Droid automated code review (GitHub/GitLab/Bitbucket/Azure DevOps) | `SKILL-8tzj0zgy.md` |
| 17 | `install-qa` | — | Set up automated QA testing: questionnaire, modular QA skill, CI | `SKILL-2t6kq9c6.md` |
| 18 | `install-triage` | — | Scaffold a scheduled Slack triage automation | `SKILL-4e67370f.md` |
| 19 | `install-wiki` | — | Install a CI action that refreshes the repository wiki | `SKILL-6x222byp.md` |
| 20 | `learn-review-guidelines` | — | Learn a repo's review guidelines from acted-on PR comments | `SKILL-vj71qseh.md` |
| 21 | `listener` | — | Run as a workstream listener and poll data sources | `SKILL-6kc9wg57.md` |
| 22 | `listeners` | — | Create listeners and dispatch the items they send | `SKILL-pccfjsdv.md` |
| 23 | `migrate` | NM | Take substantial work from an agreed plan to a verified outcome | `SKILL-g1nnpaw2.md` |
| 24 | `mission-ledger` | NU, NM | Workstreams Ledger instructions injected into the orchestrator prompt (not invocable) | `SKILL-03zbfpwe.md` |
| 25 | `pdf-document` | — | Produce polished PDF documents | `SKILL-wpy2j0ry.md` |
| 26 | `powerpoint` | — | Produce polished PowerPoint decks as real `.pptx` | `SKILL-9tkvdm7a.md` |
| 27 | `pr-risk-assessment` | — | Assess the risk level of a PR | `SKILL-kf88p09z.md` |
| 28 | `pull-request-layer-manifest` | NU | Create/update the narrated reviewer layer manifest | `SKILL-tp6akc98.md` |
| 29 | `review` | — | Review code changes and identify high-confidence, actionable bugs | `SKILL-pvsxjwm1.md` |
| 30 | `review` (recall variant) | — | Recall-oriented replacement when the `ReviewRecallSkill` flag is on | `SKILL.recall-7hc692m5.md` |
| 31 | `security-review` | — | STRIDE / OWASP Top 10 / OWASP LLM Top 10 / supply-chain review | `SKILL-e24hmgjz.md` |
| 32 | `session-navigation` | — | Navigate, search, and manage Droid sessions | `SKILL-09h1a4ja.md` |
| 33 | `shared-context` | — | Read/publish shared documents via `droid space` | `SKILL-c3q5m9m8.md` |
| 34 | `simplify` | — | Review the intended change for reuse, quality, compatibility, efficiency | `SKILL-q59hwpmh.md` |
| 35 | `visualize` | — | Inline charts and diagrams in desktop/web chat | `SKILL-a2hq898w.md` |
| 36 | `wiki` | — | Generate comprehensive codebase documentation for a repository | `SKILL-jptbza44.md` |
| 37 | `wiki-video-gen` | — | Factory-branded HyperFrames video overviews for wikis | `SKILL-jxjgmy45.md` |
| 38 | `word-document` | — | Produce polished Word documents | `SKILL-mpyk7mee.md` |

Two assets carry the name `review`: the second replaces the first when the `ReviewRecallSkill` feature
flag is on (`evidence/original/windows-x64/src/skills/builtin/builtinSkillDefinitions.ts:99-110`). Each
name in this table corresponds to an entry in the builtin definition registry
(`evidence/original/windows-x64/src/skills/builtin/builtinSkillDefinitions.ts:97-180`); the eight code-only
builtins named in B52 have no asset and therefore no row here.

### ACP

**B60 — Transport and startup.** `droid exec --output-format acp` (and `acp-daemon`) starts an ACP
agent: all console output is redirected to stderr, and the protocol is NDJSON over stdin/stdout
(`evidence/original/windows-x64/src/exec/acpDaemonRunner.ts:14-47`,
`evidence/original/windows-x64/src/entrypoints/exec/handler.ts:824-831`).

**B61 — Method surface.** The agent serves `initialize`, `authenticate`, `session/new`, `session/load`,
`session/resume`, `session/fork`, `session/list`, `session/close`, `session/prompt`,
`session/set_mode`, `session/set_config_option`, `logout`, plus the legacy `session/set_model`, and
receives the `session/cancel` notification. The cancel handler is registered immediately after the
prompt handler because the SDK awaits handlers in order and a later cancel must be able to overtake the
next prompt (`evidence/original/windows-x64/src/exec/acpDaemonRunner.ts:49-92`).

**B62 — `initialize` capabilities.** The response advertises `loadSession`, `sessionCapabilities`
`{list, resume, close, fork}`, `promptCapabilities {image, embeddedContext}`,
`mcpCapabilities {http, sse}`, `auth {logout}`, and the unstable `_meta['terminal-auth']` extension.
`agentInfo` is `{name: package name, title: 'Factory Droid', version}`. Auth methods are
`customer-prem` for customer-prem deployments, else `device-pairing` ("Login") and `factory-api-key`
(`evidence/original/windows-x64/src/acp/AcpAgent.ts:1450-1517`).

**B63 — Session creation.** `session/new` requires authentication, mints a UUID session id, marks the
session loading, and initializes it with the request `cwd`, the converted `mcpServers`, and
`sessionOriginHint = cli_acp`. ACP-supplied MCP servers are merged with the session's filesystem MCP
config (`evidence/original/windows-x64/src/acp/AcpAgent.ts:1519-1560`,
`evidence/original/windows-x64/src/acp/session/convertAcpMcpServer.ts:9-13`).

**B64 — ACP MCP server conversion.** A `command` server becomes `{name, command, args: []|args,
env: {}}` (env list flattened to a map); an `http`/`sse` server becomes `{type, name, url, headers}`
(headers list flattened); `type: 'acp'` is rejected with invalid-params
`MCP servers with the acp transport are not supported`, and the agent does not advertise
`mcpCapabilities.acp` (`evidence/original/windows-x64/src/acp/session/convertAcpMcpServer.ts:13-39`).

**B65 — One turn per session.** `session/prompt` while a turn is running fails with invalid-request
`A prompt is already running for this session`. The turn's prompt text is `formatPromptForExec(...)` or
the literal `Process request` when empty, images are attached, and all pending session updates are
flushed before the response is returned
(`evidence/original/windows-x64/src/acp/AcpAgent.ts:2130-2200`).

**B66 — Stop reasons.** A cancelled turn or a turn that ended cancelled returns
`{stopReason: 'cancelled'}`; a successful turn returns `end_turn`; a recognized moderation refusal sends
the content-moderation message as agent text and returns `refusal`; any other ending sends
`Error: <message>` as agent text and fails the request with an internal error
(`evidence/original/windows-x64/src/acp/AcpAgent.ts:2202-2233`).

**B67 — Cancellation.** `session/cancel` is a no-op when the session has no turn; otherwise it marks the
turn cancelled, aborts the turn controller, and asks the daemon to interrupt the session. A `$/cancel_request`
for the prompt request aborts it the same way, and a turn whose session was closed and reloaded is not
cancelled by a stale request (`evidence/original/windows-x64/src/acp/AcpAgent.ts:2235-2250`, `:2144-2165`).

**B68 — Session updates.** Server→client updates use `session/update` with
`sessionId` and one of: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `plan`,
`tool_call`, `tool_call_update`, `session_info_update`, `available_commands_update`,
`current_mode_update`, `config_option_update`, `usage_update`. Updates may carry a strict `_meta.factory`
`{source: mcp|connector, server, tool}` and Zed extensions `subagent_session_info`, `terminal_info`,
`terminal_output`, `terminal_exit`
(`evidence/original/windows-x64/src/acp/protocol/sessionUpdates.ts:266-705`,
`evidence/original/windows-x64/src/acp/protocol/schemas.ts:1-40`,
`evidence/original/windows-x64/src/acp/AcpAgent.ts:1238`, `:1313-1333`, `:2033-2044`).

**B69 — Permission requests.** Droid's confirmation options are mapped to ACP kinds: proceed-once and
proceed-edit → `allow_once`; proceed-always, always-tools, always-server and the auto-run variants →
`allow_always`; cancel → `reject_once`; anything else defaults to `allow_once`. Batch labels use
"both"/"all" quantifiers, and options are shortened for ACP's limited space (e.g. `Allow`, `Allow always`,
`Allow & auto-run (low risk)`)
(`evidence/original/windows-x64/src/acp/tools/mapOutcomeToKind.ts:8-33`,
`evidence/original/windows-x64/src/acp/tools/permissionMappers.ts:1-60`).

**B70 — Modes and config options.** Mode ids are the autonomy modes `normal`, `spec`, `auto-low`,
`auto-medium`, `auto-high`, filtered/clamped by the org `maxAutonomyLevel`. Config option ids are
`model`, `reasoning_effort`, `autonomy_level`; `session/set_model` is accepted for older clients and
routed through the same settings path. Each successful change emits `current_mode_update` when the mode
changed and `config_option_update` with the full option set when mode, model or effort changed
(`evidence/original/windows-x64/packages/droid-sdk-core/src/protocol/shared/enums.ts:39-45`,
`evidence/original/windows-x64/src/acp/session/constants.ts:4-6`,
`evidence/original/windows-x64/src/acp/session/modes.ts:14-38`,
`evidence/original/windows-x64/src/acp/AcpAgent.ts:1290-1335`).

**B71 — Session listing, resume, fork, close and load.** `session/list` reports `SessionInfo` rows,
`session/load` replays history as `session/update` notifications **before** its response,
`session/resume` re-attaches without replay, `session/fork` forks at a point, and `session/close`
removes the session so later requests for that id fail rather than reviving it
(`evidence/original/windows-x64/src/acp/AcpAgent.ts:1554-1780`, `:2097-2130`, `:523-530`).

## Data & config

### MCP

| Item | Location / shape | Required | Default | Notes |
|---|---|---|---|---|
| User servers | `<factoryDir>/mcp.json` → `mcpServers.<name>` | no | absent | key normalized before use (`evidence/original/windows-x64/src/services/mcp/mcpConfigPresence.ts:73-81`, `evidence/original/windows-x64/packages/runtime/settings/src/FactorySettingsFolder.ts:1286-1310`) |
| Project servers | `<projectRoot>/.factory/mcp.json` | no | absent | `projectRoot` = git root else cwd |
| Transport | `type`: `stdio`\|`http`\|`sse` | no | `stdio` | discriminated union |
| stdio | `command`, `args[]`, `env{}` | `command` | `args: []` | `env` is the credential channel |
| remote | `url`, `headers{}`, `oauth` | `url` | — | `oauth: false` disables |
| Per-server limits | `timeout`, `connectTimeout` (ms) | no | 180 000 / 10 000 (stdio 30 000) | positive int ≤ 2 147 483 647 |
| Filters | `enabledTools[]`, `disabledTools[]` | no | — | denylist wins |
| Permissions | `persistentPermissions.servers/tools` | no | — | nested shape; flat keys migrate |
| Era cache | `cache/mcp/protocol-eras/v1/<sha256>.json` | no | — | `{version:1, checkedAt}`, ≤1 KiB |
| Catalogs | `cache/mcp/catalogs/<server>.json` | no | — | `MCP_CATALOG_VERSION = 1`, ≤4 MiB |
| Env overrides | `FACTORY_MCP_LIST_TOOLS_TIMEOUT_MS`, `FACTORY_MCP_BLOCKING_LOAD_TIMEOUT_MS` | no | 15 000 / 60 000 | per-fetch / per-session |

### Plugins

| Item | Location / shape | Notes |
|---|---|---|
| Marketplace registry | `<scopeRoot>/plugins/known_marketplaces.json` (+ `known_marketplaces/`) | one entry per registered marketplace (`MarketplaceEntrySchema`: `source`, `installLocation`, `lastUpdated`, `autoUpdate` default `true`) |
| Installed registry | `<scopeRoot>/plugins/installed_plugins.json` (+ `installed_plugins/`) | `{schemaVersion, plugins: {id: entry[]}}` |
| Entry | `scope`, `installPath`, `version`, `installedAt`, `lastUpdated`, `source`, `marketplaceSourceHash?`, `externalSource?`, `externalCommit?`, `npm?`, `portableOnly?` | one array per plugin id |
| Marketplace checkout | `<scopeRoot>/plugins/marketplaces/<name>/` | manifest at `.factory-plugin/marketplace.json` or `.claude-plugin/marketplace.json` |
| Plugin copies | `<scopeRoot>/plugins/cache/<version>/` | staging prefix `.plugin-staging-` |
| Plugin data | `<scopeRoot>/plugins/data/<slot>/` | referenced as `${*_PLUGIN_DATA}` |
| Enablement | `general.enabledPlugins` in `settings.json` | plus `strictEnabledPlugins`, `extraKnownMarketplaces`, `strictKnownMarketplaces`, `pluginTokenHosts` |

### Skills

| Item | Shape | Notes |
|---|---|---|
| Skill file | `SKILL.md` with YAML frontmatter + markdown body | body becomes `systemPrompt` |
| Frontmatter | `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `version`, `tools`, `enabled`, `user-invocable`, `disable-model-invocation` | see B48 |
| Directories | `<settingsFolder>/skills/<name>/SKILL.md`, `.agent/skills`, `.agents/skills`, `<mission>/skills` | see B46/B47 |
| Ledger | `general.disabledSkills: string[]` | union across levels, sanitized names |
| Builtin ids | `filePath = "builtin:<name>"` | no file on disk unless the bundle is materialized |

### ACP

| Item | Value |
|---|---|
| Transport | NDJSON on stdin/stdout; console → stderr |
| Methods | see B61 |
| Mode ids | `normal`, `spec`, `auto-low`, `auto-medium`, `auto-high` |
| Config option ids | `model`, `reasoning_effort`, `autonomy_level` |
| Stop reasons | `end_turn`, `cancelled`, `refusal` (+ SDK-defined others unused here) |
| Meta extension | `_meta.factory.source ∈ {mcp, connector}` |

## Errors

| Trigger | Identity (observed) | Effect |
|---|---|---|
| `mcp.json` JSONC parse error | file contributes nothing; `Failed to load mcp.json` logged | other files still load |
| `mcp.json` schema violation (server entry) | presence probe reports `hasError`; server not started | no partial server |
| Unset `${VAR}` in `env`/`headers` | `MCP server credential references an unset environment variable "<VAR>"` | that server's connect fails |
| Server not in config at call time | `Server does not exist` with `{name}` | call fails, no retry |
| Connect exceeds budget | `MCP server connection timed out after <n> seconds` (`McpServerConnectTimeoutError`) | server marked failed |
| `tools/list` rejected result | `The MCP server returned an invalid tools/list result` (+ `reason`) — no cause is attached | listing fails; failure negative-cached 60 s |
| stdio transport closed mid-call | `Stdio MCP server transport closed` with `stage: in_flight\|not_sent` | call fails; message tells whether the server may have acted |
| Tool call exceeds `timeout` | SDK request timeout | call fails; turn continues |
| MCP add: unknown `--type` | `commands:mcp.add.invalidServerType` message | nothing written |
| MCP add: duplicate name | `commands:mcp.add.serverAlreadyExists` with the existing config detail | nothing written |
| MCP add: URL without `--type` | `commands:mcp.add.looksLikeUrl` | nothing written |
| MCP add: policy denial | `commands:mcp.add.blockedByPolicy` | nothing written |
| Plugin id without `@` | `"<id>" isn't a valid plugin name. Use plugin-name@marketplace, for example review-tools@team-tools.` | nothing installed |
| Marketplace unknown | `plugin-not-found` / `marketplace-not-found` reason; user-facing error text | nothing installed |
| Marketplace source drift | `Marketplace "<name>" does not match its configured source` | install refused |
| Org policy denies source | `Installing plugins from "<name>" is not allowed by organization policy` | install refused |
| Archive checksum mismatch | `checksum-mismatch` | install refused, cache untouched |
| Archive unsafe entry / limits | `unsafe-entry`, `extraction-limit`, `invalid-archive`, `too-large` | extraction aborted |
| Plugin uninstall, not present | `commands:plugin.pluginNotInstalled` | no change |
| Skill name invalid | validation errors: `Skill must have a name` / `Skill name must contain only lowercase letters, numbers, and hyphens` / `Skill name must contain at least one letter or number` / `Skill must have a system prompt` | skill listed as `invalid`, not activatable |
| Skill tool: unknown name | `skillNotFound` message | tool result is an error, no activation |
| Skill tool: disabled/invalid | `skillDisabled` / `skillInvalid` (invalid lists the validation errors) | no activation |
| ACP prompt while busy | invalid request `A prompt is already running for this session` | no second turn starts |
| ACP `type: 'acp'` MCP server | invalid params `MCP servers with the acp transport are not supported` | `session/new` fails |
| ACP `--disable-builtin-skills` | `Invalid flags: --disable-builtin-skills is not supported in ACP modes.` | process exits non-zero before starting |

## Acceptance tests

All fixtures are synthesised: temporary directories standing in for `~/.factory` and a project root, plus
hand-written `SKILL.md`, `mcp.json`, `marketplace.json` and `plugin.json` files. No network, no
credentials, no wall clock, no dependence on the original binary.

| Clause | Test id | Fixture |
|---|---|---|
| B1, B2 | `tests/extensions/test_mcp_config_discovery_and_tolerance` | `fixtures/mcp/two-files/`, `fixtures/mcp/broken-jsonc/` |
| B3 | `tests/extensions/test_mcp_server_schema_by_transport` | `fixtures/mcp/transports/` |
| B4 | `tests/extensions/test_mcp_config_merge_precedence` | `fixtures/mcp/merge-precedence/` |
| B5 | `tests/extensions/test_mcp_name_canonicalization` | `fixtures/mcp/alias-keys/` |
| B6 | `tests/extensions/test_mcp_add_writes_user_file` | `fixtures/mcp/empty-home/` |
| B7 | `tests/extensions/test_mcp_policy_allowlist` | `fixtures/mcp/policy/` |
| B8 | `tests/extensions/test_mcp_secret_reference_resolution` | `fixtures/mcp/secrets/` |
| B9 | `tests/extensions/test_mcp_sandbox_env_allowlist` | `fixtures/mcp/sandbox-env/` |
| B10, B11 | `tests/extensions/test_mcp_connect_budget_and_era_plan` | `fixtures/mcp/connect/` |
| B12 | `tests/extensions/test_mcp_era_cache_ttl_and_ignored_files` | `fixtures/mcp/era-cache/` |
| B13, B14 | `tests/extensions/test_mcp_tool_list_timeout_and_lenient_retry` | `fixtures/mcp/tool-list/` |
| B15 | `tests/extensions/test_mcp_tool_filters` | `fixtures/mcp/tool-filters/` |
| B16 | `tests/extensions/test_mcp_tool_registration_identity` | `fixtures/mcp/registration/` |
| B17 | `tests/extensions/test_mcp_tool_name_collision` | `fixtures/mcp/name-collision/` |
| B18, B19 | `tests/extensions/test_mcp_registration_lifecycle_and_seed` | `fixtures/mcp/seed-catalog/` |
| B20, B21 | `tests/extensions/test_mcp_call_timeout_and_cancel` | `fixtures/mcp/call/` |
| B22, B23 | `tests/extensions/test_mcp_result_marshalling` | `fixtures/mcp/results/` |
| B24 | `tests/extensions/test_mcp_persistent_permission_gates` | `fixtures/mcp/permissions/` |
| B25 | `tests/extensions/test_mcp_cli_help_matches_golden` | `tests/parity/cases/help-mcp.json` |
| B26 | `tests/extensions/test_mcp_oauth_config_constraints` | `fixtures/mcp/oauth-config/` |
| B27, B28 | `tests/extensions/test_mcp_oauth_callback_ports` | `fixtures/mcp/oauth-ports/` |
| B29, B30 | `tests/extensions/test_mcp_oauth_credential_tombstones` | `fixtures/mcp/oauth-store/` |
| B31 | `tests/extensions/test_plugin_registry_layout` | `fixtures/plugins/registry/` |
| B32 | `tests/extensions/test_plugin_marketplace_manifest_validation` | `fixtures/plugins/marketplace-manifest/` |
| B33 | `tests/extensions/test_plugin_manifest_validation` | `fixtures/plugins/plugin-manifest/` |
| B34, B35 | `tests/extensions/test_plugin_source_kinds_and_verification` | `fixtures/plugins/sources/` |
| B36 | `tests/extensions/test_plugin_enablement_settings_precedence` | `fixtures/plugins/enablement/` |
| B37 | `tests/extensions/test_plugin_install_flow` | `fixtures/plugins/install/` |
| B38, B39 | `tests/extensions/test_plugin_uninstall_and_update_flows` | `fixtures/plugins/installed/` |
| B40 | `tests/extensions/test_plugin_marketplace_cli` | `fixtures/plugins/marketplace-cli/` |
| B41, B44 | `tests/extensions/test_plugin_component_merge` | `fixtures/plugins/components/` |
| B42, B43 | `tests/extensions/test_plugin_claude_layout_translation` | `fixtures/plugins/claude-layout/` |
| B45 | `tests/extensions/test_plugin_component_markers` | `fixtures/plugins/markers/` |
| B46, B47 | `tests/extensions/test_skill_discovery_with_overlapping_names` | `fixtures/skills/overlap/` |
| B48, B49 | `tests/extensions/test_skill_frontmatter_keys_and_validation` | `fixtures/skills/frontmatter/` |
| B50 | `tests/extensions/test_skill_collision_priority_and_shadowing` | `fixtures/skills/collide/` |
| B51 | `tests/extensions/test_skill_disabled_ledger_union` | `fixtures/skills/ledger/` |
| B52 | `tests/extensions/test_builtin_skill_materialization` | `fixtures/skills/builtin/` |
| B53, B54 | `tests/extensions/test_skill_listing_budget_and_rendering` | `fixtures/skills/listing/` |
| B55 | `tests/extensions/test_skill_delta_reminder` | `fixtures/skills/delta/` |
| B56 | `tests/extensions/test_skill_tool_activation_payload` | `fixtures/skills/activate/` |
| B57 | `tests/extensions/test_skill_slash_command_registration` | `fixtures/skills/slash/` |
| B58 | `tests/extensions/test_disable_builtin_skills_effect` | `fixtures/skills/disable-builtin/` |
| B59 | `tests/extensions/test_spec_mode_skill_write_boundary` | `fixtures/spec-mode/` |
| B60, B61 | `tests/extensions/test_acp_method_surface` | `fixtures/acp/ndjson/` |
| B62 | `tests/extensions/test_acp_initialize_response` | `fixtures/acp/initialize/` |
| B63, B64 | `tests/extensions/test_acp_mcp_server_conversion` | `fixtures/acp/mcp-servers/` |
| B65, B66 | `tests/extensions/test_acp_prompt_and_stop_reasons` | `fixtures/acp/turns/` |
| B67 | `tests/extensions/test_acp_cancel_semantics` | `fixtures/acp/cancel/` |
| B68 | `tests/extensions/test_acp_session_update_shapes` | `fixtures/acp/updates/` |
| B69 | `tests/extensions/test_acp_permission_option_mapping` | `fixtures/acp/permissions/` |
| B70 | `tests/extensions/test_acp_modes_and_config_options` | `fixtures/acp/config/` |
| B71 | `tests/extensions/test_acp_session_lifecycle` | `fixtures/acp/lifecycle/` |

The inventory table is pinned by `tests/extensions/test_bundled_skill_inventory` against
`fixtures/skills/inventory/`: it asserts the exact set of bundled names, each name's `user-invocable` /
`disable-model-invocation` flags, and that no bundled name is duplicated except the `review` /
review-recall pair.

## Evidence

Every `path:line` below is relative to `evidence/original/windows-x64/`, e.g.
`evidence/original/windows-x64/src/mcp/constants.ts:6`; rows that name a repo-relative path
(`tests/parity/…`) or a path under `evidence/extracted/windows-x64/` say so explicitly.

| Evidence | Supports | Method |
|---|---|---|
| `ev_mcp_constants_1` (`src/mcp/constants.ts:6-102`) | B10, B13, B19, B20, B28 | reading |
| `ev_mcp_schema_1` (`packages/common/src/settings/schema.ts:2254-2362`) | B3, B4, B24 | reading |
| `ev_mcp_schema_2` (`packages/droid-sdk-core/src/protocol/settings/schema.ts:96-160`) | B26 | reading |
| `ev_mcp_merge_1` (`packages/runtime/settings/src/mergeMcp.ts:1-28`) | B4 | reading |
| `ev_mcp_hierarchy_1` (`packages/runtime/settings/src/SettingsManager.ts:3923-4053`) | B4 | reading |
| `ev_mcp_hierarchy_2` (`packages/runtime/settings/src/SettingsResolver.ts:286-305`) | B4 | reading |
| `ev_mcp_paths_1` (`src/services/mcp/mcpConfigPresence.ts:73-81`, `:236-266`) | B1, B4 | reading |
| `ev_mcp_load_1` (`packages/runtime/settings/src/FactorySettingsFolder.ts:1286-1315`) | B2 | reading |
| `ev_mcp_names_1` (`packages/utils/src/mcp/normalizeServerName/index.ts:15-82`) | B5 | reading |
| `ev_mcp_names_2` (`src/mcp/utils.ts:115-117`, `:255-305`) | B17 | reading |
| `ev_mcp_names_3` (`packages/droid-core/src/llms/client/tool-call-ids.ts:13-70`) | B17 | reading |
| `ev_mcp_service_1` (`src/services/mcp/McpService.ts:4198-4310`, `:4429-4480`) | B16, B18 | reading |
| `ev_mcp_hub_1` (`src/mcp/McpHub.ts:1762-1800`, `:2221-2330`) | B15, B20, B21, B30 | reading |
| `ev_mcp_exec_1` (`src/tools/executors/client/mcp/formatMcpResult.ts:12-125`) | B22, B23 | reading |
| `ev_mcp_oauth_1` (`packages/common/src/mcp-oauth/constants.ts:3-74`) | B27 | reading |
| `ev_mcp_oauth_2` (`packages/runtime/auth/src/mcp-oauth/schema.ts:111-174`) | B29 | reading |
| `ev_mcp_oauth_3` (`src/services/mcp/oauth/core/driver.ts:1-70`) | B28, B29 [inferred step order] | reading |
| `ev_mcp_policy_1` (`packages/runtime/settings/src/McpSettingsManager.ts:119-135`, `:193-270`) | B7 | reading |
| `ev_mcp_perm_1` (`src/services/mcp/McpPermissionService.ts:1-35`, `:196-260`) | B24 | reading |
| `ev_mcp_cli_1` (`src/entrypoints/mcp/command.ts:17-112`) | B6, B25 | reading |
| `ev_mcp_add_1` (`src/commands/mcp/add.ts:25-252`) | B5, B6 | reading |
| `ev_mcp_secrets_1` (`src/mcp/resolveMcpSecretReferences.ts:8-80`) | B8 | reading |
| `ev_mcp_sandbox_1` (`src/mcp/sandbox.ts:77-150`) | B9 | reading |
| `ev_mcp_era_1` (`src/mcp/protocolEra.ts:1-84`) | B12 | reading |
| `ev_plugin_layout_1` (`packages/runtime/plugins/src/constants.ts:5-39`, `:71-88`) | B31, B34 | reading |
| `ev_plugin_registry_1` (`packages/runtime/plugins/src/PluginRegistry.ts:283-300`, `:791-815`) | B31 | reading |
| `ev_plugin_manifest_1` (`packages/common/src/settings/schema.ts:306-350`, `:490-527`) | B32, B35, B36 | reading |
| `ev_plugin_manifest_2` (`packages/runtime/plugins/src/pluginHooks.ts:37-45`, `:192-240`) | B33, B44 | reading |
| `ev_plugin_archive_1` (`packages/runtime/plugins/src/archivePluginInstaller.internals.ts:438-486`) | B33, B45 | reading |
| `ev_plugin_archive_2` (`packages/runtime/plugins/src/archivePluginInstaller.ts:82`, `:160-175`) | B35 | reading |
| `ev_plugin_cli_1` (`src/entrypoints/plugin/command.ts:24-118`, `src/entrypoints/plugin/install.ts:11-49`) | B37, B40 | reading |
| `ev_plugin_cli_2` (`src/entrypoints/plugin/uninstall.ts:16-45`, `src/entrypoints/plugin/update.ts:11-66`) | B38, B39 | reading |
| `ev_plugin_manager_1` (`packages/runtime/settings/src/PluginMarketplaceManager.ts:1707-1795`, `:2172-2200`) | B37, B38 | reading |
| `ev_plugin_loader_1` (`packages/runtime/plugins/src/PluginLoader.ts:283-296`, `:355-380`, `:515-560`, `packages/runtime/settings/src/mergeDroids.ts:10-37`, `packages/runtime/settings/src/mergeMcp.ts:15-27`) | B41 | reading |
| `ev_plugin_loader_2` (`packages/runtime/plugins/src/PluginLoader.ts:238-282`) | B41 | reading |
| `ev_plugin_copy_1` (`packages/runtime/plugins/src/pluginCopy.ts:196-250`) | B42 | reading |
| `ev_plugin_env_1` (`packages/utils/src/settings/pluginEnvVars.ts:1-60`) | B43 | reading |
| `ev_plugin_id_1` (`packages/runtime/plugins/src/pluginId.ts:1-37`) | B37 | reading |
| `ev_skill_priority_1` (`src/skills/constants.ts:3-44`) | B46, B53, B54, B55 | reading |
| `ev_skill_resolve_1` (`src/skills/resolveEffectiveSkills.ts:71-240`) | B50, B51 | reading |
| `ev_skill_index_1` (`src/skills/builtin/index.ts:204-215`, `:467-633`) | B46, B51, B58 | reading |
| `ev_skill_dirs_1` (`packages/runtime/settings/src/FactorySettingsFolder.ts:1455-1487`, `packages/runtime/settings/src/AgentSettingsFolder.ts:33-140`) | B47 | reading |
| `ev_skill_fm_1` (`packages/common/src/settings/schema.ts:2396-2420`) | B48 | reading |
| `ev_skill_fm_2` (`packages/utils/src/frontmatter/parseSkillFrontmatter.ts:73-118`) | B49 | reading |
| `ev_skill_builtin_1` (`src/skills/builtin/loadBuiltinSkill.ts:89-110`, `src/skills/builtin/builtinSkillDefinitions.ts:186-247`, `src/skills/builtin/agent-browser/prompt.ts:1-4`) | B52 | reading |
| `ev_skill_render_1` (`src/skills/availableSkillsReminder.ts:27-140`) | B53, B55 | reading |
| `ev_skill_render_2` (`src/skills/skillListingRenderer.ts:9-169`) | B54 | reading |
| `ev_skill_exec_1` (`src/tools/executors/SkillExecutor.ts:66-175`) | B56 | reading |
| `ev_skill_slash_1` (`src/commands/skills/SkillCommandsLoader.ts:20-60`, `src/commands/skills/BuildSlashCommandsForSkills.ts:274-296`) | B57, B58 | reading |
| `ev_skill_spec_1` (`src/agent/tools.ts:1979-2036`) | B59 | reading |
| `ev_skill_disable_1` (`src/services/SessionService.ts:10884-10902`, `src/entrypoints/exec/assertValidOptions.ts:166-175`) | B58 | reading |
| `ev_skill_inventory_1` (38 `SKILL*.md` assets in `evidence/extracted/windows-x64/`) | inventory table | decoded via `iconv` (UTF-16LE) / text grep |
| `ev_acp_wire_1` (`src/exec/acpDaemonRunner.ts:14-92`) | B60, B61 | reading |
| `ev_acp_agent_1` (`src/acp/AcpAgent.ts:1450-1560`) | B62, B63 | reading |
| `ev_acp_agent_2` (`src/acp/AcpAgent.ts:2130-2250`) | B65, B66, B67 | reading |
| `ev_acp_agent_3` (`src/acp/AcpAgent.ts:1290-1335`, `:2033-2044`) | B68, B70 | reading |
| `ev_acp_convert_1` (`src/acp/session/convertAcpMcpServer.ts:13-39`) | B64 | reading |
| `ev_acp_updates_1` (`src/acp/protocol/sessionUpdates.ts:266-705`, `src/acp/protocol/schemas.ts:1-40`) | B68 | reading |
| `ev_acp_perm_1` (`src/acp/tools/mapOutcomeToKind.ts:8-33`, `src/acp/tools/permissionMappers.ts:1-60`) | B69 | reading |
| `ev_acp_modes_1` (`src/acp/session/constants.ts:4-6`, `src/acp/session/modes.ts:14-38`) | B70 | reading |
| `ev_acp_lifecycle_1` (`src/acp/AcpAgent.ts:1554-1780`, `:2097-2130`) | B71 | reading |
| `ev_cli_goldens_1` (repo-relative `tests/parity/expected/help-mcp.json`, `help-plugin.json`, `help-exec.json`) | B25, B40, B58 | recorded goldens |

Labelling. Two claims are `[derived]` rather than read directly: B17's collision-stability guarantee
(the code comments assert it and the hashing is of the raw name, but no executed collision case was
observed) and B45 (derived from the absence of a plugin tool component across the loader, the archive
markers and the settings schema). B67's stale-request rule is `[observed]` in code as written and
`[derived]` as a guarantee. Every other clause rests on the cited lines alone.

## Open questions

1. **`SkillBucket` / `SkillStatus` literal values.** `src/skills/enums.ts` is imported by
   `constants.ts` and `resolveEffectiveSkills.ts` but is absent from the recovered tree (elided
   type/barrel module). Only the ordering identifiers are observable. Settling it needs the enum module
   or an observed serialized skill record. Blocks nothing: B46/B50/B51 are stated in terms of ordering
   and status names, not enum values. `[inferred]`
2. **`McpServerConfig.plugin` field shape.** The `plugin` binding on a server config is used
   (`resolveMcpSecretReferences.ts:64-73`, `McpSettingsManager.ts:36-66`) but its type is elided. What is
   known: it carries a `root`, an optional `data` directory, and path variables resolve from it.
   Blocks B43's exact key names.
3. **`.factory-plugin/plugin.json` full schema.** Only `hooks` is read and only a `$schema` prefix is
   sniffed; no schema exists for `name`, `version`, `description`. Whether other keys are validated,
   ignored, or rejected on install is unknown; `manifest-invalid` (`PluginFailureReason`) names a
   failure class but its trigger site is not in the recovered tree. Blocks a claim that a manifest
   without `name` is accepted or rejected.
4. **`droid mcp list` exact output.** The command's rendering (table columns, auth-status wording) lives in
   the 593-line `src/commands/mcp/utils.ts`, which was only skimmed; B25 pins the command set only, not
   the text. Settling it needs the renderer plus a recorded golden.
5. **Stdio command resolution on Windows.** `spawnStdioFamily` / `windowsJobFamily` implement process
   trees and a job object; whether `command` is resolved through `PATH`, `cmd.exe`, or a shell is not
   established here. Blocks any claim about how a config command string with shell metacharacters runs.
6. **Protocol era for SSE servers.** Comments state SSE predates 2026-07-28 (`legacy_only`), but the connect
   path for `sse` was not read line by line. B11 states the plan source; whether a configured SSE server
   with modern negotiation on is ever probed is unverified.
7. **`FACTORY_MCP_LIST_TOOLS_TIMEOUT_MS` / `FACTORY_MCP_BLOCKING_LOAD_TIMEOUT_MS` bounds.** The resolver is
   in `src/environment.ts:405-420`; the accepted range and fallback for malformed values were not read.
8. **MCP catalog prewarming preconditions.** `src/mcp/prewarmMcpCatalogs.ts` skips servers for reasons
   including sandbox, org-policy authority and folder trust; the daemon-side trigger is out of this
   slice. It affects only latency, not the session contract.

## Clean-room notes

**The contract a reimplementation must reproduce**

- Two MCP config files (`<factoryDir>/mcp.json`, `<projectRoot>/.factory/mcp.json`), JSONC, tolerant of a
  broken file, merged lowest-first with per-name whole-entry override and normalized-name identity.
- The server schema exactly: `type` defaulting to `stdio`, `command/args/env` vs `url/headers/oauth`, and
  `disabled`, `enabledTools`, `disabledTools`, `timeout`, `connectTimeout`.
- `${VAR}` / `${VAR:-default}` resolution at connect time, with plugin paths winning over the environment.
- Org MCP policy semantics: hostname matching for remote, normalized-substring matching for stdio, and an
  empty allowlist allowing nothing.
- The tool identity contract: `mcp_<server>_<tool>` id, `<server>___<tool>` llmId sanitized to
  `[A-Za-z0-9_-]` and 64 characters with an 8-char hash suffix, deterministic collision suffixes, and the
  `mcp__<server>__<tool>` alias only when unambiguous.
- Timeout defaults (10 s connect / 30 s stdio connect / 15 s listing / 180 s call / 60 s blocking-load),
  the negative-cache TTL, and cancellation that settles rather than hangs.
- Result marshalling strings: `Error: …`, `Error: Unknown error occurred`, `[No content returned]`, and
  the output-schema remediation sentence.
- Persistent-permission gating (impact ≤ approved, identity match, autonomy ceiling) and the nested
  `servers`/`tools` shape.
- Plugin layout under `<scopeRoot>/plugins/` with both the legacy file and the directory registry readable,
  the two marketplace-manifest paths, the archive root markers, the Claude→Factory layout translation and
  the `PLUGIN_ROOT`/`PLUGIN_DATA` variable expansion.
- Plugin id parsing on the first `@` at index ≥ 1, default install scope `user`, uninstall scope probing
  user→project, and the install refusals (unknown marketplace, source drift, org policy, checksum).
- Skill discovery across all buckets in the stated priority order, `skills/<name>/SKILL.md` layout,
  first-wins intra-bucket and first-bucket-wins cross-bucket collision handling, the union
  `disabledSkills` ledger with no re-enable, and frontmatter defaults.
- The reminder header sentences, the `name: trigger` line shape, the 200-code-point trigger cap, the
  1.5 %/8000-char listing budget with name-first reservation, the append-only delta/removal reminders, and
  the `<skill name filePath>` activation payload.
- `--disable-builtin-skills` emptying only the builtin bucket and being rejected in ACP modes.
- The ACP method set, `initialize` capabilities and auth method ids, NDJSON transport with console output
  redirected to stderr, one turn per session, the three stop reasons, cancel semantics, the update kinds,
  the permission-kind mapping, and mode/config-option ids.

**Explicitly not part of the contract**

- Exact wording of progress/spinner text, table formatting, and log lines.
- The set of bundled skills is a *release* property: a reimplementation must keep the mechanism and the
  inventory of the release it targets, but adding or removing a skill is not a behaviour change of this
  subsystem.
- Internal implementation choices: the `codegraph`-style private helpers, the stdio process-family/job-object
  machinery, catalog prewarming, metrics names, and the exact hashing of internal cache filenames beyond
  the directory layout stated above.
- Feature-flag gating of individual builtins and plugins (which of them a given org sees) is a policy
  concern owned elsewhere; this spec pins that gating *exists* and where it is applied.