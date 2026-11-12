import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BUILTIN_CHECKS } from "../../../src/doctor/checks.ts";
import type { DoctorContext } from "../../../src/doctor/types.ts";

function context(
  env: Readonly<Record<string, string | undefined>> = {},
  fetchImpl?: typeof fetch,
): DoctorContext {
  return {
    settings: {},
    paths: { stateDir: join(tmpdir(), "droide-doctor-provider") },
    environment: {
      platform: "linux",
      nodeVersion: "24.0.0",
      cwd: "/work",
      home: "/home/u",
      env,
    },
    timeoutMs: 5_000,
    withTimeout: async (_label, run) => run(new AbortController().signal),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  };
}

function check(name: string) {
  const found = BUILTIN_CHECKS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`check ${name} is not registered`);
  return found;
}

test("proxy with no variables configured is ok", async () => {
  const result = await check("proxy").run(context());
  assert.equal(result.status, "ok");
  assert.match(result.summary, /no proxy configured/);
});

test("a malformed proxy URL fails with a fix", async () => {
  const result = await check("proxy").run(
    context({ HTTPS_PROXY: "proxy.internal:8080" }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.summary, /HTTPS_PROXY must be an http\(s\) URL/);
  assert.equal(result.fixes?.length, 1);
});

test("a valid proxy is reported without credentials", async () => {
  const result = await check("proxy").run(
    context({ HTTPS_PROXY: "http://user:pass@proxy.internal:3128" }),
  );
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("pass"), false);
});

test("an unreadable extra CA bundle fails", async () => {
  const result = await check("certs").run(
    context({ NODE_EXTRA_CA_CERTS: join(tmpdir(), "missing-ca.pem") }),
  );
  assert.equal(result.status, "fail");
});

test("a readable extra CA bundle is ok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droide-ca-"));
  try {
    const file = join(dir, "ca.pem");
    await writeFile(file, "-----BEGIN CERTIFICATE-----\n");
    const result = await check("certs").run(
      context({ NODE_EXTRA_CA_CERTS: file }),
    );
    assert.equal(result.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an API key in the environment is reported by length only", async () => {
  const result = await check("auth").run(
    context({ DROIDE_API_KEY: "fk-secret-value" }),
  );
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("fk-secret-value"), false);
  assert.equal(result.metadata?.["length"], "fk-secret-value".length);
});

test("no credential warns and names the fix", async () => {
  const result = await check("auth").run(context());
  assert.equal(result.status, "warn");
  assert.match(result.fixes?.[0] ?? "", /DROIDE_API_KEY/);
});

test("every registered check has a unique name and a title", () => {
  const names = BUILTIN_CHECKS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(
    BUILTIN_CHECKS.every((entry) => entry.title.length > 0),
    true,
  );
});

function releaseFetch(tag: string | undefined, status = 200): typeof fetch {
  return async () =>
    new Response(
      tag === undefined
        ? ""
        : JSON.stringify({ tag_name: tag, html_url: "https://example.test/r" }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
}

test("updates reports the current release as ok", async () => {
  const result = await check("updates").run(
    context({}, releaseFetch("v0.0.1")),
  );
  assert.equal(result.status, "ok");
  assert.match(result.summary, /newest published release/);
});

test("updates reports a newer release as a warning with the install fix", async () => {
  const result = await check("updates").run(
    context({}, releaseFetch("v99.0.0")),
  );
  assert.equal(result.status, "warn");
  assert.match(result.summary, /99\.0\.0 is available/);
  assert.match(result.fixes?.[0] ?? "", /droide update/);
});

test("updates skips when the feed is invisible", async () => {
  const result = await check("updates").run(
    context({}, releaseFetch(undefined, 404)),
  );
  assert.equal(result.status, "skip");
  assert.match(result.summary, /could not check for updates/);
});
