import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvalidBaseUrlError,
  InvalidDeploymentOriginError,
  canonicalizeCustomerOrigin,
  createApiUrlConfig,
  joinApiPath,
  parseApiBaseUrl,
  resolveApiRequestUrl,
  resolveCliApiBaseUrl,
  resolvePremBaseHost,
  resolveRegion,
  type ApiUrlConfig,
  type BakedApiUrls,
} from "../../../src/transport/urls.ts";

const BAKED: BakedApiUrls = {
  apiBaseUrl: "https://api.example",
  apiBaseUrlEu: "https://eu.example",
};

function factoryConfig(
  env: Readonly<Record<string, string | undefined>>,
  baked: BakedApiUrls = BAKED,
): ApiUrlConfig {
  return createApiUrlConfig({
    deployment: { kind: "factory" },
    environment: { env },
    baked,
  });
}

interface BaseUrlCase {
  readonly name: string;
  readonly deployment: "factory" | "customer-prem";
  readonly region: "global" | "eu";
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly baked: BakedApiUrls;
  readonly expected: string;
}

const MATRIX: readonly BaseUrlCase[] = [
  {
    name: "factory + global uses the global base",
    deployment: "factory",
    region: "global",
    env: {},
    baked: BAKED,
    expected: "https://api.example/",
  },
  {
    name: "factory + eu uses the EU base when configured",
    deployment: "factory",
    region: "eu",
    env: {},
    baked: BAKED,
    expected: "https://eu.example/",
  },
  {
    name: "factory + eu falls back when the EU base is absent",
    deployment: "factory",
    region: "eu",
    env: {},
    baked: { apiBaseUrl: "https://api.example", apiBaseUrlEu: null },
    expected: "https://api.example/",
  },
  {
    name: "customer Prem wins over the EU base",
    deployment: "customer-prem",
    region: "eu",
    env: {},
    baked: BAKED,
    expected: "https://prem.example/",
  },
  {
    name: "the environment beats the baked define",
    deployment: "factory",
    region: "global",
    env: { FACTORY_API_BASE_URL: "https://env.example" },
    baked: BAKED,
    expected: "https://env.example/",
  },
  {
    name: "the EU environment value beats the baked EU define",
    deployment: "factory",
    region: "eu",
    env: { FACTORY_API_BASE_URL_EU: "https://eu-env.example" },
    baked: BAKED,
    expected: "https://eu-env.example/",
  },
];

for (const testCase of MATRIX) {
  test(`base URL matrix: ${testCase.name}`, () => {
    const config = createApiUrlConfig({
      deployment:
        testCase.deployment === "factory"
          ? { kind: "factory" }
          : { kind: "customer-prem", origin: "https://prem.example" },
      environment: { env: testCase.env },
      baked: testCase.baked,
    });
    assert.equal(
      resolveCliApiBaseUrl(config, testCase.region).href,
      testCase.expected,
    );
  });
}

test("an explicit override beats the environment and the baked define", () => {
  const config = createApiUrlConfig({
    deployment: { kind: "factory" },
    environment: { env: { FACTORY_API_BASE_URL: "https://env.example" } },
    baked: BAKED,
    overrides: { apiBaseUrl: "https://override.example" },
  });
  assert.equal(config.apiBaseUrl.href, "https://override.example/");
});

test("an explicit null EU override removes the EU branch", () => {
  const config = createApiUrlConfig({
    deployment: { kind: "factory" },
    environment: { env: {} },
    baked: BAKED,
    overrides: { apiBaseUrlEu: null },
  });
  assert.equal(resolveCliApiBaseUrl(config, "eu").href, "https://api.example/");
});

test("a customer deployment leaves apiBaseUrlEu unset", () => {
  const config = createApiUrlConfig({
    deployment: { kind: "customer-prem", origin: "https://prem.example" },
    environment: { env: {} },
    baked: BAKED,
  });
  assert.equal(config.apiBaseUrlEu, null);
});

test("reject cases: empty, trailing slash and non-http schemes throw", () => {
  assert.throws(() => parseApiBaseUrl("", "base"), InvalidBaseUrlError);
  assert.throws(
    () => parseApiBaseUrl("https://api.example/", "base"),
    InvalidBaseUrlError,
  );
  assert.throws(
    () => parseApiBaseUrl("ftp://api.example", "base"),
    InvalidBaseUrlError,
  );
  assert.throws(
    () => parseApiBaseUrl("ws://api.example", "base"),
    InvalidBaseUrlError,
  );
});

