# Transport and authentication

- **Target:** the `droide` CLI shipped from this repository
- **Status:** draft
- **Owner:** Transport / auth
- **Related:** `00-context.md`; `10-cli-surface.md` (dispatch of
  `droide deployment`, exit-code normalization); `40-sessions-and-storage.md`
  (local session store, not the HTTP session API); `80-exec-and-streaming.md`
  (exec record shapes; it defers the agent loop's retry orchestration to the
  agent-loop spec). Tool ids: none.

## Purpose

Everything `droide` sends over HTTP and everything it presents as proof of who
the caller is. This subsystem owns: which host a request goes to (the hosted
control plane, managed Prem, or a customer's own Prem), the exact headers a
request carries, the closed inventory of backend routes, the retry
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
- The agent loop's decision to retry a _turn_ (model fallback, provider
  rotation, resumption), as opposed to the transport's per-attempt policy —
  agent-loop spec.
- Session transcript persistence and cloud-sync batching semantics —
  `40-sessions-and-storage.md`, cloud-sync spec. This spec inventories the
  routes and states their placement rules.
- MCP OAuth (`droide mcp auth`) and its credential store — MCP spec.
- Interactive-login UI, pickers and localization catalogues beyond the English
  fallbacks quoted here.
- Telemetry authentication and feature-flag evaluation — their own specs.

**Deferred:** platform-specific keyring backends (macOS Keychain vs Windows
Credential Manager vs libsecret) beyond the observable file/account names; and
the `openai`-platform header values, which come from the model catalogue spec.

## Terms

Citations are abbreviated: `orig/…` = `evidence/original/windows-x64/…`.

| Term                     | Meaning                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **backend**              | The hosted control plane reached at `apiBaseUrl`/`apiBaseUrlEu`, or at a customer Prem origin.                                                                              |
| **hosted route**         | A route served by the hosted control plane, e.g. `/api/sessions/v2`.                                                                                                        |
| **managed Prem**         | A hosted Prem placement advertised per organization as `premBaseHostV2`; it is _not_ an authentication authority (`orig/packages/common/src/api/backend/schemas.ts:45-47`). |
| **customer Prem**        | A self-hosted deployment selected by `auth-deployment.json`; it _is_ the authentication authority (`orig/packages/runtime/auth/src/auth/prem/config.ts:101-107`).           |
| **deployment selection** | The persisted choice `managed` or `customer-prem`+origin. Independent of whether credentials are saved.                                                                     |
| **credential source**    | One of `workos` (stored WorkOS session or brokered provider), `api-key` (`DROIDE_API_KEY`), `prem` (customer credential record). Spelled `TokenSourceType` in code.         |
| **credential snapshot**  | One consistent read of token + active organization (+ Prem identity) plus the user it names.                                                                                |
| **base URL**             | The origin (and any path prefix) a relative backend path is appended to.                                                                                                    |
| **managed LLM route**    | One of the `/api/llm/…` proxy paths; `headerPurpose: 'usage'`.                                                                                                              |
| **turn attempt**         | One HTTP/WebSocket request to a model provider under the retry policy; a _turn_ may contain several attempts.                                                               |
| **stream event**         | One decoded JSON payload from an SSE `data:` field or one Responses WebSocket frame.                                                                                        |
| **airgap**               | `DROIDE_AIRGAP_ENABLED` (or the baked define) is true: no backend-bound request may leave the process.                                                                      |

## Observable behaviour

### A. Base-URL resolution

**B1** For a backend API request the destination is, in order: the
customer-Prem origin when a `customer-prem` deployment is selected; else
`apiBaseUrlEu` when the resolved region is `eu` **and** that value is
configured; else `apiBaseUrl`
(`orig/packages/runtime/auth/src/auth/common/resolveCliApiBaseUrl.ts:13-21`).
`[observed]`

**B2** The deployment selection is resolved once per process, before services
load. A `customer-prem` selection sets the runtime `apiBaseUrl` to the origin
and leaves `apiBaseUrlEu` unset, so B1's EU branch cannot win. A `managed`
selection keeps the environment-resolved URLs
(`orig/src/environment.ts:300-317`). `[observed]`

