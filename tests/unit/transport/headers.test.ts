import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HEADER_NAMES,
  REDACTED,
  USER_AGENT_HEADER,
  buildCustomerPremAuthHeaders,
  buildHeaders,
  buildWhoamiHeaders,
  headerValue,
  mergeHeaders,
  redactHeaders,
  redactUrl,
  stripAttributionHeaders,
  type CredentialSnapshot,
} from "../../../src/transport/headers.ts";

function snapshot(
  overrides: Partial<CredentialSnapshot> = {},
): CredentialSnapshot {
  return {
    token: "t",
    organization: "o",
    purpose: "operational",
    ...overrides,
  };
}

test("an operational snapshot yields auth, client attribution and organization", () => {
  assert.deepEqual(buildHeaders(snapshot(), { version: "1.9.0" }), {
    Authorization: "Bearer t",
    "X-Factory-Client": "cli",
    "X-Client-Version": "1.9.0",
    "X-Factory-Org-Id": "o",
  });
});

test("no token means no Authorization key", () => {
  const headers = buildHeaders(snapshot({ token: null }), { version: "1.9.0" });
  assert.equal("Authorization" in headers, false);
  assert.equal(headers["X-Factory-Org-Id"], "o");
});

test("no organization means no organization header", () => {
  const headers = buildHeaders(snapshot({ organization: null }));
  assert.equal("X-Factory-Org-Id" in headers, false);
});

test("X-Client-Version is sent only when a version is set", () => {
  assert.equal("X-Client-Version" in buildHeaders(snapshot()), false);
  assert.equal(
    buildHeaders(snapshot(), { version: null })["X-Client-Version"],
    undefined,
  );
});

test("a usage route sends no default client attribution", () => {
  const headers = buildHeaders(snapshot({ purpose: "usage" }), {
    version: "1.9.0",
  });
  assert.equal("X-Factory-Client" in headers, false);
  assert.equal(headers.Authorization, "Bearer t");
});

test("a usage route sends a known caller's attribution", () => {
  const headers = buildHeaders(
    snapshot({ purpose: "usage", callerKnown: true, client: "daemon" }),
    { version: "1.9.0" },
  );
  assert.equal(headers["X-Factory-Client"], "daemon");
});

test("SDK attribution adds X-Factory-Sdk", () => {
  const headers = buildHeaders(snapshot({ sdk: "1.9.0" }));
  assert.equal(headers["X-Factory-Sdk"], "1.9.0");
});

test("a caller header differing only in case never duplicates", () => {
  const base = buildHeaders(snapshot(), { version: "1.9.0" });
  const merged = mergeHeaders(base, {
    authorization: "Bearer caller",
    "x-factory-org-id": "caller-org",
  });
  assert.equal(merged.Authorization, "Bearer caller");
  assert.equal(merged["X-Factory-Org-Id"], "caller-org");
  const names = Object.keys(merged).map((name) => name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
});

test("mergeHeaders: later groups win and undefined values are skipped", () => {
  const merged = mergeHeaders(
    { A: "1", B: "base" },
    { b: "config", C: "trace" },
    { C: undefined, D: "caller" },
  );
  assert.deepEqual(merged, { A: "1", B: "config", C: "trace", D: "caller" });
});

test("the daemon builder adds Content-Type and a caller override wins", () => {
  const base = buildHeaders(snapshot(), { contentType: "application/json" });
  assert.equal(base["Content-Type"], "application/json");
  const merged = mergeHeaders(base, { "content-type": "text/plain" });
  assert.equal(headerValue(merged, "CONTENT-TYPE"), "text/plain");
  assert.equal(Object.keys(merged).length, Object.keys(base).length);
});

test("usage-route attribution supplied by a caller is stripped", () => {
  const stripped = stripAttributionHeaders({
    ...buildHeaders(snapshot(), { version: "1.9.0" }),
    "X-Factory-Request-Surface": "sdk",
    "x-factory-exec-output-format": "json",
  });
  assert.equal("X-Factory-Request-Surface" in stripped, false);
  assert.equal("X-Factory-Exec-Output-Format" in stripped, false);
  assert.equal(stripped.Authorization, "Bearer t");
});

test("an injected trace context is sent as traceparent (B18)", () => {
  const headers = buildHeaders(snapshot(), {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  });
  assert.equal(
    headers.traceparent,
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  assert.equal("traceparent" in buildHeaders(snapshot()), false);
});

test("a supplied user agent is sent (B17)", () => {
  const headers = buildHeaders(snapshot(), { userAgent: "droide/0.5.0" });
  assert.equal(headers[USER_AGENT_HEADER], "droide/0.5.0");
  assert.equal("User-Agent" in buildHeaders(snapshot()), false);
  assert.equal(USER_AGENT_HEADER, "User-Agent");
});

test("customer Prem auth headers carry only auth, organization and content type (B22)", () => {
  assert.deepEqual(buildCustomerPremAuthHeaders(snapshot(), true), {
    Authorization: "Bearer t",
    "X-Factory-Org-Id": "o",
    "Content-Type": "application/json",
  });
  assert.deepEqual(
    buildCustomerPremAuthHeaders(snapshot({ token: null }), false),
    {
      "X-Factory-Org-Id": "o",
    },
  );
});

test("whoami headers always ask for the extended answer", () => {
  const headers = buildWhoamiHeaders(snapshot(), {}, "attribution-1");
  assert.equal(headers["X-Factory-Whoami-Extended"], "true");
  assert.equal(headers["X-Factory-Session-Attribution"], "attribution-1");
  assert.equal(
    "X-Factory-Session-Attribution" in buildWhoamiHeaders(snapshot()),
    false,
  );
});

test("redaction replaces every credential-bearing value, not just Authorization", () => {
  const redacted = redactHeaders({
    Authorization: "Bearer secret-token",
    "X-Factory-Org-Id": "o",
    "x-api-key": "fk-secret",
    Cookie: "session=abc",
    "proxy-authorization": "Basic abc",
    "Content-Type": "application/json",
  });
  assert.deepEqual(redacted, {
    Authorization: REDACTED,
    "X-Factory-Org-Id": "o",
    "x-api-key": REDACTED,
    Cookie: REDACTED,
    "proxy-authorization": REDACTED,
    "Content-Type": "application/json",
  });
  assert.equal(JSON.stringify(redacted).includes("secret-token"), false);
  assert.equal(JSON.stringify(redacted).includes("fk-secret"), false);
});

test("redaction also accepts a Headers instance", () => {
  const headers = new Headers({
    authorization: "Bearer secret",
    accept: "application/json",
  });
  assert.deepEqual(redactHeaders(headers), {
    authorization: REDACTED,
    accept: "application/json",
  });
});

test("redactUrl drops credentials, query and fragment", () => {
  assert.equal(
    redactUrl("https://user:pass@api.example:8443/api/x?token=1#frag"),
    "https://api.example:8443/api/x",
  );
  assert.equal(redactUrl("not a url"), null);
});

test("the literal header names match the spec table", () => {
  assert.deepEqual(HEADER_NAMES, {
    authorization: "Authorization",
    organization: "X-Factory-Org-Id",
    client: "X-Factory-Client",
    sdk: "X-Factory-Sdk",
    requestSurface: "X-Factory-Request-Surface",
    execOutputFormat: "X-Factory-Exec-Output-Format",
    execInputFormat: "X-Factory-Exec-Input-Format",
    clientVersion: "X-Client-Version",
    whoamiExtended: "X-Factory-Whoami-Extended",
    sessionAttribution: "X-Factory-Session-Attribution",
    contentType: "Content-Type",
    traceparent: "traceparent",
  });
});
