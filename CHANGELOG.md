# Changelog

The CLI's `--version` reports `PRODUCT_VERSION` from `src/cli/brand.ts`, which a
unit test keeps equal to the package version; a release bumps both. The recorded
CLI cases check the version line by shape, not by number. See `docs/release.md`.

## 0.7.1 — 2026-11-13

### Added

- **A startup animation of the block-letter logo.** Before the shell paints, the
  logo is revealed left to right in twelve-column steps, held, swept by a
  diagonal shimmer, then faded through `█ → ▓ → ▒ → ░` — 31 frames, about 1.4 s,
  centred in the terminal both ways. Frames are computed from the logo rows, so
  there is no asset to drift from the product name. Spec 95 B22.
- **`general.logoAnimation`** — `once` (default), `always` or `off`. `once`
  records `<stateDir>/logo-animation-shown`; `always` ignores it; `off` never
  plays. `DROIDE_NO_ANIMATION=1`, `CI`, a pipe and a terminal narrower than the
  mini logo all keep the launch still.

## 0.7.0 — 2026-11-13

### Added

- **`Read` spills what it cannot show.** An over-budget result is written to
  `<stateDir>/tool-outputs/<sha256 prefix>.txt` (directory `0700`, file `0600`,
  temp-then-rename, 32 MiB cap) and the cut notice names that path; an
  unwritable directory falls back to the offset/limit notice. A second identical
  read reuses the file. Spec 30 B12.
- **`Edit` matches against a scrubbed view.** Private-key blocks, bearer
  credentials, provider-shaped keys, JWTs, assigned secrets and the session's
  own key are replaced by `[redacted]` for matching only, with original offsets
  kept, so a credential can neither be matched nor echoed; the file on disk is
  written from the original bytes. Spec 30 B22.
- **Background commands are supervised.** The child leads its own process group
  and one exit hook kills it when the CLI dies (unless
  `DROIDE_PRESERVE_BACKGROUND_PROCESSES`), and on Windows the inner PID and
  creation time are reported instead of the PowerShell wrapper's. Spec 30 B31.
- **ACP turns carry images**, a denied permission is the documented `end_turn`
  rather than an internal error, and the confirm seam receives the tool-use id.
  Spec 60 B65/B66/B69.
- **MCP era negotiation**: `server/discover`, a 2025 fallback on `-32022`/
  `-32601`/HTTP 400–405, a 24-hour verdict cache, a bounded cursor chain and the
  three structured-output markers rewritten to the remediation sentence. Spec 60
  B11/B13/B23.
- **Plugins in the other layout install cleanly**: `.claude-plugin` →
  `.droide-plugin`, `agents/` → `droids/`, `.mcp.json` → `mcp.json` wrapped in
  `{ "mcpServers": … }` byte-for-byte, refused if the wrapper would exceed the
  source size. Spec 60 B42.
- **Compaction keeps what it replaced**: the summary row names the files the
  replaced messages touched (≤40) and the last todo list (≤20), plus a fixed
  authorship note. Spec 20 B49.
- **The Anthropic rate-limit pair is a delay source** when `retry-after` is
  absent. Spec 50 B41.

### Changed

- Spec 50 quotes the stream id spellings, the exact usage fields, the handled
  event order, the absent character-based thinking estimate and the base-URL
  credential/query refusals. Spec 70 quotes the four `daemon.*` budget methods;
  spec 80 the `defaultAllowed` derivation.

Gap markers across the three waves: 54 → 18.

## 0.6.0 — 2026-11-13

### Added

- **`droide resume` adopts the stored transcript.** The shell opens with the
  session's turns rendered and the next prompt carries that history; a missing
  or corrupt transcript is a named error instead of an empty shell. On a TTY a
  bare `resume` opens a picker (id, first prompt, updated time); a pipe still
  gets the bounded list. Spec 10 B22.
- **Settings are written safely.** A textual, atomic writer edits
  `settings.json`/JSONC in place — comments and formatting survive, a document
  that does not parse or a duplicate key is refused — and a plugin install now
  records `general.enabledPlugins`, rolling the settings back if the copy fails.
  `strictEnabledPlugins` is enforced: the highest level that names a plugin
  decides. ADR 0013, spec 60 B36/B37/B38.
- **The interactive shell queues what you type during a turn**: FIFO, bounded,
  shown with its position, drained one entry per completed turn, cleared by Esc
  together with the running turn. Spec 95 B10.