**B3** For a `managed` selection, `apiBaseUrl` comes from
`DROIDE_API_BASE_URL` and `apiBaseUrlEu` from `DROIDE_API_BASE_URL_EU`. This
build bakes **no** endpoint: the baked define is empty, so the environment is
the only source. With neither variable set, `droide exec` exits 1 with `no API
endpoint configured: set DROIDE_API_BASE_URL (or choose a custom model in
settings)`, and `doctor`'s `connectivity` check reports `skip` with `no API
endpoint configured` rather than probing a host of ours
(`orig/src/environmentResolution.ts:90-127,189-197`; `src/transport/urls.ts`,
`src/exec/command.ts`). `[observed]`

Precedence is: an explicit per-process override supplied by a caller, then the
environment, then the baked define. The override exists so a test or an
embedding can pin a loopback endpoint without touching the environment, and it
can never introduce a URL the validator would reject: every source passes the
same parse and the same credential/query refusal (`src/transport/urls.ts`,
`createApiUrlConfig`). `[observed]`

**B4** The region used by B1 is `global` whenever a customer Prem is selected,
whenever no credential resolves, or when the cached identity has no region;
otherwise it is the region the identity reports (`Region.global|eu`; vendor
prefix elided) (`orig/packages/runtime/auth/src/auth/common/cache.ts:665-676`;
`orig/packages/common/src/shared/enums.ts:129-132`). `[observed]`

**B5** The Prem host used for a _managed_ Prem organization is
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

### B. Request construction and headers

**B10** Headers built from a credential are, in order: `Authorization: Bearer
<token>` when a token exists, the client headers (B11), and
`X-Droide-Org-Id: <organization>` when an organization is known
(`orig/src/api/config.ts:233-242`). `[observed]`

**B11** Client headers are the caller-attribution projection plus the installed
version: `X-Droide-Client` (always present on an operational request, defaulting
to `cli`), `X-Droide-Sdk` (SDK callers only), `X-Droide-Request-Surface`,
`X-Droide-Exec-Output-Format`, `X-Droide-Exec-Input-Format`, and
`X-Client-Version` (sent only when `CLI_VERSION` is set)
(`orig/src/api/config.ts:149-186,209-228`;
`orig/packages/sdk-core/src/protocol/schemas/constants.ts:7-19`).
`[observed]`

**B12** `headerPurpose: 'usage'` omits the operational `X-Droide-Client`
default and sends only a _known_ caller's attribution. On a usage route the
final transport strips attribution headers supplied by the caller, so a retained
SDK tuple cannot be relabelled onto proxy traffic
(`orig/src/api/config.ts:191-228`;
`orig/src/api/BackendClient.ts:807-886`). `[observed]`

**B13** The identity request always carries `X-Droide-Whoami-Extended: true`
and an optional `X-Droide-Session-Attribution` claim; the credential itself is
presented as `Authorization: Bearer` plus `X-Droide-Org-Id` only when an active
organization is set (`orig/packages/runtime/auth/src/auth/common/whoami.ts:19-56`;
`orig/packages/sdk-core/src/protocol/schemas/constants.ts:21-36`).
`[observed]`

**B14** For any credential other than an API key the request organization is
the stored active organization. For an API key it is the organization the key's
account reports, and an unreadable account is an error rather than a fallback to
the stored selection (`orig/src/api/BackendClient.ts:60-78`). `[observed]`

**B15** A request whose credentials must match a scope also carries the user:
the identity is re-read immediately before send and a change of organization or
account refuses the request before any bytes leave
(`orig/src/api/BackendClient.ts:60-99,864-886`). `[observed]`

**B16** The egress organization — the organization whose content may leave the
device — is the stored active organization, or the key's organization when the
key stores no choice; it is `null` when a key belongs to a different
organization than the stored selection
(`orig/packages/runtime/auth/src/auth/get.ts:256-282`). `[observed]`

**B17** Managed model requests to the inference proxy carry, besides auth and
client headers: `x-session-id`, `x-assistant-message-id`, `x-api-provider`,
optional `x-message-call-type`, the source tool-call id when present, a provider
routing source header, `User-Agent`, `X-Client-Version` (the package version),
and an OpenAI-platform header when the provider is an OpenAI-platform one
(`orig/src/llm-proxy/utils.ts:235-296`). `[observed]`

**B18** Backend API requests receive a `traceparent` header injected from the
active OpenTelemetry context (`orig/packages/utils/src/api/fetch.ts:255-275`).
`[observed]`

**B19** On the plain backend path the header merge order is: base headers
minus any name the later groups mention (case-insensitively), then config
headers, then trace headers, then the caller's `init.headers` — so a caller can
override config headers. On a customer-policy request the config's expected
headers are written last, so the caller cannot override credentials
(`orig/packages/utils/src/api/fetch.ts:32-96,255-296`). `[observed]`

**B20** The daemon client sends `Content-Type: application/json`, the resolved
auth headers, and then the caller's headers, which win on collision
(`orig/packages/daemon-core/src/services/ApiClient.ts:430-480`). `[observed]`

**B21** On a customer deployment the daemon sends only allowlisted application
paths (`/api/v0/automations` and one definition), with `redirect: 'error'` and
`credentials: 'omit'`; an unlisted hosted path is refused before the fetch with
a precondition error (`orig/packages/daemon-core/src/services/ApiClient.ts:129-145,229-260,470-480`;
`orig/packages/utils/src/api/constants.ts:6-9`). `[observed]`

**B22** Customer-Prem authentication requests carry `Authorization: Bearer
<accessToken>` and `X-Droide-Org-Id: <activeOrganizationId>` when an
organization is selected, plus `Content-Type: application/json` when a body is
present (`orig/packages/runtime/auth/src/auth/prem/client.ts:107-140`).
`[observed]`

### C. Route inventory

**B23** Backend routes are a closed enum of stable operation ids; each route
definition carries a method, a hosted path builder, a Prem path builder or
`null`, an optional Prem method override, an optional SDK suffix, an optional
managed transport (`http`/`websocket`), an optional header purpose, and one of
`customerPremOnly` / `managedPremOnly`
(`orig/src/api/BackendClient.ts:191-593`;
`orig/packages/common/src/api/backend/enums.ts:9-83`). `[observed]`

**B24** The session and message routes are:

| Route id                        | Method                     | Hosted path                                                                                   | Prem path                                     |
| ------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `create-session`                | POST                       | `/api/sessions/create`                                                                        | `/api/apps/cloud-sync/sessions`               |
| `list-sessions`                 | GET                        | `/api/sessions/v2`                                                                            | `/api/apps/cloud-sync/sessions`               |
| `list-archived-sessions`        | GET                        | `/api/sessions/archived`                                                                      | `/api/apps/cloud-sync/sessions/archived`      |
| `get-session`                   | GET                        | `/api/sessions/{id}`                                                                          | `/api/apps/cloud-sync/sessions/{id}`          |
| `archive-session`               | POST                       | `/api/sessions/{id}/archive`                                                                  | same path under Prem prefix                   |
| `unarchive-session`             | POST                       | `/api/sessions/{id}/unarchive`                                                                | same path under Prem prefix                   |
| `list-session-messages`         | GET                        | `/api/v0/sessions/{id}/messages`                                                              | none                                          |
| `update-agent-status`           | POST                       | `/api/sessions/{id}/agent-status`                                                             | Prem prefix                                   |
| `update-title`                  | POST                       | `/api/sessions/{id}/update-title`                                                             | Prem prefix                                   |
| `update-settings`               | POST                       | `/api/sessions/{id}/update-settings`                                                          | Prem prefix                                   |
| `update-mission-metadata`       | POST                       | `/api/sessions/{id}/mission/metadata`                                                         | Prem prefix                                   |
| `update-artifacts`              | POST                       | `/api/sessions/{id}/artifacts`                                                                | Prem prefix                                   |
| `update-pull-request-links`     | POST                       | `/api/sessions/{id}/pull-request-links`                                                       | Prem prefix                                   |
| `update-privacy`                | POST                       | `/api/sessions/{id}/privacy`                                                                  | none (hosted until Prem supports sharing)     |
| `create-message`                | POST                       | `/api/sessions/{id}/message/create`                                                           | `/api/apps/cloud-sync/sessions/{id}/messages` |
| `search-sessions`               | GET (hosted) / POST (Prem) | `/api/sessions/search`                                                                        | `/api/apps/cloud-sync/sessions/search`        |
| `cloud-sync-batch`              | POST                       | the `SESSION_BATCH_PATH` constant (value absent from the recovered tree; see Open question 1) | `/api/apps/cloud-sync/sessions/batch`         |
| `get-pinned-sessions`           | GET                        | `/api/sessions/pinned`                                                                        | Prem prefix `/pinned`                         |
| `pin-session` / `unpin-session` | POST / DELETE              | `/api/sessions/{id}/pin`                                                                      | Prem prefix `/pin`                            |

(`orig/src/api/BackendClient.ts:274-394`;
`orig/packages/common/src/api/prem/constants/index.ts:34-38`; the batch constant
in `common/api/sessions` is not present in the recovered tree, so its
literal is `[inferred]` to remain the hosted `/api/sessions` prefix.)
`[observed except where noted]`

**B25** The managed model routes are: `POST /api/llm/a/v1/messages`
(Anthropic Messages, SDK suffix `/v1/messages`), `POST
/api/llm/o/v1/responses` (SDK suffix `/responses`), `GET
/api/llm/o/v1/responses/ws` (WebSocket), `POST
/api/llm/o/v1/chat/completions` (SDK suffix `/chat/completions`), `POST
/api/llm/o/v1/images/generations`, `POST /api/llm/o/v1/images/edits`, `POST
/api/llm/g/v1/generate`, `POST|GET /api/llm/custom/usage`, and `POST
/api/llm/o/v1/embeddings`, which is hosted-only
(`orig/packages/common/src/api/llm-proxy/enums.ts:10-44`;
`orig/src/api/BackendClient.ts:192-233`). `[observed]`

**B26** Automations live at `/api/v0/automations` (list/create), `/…/{id}`
(get/patch/delete), `/…/{id}/run`, `/…/{id}/webhook/rotate`,
`/…/{id}/webhook/deliveries`, `/…/{id}/runs/{runId}`,
`/…/{id}/memory`, `/…/{id}/memory/file`, `/…/{id}/memory/edit`, plus the shared
list `/api/automations`. Only list/create/get/update/delete are marked
`customerPremOnly`; the rest are hosted-only
(`orig/src/api/BackendClient.ts:180-190,443-521`). `[observed]`

**B27** Computer routes live at `/api/v0/computers` (list/create), `/{id}`
(get/patch/delete), `/name/{name}`, `/providers`, `/{id}/restart`,
`/{id}/refresh`, `/{id}/activity`. Get/update/delete/restart/refresh/activity
are `customerPremOnly`; list/create/providers/by-name are hosted-only
(`orig/src/api/BackendClient.ts:522-590`). `[observed]`

**B28** Remaining route groups: `GET /api/integrations/{provider}/credential`,
`GET /api/integrations/model-providers`, `GET /api/v0/environments` and
`/{id}`, `GET /api/service-accounts/{id}/computers`, `POST
/api/remote-delegations/events`, `POST /api/organization/onboarding/events`,
`POST` the PR-autofix subscriptions endpoint, `POST /api/daemon/heartbeat`,
`POST /api/sessions/{id}/local-signals` + `GET` the same (managed-Prem only),
`POST` skill suggestions, and `POST` the inbox path, which has no hosted handler
and throws before sending (`orig/src/api/BackendClient.ts:233-273,395-442,587-590`).
`[observed]`

**B29** An SDK base URL is the resolved route URL with the route's `sdkSuffix`
removed, e.g. `/api/llm/a` for Anthropic Messages and `/api/llm/o/v1` for both
Responses and Chat Completions (`orig/src/api/BackendClient.ts:799-806`).
`[observed]`

**B30** Route placement: a customer deployment serves a route by its Prem path
(and its Prem method, if overridden) when the route has one, and otherwise
throws `This operation is unavailable on customer deployments.` before sending.
A managed Prem serves the Prem path unless the route is `managedPremOnly`; every
other request goes to hosted. Managed inference never goes to a customer
deployment (`orig/src/api/BackendClient.ts:610-650,658-660,724-795`).
`[observed]`

**B31** A route with no Prem path is sent hosted without waiting for Prem
discovery, even when the organization turns out to be Prem-backed; a route with
one uses the cached Prem host, falls back to hosted once the identity cache is
settled and names no host, and otherwise resolves the host first
(`orig/src/api/BackendClient.ts:888-916`). `[observed]`

**B32** `GET /api/cli/whoami` is the one identity endpoint used by every
credential-verification path; its response carries `userId`, `orgId`, optional
`region`, `inferenceRegion`, `isEnterprise`, `isOnPrem`, `premBaseHost`,
`premBaseHostV2`, `principalKind`, and `attribution`, and is parsed leniently so
a newer backend field cannot break an older client
(`orig/packages/common/src/api/cli/schemas.ts:34-100`). `[observed]`

### D. Retry, backoff and deadlines

**B33** The ordinary backend boundary performs exactly one `fetch` and has no
retry or built-in timeout of its own; a caller-supplied `AbortSignal` is the
only deadline, and the first non-2xx status becomes an error
(`orig/packages/utils/src/api/fetch.ts:298-320`;
`orig/src/api/BackendClient.ts:807-886`). `[derived]`

**B34** The identity request has a 10 s deadline covering the whole exchange,
including the body, and applies it alongside any caller signal
(`orig/packages/runtime/auth/src/auth/common/constants.ts:24-29`;
`orig/packages/runtime/auth/src/auth/common/whoami.ts:40-56`). `[observed]`

**B35** One WorkOS refresh-token redemption has a 15 s deadline covering the
response body (`orig/packages/runtime/auth/src/auth/common/constants.ts:31-35`;
`orig/packages/runtime/auth/src/auth/workos/refresh.ts:39-62`). `[observed]`

**B36** Every customer-Prem authentication request has a 15 s deadline and
refuses redirects (`orig/packages/runtime/auth/src/auth/prem/constants.ts:1-2`;
`orig/packages/runtime/auth/src/auth/prem/client.ts:45-62`). `[observed]`

**B37** A failed WorkOS refresh is _permanent_ for a 4xx status other than 429,
and _transient_ for 5xx, transport failure, the deadline, or a 2xx whose body
does not carry tokens (`orig/packages/runtime/auth/src/auth/workos/refresh.ts:18-36,64-89`;
`orig/packages/utils/src/api/httpStatus.ts:10-12`). `[observed]`

**B38** A transient refresh failure is retried at most three times with a
linear backoff of `500 ms × attempt`; a permanent failure is returned
immediately (`orig/packages/runtime/auth/src/auth/source.ts:101-102,333-373`).
`[observed]`

**B39** WorkOS redemptions are serialized: one at a time, each reading the login
the previous one left behind. A stored login that keeps being replaced gives up
after three redemptions and reports the store unavailable; a refresh token that
failed permanently is remembered so the same token short-circuits to
signed-out (`orig/packages/runtime/auth/src/auth/source.ts:83-95,101-160,466-530`).
`[observed]`

**B40** Model-call retry defaults depend on strategy: `NoRetry` 1 attempt,
`NonInteractive` 5, `Interactive` 4; base delay 2000 ms non-interactive and
1000 ms otherwise; backoff factor 2.5 and 2 respectively, with jitter
(`orig/packages/core/src/llms/client/retryPolicy/index.ts:14-15,61-72,105-120`).
`[observed]`

**B41** A throttling failure waits at least 5 s and at most 30 s, plus up to 20 %
jitter; a server-provided delay is respected as a minimum. `retry-after-ms` is
read in milliseconds, `retry-after` in seconds or as an HTTP date, and an
Anthropic `-remaining`/`-reset` pair is used when remaining is zero. Interactive
turns allow 6 throttling attempts (`orig/packages/core/src/llms/client/retryPolicy/index.ts:16-17,30,74-102,120-140,179-203`).
`[observed]`

**B42** A provider-capacity failure (408, 502, 503, 529 unconditionally; 500
when the message reads as a server error or overload, plus the overloaded and
internal error classes) waits about
500 ms when another provider can be rotated to, and otherwise backs off like a
throttle (5 s…30 s); with no rotation target a single provider gets 10 attempts.
Timeout failures use a 3 s base growing 1.5× per attempt, capped at 15 s
(`orig/packages/core/src/llms/client/retryPolicy/index.ts:20-34,148-170`).
`[observed]`

**B43** A managed Anthropic stream that produces no event for 4 minutes is
failed as idle; while the model is thinking the budget is 10 minutes. Custom
models use the configured request timeout instead
(`orig/packages/core/src/llms/client/sendMessage.ts:484-491,3076-3081`).
`[observed]`

**B44** A managed stream's server-side deadline is advertised as
`x-droide-stream-deadline-ms`; when absent, clients assume 600 000 ms
(`orig/packages/common/src/api/llm-proxy/constants.ts:59-70`). `[observed]`

### E. Credential storage and lookup

**B45** Credential files live in the credential base directory:
`$DROIDE_HOME/<.droide|.droide-dev>`, where `DROIDE_HOME_OVERRIDE` replaces
the home directory and the directory name is the production-tier name
(`orig/packages/runtime/auth/src/credentials/presence.ts:16-19`;
`orig/packages/runtime/cli/src/home/index.ts:20-23`;
`orig/packages/utils/src/environment/dir-name/index.ts:12-14`).
`[observed]`

**B46** The WorkOS v2 store uses these literal names: `auth.v2.keyring` (keyring
ciphertext), `auth.v2.loginkeychain` (macOS security-CLI ciphertext),
`auth.v2.file` (keyfile ciphertext), `auth.v2.key` (keyfile key) and
`auth.v2.write.lock`. Credential files are written with mode `0600`
(`orig/packages/runtime/auth/src/credentials/constants.ts:1-3`;
`orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:50-64,150-186`).
`[observed]`

**B47** Load order: the in-memory recall for the same file identity; then the
secure file, when secure storage is enabled; then the keyfile. With
`DROIDE_DISABLE_KEYRING` (any `true`/`1`) the secure file is never read and the
OS key store is never touched (`orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:320-322,512-541`).
`[observed]`

**B48** The secure backend is the macOS security CLI when that path is selected
for the platform, otherwise the OS keyring; the keyring account is scoped with a
`-dev` suffix outside production builds (`orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:158-186,66-74`).
`[observed]`

**B49** Writes are atomic and read back; a refresh writes only to the backend it
started from and only while the same backend remains selected, otherwise the
write is rejected. `updateCredentials` reports `applied`, `rejected` or
`unavailable`, and never recreates missing credentials
(`orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:676-704,717-830`).
`[observed]`

**B50** A new login uses secure storage when enabled. If the OS key store is
unusable, the login is written to the keyfile instead, but only when no secure
ciphertext exists that the new record would shadow; the reason is retained for
`droide doctor` and the login-saved-to-disk message
(`orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:653-672,717-780`).
`[observed]`

**B51** Logout deletes only the ciphertext of the backend currently in use and
never deletes key material, so a re-login reuses the key
(`orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:816-838`;
`orig/packages/runtime/auth/src/auth/logout.ts:12-38`). `[observed]`

**B52** Credential lookup order is fixed: airgap synthetic credential; then
`DROIDE_API_KEY`; then, when a customer deployment is selected, the Prem
credential record; then an installed external WorkOS provider; then the stored
WorkOS session (`orig/packages/runtime/auth/src/auth/source.ts:234-290`).
`[observed]`

**B53** A configured `DROIDE_API_KEY` always wins over a stored WorkOS session,
even an expired one, and names no organization of its own
(`orig/packages/runtime/auth/src/auth/source.ts:241-248,300-320`). `[observed]`

**B54** The stored WorkOS record is `access_token`, `refresh_token`, optional
`active_organization_id`, optional `whoami` identity; a legacy top-level
`region` is accepted and folded into `whoami` (`orig/packages/runtime/auth/src/credentials/schemas.ts:10-42`).
`[observed]`

**B55** An expired WorkOS access token is refreshed before use; API keys are
never refreshed; an external provider that returns an expired token resolves to
signed-out rather than falling back to local refresh
(`orig/packages/runtime/auth/src/auth/source.ts:579-605`). `[observed]`

**B56** Strict readers distinguish "signed out" (`null`) from "the store could
not be read right now" (a transient `TokenRefreshError`), so a caller that
requires a credential can tell offline from logged out
(`orig/packages/runtime/auth/src/auth/source.ts:83-95,650-663`). `[observed]`

**B57** The identity cache is keyed by token hash; a failed populate is
negatively cached for 30 s; logout clears the cache, advances its epoch and
aborts in-flight identity work, while a refresh is picked up because the new
token hashes to a different entry
(`orig/packages/runtime/auth/src/auth/common/cache.ts:50-88,93-95,506-593`).
`[observed]`

**B58** In airgap the credential is synthetic: `DROIDE_API_KEY`-shaped token
`airgapped-token` and user `{userId: 'airgapped-user', orgId:
'airgapped-org', email: ''}`; the org id is deliberately non-routable
(`orig/packages/runtime/auth/src/auth/common/constants.ts:8-24`;
`orig/packages/runtime/auth/src/auth/source.ts:97-99`). `[observed]`

### F. WorkOS login, refresh and organization switching

**B59** The default WorkOS API base is
`https://api.workos.com/user_management`, overridable by
`DROIDE_WORKOS_BASE_URL` (`orig/packages/runtime/auth/src/auth/workos/base-url.ts:3-9`;
`orig/src/environmentResolution.ts:239-241`). `[observed]`