test("a configured base URL carrying credentials or a query is refused", () => {
  assert.throws(
    () => parseApiBaseUrl("https://user:pass@api.example", "base"),
    InvalidBaseUrlError,
  );
  assert.throws(
    () => parseApiBaseUrl("https://api.example?token=1", "base"),
    InvalidBaseUrlError,
  );
  assert.throws(
    () => parseApiBaseUrl("https://api.example#frag", "base"),
    InvalidBaseUrlError,
  );
});

test("an empty environment value falls through to the baked define", () => {
  const config = factoryConfig({ FACTORY_API_BASE_URL: "" });
  assert.equal(config.apiBaseUrl.href, "https://api.example/");
});

test("resolveRegion: no credential, no identity region and customer Prem are global", () => {
  assert.equal(
    resolveRegion({
      deployment: { kind: "factory" },
      hasCredential: false,
      identityRegion: "eu",
    }),
    "global",
  );
  assert.equal(
    resolveRegion({
      deployment: { kind: "factory" },
      hasCredential: true,
      identityRegion: null,
    }),
    "global",
  );
  assert.equal(
    resolveRegion({
      deployment: { kind: "customer-prem", origin: "https://prem.example" },
      hasCredential: true,
      identityRegion: "eu",
    }),
    "global",
  );
  assert.equal(
    resolveRegion({
      deployment: { kind: "factory" },
      hasCredential: true,
      identityRegion: "eu",
    }),
    "eu",
  );
});

test("resolvePremBaseHost: customer origin, premBaseHostV2, or hosted", () => {
  assert.equal(
    resolvePremBaseHost({
      deployment: { kind: "customer-prem", origin: "https://prem.example" },
      identity: { premBaseHostV2: "https://ignored.example" },
    })?.origin,
    "https://prem.example",
  );
  assert.equal(
    resolvePremBaseHost({
      deployment: { kind: "factory" },
      identity: { premBaseHostV2: "https://managed.example" },
    })?.origin,
    "https://managed.example",
  );
  assert.equal(
    resolvePremBaseHost({ deployment: { kind: "factory" }, identity: null }),
    null,
  );
  assert.equal(
    resolvePremBaseHost({
      deployment: { kind: "factory" },
      identity: { premBaseHostV2: "" },
    }),
    null,
  );
});

test("customer origin canonicalization accepts a bare host and strips a trailing dot", () => {
  assert.equal(
    canonicalizeCustomerOrigin("  prem.example.  ").href,
    "https://prem.example/",
  );
  assert.equal(
    canonicalizeCustomerOrigin("http://localhost:8080").href,
    "http://localhost:8080/",
  );
});

test("customer origin canonicalization rejects what B72 refuses", () => {
  const rejected = [
    "",
    "https://prem.example/path",
    "https://prem.example?x=1",
    "https://prem.example#frag",
    "https://user:pass@prem.example",
    "https://prem.example\\path",
    "https://prem example",
    "http://prem.example",
    "ftp://prem.example",
  ];
  for (const value of rejected) {
    assert.throws(
      () => canonicalizeCustomerOrigin(value),
      InvalidDeploymentOriginError,
      value,
    );
  }
});

test("joinApiPath keeps a base path prefix and refuses absolute paths", () => {
  const base = parseApiBaseUrl("https://prem.example/prefix", "base");
  assert.equal(
    joinApiPath(base, "/api/sessions/v2").href,
    "https://prem.example/prefix/api/sessions/v2",
  );
  assert.equal(
    resolveApiRequestUrl(factoryConfig({}), "global", "/api/cli/whoami").href,
    "https://api.example/api/cli/whoami",
  );
  assert.throws(() => joinApiPath(base, "api/x"), InvalidBaseUrlError);
  assert.throws(() => joinApiPath(base, "//evil.example/x"), InvalidBaseUrlError);
  assert.throws(
    () => joinApiPath(base, "\\api\\x"),
    InvalidBaseUrlError,
  );
});