- **The daemon's `/port-proxy/<port>` surface** is real: token in the query, an
  HttpOnly SameSite=Strict cookie for subsequent requests, WebSocket upgrades,
  loopback only, and distinct refusals for a missing token (401), an
  unregistered port (403), a traversal attempt (400), an oversized body (413)
  and a bad method (405). Spec 70 B33.
- **An `sse` MCP server's inbound stream is opened**: `tools/list_changed`
  and `resources/updated` arrive, `Last-Event-ID` resumes after a drop under an
  injectable backoff policy, a cross-origin redirect is refused, and the cached
  tool list is re-read once per notification. Spec 60 B3.

### Changed — the specification caught up with the code

- `TlsTrustError`'s full sentence and the seventeen provider messages are quoted
  in spec 50 (B88, B102) instead of described.
- Spec 30 B20 lists the `type` table `Grep` ships; B46 quotes the five
  permission-guidance sentences.
- Spec 50 B3 states the override precedence (`override > environment > baked`).
- One marker was withdrawn rather than closed: spec 30 B7 says MCP servers own
  their argument grammar, so forwarding the arguments unvalidated is the
  specified behaviour, not a gap.

## 0.5.0 — 2026-11-13

### Added

- **A brand guard** (`npm run brand:check`, `tools/brand-check.mjs`, wired into
  CI): a tracked file may not name another product, its release number or its
  vendor host. ADR 0011 is the one allowlisted file, because it has to explain
  what the previous layout was called.
- **Our own request headers** (`X-Droide-Org-Id`, `X-Droide-Client`,
  `X-Droide-Sdk`, `X-Droide-Request-Surface`, `X-Droide-Exec-Output-Format`,
  `X-Droide-Exec-Input-Format`, `X-Droide-Whoami-Extended`,
  `X-Droide-Session-Attribution`) and the `managed` deployment discriminant.

### Changed

- **No invented endpoint.** The build bakes no API base URL, so
  `DROIDE_API_BASE_URL` is the only source. With it unset, `doctor`'s
  `connectivity` check reports `skip` (`no API endpoint configured`) instead of
  resolving a host of ours, and `droide exec` exits 1 with
  `no API endpoint configured: set DROIDE_API_BASE_URL (or choose a custom model
in settings)`.
- `exec --list-tools` answers before a model target, session, socket or API key
  is resolved, so it needs no credential.
- The settings key for the agent model is `model`.
- CLI snapshots are tracked under `tests/parity/expected/`, so the parity CI job
  gates every change; `--record` stays a reviewed act.
- Specs cite the reference corpus under neutral names (`protocol/agent/`,
  `agent-registry.ts`, `packages/core/`) and every deployment sentence says
  `managed`.

## 0.4.0 — 2026-11-13

### Added

- **`mcp auth` end to end**: protected-resource and authorization-server discovery,
  RFC 7591 dynamic registration (or a configured client id), PKCE S256, the
  loopback callback with state validation, the code exchange, and a credential
  written to the OS-sealed store with its issuer, client metadata and a
  compare-and-set revision (ADR 0008). A server that needs no authentication is
  reported and the command exits 0.
- **Native helper behind the tool runtime**: a `native-backend` seam
  (`search.walk`, `search.text`, `path.resolve`) beside the existing TypeScript
  implementations, selected conservatively and degrading to `local` with a
  diagnostic when the helper fails — proven by backend-parity tests.
- **`update` installation** (ADR 0009): the release's assets are resolved, the
  archive is streamed to a staging directory while being hashed and compared with
  `timingSafeEqual`, the swap is two renames in one directory, a single probe
  runs the new binary, and a failed probe restores `.old-<version>`. An `O_EXCL`
  lock prevents concurrent installs; a non-writable directory is refused with the
  exact path and no elevation.
- `doctor --checks updates` compares the running version with the release feed.
- A command-tree smoke net: every command group must answer `--help`, unknown
  words are refused as prompts, and a declared-but-unbuilt mode fails loudly.
- CI is live (the repository is public): six jobs — typescript,
  typescript-windows, rust, rust-windows, supply-chain, parity.

### Changed

- **The product is Droide** (ADR 0010): `--version` reports `0.4.0`, the help
  tagline and the docs link are ours, and the CLI harness records our own
  snapshots instead of comparing against another build.
- **Our own state directory and environment variables** (ADR 0011): `~/.droide`,
  `<cwd>/.droide`, `.droide-plugin/`, `DROIDE_API_KEY`,
  `DROIDE_HOME_OVERRIDE`, `DROIDE_RUNTIME_SETTINGS_PATH`, `DROIDE_ENV`. Nothing
  is migrated from the previous layout: 0.4.0 is the first release under these
  names, and no earlier installation is in use.