**B60** The public WorkOS client id is chosen from `DROIDE_ENV`: the production
client id only for `production`, the development id otherwise. An invalid
`DROIDE_ENV` throws `MetaError` naming the allowed values
(`orig/packages/runtime/auth/src/auth/workos/config/index.ts:11-40`). `[observed]`

**B61** Device login starts with `POST {workosBase}/authorize/device`,
form-encoded `client_id`, and expects `device_code`, `user_code`,
`verification_uri`, `verification_uri_complete`, `expires_in`, `interval`
(`orig/packages/runtime/auth/src/auth/workos/login/device-code.ts:34-64`;
`orig/packages/runtime/auth/src/auth/workos/login/schemas.ts:4-12`). `[observed]`

**B62** Polling is `POST {workosBase}/authenticate` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` and
`client_id`, under one deadline of `expires_in` seconds. `authorization_pending`
waits the current interval; `slow_down` adds one second and waits the new
interval; `access_denied` and `expired_token` fail; any other error code fails
(`orig/packages/runtime/auth/src/auth/workos/login/device-code.ts:70-148`).
`[observed]`

**B63** A completed device login saves the access and refresh tokens as a new
v2 record and warms the identity cache (and therefore the region pin) with the
new token (`orig/packages/runtime/auth/src/auth/workos/login/device-code.ts:203-246`).
`[observed]`

**B64** A refresh is `POST {workosBase}/authenticate`, form-encoded
`grant_type=refresh_token`, `refresh_token`, `client_id`, plus `organization_id`
when switching organization (`orig/packages/runtime/auth/src/auth/workos/refresh.ts:39-62`).
`[observed]`

**B65** An organization switch redeems the stored refresh token scoped to the
new organization, commits only if the same refresh token still owns the store,
and clears `active_organization_id` until the next identity answer resolves the
Firestore organization (`orig/packages/runtime/auth/src/auth/source.ts:531-577`).
`[observed]`

**B66** An organization switch with no stored refresh token throws `No refresh
token available for organization switch`; one superseded mid-flight throws
`Organization switch superseded by a newer stored session`, carrying the commit
reason (`orig/packages/runtime/auth/src/auth/source.ts:533-548,566-576`).
`[observed]`

**B67** Changing the active organization clears the persisted whoami identity
when the value changes, so a new organization cannot inherit the previous one's
regional or Prem routing (`orig/packages/runtime/auth/src/auth/active-organization.ts:88-126`).
`[observed]`

**B68** A whoami identity is committed only while the same access token and the
same requested organization are still stored; the commit writes
`active_organization_id` and `whoami` together
(`orig/packages/runtime/auth/src/auth/active-organization.ts:180-234`).
`[observed]`

**B69** A token whose JWT carries no organization asks `GET
{apiBaseUrl}/api/cli/org` for `workosOrgIds`; when an id is returned the token
is refreshed scoped to it (`orig/packages/runtime/auth/src/auth/resolve-org.ts:15-61`).
`[observed]`

### G. Customer deployment (Prem)

**B70** The deployment selection is the file `auth-deployment.json` in the
credential base directory with shape `{version: 1, revision: <uuid>, deployment:
{kind:'managed'} | {kind:'customer-prem', origin: <url>}}`
(`orig/packages/runtime/auth/src/deployment/index.ts:25-95`;
`orig/packages/runtime/auth/src/deployment/schemas.ts:4-25`;
`orig/packages/runtime/auth/src/deployment/constants.ts:1`). `[observed]`

**B71** A missing selection file means the `managed` deployment. A malformed or
unreadable file is not a sign-out: it throws `AuthDeploymentSelectionError`
naming the file, and the process writes the message to stderr and exits 1
before dispatch (`orig/packages/runtime/auth/src/deployment/index.ts:51-68`;
`orig/packages/runtime/auth/src/deployment/errors.ts:6-18`;
`orig/src/index.ts:186-196`). `[observed]`

**B72** A customer origin is canonicalized: trimmed; `https://` is prepended
when no scheme is present; a path or query is refused; whitespace, backslashes,
userinfo and fragments are refused; `http` is allowed only for `localhost`,
`127.0.0.1` or `[::1]`; a trailing dot is removed and the result is the origin
(`orig/packages/runtime/auth/src/auth/prem/config.ts:11-77`). `[observed]`

**B73** `droide deployment set` requires exactly one of `--private-origin` or
`--managed`, refuses to run in airgap or inside a sandbox, saves the selection,
and prints `Deployment saved. Restart Droide, desktop, daemons, and workers to
use it. Saved credentials are unchanged.` It exits 0 on success and 1 on any
failure (`orig/src/entrypoints/deployment/command.ts:30-112`). `[observed]`

**B74** When the computer is pinned to an expected Prem origin and the saved
selection differs (including a missing file, which reads as the `managed`
deployment), startup throws `ExpectedPremDeploymentError` asking for
`droide deployment set --private-origin` (`orig/src/environment.ts:285-298`;
`orig/packages/runtime/auth/src/deployment/errors.ts:20-36`). `[observed]`

**B75** Prem discovery is `GET {origin}/api/auth/config`; the result must
declare the OIDC provider and include the `openid` scope, and its device and
token endpoints are validated as URLs before use
(`orig/packages/runtime/auth/src/auth/prem/client.ts:158-193`).
`[observed]`

