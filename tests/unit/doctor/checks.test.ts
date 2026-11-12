import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BUILTIN_CHECKS } from "../../../src/doctor/checks.ts";
import type { DoctorContext } from "../../../src/doctor/types.ts";

function context(
  env: Readonly<Record<string, string | undefined>> = {},
): DoctorContext {
  return {
    settings: {},
    paths: { factoryDir: join(tmpdir(), "droide-doctor-provider") },
    environment: {
      platform: "linux",
      nodeVersion: "24.0.0",
      cwd: "/work",
      home: "/home/u",
      env,
    },
    timeoutMs: 5_000,
    withTimeout: async (_label, run) => run(new AbortController().signal),
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
    context({ FACTORY_API_KEY: "fk-secret-value" }),
  );
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("fk-secret-value"), false);
  assert.equal(result.metadata?.["length"], "fk-secret-value".length);
});

test("no credential warns and names the fix", async () => {
  const result = await check("auth").run(context());
  assert.equal(result.status, "warn");
  assert.match(result.fixes?.[0] ?? "", /FACTORY_API_KEY/);
});

test("every registered check has a unique name and a title", () => {
  const names = BUILTIN_CHECKS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(
    BUILTIN_CHECKS.every((entry) => entry.title.length > 0),
    true,
  );
});
