# src/extensions — MCP, plugins, skills

Reads and resolves the extension configuration a session sees, and drives MCP
servers through one typed client. Contract:
`specs/60-extensions-mcp-and-skills.md`. Configuration, plugin and skill code is
pure: paths and file readers are injected and every name is derived
deterministically. The MCP client is the only part that spawns a process or
posts to an endpoint, and it does so only when a caller opens a client.

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
- `mcp/transport.ts` — the `McpTransport` interface (`request`, `notify`,
  `close`) and its two implementations: a stdio child spoken to in
  newline-delimited JSON-RPC 2.0, and a streamable-HTTP endpoint.
- `mcp/client.ts` — the per-server lifecycle, the budgets, the listing negative
  cache, cancellation and result marshalling.
- `mcp/errors.ts` — `McpConnectError`, `McpProtocolError`, `McpToolError`,
  `McpTimeoutError`, `McpCancelledError`; each carries its server name.
- `mcp/tools.ts` — `createMcpToolDefinitions(servers)`, a pure factory turning a
  live listing into registry definitions (not wired into `createCoreRegistry`).
- `skills/discovery.ts` — strict YAML-subset frontmatter, bucket discovery,
  collision/shadow resolution, the disable ledger, the listing budget and the
  activation payload.
- `plugins/manifest.ts` — plugin-id parsing, manifest lookup and `hooks`
  validation.
- `jsonc.ts`, `guards.ts` — shared JSONC scanner and the untrusted-object guard.

## MCP client lifecycle

One `McpClient` is one server (`createMcpClient(options)`). It owns its
transport and closes it on every failure path.

1. **Build the transport.** `stdio` spawns `command` with an argument array
   (`shell: false`) and the caller's base environment plus the configured `env`
   channel; `http`/`sse` post to `url` with the configured `headers`. The child
   is a process-group leader on POSIX and is killed with `taskkill /T` on
   Windows, so `close()` always reaps descendants.
2. **`initialize`.** Sends `{protocolVersion, capabilities: {}, clientInfo}`;
   validates `protocolVersion`, `capabilities` and `serverInfo` from the reply.
   Budget: `connectTimeout`, else 10 s (30 s for stdio).
3. **`notifications/initialized`.** Sent inside the same connect budget. A
   failure here is a connect failure: the transport is closed and the promise
   rejects.
4. **`tools/list`.** Follows `nextCursor` until a page has none, all inside one
   15 s budget (`FACTORY_MCP_LIST_TOOLS_TIMEOUT_MS` in the subject). A page is
   parsed strictly first; if any tool fails, the same payload is parsed per tool
   and the refusals are returned as `skipped` instead of discarding the listing.
   Pages are capped at 100 and a repeated cursor is refused.
5. **`tools/call`.** Sends `{name, arguments}` inside `config.timeout`, else
   180 s. Content blocks become text (JSON re-indented), image and unknown
   blocks become markers; `structuredContent` renders when the content array is
   empty; an empty result is `[No content returned]`.
6. **`close()`.** Idempotent: settles every pending request with
   `client_closed`, ends stdin, waits the close grace, then kills the process
   tree.

Server notifications are advisory: `notifications/tools/list_changed` clears the
listing negative cache. No `resources/*` or prompt method is called — the spec
requires none.

### Failures

| Condition                                                        | Error                                             | Identity                                                                                                                | Effect                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| command cannot start                                             | `McpConnectError`                                 | `MCP server "<s>" could not be started: <cause>`                                                                        | connect fails, no process left                                                 |
| process dies before the handshake                                | `McpConnectError`                                 | `MCP server "<s>" could not complete the initialize handshake: <cause>`                                                 | connect fails, transport closed                                                |
| server did not answer `initialize`                               | `McpTimeoutError` (`phase: connect`)              | `MCP server connection timed out after <n> seconds`                                                                     | connect fails, transport closed                                                |
| bad frame, wrong id, unattributable error, JSON-RPC error        | `McpProtocolError`                                | `sent a frame that is not JSON`, `answered request id <n>, which is not pending`, `rejected <method>: <msg> (code <n>)` | the stream is untrustworthy: every pending request settles, the boundary fails |
| `tools/list` result is not an object, or `tools` is not an array | `McpProtocolError`                                | `The MCP server returned an invalid tools/list result: <reason>`                                                        | listing fails, cached 60 s                                                     |
| listing budget exhausted                                         | `McpTimeoutError` (`phase: list`)                 | `MCP server "<s>" did not answer tools/list within <n> seconds`                                                         | listing fails, cached 60 s                                                     |
| repeated cursor, or more than 100 pages                          | `McpProtocolError`                                | `returned the tools/list cursor "<c>" twice`                                                                            | listing fails, cached 60 s                                                     |
| tool result has `isError: true`                                  | `McpToolError`                                    | `Error: <first text block>`, `Error: <structuredContent>`, `Error: Unknown error occurred`                              | the call fails, the turn continues                                             |
| call budget exhausted                                            | `McpTimeoutError` (`phase: call`)                 | `MCP tool <server>/<tool> timed out after <n> seconds`                                                                  | the call fails; not cached                                                     |
| caller aborts before the frame is written                        | `McpCancelledError` (`stage: not_sent`)           | `MCP server "<s>" cancelled <method> before it was sent`                                                                | settles at once; nothing reached the server                                    |
| caller aborts after the frame is written                         | `McpCancelledError` (`stage: in_flight`)          | `... after it was sent; the server may already have acted`                                                              | settles at once; the server may still act                                      |
| server exits or closes the stream                                | `McpCancelledError` (`trigger: transport_closed`) | `Stdio MCP server transport closed`, exit code and stderr tail in `cause`                                               | every pending request settles                                                  |
| client closed or never connected                                 | `McpCancelledError` (`trigger: client_closed`)    | `MCP client for "<s>" was closed before answering <method>`                                                             | pre-send refusal                                                               |

A cancelled request is never negative-cached: the cache is for server failures.

## Rules

- Untrusted documents and frames are parsed once at the boundary, never cast;
  failures are typed (`McpNamingError`, `PluginError`, `JsoncParseError`,
  `McpError` and its subclasses) with spec-pinned identities.
- Merge and naming functions are pure; filesystem access is injectable so tests
  synthesise fixtures in a temporary directory. Timers, the clock, `fetch` and
  the transport itself are injectable, so no test sleeps on a real budget.
- Where the spec does not pin a behavior, the code says `TODO(spec): <clause>`
  instead of guessing.