**B76** Prem device login is RFC 8628 against the discovered IdP. The exchange
`POST /api/auth/exchange` with the IdP `id_token` returns access token, refresh
token, access-token expiry, session expiry and identity grants. Credentials that
are already expired are rejected. A single grant is selected automatically; a
multiple-grant login stays unselected until an explicit choice
(`orig/packages/runtime/auth/src/auth/prem/login.ts:47-171`;
`orig/packages/runtime/auth/src/auth/prem/client.ts:204-249`).
`[observed]`

**B77** Prem credentials persist as one encrypted record per origin at
`<credentialBaseDir>/prem-auth/<sha256(origin)>/credentials.json`, with its key
at `credentials.key` or in the keyring under `prem-auth-<sha256(directory)>`.
The envelope pins the key backend, so a keyring outage cannot revive an older
token (`orig/packages/runtime/auth/src/auth/prem/storage.ts:80-104,224-300`).
`[observed]`

**B78** A Prem refresh happens when the access token is within 30 s of expiry;
it requires the same user, issuer and session id, the same session expiry, and a
rotated refresh token, else it fails with `Prem refresh returned a different
session. Sign in again.`. A 401 from refresh clears the record
(`orig/packages/runtime/auth/src/auth/prem/client.ts:293-360`;
`orig/packages/runtime/auth/src/auth/prem/constants.ts:1-2`). `[observed]`

**B79** Prem failures expose status only, never the deployment's response text;
the messages are `The Prem authentication request failed.` and
`The identity provider rejected device authorization.`
(`orig/packages/runtime/auth/src/auth/prem/client.ts:141-156`;
`orig/packages/runtime/auth/src/auth/prem/login.ts:80-86`). `[observed]`

**B80** Prem logout revokes the session remotely only when a credential exists,
is unexpired and airgap is off; a failed revocation is logged and the local
record is cleared anyway (`orig/packages/runtime/auth/src/auth/prem/client.ts:460-483`).
`[observed]`

**B81** `getCustomerPremAuthHeaders` returns `Authorization: Bearer <token>` and
`X-Droide-Org-Id`, using the verified API key when one is configured and the
stored human credential otherwise; with no credential it throws
`Sign in to this customer deployment.`, and with no selected organization
`Choose an organization for this customer deployment.`
(`orig/packages/runtime/auth/src/auth/get.ts:36-91`). `[observed]`

**B82** Prem authentication is unavailable in airgap and throws 403 `Prem
authentication is unavailable in airgap mode.`
(`orig/packages/runtime/auth/src/auth/prem/config.ts:110-116`). `[observed]`

**B83** A selected customer authority is never reinterpreted as the hosted
control plane: when the deployment is `customer-prem` and no API key wins,
identity, active organization and visibility all read the Prem record
(`orig/packages/runtime/auth/src/auth/get.ts:165-190`;
`orig/packages/runtime/auth/src/auth/active-organization.ts:50-70`).
`[observed]`

### H. Proxy, certificates and airgap

**B84** Ambient proxy configuration is honoured through the standard
`HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` variables, accepted in either case;
`droide doctor` reports the effective proxy and redacts credentials embedded in
proxy URLs (`orig/src/constants/constants.ts:87-94`;
`orig/src/entrypoints/doctor/checks/proxy.ts:17-20`). `[observed]`

**B85** Extra roots are read from `DROIDE_EXTRA_CA_CERTS` and
`NODE_EXTRA_CA_CERTS`; each is either inline PEM or a `path.delimiter` list of
files with empty entries dropped (`orig/src/utils/certificates/parseCertificates.ts:8-20`).
`[observed]`

**B86** Startup trust material is the bundled Node roots plus the OS system
store plus the extra roots; the merged list is installed on
`https.globalAgent` and used by a patched `tls.createSecureContext`, capped at
4096 certificates. System roots are cached under the state directory and a
cache older than 24 h is reported as stale
(`orig/src/utils/systemCertificates.ts:46,640-700`;
`orig/src/entrypoints/doctor/checks/certificates.ts:21-47,140-180`).
`[observed]`

**B87** `NODE_TLS_REJECT_UNAUTHORIZED` disables certificate verification
process-wide; `droide doctor` warns that this is unsafe and recommends trusting
the appliance root through `DROIDE_EXTRA_CA_CERTS` instead
(`orig/src/entrypoints/doctor/checks/certificates.ts:120-130`). `[observed]`

**B88** TLS interception is diagnosed as `certificate chain not trusted: …`
with the remediation to export the appliance root CA (PEM) and point
`DROIDE_EXTRA_CA_CERTS` at it, and on Windows to delete the certificate cache
under the state directory (`orig/src/entrypoints/doctor/checks/
connectivity.ts:170-182`). `[observed]`

The full sentence this build prints is
`certificate chain not trusted: <cause>. Export the appliance's root CA as PEM
and point DROIDE_EXTRA_CA_CERTS at it` followed, on Windows, by
`; if it persists, delete the certificate cache under the state directory`
(`src/transport/errors.ts`, `TlsTrustError`). No certificate is ever bypassed
for the caller, and the cause is the sanitized TLS code, never the peer's
certificate bytes. `[observed]`

**B89** Airgap vetoes every backend-bound request with `AirgapBlockedError`
whose message is `Outbound request blocked because Airgap Mode is enabled; only
BYOK, MCP, and marketplaces are permitted.`; the veto fires for relative URLs
and for absolute URLs under the configured base URL, and BYOK/absolute external
URLs pass through (`orig/packages/utils/src/api/fetch.ts:54,250`;
`orig/packages/utils/src/api/errors.ts:40-56`). `[observed]`

**B90** `fetchBackend` refuses outright in airgap (before resolving a region)
and refuses every hosted operation on a customer deployment with `This hosted
operation is unavailable on customer deployments.`
(`orig/src/api/fetchBackend.ts:14-30`). `[observed]`

**B91** Customer-deployment requests are sent with `redirect: 'error'` and
`credentials: 'omit'`, so a redirect or ambient cookie cannot carry credentials
off the origin (`orig/packages/utils/src/api/constants.ts:1-9`). `[observed]`

### I. Error taxonomy at the HTTP boundary

**B92** A non-2xx response on the configured-fetch path throws `FetchError`,
whose message is `<status> <body>` (or `<status> Fetch failed` for an empty
body) and which carries the `Response`, `statusCode` and, when known, the
request URL and a backend marker
(`orig/packages/logging/src/errors/errors.ts:13-46`). `[observed]`

**B93** A customer-deployment failure instead throws `FetchError('Customer
request failed')` without the body, because customer bodies may carry secrets or
user content (`orig/packages/utils/src/api/fetch.ts:308-315`;
`orig/packages/daemon-core/src/services/ApiClient.ts:186-206`). `[observed]`

**B94** `ResponseError` carries `statusCode`, an optional public `code`, and an
optional `retryAfterSeconds`; its public object is `{detail, status, title}`
plus `code`, and `displayToUser: true` metadata adds the same fields under
`error` for OpenAI-SDK-compatible readers
(`orig/packages/logging/src/errors/responses/errors.ts:7-68`). `[observed]`

**B95** API-key verification maps 400, 401 and 403 to `API key was
rejected.` with `ResponseError400BadRequest` / `…401Unauthorized` /
`…403Forbidden` respectively; every other non-2xx becomes a generic
`ResponseError` carrying `API key validation failed.` and the status.
Transport failures and a malformed 2xx propagate unchanged
(`orig/packages/runtime/auth/src/auth/api-key/verify.ts:47-127`). `[observed]`

**B96** Classification of an API-key validation outcome: 400/401/403 →
`apiKeyRejected` with the invalid-key copy; any status ≥ 500 →
`ApiUnavailable` with the network/proxy copy; any other status →
`ApiValidationFailed`; a `ResponseError`/`MetaError` without a status
(malformed 2xx) → validation failed; any other `Error` → unavailable
(`orig/src/commands/authHelpers.ts:65-148`). `[observed]`

**B97** The user-visible auth copy is fixed: not-authenticated (`Not
authenticated. Please log in using /login or set a valid DROIDE_API_KEY
environment variable.`), invalid API key (`Authentication failed.
DROIDE_API_KEY is set but appears to be invalid. Unset it or replace it with a
valid key.`), API unavailable (`DROIDE_API_KEY could not be validated because
the API is not accessible. Check network or proxy access and try
again.`), validation failed (`DROIDE_API_KEY validation failed. Try again or
contact support if the problem continues.`), expired login, customer login
required, and login-saved-to-disk (`orig/src/i18n/authMessages.ts:11-63`).
`[observed]`

**B98** An auth rejection is reported as invalid-key copy when a key is
configured, as customer-login copy on a customer deployment, and otherwise as
the generic `commands:authError` string
(`orig/src/commands/authHelpers.ts:41-63`). `[observed]`

**B99** A 401 from WorkOS refresh is permanent and becomes `TokenRefreshError`
with no retry; the caller sees no token and does not fall back to another
source (`orig/packages/runtime/auth/src/auth/workos/refresh.ts:18-36`;
`orig/packages/runtime/auth/src/auth/source.ts:333-360`). `[observed]`

**B100** `droide exec` exits 1 on a refused invocation and on a startup failure;
lightweight subcommands report an auth failure by writing the auth message to
stderr and setting exit code 1; `droide deployment` returns 0 or 1
(`orig/src/entrypoints/exec/run.ts:585-590,660-680`;
`orig/src/entrypoints/wiki-search/run.ts:85-92`;
`orig/src/entrypoints/deployment/command.ts:94-112`). `[observed]`

**B101** A model-call failure is classified into exactly one reason, most
specific first: quota exhausted vs payment required (402), content moderation,
context limit, request too large, invalid request (thinking-signature or PDF
page limit), authentication, forbidden, gone (410), throttling, overloaded,
network, then the generic 4xx→invalid-request and ≥500→internal-error fallback,
then unknown. Provider-controlled text never becomes the reason
(`orig/packages/core/src/llms/errors/utils.ts:1034-1156`). `[observed]`

**B102** Model-call user-facing messages are fixed per class
(`orig/packages/core/src/llms/errors/constants.ts:1-44`). This build's copy is
fixed too, and it is what a user reads (`src/transport/errors.ts`,
`LLM_FAILURE_MESSAGES`):