- The specifications keep neutral provenance language: behaviour is cited from an
  untracked evidence corpus (ADR 0003), and no document names another product,
  its version or its vendor.

### Fixed

- The config-context fixture used a hard-coded platform, so it passed on Windows
  and failed on the Linux CI runner.
- `docs/gaps.md` is regenerated only together with the sources it describes.

## 0.3.0 — 2026-11-13

### Added

- **Agent turns in the interactive shell**: submitted lines run a turn, assistant
  text is coalesced per frame, tool rows go `pending → success/error`, thinking is
  collapsed, R11 approvals offer the three documented choices (single call,
  session, deny), Esc cancels, quit disposes the driver — no provider request,
  `AbortController` or timer survives.
- **Plugin marketplaces and installation**: `known_marketplaces.json`, git-backed
  `marketplace add|remove|list|update` with the manifest validated before
  adoption, `plugin install|uninstall|update` into either scope through an
  injected git runner, atomic registry merges, collision and reference refusals.
- **Session transcript index**: migration 10 (`transcript_index`,
  `transcript_index_value`, three indexes, three triggers), pragmas and shape
  validation, corrupt-file quarantine, a pure refresh planner (insert/update/
  skip/delete by mtime+size), and search served from the index with a _proving_
  fallback to the literal scan (`--reindex` refreshes).
- **PTY in the native helper**: ConPTY on Windows and `openpty` on Unix behind one
  session registry (`pty.spawn|read|write|resize|kill|close`), typed TypeScript
  wrappers, and a contract test that spawns a real process through the compiled
  binary.
- **MCP OAuth building blocks**: PKCE (RFC 7636 vector), the loopback callback
  with state validation and a 4-minute window, token exchange and refresh with
  typed errors, and a sealed credential store with revisions and tombstones
  (ADR 0008). The `mcp auth` command itself is not wired yet.
- `doctor --checks mcp` connects to enabled servers and reports tool counts;
  `computer list` reports registration scope; `exec` honours
  `--append-system-prompt[-file]` and `--disable-builtin-skills`.

### Fixed

- `exec` no longer ignores `--disable-builtin-skills` silently.
- Sandbox path validation accepts paths absolute on the _target_ platform.

## 0.2.0 — 2026-11-12

### Added

- `resume`: session listing, id and session-link parsing, continuation through the
  `exec -s` path, `--fork`, and typed refusals for unknown/archived/misused ids.
- `mcp add` / `mcp remove`: surgical JSONC edits (comments, key order and
  indentation preserved), atomic writes, alias-aware duplicate refusal.
- `mcp permissions list|revoke|clear`: nested `persistentPermissions`, legacy key
  migration on read, server revoke cascading to tools.
- Context compaction: token estimate with a documented basis, strict threshold
  plus hard ceiling, tool-pair preservation, `user_only` exclusion, a summariser
  port, and a `compaction` turn event — wired into the loop and into `exec`.
- Typed, validating wrappers for all nine native helper methods, plus
  `npm run test:native` (builds the crate, runs the contract against the binary).
- `doctor` probes: proxy validation, `NODE_EXTRA_CA_CERTS` readability,
  credential presence reported by length only.
- README in Russian and Simplified Chinese with a language switcher; ADR 0007
  (update channel); SECURITY.md, CONTRIBUTING.md, release process, PR/issue
  templates.

### Fixed

- Sandbox path validation now accepts a path that is absolute on the **target**
  platform (`C:\…`, `\\server\…`) instead of requiring POSIX form.
- The permission-denial guidance text matches the specification verbatim.
- The process-tree test no longer fails on Windows cleanup (`rmSync` retries).

## 0.1.0 — 2026-11-12

### Added

- CLI surface with recorded parity goldens (20/20): root options, every visible
  and hidden command, help rendering, non-TTY refusal.
- `exec` with `text`, `json` and `stream-json` output, session continuation and
  streaming input.
- `search|find` over the session store; `doctor` with text and `--json` reports;
  `update --check` against this repository's releases.
- SQLite session store with migrations, transcript records and search.
- Daemon: WebSocket transport, JSON-RPC protocol, authenticate gate, single
  instance, ordered shutdown.
- Interactive Ink shell with tokens from the spec, key handling and teardown.
- Rust helper: protocol, safe paths, file search, sandbox profiles, PTY quoting,
  DPAPI secrets — 57 tests.
