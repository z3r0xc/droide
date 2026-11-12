# transport/ — backend HTTP, auth headers, LLM stream

Spec: `specs/50-transport-and-auth.md` (§A, §B, §D, §I, §J).

| Module | Responsibility |
|---|---|
| `urls.ts` | Base-URL precedence (customer origin → EU base on `eu` → global base), region/Prem-host selection, origin canonicalization, path joining |
| `headers.ts` | Headers from one credential snapshot; case-insensitive merge; `redactHeaders`/`redactUrl` for every error path |
| `client.ts` | One `fetch` per request by default; opt-in retry; per-request deadline; bounded body; validating JSON parse |
| `errors.ts` | Status → typed error → user copy; API-key classification; LLM failure reasons and retryability |
| `sse.ts` | Streaming SSE framing: CRLF, multi-line `data:`, comments, `[DONE]`, truncation and size bounds |
| `llm.ts` | Provider-agnostic turn shape; parsed SSE → typed deltas for Anthropic, Responses, Chat |

## Timeouts

Every request takes an explicit `timeoutMs`, applied with
`AbortSignal.timeout` and combined with the caller's signal. The deadline covers
the whole exchange including the body. Callers own the values (10 s identity,
15 s WorkOS refresh / Prem auth).

## Retry

Default is one attempt (`NO_RETRY`), matching the ordinary backend boundary.
`REFRESH_RETRY` is the spec's transient-refresh policy: at most three retries,
500 ms × attempt. A retry happens only for an idempotent request and only on 429
or 5xx — never a 4xx auth failure. `Retry-After` (`retry-after-ms`, seconds or
an HTTP date) is a *minimum* delay. Sleeping and jitter are injected, so tests
assert exact delays without waiting.

## Security invariants

- The token lives only in the header record sent to `fetch`; errors carry
  `redactHeaders`, and URLs are reduced to origin + path (query dropped).
- Response bodies are untrusted: bounded by `MAX_RESPONSE_BYTES`, parsed only by
  a caller validator, and a customer-Prem failure never quotes the body.
- Redirects are manual: a hop must stay on the same origin and never downgrade
  HTTPS; a customer deployment refuses every redirect (`redirects: "refuse"`)
  and sends `credentials: "omit"`.
- An SSE event is bounded (`MAX_SSE_EVENT_BYTES`) and a body must end at an
  event boundary, so a broken stream fails instead of being silently truncated.