| class | message |
|---|---|
| `quota-exhausted` | The model provider quota for this account is exhausted. |
| `payment-required` | No active subscription found. |
| `content-moderation` | The model provider rejected the request under its content policy. |
| `context-limit` | The conversation exceeds the model's context window. |
| `request-too-large` | The request is too large for the model provider. |
| `text-fields-too-large` | One or more text fields in the request are larger than the model provider accepts. |
| `invalid-request` | The model provider rejected the request as invalid. |
| `authentication` | The model provider rejected the credentials. |
| `forbidden` | The model provider refused the request. |
| `gone` | The requested model is no longer available from the provider. |
| `throttling` | The model provider is throttling requests for this account. |
| `overloaded` | The model provider is currently overloaded. |
| `network` | The model provider could not be reached because of network issues. |
| `host-duration-limit` | The model provider stopped the request at its host duration limit. |
| `output-degeneration` | The model response degenerated and was stopped. |
| `internal-error` | The model provider reported an internal error. |
| `unknown` | The model call failed for an unknown reason. |

The class list is closed: a provider refusal the classifier cannot place is
`unknown`, never a new class. `[observed]`

**B103** Retryability is part of the error class: throttling, overloaded,
network, stream, internal and unknown errors are retryable; a host-duration cut
is retryable only when its thrower allows the single retry (a repeated cut is
not); invalid request, content moderation, context limit, request too
large, text-fields-too-large and output degeneration are not
(`orig/packages/core/src/llms/errors/errors.ts:125-545`). `[observed]`

**B104** The inference proxy's gate failures have stable identities: 403 with
code `content_policy_rejected` (or legacy `{"detail":"Forbidden"}`), 402 with
code `no_active_subscription`, and any provider error it forwards is marked by
`x-droide-upstream-error`. Gate detection excludes firewall block pages and
upstream-marked errors (`orig/packages/common/src/api/llm-proxy/constants.ts:24-58`;
`orig/packages/core/src/llms/errors/utils.ts:1185-1213`). `[observed]`

### J. LLM transport

**B105** A turn has one provider-agnostic shape — an ordered message history of
text, image, document, tool-use and tool-result blocks, a system prompt, and a
tool catalogue — which each adapter converts to its wire dialect
(`orig/packages/core/src/llms/client/converters.ts:102,1393,2080`;
`orig/packages/core/src/llms/client/sendMessage.ts:2676-2696`).
`[observed]`

**B106** The Anthropic request carries `model`, `max_tokens`, `messages`,
`tools` and `system`, is sent streaming, and adds optional `tool_choice` and any
custom-model `extraArgs`; `max_tokens` is clamped to the model capability's
ceiling (`orig/packages/core/src/llms/client/sendMessage.ts:2683-2704`).
`[observed]`

**B107** A managed model call's URL is the managed route resolved through the
route table (B29–B31), so a managed Prem or customer Prem organization sends the
same dialect to its own host (`orig/src/api/BackendClient.ts:658-712,795-806`).
`[observed]`

**B108** Routing selects the dialect: Google → Gemini; Bedrock Converse →
Converse; managed models → Anthropic when the catalogue's API provider is
Anthropic, else Responses for the Responses endpoint and Chat Completions
otherwise; generic Chat-Completions providers → Chat; OpenAI and xAI →
Responses, except image models; Anthropic → Anthropic
(`orig/packages/core/src/llms/client/providerRouting.ts:60-102`).
`[observed]`

**B109** Proxy path families are chosen from the provider: Anthropic-wire and
Fireworks-Anthropic-compatible models use the `/a` base; OpenAI-compatible and
Google (whose client is a placeholder) use the `/o/v1` base
(`orig/packages/core/src/llms/client/providerRouting.ts:320-352`).
`[observed]`

**B110** SSE framing in the generic reader: only `data:` lines are payloads;
`event:`/`id:`/`retry:` lines and `:` comments are ignored; consecutive `data:`
lines are joined with `\n`; one leading space after the colon is stripped; a
blank line terminates and yields the parsed JSON; `\r` before `\n` is tolerated
(`orig/packages/utils/src/api/response.ts:168-280`). `[observed]`

**B111** The generic reader fails loudly: a payload that is not JSON, an event
whose bytes exceed the bound, or a body that ends inside a line or an event each
throws, the last as a truncation; it ends cleanly only at an event boundary.
Aborting cancels the body and releases the lock
(`orig/packages/utils/src/api/response.ts:139-166,193-268`). `[observed]`

**B112** The Gemini adapter reads the body itself: it survives split UTF-8 and
split lines, ignores non-`data:` lines and `[DONE]`, parses each payload, and
routes an in-band Gemini error envelope through the same mapper as an HTTP
failure so the retry loop classifies both alike
(`orig/packages/core/src/llms/client/sendMessage.ts:5040-5135`).
`[observed]`

**B113** Chat Completions tolerates a chunk without `choices` (reasoning-only
chunks), treats `finish_reason` as terminal, and treats `[DONE]` as a
non-payload (`orig/packages/core/src/llms/client/chunk-processing.ts:2150-2155,2410-2416`;
`orig/packages/core/src/llms/client/sendMessage.ts:5083`). `[observed]`

**B114** The Anthropic event order handled is `message_start`,
`content_block_start`, `content_block_delta` (`text_delta`, `thinking_delta`,
`signature_delta`, `input_json_delta`), `content_block_stop`, `message_delta`,
`message_stop`; an unknown type is ignored
(`orig/packages/core/src/llms/client/chunk-processing.ts:735-1030`).
`[observed]`

**B115** `message_delta.stop_reason` is terminal: the stream is finalized — tool
input flushed, usage emitted once, completion signalled — without waiting for
`message_stop` or transport EOF, so an intermediary holding the body open cannot
hang the turn (`orig/packages/core/src/llms/client/chunk-processing.ts:699-733,1008-1020`).
`[observed]`

**B116** The Responses event order handled is `response.created`,
`response.output_item.added`/`.done`, `response.output_text.delta`/`.done`,
`response.reasoning_*` deltas and parts, `response.function_call_arguments.delta`/`.done`,
`response.custom_tool_call_input.delta`/`.done`, `response.completed` /
`response.incomplete`, `response.failed`, and `error`. Completed and incomplete
both finalize, with incomplete mapping to a max-output-tokens stop
(`orig/packages/core/src/llms/client/chunk-processing.ts:1177-1740`).
`[observed]`

**B117** Anthropic tool-call deltas: a `tool_use` block start assigns a client
tool-call id derived from the assistant message id and the block index, and
`input_json_delta` fragments accumulate per block index into that call's input
(`orig/packages/core/src/llms/client/chunk-processing.ts:782-812,914-945`).
`[observed]`

**B118** Chat-Completions tool-call deltas: the provider `index` is used when
present; a delta without an index is grouped by its id; a different non-empty id
arriving at an already-occupied index is a new call, and the earlier call is
kept, not concatenated
(`orig/packages/core/src/llms/client/chunk-processing.ts:2238-2310`).
`[observed]`

**B119** Responses tool calls take the call id from the output item and, when a
`…arguments.done` payload is non-empty, that payload replaces the buffered
deltas; an empty done payload does not erase them
(`orig/packages/core/src/llms/client/chunk-processing.ts:1035-1050,1551-1596`).
`[observed]`

**B120** Usage is reported with disjoint buckets: `inputTokens` excludes both
cache read and cache write tokens, which are reported separately as
`cacheReadTokens` and `cacheCreationTokens`; `outputTokens` and optional
`thinkingTokens` complete the record. OpenAI's inclusive `input_tokens` is split
by subtracting cached and cache-write counts
(`orig/packages/core/src/llms/client/chunk-processing.ts:1144-1175,2123-2145`).
`[observed]`

**B121** Anthropic usage arrives twice: `message_start` seeds input and cache
counts, `message_delta` overwrites them. Thinking tokens are estimated from the
streamed character count and replaced by the provider's breakdown when present.
Streaming never commits session totals; the send loop commits one billed attempt
at a time, and an attempt that was retried, cut, resampled or aborted after
reporting prompt tokens still counts (`orig/packages/core/src/llms/client/chunk-processing.ts:704-733,742-757,959-1000`;
`orig/src/services/SessionService.ts:8430-8497`). `[observed]`

**B122** Streaming usage is a live-display snapshot only: `onTokenUsage(usage,
isStreaming=true)` updates the current-call numbers without accumulating; the
session's durable totals and `credits` (vendor prefix elided) are updated once
per attempt by the commit path
(`orig/packages/core/src/llms/client/sendMessage.ts:1330-1332`;
`orig/src/services/SessionService.ts:8430-8497`). `[observed]`

**B123** Chat Completions falls back to the `fireworks-cached-prompt-tokens`
response header for cache-read counts when the chunk omits them
(`orig/packages/core/src/llms/client/chunk-processing.ts:2117-2127`).
`[observed]`

**B124** The Bedrock Converse adapter consumes the Converse event union
(`messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`,
`messageStop`, metadata) and maps the five event-stream error members
(`internalServerException`, `modelStreamErrorException`, `validationException`,
`throttlingException`, `serviceUnavailableException`) into typed LLM errors so
the retry policy applies (`orig/packages/core/src/llms/client/bedrock/converse.ts:333-420`).
`[observed]`

**B125** Converse stop reasons map as: `end_turn`/`stop_sequence` → stop,
`tool_use` → tool calls, `max_tokens` → length,
`guardrail_intervened`/`content_filtered` → content filter, anything else →
unknown (`orig/packages/core/src/llms/client/bedrock/converse.ts:266-287`).
`[observed]`

**B126** The Responses WebSocket is a managed transport only for routes whose
definition names it; its proxy close reasons are `connection deadline`, `idle`,
`connection draining`, `turn deadline` and `turn stalled`, and connection-scoped
reasons are not replayed on a fresh connection
(`orig/packages/common/src/api/llm-proxy/enums.ts:47-63,80-88`;
`orig/src/api/BackendClient.ts:212-220`). `[observed]`

### K. The CLI's authentication surface

**B127** The CLI has **no `droide auth` command**. The root help lists `resume`,
`exec`, `daemon`, `search|find`, `update`, `mcp`, `plugin`, `computer`,
`doctor` and `help`; sign-in and sign-out are TUI slash commands, and deployment
selection is `droide deployment set` (`evidence/cli/help.txt`;
`orig/src/commands/loginCommand.ts:11-31`). `[observed]`

**B128** `/login` opens the login selector; on a host without one it reports the
localized `…login.notAvailable` system notification instead of failing
(`orig/src/commands/loginCommand.ts:11-31`). `[observed]`

**B129** `/logout` deletes the stored credential, clears the user and feature-flag
caches, resets cloud-preferences auth state, and rotates the daemon's
authentication context after starting a close of the local session
(`orig/src/commands/logoutCommand.ts:39-138`). `[observed]`

