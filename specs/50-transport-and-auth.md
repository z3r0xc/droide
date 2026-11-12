# Transport and authentication

- **Target:** Factory AI `droid` 1.9.0
- **Status:** draft
- **Owner:** Transport / auth
- **Related:** `00-context.md`; `10-cli-surface.md` (dispatch of
  `droid deployment`, exit-code normalization); `40-sessions-and-storage.md`
  (local session store, not the HTTP session API); `80-exec-and-streaming.md`
  (exec record shapes; it defers the agent loop's retry orchestration to the
  agent-loop spec). Tool ids: none.

## Purpose

Everything `droid` sends over HTTP and everything it presents as proof of who
the caller is. This subsystem owns: which host a request goes to (Factory
control plane, Factory-managed Prem, or a customer's own Prem), the exact
headers a request carries, the closed inventory of backend routes, the retry
and deadline budget each boundary enforces, how credentials are stored,
refreshed, revoked and read back for a different process, and how a failed
request becomes a typed error with user-visible copy and an exit status. The
managed model transport (Anthropic Messages, OpenAI Responses/Chat Completions,
Gemini, Bedrock Converse, and the Responses WebSocket) is specified here because
its destination, credentials and failure classes are the same boundary.

## Scope

**Covers:** base-URL resolution and its inputs; header construction from a
credential snapshot; the backend route table and its hosted/Prem placement
rules; retry, backoff and timeout values at both the backend and LLM transport
boundaries; credential storage on disk (WorkOS v2 files, Prem records), lookup
order, refresh/rotation, expiry, logout; the WorkOS device-code login; customer
Prem discovery, device authorization, exchange, refresh and logout; deployment
selection; proxy and extra-CA handling; airgap vetoes; the HTTP-error taxonomy,
its user-visible messages and exit codes; and the LLM stream contract (request
shape, SSE framing, event ordering, tool-call deltas, usage accounting,
per-provider adapters).

**Does not cover, and where it is specified instead:**

- Command parsing, help text, and the fact that `deployment` is intercepted
  before commander dispatch — `10-cli-surface.md`.
- The agent loop's decision to retry a *turn* (model fallback, provider
  rotation, resumption), as opposed to the transport's per-attempt policy —
  agent-loop spec.
- Session transcript persistence and cloud-sync batching semantics —
  `40-sessions-and-storage.md`, cloud-sync spec. This spec inventories the
  routes and states their placement rules.
- MCP OAuth (`droid mcp auth`) and its credential store — MCP spec.
- Interactive-login UI, pickers and localization catalogues beyond the English
  fallbacks quoted here.
- Telemetry authentication and feature-flag evaluation — their own specs.

**Deferred:** platform-specific keyring backends (macOS Keychain vs Windows
Credential Manager vs libsecret) beyond the observable file/account names; and
the `openai`-platform header values, which come from the model catalogue spec.

## Terms

Citations are abbreviated: `orig/…` = `evidence/original/windows-x64/…`.

| Term | Meaning |
|---|---|
| **backend** | The Factory control plane reached at `apiBaseUrl`/`apiBaseUrlEu`, or at a customer Prem origin. |
| **hosted route** | A route served by the Factory control plane, e.g. `/api/sessions/v2`. |
| **managed Prem** | A Factory-hosted Prem placement advertised per organization as `premBaseHostV2`; it is *not* an authentication authority (`orig/packages/common/src/api/backend/schemas.ts:45-47`). |
| **customer Prem** | A self-hosted deployment selected by `auth-deployment.json`; it *is* the authentication authority (`orig/packages/runtime/auth/src/auth/prem/config.ts:101-107`). |
| **deployment selection** | The persisted choice `factory` or `customer-prem`+origin. Independent of whether credentials are saved. |
| **credential source** | One of `workos` (stored WorkOS session or brokered provider), `api-key` (`FACTORY_API_KEY`), `prem` (customer credential record). Spelled `TokenSourceType` in code. |
| **credential snapshot** | One consistent read of token + active organization (+ Prem identity) plus the user it names. |
| **base URL** | The origin (and any path prefix) a relative backend path is appended to. |
| **managed LLM route** | One of the `/api/llm/…` proxy paths; `headerPurpose: 'usage'`. |
| **turn attempt** | One HTTP/WebSocket request to a model provider under the retry policy; a *turn* may contain several attempts. |
| **stream event** | One decoded JSON payload from an SSE `data:` field or one Responses WebSocket frame. |
| **airgap** | `FACTORY_AIRGAP_ENABLED` (or the baked define) is true: no Factory-bound request may leave the process. |

## Observable behaviour

### A. Base-URL resolution

**B1** For a Factory API request the destination is, in order: the
customer-Prem origin when a `customer-prem` deployment is selected; else
`apiBaseUrlEu` when the resolved region is `eu` **and** that value is
configured; else `apiBaseUrl`
(`orig/packages/runtime/auth/src/auth/common/resolveCliApiBaseUrl.ts:13-21`).
`[observed]`

**B2** The deployment selection is resolved once per process, before services
load. A `customer-prem` selection sets the runtime `apiBaseUrl` to the origin
and leaves `apiBaseUrlEu` unset, so B1's EU branch cannot win. A `factory`
selection keeps the environment-resolved URLs
(`orig/src/environment.ts:300-317`). `[observed]`

**B3** For a `factory` selection, `apiBaseUrl` comes from
`FACTORY_API_BASE_URL` and `apiBaseUrlEu` from `FACTORY_API_BASE_URL_EU`; the
environment variable beats the baked build define. A test runtime substitutes
the test defaults only when neither is set
(`orig/src/environmentResolution.ts:90-127,189-197`). `[observed]`

**B4** The region used by B1 is `global` whenever a customer Prem is selected,
whenever no credential resolves, or when the cached identity has no region;
otherwise it is the region the identity reports (`FactoryRegion.global|eu`)
(`orig/packages/runtime/auth/src/auth/common/cache.ts:665-676`;
`orig/packages/common/src/shared/enums.ts:129-132`). `[observed]`

**B5** The Prem host used for a *managed* Prem organization is
`premBaseHostV2` from the identity answer, read synchronously from cache for
callers that cannot await; the blocking read pops the identity cache when it is
cold (`orig/packages/runtime/auth/src/auth/common/cache.ts:617-620,691-703`).
`[observed]`

**B6** The legacy `premBaseHost` field is never used for routing; only
`premBaseHostV2` is read (`orig/packages/runtime/auth/src/auth/common/cache.ts:617-620`;
`orig/packages/common/src/api/backend/schemas.ts:45-47`). `[observed]`

**B7** A configured base URL must be non-empty, must start with `http://` or
`https://`, and must not end with `/`. Violating any of these throws a
`MetaError` when the global API config is installed, before any request
(`orig/packages/utils/src/api/config.ts:7-40`). `[observed]`

**B8** Relative paths are joined to the base URL resolved for that request
(`getBaseUrl`), not to a value captured at construction, so a region
resolution or organization switch that lands between requests changes the
destination (`orig/packages/utils/src/api/fetch.ts:200-218`;
`orig/src/api/config.ts:302-334`). `[observed]`

**B9** A customer deployment binds every request to one origin and one allowed
path: the request policy, when present, refuses a different origin, any
userinfo, a fragment, or a path the policy does not allow, before credentials
are resolved or bytes are sent (`orig/packages/utils/src/api/fetch.ts:11-29`;
`orig/src/api/config.ts:326-334`). `[observed]`