**B130** `droide doctor --checks auth` reports four checks by id —
`auth.credentials`, `auth.tokenExpiry`, `auth.workosRefresh` and `auth.verify` —
and exits non-zero when any selected check fails
(`orig/src/entrypoints/doctor/checks/auth.ts:147,234,260,403-427`;
`orig/src/entrypoints/doctor/run.ts:406-421`). `[observed]`

## Data & config

### Environment variables

| Name                                                  | Type / domain                             | Default                                  | Absent / malformed                                                                       | Clause   |
| ----------------------------------------------------- | ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| `DROIDE_API_BASE_URL`                                 | absolute http(s) URL, no trailing `/`     | none — the baked define is empty         | `exec` exits 1 with `no API endpoint configured`; `doctor` `connectivity` reports `skip` | B3, B7   |
| `DROIDE_API_BASE_URL_EU`                              | absolute http(s) URL, no trailing `/`     | none                                     | EU region falls back to `DROIDE_API_BASE_URL`                                            | B1, B3   |
| `DROIDE_API_KEY`                                      | opaque key, prefix `fk-`                  | none                                     | falls through to WorkOS/Prem                                                             | B52, B53 |
| `DROIDE_WORKOS_BASE_URL`                              | URL                                       | `https://api.workos.com/user_management` | default used                                                                             | B59      |
| `DROIDE_ENV`                                          | `development` \| `production`             | `development`                            | invalid value throws                                                                     | B60      |
| `DROIDE_DISABLE_KEYRING`                              | `true` \| `1`                             | false                                    | any other value is false                                                                 | B47      |
| `DROIDE_AIRGAP_ENABLED`                               | `true` \| `1`; baked define wins          | false                                    | any other value is false                                                                 | B89, B58 |
| `DROIDE_HOME_OVERRIDE`                                | absolute path                             | OS home                                  | ignored when empty                                                                       | B45      |
| `DROIDE_EXTRA_CA_CERTS`, `NODE_EXTRA_CA_CERTS`        | inline PEM, or `path.delimiter` file list | none                                     | unreadable entries contribute nothing                                                    | B85      |
| `NODE_TLS_REJECT_UNAUTHORIZED`                        | `0` disables verification                 | verification on                          | doctor warns                                                                             | B87      |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (either case) | proxy URLs / host list                    | none                                     | direct connection                                                                        | B84      |
| `CLI_VERSION`                                         | version string                            | unset                                    | `X-Client-Version` is not sent                                                           | B11      |

### Files

| Path (relative to the credential base directory) | Format                                        | Owner                          | Clause |
| ------------------------------------------------ | --------------------------------------------- | ------------------------------ | ------ |
| `auth-deployment.json`                           | JSON `{version:1, revision:uuid, deployment}` | deployment selection           | B70    |
| `auth.v2.keyring`                                | encrypted credentials JSON                    | WorkOS v2 (keyring)            | B46    |
| `auth.v2.loginkeychain`                          | encrypted credentials JSON                    | WorkOS v2 (macOS security CLI) | B46    |
| `auth.v2.file`                                   | encrypted credentials JSON                    | WorkOS v2 (keyfile)            | B46    |
| `auth.v2.key`                                    | 32-byte key                                   | keyfile backend                | B46    |
| `auth.v2.write.lock`                             | lock file                                     | all writers                    | B46    |
| `prem-auth/<sha256(origin)>/credentials.json`    | encrypted `{version, backend, ciphertext}`    | Prem                           | B77    |
| `prem-auth/<sha256(origin)>/credentials.key`     | key                                           | Prem keyfile backend           | B77    |
| `certs/…`                                        | system-root cache                             | certificate loader             | B86    |

### Header names (literal)

`Authorization`, `X-Droide-Org-Id`, `X-Droide-Client`, `X-Droide-Sdk`,
`X-Droide-Request-Surface`, `X-Droide-Exec-Output-Format`,
`X-Droide-Exec-Input-Format`, `X-Client-Version`,
`X-Droide-Whoami-Extended`, `X-Droide-Session-Attribution`,
`x-session-id`, `x-assistant-message-id`, `x-api-provider`,
`x-message-call-type`, `traceparent`, `Content-Type`,
`x-droide-upstream-error`, `x-droide-stream-deadline-ms`,
`x-droide-computer-delete-support`, `fireworks-cached-prompt-tokens`,
`x-api-key`, `proxy-authorization`, `cookie`.

## Errors

Grouped by trigger. Exit codes are process-level; library errors carry no exit
status of their own.

| Trigger                                       | Identity                                                       | User-visible effect                                                        | Retry-safe                      |
| --------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| No credential at all                          | `AuthenticationError` / `notAuthenticatedMessage`              | "Not authenticated…"                                                       | no (needs `/login` or key)      |
| Configured key rejected (400/401/403)         | `ResponseError400/401/403`, reason `apiKeyRejected`            | invalid-key copy                                                           | no                              |
| Key validation could not run (≥500 / network) | reason `ApiUnavailable`                                        | "API is not accessible…"                                                   | yes, later                      |
| Key validation malformed 2xx                  | `ResponseError` (502)                                          | validation-failed copy                                                     | no                              |
| Expired session, refresh unreachable          | transient `TokenRefreshError`, null token for nullable readers | expired/again-later copy                                                   | yes                             |
| Refresh rejected (4xx ≠ 429)                  | permanent `TokenRefreshError`                                  | expired-login copy                                                         | no; session ends                |
| Customer deployment signed out                | `AuthenticationError('Sign in to this customer deployment.')`  | customer-login copy                                                        | after sign-in                   |
| Customer deployment awaiting org              | `AuthenticationError('Choose an organization…')`               | same                                                                       | after choice                    |
| Selection file malformed/unreadable           | `AuthDeploymentSelectionError`                                 | message + exit 1 at startup                                                | no (repair file)                |
| Expected Prem pin mismatch                    | `ExpectedPremDeploymentError`                                  | `droide deployment set --private-origin`                                   | no                              |
| Prem auth in airgap                           | `ResponseError403Forbidden`                                    | "Prem authentication is unavailable…"                                      | no                              |
| Prem network/TLS failure                      | `ResponseError` (status preserved)                             | generic Prem auth failure                                                  | yes                             |
| Backend call in airgap                        | `AirgapBlockedError`                                           | "Outbound request blocked…"                                                | no                              |
| Hosted path on customer deployment            | `MetaError`                                                    | "This hosted operation is unavailable…" / "This operation is unavailable…" | no                              |
| Backend non-2xx                               | `FetchError` `${status} ${body}`                               | status + server text (hosted)                                              | 5xx/429 only if caller retries  |
| Customer backend non-2xx                      | `FetchError('Customer request failed')`                        | status only                                                                | as above                        |
| Daemon missing credentials                    | `MetaError` type `Precondition`                                | "Daemon not authenticated"                                                 | no, until configured            |
| HTTP 401 from WorkOS refresh                  | permanent `TokenRefreshError`                                  | re-login                                                                   | no                              |
| HTTP 429 at a model provider                  | `LLMThrottlingError` / throttling reason                       | "high demand…"                                                             | yes, with server delay honoured |
| HTTP 5xx/529 at a model provider              | `LLMOverloadedError` / internal error                          | "provider is currently overloaded…"                                        | yes (capacity policy)           |
| Network/TLS failure to a model provider       | `LLMNetworkError`                                              | "network issues…"                                                          | yes                             |
| Proxy content gate 403                        | code `content_policy_rejected`                                 | policy-blocked copy                                                        | no                              |
| No active plan 402                            | code `no_active_subscription`                                  | "No active subscription found."                                            | no                              |
| Request body too large 413                    | `LLMRequestTooLargeError`                                      | shrink attachments copy                                                    | no                              |
| Context window exceeded                       | context-limit reason                                           | "Context limit exceeded…"                                                  | no (compaction may follow)      |

## Acceptance tests

| Clause           | Test id                                      | Fixture                                       |
| ---------------- | -------------------------------------------- | --------------------------------------------- |
| B1–B9            | `tests/transport/test_base_url_matrix`       | `fixtures/transport/base_url_matrix.json`     |
| B10–B20, B22     | `tests/transport/test_header_construction`   | `fixtures/transport/credential_snapshot.json` |
| B8, B9, B21, B91 | `tests/transport/test_request_policy`        | `fixtures/transport/policy_cases.json`        |
| B23–B32          | `tests/transport/test_route_table`           | `fixtures/transport/routes.json`              |
| B33–B39          | `tests/transport/test_deadlines`             | `fixtures/transport/deadlines.json`           |
| B40–B44          | `tests/transport/test_llm_retry`             | `fixtures/transport/retry_cases.json`         |
| B45–B58          | `tests/transport/test_credential_store`      | `fixtures/transport/credential_store/`        |
| B59–B69          | `tests/transport/test_workos`                | `fixtures/transport/workos_cases.json`        |
| B70–B74          | `tests/transport/test_deployment_selection`  | `fixtures/transport/deployments.json`         |
| B75–B83          | `tests/transport/test_prem_auth`             | `fixtures/transport/prem_cases.json`          |
| B84–B91          | `tests/transport/test_ca_and_airgap`         | `fixtures/transport/ca_airgap.json`           |
| B92–B104         | `tests/transport/test_http_error_messages`   | `fixtures/transport/http_errors.json`         |
| B105–B109        | `tests/transport/test_llm_transport_routing` | `fixtures/transport/routing.json`             |
| B110–B113        | `tests/transport/test_sse_reader`            | `fixtures/transport/sse/*.txt`                |
| B114–B119        | `tests/transport/test_stream_events`         | `fixtures/transport/streams/*.jsonl`          |
| B120–B123        | `tests/transport/test_usage_accounting`      | `fixtures/transport/usage_streams.jsonl`      |
| B124–B126        | `tests/transport/test_converse_and_ws`       | `fixtures/transport/converse_ws.json`         |
| B127–B130        | `tests/transport/test_cli_auth_surface`      | `fixtures/transport/doctor_auth.json`         |

### Test specifications

**`test_base_url_matrix`** — table-driven over `resolveCliApiBaseUrl(config,
region)`. Rows: (deployment `managed`, region global, base
`https://api.example`, eu `https://eu.example`) → `https://api.example`;
(`managed`, eu, both) → `https://eu.example`; (`managed`, eu, eu absent) →
`https://api.example`; (customer-prem `https://prem.example`, eu, both) →
`https://prem.example`. Also asserts `getRegion` returns `global` with no
credential and with a customer deployment, and that `getPremBaseHost` returns
the origin for a customer deployment and `premBaseHostV2` for a managed one.
Reject cases: empty base, trailing `/`, `ftp://` each throw. Fixture is a JSON
array of cases; no network.

**`test_header_construction`** — given a fake snapshot `{token: 't', org: 'o',
purpose: 'operational'}` the produced header record equals
`{Authorization: 'Bearer t', 'X-Droide-Org-Id': 'o', 'X-Droide-Client':
'cli', 'X-Client-Version': <fixture version>}`; with no token the
`Authorization` key is absent; with `purpose: 'usage'` the default
`X-Droide-Client` is absent; SDK attribution adds `X-Droide-Sdk`; a caller
header whose name differs only in case is never duplicated. Daemon builder adds
`Content-Type: application/json` and lets a caller override win.

**`test_request_policy`** — a policy `{origin: 'https://prem.example',
allows: path === '/api/apps/x'}` accepts exactly that origin+path and rejects
(a) another origin, (b) userinfo, (c) a fragment, (d) another path, (e) a
`Host` header naming another authority, (f) an `Authorization`/`X-Droide-Org-Id`
that differs from the expected value, (g) `x-api-key`/`proxy-authorization`/
`cookie`. Expected refusal is `MetaError` before the injected fetch is called
(assert call count 0).

**`test_route_table`** — evaluates every row of `fixtures/transport/routes.json`
(route id, params, hosted base, prem host, customer flag) and asserts the
resolved method+URL, the SDK base URL, and the thrown message when the route has
no Prem path. Includes `search-sessions`: GET hosted, POST on Prem. Asserts
`customerPremOnly` routes are refused on a managed Prem and served on a
customer Prem; `managedPremOnly` the reverse.

**`test_deadlines`** — with a fake clock and an injected transport: one backend
call issues exactly one fetch; whoami aborts at 10 000 ms; WorkOS refresh at
15 000 ms; Prem auth at 15 000 ms; a 400/401/403 refresh yields a permanent
`TokenRefreshError` (one attempt), a 500 yields three attempts at 500/1000 ms
delays before the transient error; two queued refreshes never run concurrently
(assert interleaving); a permanently dead refresh token is not redeemed twice.

**`test_llm_retry`** — `getRetryConfig`/`getRouteAwareRetryConfig` with a
seeded RNG: attempt counts per strategy are 1/5/4; 429 delays clamped to
[5000, 30000] ms; `retry-after: 2` honoured as a minimum; timeout delays
3000, 4500, 6750… capped at 15000; capacity delay ≈500–1000 ms with rotation
and 5000–30000 without; interactive throttling grants 6 attempts; single
provider capacity 10.

**`test_credential_store`** — a temp base dir with injected keyfile adapter:
load preference (secure then keyfile), `disableKeyring` never touches the secure
adapter; save with `forceNew` writes keyfile when the key store is unavailable;
refresh with a mismatched context is rejected; `updateCredentials` returns
`rejected` for an undefined update and `unavailable` when ciphertext exists but
cannot be decrypted; `clear` removes only the active file and keeps
`auth.v2.key`; lookup order is airgap → env key → Prem → external → stored;
strict reader throws transient on an unreadable store and returns null when
signed out.

**`test_workos`** — recorded request shapes against a fake fetch: device
authorize body, poll body, refresh body (with and without
`organization_id`); poll state machine (`authorization_pending`, `slow_down`
+1 s, `access_denied`, `expired_token`, unknown); login saves with `forceNew`;
organization switch clears the org until identity; switch superseded error;
org membership lookup returns the first `workosOrgIds` entry and triggers a
scoped refresh.

**`test_deployment_selection`** — missing file → `{kind:'managed'}`; malformed
JSON → `AuthDeploymentSelectionError`; load of a customer deployment
canonicalizes the origin; save preserves unknown metadata, bumps `revision`;
`droide deployment set` with both flags → 400 message; in airgap → 403; expected
origin mismatch → `ExpectedPremDeploymentError`; success prints the restart
notice and exits 0.

**`test_prem_auth`** — canonicalization accept/reject table (scheme, trailing
dot, path, query, userinfo, backslash, whitespace, fragment, local http);
discovery rejects a non-OIDC provider and an `openid`-less scope; device flow
polls to exchange and returns a candidate without writing; a single grant is
auto-selected, two grants stay unselected; a refresh with a changed user,
issuer, session id or session expiry fails; a 401 refresh clears the record;
logout revokes then clears; failures carry status only (assert no body text in
`message`).

**`test_ca_and_airgap`** — `parseExtraCaCertsValue` for inline PEM vs
`a:b` path list vs empty entries; `AirgapBlockedError` fires for a relative
path and for an absolute URL under the base origin, and not for an unrelated
absolute URL; `FetchError` for a customer request has message `Customer request
failed` and no body; request init carries `redirect:'error'` and
`credentials:'omit'`.

**`test_http_error_messages`** — table of (status, configured key?) → error
type/message/exit: 400/401/403 → `ResponseError400/401/403` +
`API key was rejected.` + `apiKeyRejected`; 500 → unavailable copy;
418 → validation-failed copy; malformed 200 (`ResponseError`) → validation
failed; transport `TypeError` → unavailable. Also asserts `FetchError.message`
is `${status} ${body}`; `ResponseError.toPublicObject()` shape; `droide exec`
exit 1 on a refused invocation; wiki-search-style subcommand exit 1 on auth
failure; `droide deployment` maps non-zero to 1.

**`test_llm_transport_routing`** — `resolveProviderRoute` table for every
`ModelProvider` member (Google, Converse, managed+anthropic, managed+responses
endpoint, managed+chat endpoint, generic, OpenAI, xAI, OpenAI image model,
Anthropic, e2e mock); `getProxyBaseURL` picks `/a` for Fireworks-Anthropic
models and `/o/v1` for OpenAI-compatible/Google; SDK base URLs strip the
suffixes; the Anthropic request body carries `stream: true` and clamps
`max_tokens` to the capability ceiling.

**`test_sse_reader`** — fixtures: (a) two events split across arbitrary byte
boundaries; (b) `event:`/`:` lines ignored; (c) multi-line `data:` joined with
`\n`; (d) CRLF; (e) `[DONE]` ignored by the Gemini-style reader; (f) invalid
JSON → error naming size and error name only, not payload; (g) oversized event
→ error; (h) body ending inside an event → truncation error; (i) clean end at a
boundary → generator completes; (j) abort → reason propagated and reader lock
released.

**`test_stream_events`** — replay recorded event lists through the chunk
processors: Anthropic full sequence yields one text block, one tool call with
accumulated JSON, and one usage emission at `message_delta` (assert no second
emission on a following `message_stop`); Responses sequence yields text,
reasoning, a function call with done-arguments replacing deltas, and completion;
Chat-Completions sequence handles missing `index`, duplicate complete calls at
one index, and a `finish_reason`-only chunk; Converse sequence maps stop
reasons and raises on each error member.

**`test_usage_accounting`** — OpenAI usage with `input_tokens=100`,
`cached_tokens=40`, `cache_write_tokens=10` → `{inputTokens:50,
cacheReadTokens:40, cacheCreationTokens:10}`; Anthropic `message_start` +
`message_delta` overwrite; thinking estimate replaced by provider breakdown;
`isStreaming=true` does not change session totals; one committed attempt adds
exactly once; `credits` accumulated.

**`test_converse_and_ws`** — Converse event union mapping and the five error
members; WebSocket close reasons enum values; connection-scoped reasons not
replayed.

**`test_cli_auth_surface`** — root help contains no `auth` command; `/login`
without a selector emits the `notAvailable` notification; `/logout` clears the
credential and rotates daemon auth; `droide doctor --checks auth` emits the four
check ids and exits non-zero when one is forced to `fail`.

## Evidence

| Evidence          | Supports  | Method                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ev_transport_1`  | B1–B9     | `orig/packages/runtime/auth/src/auth/common/resolveCliApiBaseUrl.ts:13-21`, `orig/src/environment.ts:285-317`, `orig/src/environmentResolution.ts:90-127,189-197`, `orig/packages/runtime/auth/src/auth/common/cache.ts:617-620,665-703`, `orig/packages/utils/src/api/config.ts:7-40`, `orig/packages/utils/src/api/fetch.ts:11-29,200-218`, `orig/src/api/config.ts:302-334`; direct reading                                                                                                                                                                                     |
| `ev_transport_2`  | B10–B22   | `orig/src/api/config.ts:149-242,302-334`, `orig/packages/runtime/auth/src/auth/common/whoami.ts:19-56`, `orig/packages/sdk-core/src/protocol/schemas/constants.ts:7-36`, `orig/src/api/BackendClient.ts:60-99,807-886`, `orig/src/llm-proxy/utils.ts:235-296`, `orig/packages/utils/src/api/fetch.ts:32-96,255-296`, `orig/packages/daemon-core/src/services/ApiClient.ts:129-260,430-480`, `orig/packages/utils/src/api/constants.ts:6-9`, `orig/packages/runtime/auth/src/auth/prem/client.ts:107-140`; direct reading                                                           |
| `ev_transport_3`  | B23–B32   | `orig/src/api/BackendClient.ts:191-593,610-660,724-806,888-916`, `orig/packages/common/src/api/backend/enums.ts:9-83`, `orig/packages/common/src/api/llm-proxy/enums.ts:10-44`, `orig/packages/common/src/api/prem/constants/index.ts:34-38`, `orig/packages/common/src/api/cli/schemas.ts:34-100`; route table read exhaustively                                                                                                                                                                                                                                                  |
| `ev_transport_4`  | B33–B44   | `orig/packages/utils/src/api/fetch.ts:298-320`, `orig/packages/runtime/auth/src/auth/common/constants.ts:24-35`, `orig/packages/runtime/auth/src/auth/workos/refresh.ts:18-89`, `orig/packages/runtime/auth/src/auth/prem/client.ts:45-62`, `orig/packages/core/src/llms/client/retryPolicy/index.ts:14-203`, `orig/packages/core/src/llms/client/sendMessage.ts:484-491,3076-3081`, `orig/packages/common/src/api/llm-proxy/constants.ts:59-70`, `orig/packages/utils/src/api/httpStatus.ts:10-12`; constants and branches read                                                   |
| `ev_transport_5`  | B45–B58   | `orig/packages/runtime/auth/src/credentials/presence.ts:16-19`, `orig/packages/runtime/auth/src/credentials/constants.ts:1-3`, `orig/packages/runtime/auth/src/credentials/CredentialsStorage.ts:50-74,150-186,320-322,512-541,653-704,717-838`, `orig/packages/runtime/auth/src/auth/source.ts:83-160,234-320,579-663`, `orig/packages/runtime/auth/src/credentials/schemas.ts:10-42`, `orig/packages/runtime/auth/src/auth/common/cache.ts:50-95,506-593`, `orig/packages/runtime/auth/src/auth/common/constants.ts:8-24`; storage code read                                     |
| `ev_transport_6`  | B59–B69   | `orig/packages/runtime/auth/src/auth/workos/base-url.ts:3-9`, `orig/packages/runtime/auth/src/auth/workos/config/index.ts:11-40`, `orig/packages/runtime/auth/src/auth/workos/login/device-code.ts:34-246`, `orig/packages/runtime/auth/src/auth/workos/refresh.ts:39-62`, `orig/packages/runtime/auth/src/auth/source.ts:531-605`, `orig/packages/runtime/auth/src/auth/active-organization.ts:88-126,180-234`, `orig/packages/runtime/auth/src/auth/resolve-org.ts:15-61`; flow code read                                                                                        |
| `ev_transport_7`  | B70–B74   | `orig/packages/runtime/auth/src/deployment/index.ts:25-95`, `schemas.ts:4-25`, `constants.ts:1`, `errors.ts:6-36`, `orig/packages/runtime/auth/src/auth/prem/config.ts:11-77,101-116`, `orig/src/entrypoints/deployment/command.ts:30-112`, `orig/src/environment.ts:285-317`, `orig/src/index.ts:186-196`; files and command read                                                                                                                                                                                                                                                 |
| `ev_transport_8`  | B75–B83   | `orig/packages/runtime/auth/src/auth/prem/client.ts:107-360,460-483`, `login.ts:47-171`, `storage.ts:80-104,224-300`, `schemas.ts`, `constants.ts:1-2`, `orig/packages/runtime/auth/src/auth/get.ts:36-91,165-190`, `orig/packages/runtime/auth/src/auth/active-organization.ts:50-70`; flow code read                                                                                                                                                                                                                                                                             |
| `ev_transport_9`  | B84–B91   | `orig/src/constants/constants.ts:87-94`, `orig/src/utils/certificates/parseCertificates.ts:8-20`, `orig/src/utils/systemCertificates.ts:46,640-700`, `orig/src/entrypoints/doctor/checks/proxy.ts:17-20`, `certificates.ts:21-47,120-130`, `connectivity.ts:170-182`, `orig/packages/utils/src/api/fetch.ts:54,250,308-315`, `orig/packages/utils/src/api/errors.ts:40-56`, `orig/src/api/fetchBackend.ts:14-30`, `orig/packages/utils/src/api/constants.ts:1-9`; source read                                                                                                      |
| `ev_transport_10` | B92–B104  | `orig/packages/logging/src/errors/errors.ts:13-46`, `orig/packages/logging/src/errors/responses/errors.ts:7-68`, `orig/packages/runtime/auth/src/auth/api-key/verify.ts:47-127`, `orig/src/commands/authHelpers.ts:41-148`, `orig/src/i18n/authMessages.ts:11-63`, `orig/src/entrypoints/exec/run.ts:585-590,660-680`, `orig/src/entrypoints/wiki-search/run.ts:85-92`, `orig/packages/core/src/llms/errors/utils.ts:1034-1213`, `errors/constants.ts:1-44`, `errors/errors.ts:125-545`, `orig/packages/common/src/api/llm-proxy/constants.ts:24-58`; classification and copy read |
| `ev_transport_11` | B105–B126 | `orig/packages/core/src/llms/client/converters.ts:102,1393,2080`, `sendMessage.ts:484-491,1330-1332,2676-2704,3076-3081,5040-5135`, `providerRouting.ts:60-102,320-352`, `chunk-processing.ts:699-1050,1144-1175,1177-1740,2117-2150,2151-2160,2238-2310,2410-2416`, `bedrock/converse.ts:266-287,333-420`, `orig/packages/common/src/api/llm-proxy/enums.ts:47-88`, `orig/packages/utils/src/api/response.ts:139-280`, `orig/src/api/BackendClient.ts:212-220`, `orig/src/services/SessionService.ts:8430-8497`; stream processors and adapters read                              |
| `ev_transport_12` | B127–B130 | `evidence/cli/help.txt`, `orig/src/commands/loginCommand.ts:11-31`, `orig/src/commands/logoutCommand.ts:39-138`, `orig/src/entrypoints/doctor/checks/auth.ts:147,234,260,403-427`, `orig/src/entrypoints/doctor/run.ts:406-421`; help capture and command code read                                                                                                                                                                                                                                                                                                                |

## Open questions

1. **The hosted session-batch path literal.** B24 cites
   `common/api/sessions`'s `SESSION_BATCH_PATH` without its value;
   the module is absent from the recovered tree (barrel elision). Settle by
   locating the constant in a source map or by reading the backend route table
   in a build with source maps. Blocks the exact cell only.
2. **`ApiConfig` field set** (vendor prefix elided). `packages/utils/src/api/types.ts` is absent,
   so B8/B9 describe the fields the implementation reads (`baseUrl`,
   `getBaseUrl`, `getHeaders`, `requestPolicy`, `airgapEnabled`) rather than a
   declared interface. A recovered `types.ts` would confirm field optionality.
3. **Backend timeouts at call sites.** B33 states no timeout is imposed by the
   transport. Which callers pass an `AbortSignal` (session listing does, cloud
   sync may) is not exhaustively mapped. Settle by enumerating `request({…})`
   call sites with `init: {signal}`. Does not block any clause.
4. **`traceparent` injection.** B18 relies on `OtelTracing.injectContext`;
   the propagation format (W3C vs custom) is not read. Settle by reading the
   tracing package. Blocks the header value, not its presence.
5. **Secure-storage service/account strings per platform.** B46/B48 establish
   the file names and the `-dev` suffix; the keyring service is `Droide CLI`
   and the account `auth-encryption-key`/`auth-encryption-key-security-cli`
   (`CredentialsStorage.ts:50-52`), but each OS backend's storage encoding is
   not read. Settle by reading `KeyringClient`/`SecurityCliKeyring` adapters.
6. **Capacity status set.** B42 lists 500/502/503/529/408; the 408/502/503/529
   set is read from `errors/utils.ts:508`, while including 500 comes from the
   retry-policy comment (`retryPolicy/index.ts:148-153`). Confirm with
   `isProviderCapacityError`'s body, which is not in the recovered files.
7. **Responses WebSocket frame contract.** B126 covers close reasons and route
   selection only. The `response.create` frame, the `_droide` extension key and
   the idle/deadline recovery rules live in `responsesWebSocket.ts` and are not
   specified here. Blocks a future websocket clause.
8. **Whether any hidden `auth` command exists.** B127 is based on the captured
   root help plus a grep of command registrations; a fully hidden command
   registered under a different name would be invisible to both. Settle by
   running the reference build's completion/command catalogue.
9. **Exact `X-Droide-Client` values.** B11 names the header and the `cli`
   default; the full `ClientType` value set (daemon, SDK, desktop, …) is in a
   module not read. Settle from the protocol enum.

## Clean-room notes

**Must reproduce (the contract):**

- The base-URL precedence: customer origin, then EU base on EU region, then
  global base; per-request resolution through the same precedence.
- Deployment selection as a separate, restart-scoped file that can only be
  changed through `droide deployment set`, with missing = `managed` deployment
  and malformed = hard startup failure.
- The literal credential file names, their base directory, the `0600` mode,
  secure-then-keyfile load order, `DROIDE_DISABLE_KEYRING` behaviour, key
  retention across logout, and the atomic/lock-guarded write.
- The credential lookup order and the invariant that `DROIDE_API_KEY` wins over
  any stored session and reports its own organization.
- The identity endpoint (`/api/cli/whoami`), its extended-response header, its
  10 s deadline, its lenient schema, and its role as the single verifier for all
  credential kinds.
- The WorkOS device flow URLs, form bodies, poll state machine and deadlines;
  the refresh form body; the serialization of redemptions; the permanent vs
  transient classification (4xx ≠ 429 permanent).
- The Prem discovery/exchange/refresh/logout endpoints, RFC 8628 polling, the
  single-grant auto-selection, the 30 s expiry buffer, origin-keyed storage, and
  the rule that Prem error text never leaves the deployment.
- The route inventory and hosted/Prem placement rules, including which routes
  are customer-only, managed-Prem-only, or hosted-only, and the exact refusal
  messages for the wrong deployment.
- The header names, their construction order, the customer-policy credential
  invariance, the usage-purpose attribution rule, and the request attributes
  `redirect:'error'` / `credentials:'omit'`.
- The retry/backoff constants (attempts, base delays, caps, jitter fractions,
  throttle and timeout policies) and the deadlines (10 s whoami, 15 s refresh,
  15 s Prem, 4/10 min stream idle, 600 s default stream deadline).
- The error taxonomy: HTTP status → typed error → user-visible message → exit
  code, including the API-key 400/401/403 unification, ≥500 unavailability, the
  malformed-200 validation failure, and the LLM reason set with its retryability.
- The LLM transport: the normalized turn, per-provider dialect selection, the
  proxy path families and SDK suffixes, SSE framing rules and failure modes, the
  event orders and their terminality, tool-call delta assembly, and the disjoint
  usage buckets with live-vs-durable accounting.
- Airgap as a hard veto with its fixed message, applied at the final transport
  and at helpers that front it.

**Explicitly not part of the contract:**

- Exact retry timing to the millisecond: jitter is random; tests pin the bounds
  and the deterministic components only.
- Log line wording, telemetry attribute names, and metric names.
- The internal shape of the encrypted ciphertext (algorithm, key derivation) —
  only that it is encrypted at rest, pinned to a backend, and unreadable without
  the key.
- The `getBaseUrl`/`getHeaders` callback indirection; a conforming build may
  resolve the same values eagerly per request.
- The specific TypeScript class names (`FetchError`, `ResponseError`,
  `LLMThrottlingError`, …) provided the error identity, message, status and
  retryability match.
- Which OS keyring backend is used, beyond the observable file/account names and
  the `-dev` scoping.
- Provider-side prompt caching, prompt-cache headers, eager input streaming and
  native tool-call DSL recovery beyond the tool-call deltas described here.
