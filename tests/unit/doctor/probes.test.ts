import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BUILTIN_CHECKS } from "../../../src/doctor/checks.ts";
import { parseChecks } from "../../../src/doctor/registry.ts";
import { runDoctor } from "../../../src/doctor/run.ts";
import type {
  DoctorContext,
  DoctorDaemonProbe,
} from "../../../src/doctor/types.ts";
import type {
  CustomModelProvider,
  Settings,
} from "../../../src/config/schema.ts";

interface ProbeContextOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly settings?: Settings;
  readonly fetch?: typeof fetch;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly daemon?: DoctorDaemonProbe;
  readonly factoryDir?: string;
  readonly cwd?: string;
}

function probeContext(options: ProbeContextOptions = {}): DoctorContext {
  return {
    settings: options.settings ?? {},
    paths: { factoryDir: options.factoryDir ?? "/tmp/factory" },
    environment: {
      platform: "linux",
      nodeVersion: "24.0.0",
      cwd: options.cwd ?? "/work",
      home: "/home/u",
      env: options.env ?? {},
    },
    timeoutMs: 5_000,
    withTimeout: async (_label, run) => run(new AbortController().signal),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.resolveHost === undefined
      ? {}
      : { resolveHost: options.resolveHost }),
    ...(options.daemon === undefined ? {} : { daemon: options.daemon }),
  };
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

interface Recorder {
  readonly calls: readonly Recorded[];
  readonly fetch: typeof fetch;
}

/** A fetch that never touches the network and records every request. */
function recordingFetch(respond: (url: string) => Response): Recorder {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url);
  };
  return { calls, fetch: fetchImpl };
}

function check(name: string) {
  const found = BUILTIN_CHECKS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`check ${name} is not registered`);
  return found;
}

function codeError(message: string, code: string): Error {
  const error = new Error(message);
  return Object.assign(error, { code });
}

/* -------------------------------------------------------------------------- */
/* Connectivity                                                               */
/* -------------------------------------------------------------------------- */

test("connectivity reports DNS, TLS and HTTP separately", async () => {
  const recorder = recordingFetch(() => new Response(null, { status: 204 }));

  const result = await check("connectivity").run(
    probeContext({
      resolveHost: async () => ["203.0.113.10"],
      fetch: recorder.fetch,
    }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(
    recorder.calls.map((call) => call.url),
    ["https://api.factory.ai/"],
  );
  assert.equal(recorder.calls[0]?.init.method, "HEAD");
  assert.deepEqual(result.details, [
    "base: https://api.factory.ai/",
    "DNS: 203.0.113.10",
    "TLS: handshake ok",
    "HTTP: 204",
  ]);
  assert.equal(result.metadata?.["dns"], "ok");
  assert.equal(result.metadata?.["tls"], "ok");
  assert.equal(result.metadata?.["http"], 204);
});

test("connectivity: a DNS failure is a warn with the reason, never a fail", async () => {
  const recorder = recordingFetch(() => new Response("", { status: 200 }));

  const result = await check("connectivity").run(
    probeContext({
      resolveHost: async () => {
        throw codeError("getaddrinfo ENOTFOUND api.factory.ai", "ENOTFOUND");
      },
      fetch: recorder.fetch,
    }),
  );

  assert.equal(result.status, "warn");
  assert.match(result.summary, /did not resolve/);
  assert.match(
    result.details?.[1] ?? "",
    /DNS: failed \(getaddrinfo ENOTFOUND/,
  );
  assert.equal(recorder.calls.length, 0);
});

test("connectivity: a TLS failure is a warn naming the TLS stage", async () => {
  const failure = new TypeError("fetch failed");
  Object.assign(failure, {
    cause: codeError("certificate has expired", "CERT_HAS_EXPIRED"),
  });

  const result = await check("connectivity").run(
    probeContext({
      resolveHost: async () => ["203.0.113.10"],
      fetch: async () => {
        throw failure;
      },
    }),
  );

  assert.equal(result.status, "warn");
  assert.match(result.summary, /TLS handshake/);
  assert.equal(
    result.details?.some(
      (line) => line === "TLS: failed (fetch failed (CERT_HAS_EXPIRED))",
    ),
    true,
  );
  assert.equal(result.metadata?.["tls"], "failed");
});

test("connectivity: a malformed base URL fails naming the variable", async () => {
  const result = await check("connectivity").run(
    probeContext({ env: { FACTORY_API_BASE_URL: "https://api.factory.ai/" } }),
  );

  assert.equal(result.status, "fail");
  assert.match(result.summary, /must not end with \//);
  assert.match(result.fixes?.[0] ?? "", /FACTORY_API_BASE_URL/);
});

/* -------------------------------------------------------------------------- */
/* Custom models                                                              */
/* -------------------------------------------------------------------------- */

test("custom-models: no entries skips", async () => {
  const result = await check("custom-models").run(probeContext());

  assert.equal(result.status, "skip");
  assert.match(result.summary, /no custom models configured/);
});

test("custom-models: a valid loopback entry is ok and keeps the key out of the report", async () => {
  const result = await check("custom-models").run(
    probeContext({
      settings: {
        customModels: [
          {
            id: "mock",
            model: "mock-1",
            provider: "openai",
            baseUrl: "http://127.0.0.1:9999/v1",
            apiKey: "sk-do-not-print",
          },
        ],
      },
    }),
  );

  assert.equal(result.status, "ok");
  assert.match(result.summary, /1 custom model valid/);
  assert.equal(JSON.stringify(result).includes("sk-do-not-print"), false);
});

test("custom-models: every malformed entry fails naming its index", async () => {
  const result = await check("custom-models").run(
    probeContext({
      settings: {
        customModels: [
          {
            model: "one",
            provider: "acme" as unknown as CustomModelProvider,
            baseUrl: "ftp://example.test/v1",
          },
          {
            model: "two",
            provider: "openai",
            baseUrl: "http://example.test/v1",
            apiKey: "k",
          },
        ],
      },
    }),
  );

  assert.equal(result.status, "fail");
  assert.match(result.summary, /2 custom models configured, 4 problems/);
  const details = result.details ?? [];
  assert.equal(
    details.some((line) => line.includes("customModels[0]")),
    true,
  );
  assert.equal(
    details.some((line) => line.includes("customModels[1]")),
    true,
  );
  assert.equal(
    details.some((line) => line.includes('unknown provider "acme"')),
    true,
  );
  assert.equal(
    details.some((line) => line.includes("plain http on example.test")),
    true,
  );
  assert.equal(result.metadata?.["problems"], 4);
});

/* -------------------------------------------------------------------------- */
/* Daemon                                                                     */
/* -------------------------------------------------------------------------- */

test("daemon: no endpoint configured skips", async () => {
  const result = await check("daemon").run(probeContext());

  assert.equal(result.status, "skip");
  assert.match(result.summary, /no daemon endpoint configured/);
});

test("daemon: an answering daemon reports its endpoint and version", async () => {
  const result = await check("daemon").run(
    probeContext({
      daemon: {
        endpoint: "127.0.0.1:4242",
        connect: async () => ({ protocolVersion: "1.321.0" }),
      },
    }),
  );

  assert.equal(result.status, "ok");
  assert.match(result.summary, /daemon answered at 127\.0\.0\.1:4242/);
  assert.deepEqual(result.details, [
    "endpoint: 127.0.0.1:4242",
    "protocol: 1.321.0",
  ]);
  assert.equal(result.metadata?.["protocolVersion"], "1.321.0");
});

test("daemon: a refused handshake fails naming the endpoint", async () => {
  const result = await check("daemon").run(
    probeContext({
      daemon: {
        endpoint: "/tmp/droide.sock",
        connect: async () => {
          throw new Error("Authentication failed");
        },
      },
    }),
  );

  assert.equal(result.status, "fail");
  assert.match(result.summary, /daemon did not answer at \/tmp\/droide\.sock/);
  assert.deepEqual(result.details, ["Authentication failed"]);
});

/* -------------------------------------------------------------------------- */
/* Inference                                                                  */
/* -------------------------------------------------------------------------- */

test("inference: the default run never probes a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droide-doctor-default-"));
  try {
    const recorder = recordingFetch(() => new Response("", { status: 404 }));
    const report = await runDoctor({
      checks: parseChecks(undefined),
      context: probeContext({
        factoryDir: directory,
        cwd: directory,
        env: { DROIDE_API_KEY: "fk-test-value" },
        fetch: recorder.fetch,
        resolveHost: async () => ["203.0.113.10"],
      }),
    });

    assert.equal(
      report.checks.some((entry) => entry.name === "inference"),
      false,
    );
    assert.deepEqual(
      recorder.calls.filter((call) => call.url.includes("/api/llm/")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inference: a selected check sends one tiny completion", async () => {
  const recorder = recordingFetch(
    () => new Response('{"id":"probe"}', { status: 200 }),
  );

  const result = await check("inference").run(
    probeContext({
      env: { DROIDE_API_KEY: "fk-test-value" },
      fetch: recorder.fetch,
    }),
  );

  assert.equal(result.status, "ok");
  assert.equal(recorder.calls.length, 1);
  const call = recorder.calls[0];
  assert.equal(
    call?.url,
    "https://api.factory.ai/api/llm/o/v1/chat/completions",
  );
  assert.equal(call?.init.method, "POST");
  const body: unknown = JSON.parse(String(call?.init.body));
  assert.deepEqual(body, {
    model: "gpt-6.1-sol",
    max_tokens: 1,
    messages: [{ role: "user", content: "reply with ok" }],
  });
  assert.match(result.summary, /gpt-6\.1-sol answered/);
  assert.equal(result.metadata?.["budgetMs"], 5_000);
});

test("inference: a provider refusal is reported with the credential redacted", async () => {
  const recorder = recordingFetch(
    () =>
      new Response('{"error":"bad key fk-test-value"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  );

  const result = await check("inference").run(
    probeContext({
      env: { DROIDE_API_KEY: "fk-test-value" },
      fetch: recorder.fetch,
    }),
  );

  assert.equal(result.status, "fail");
  assert.match(result.summary, /refused the request \(HTTP 401\)/);
  assert.equal(JSON.stringify(result).includes("fk-test-value"), false);
  assert.equal(
    result.details?.some((line) => line.includes("<redacted>")),
    true,
  );
});

test("inference: no model target fails before any request", async () => {
  const recorder = recordingFetch(() => new Response("", { status: 200 }));

  const result = await check("inference").run(
    probeContext({ fetch: recorder.fetch }),
  );

  assert.equal(result.status, "fail");
  assert.match(result.summary, /no model target/);
  assert.match(result.summary, /Authentication failed/);
  assert.equal(recorder.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Exec                                                                       */
/* -------------------------------------------------------------------------- */

test("exec: resolvable settings, model and tools are ok", async () => {
  const result = await check("exec").run(
    probeContext({ env: { DROIDE_API_KEY: "fk-test-value" } }),
  );

  assert.equal(result.status, "ok");
  assert.match(result.summary, /exec can start: gpt-6\.1-sol with \d+ tools/);
  assert.equal(
    result.details?.some(
      (line) =>
        line ===
        "endpoint: https://api.factory.ai/api/llm/o/v1/chat/completions",
    ),
    true,
  );
  assert.equal(typeof result.metadata?.["tools"], "number");
});

test("exec: an unresolved settings path fails before the model", async () => {
  const result = await check("exec").run(
    probeContext({ factoryDir: "", env: { DROIDE_API_KEY: "fk-test-value" } }),
  );

  assert.equal(result.status, "fail");
  assert.match(result.summary, /factory directory is not resolved/);
  assert.equal(result.metadata?.["stage"], "settings");
});

test("exec: a missing credential fails naming what is missing", async () => {
  const result = await check("exec").run(probeContext());

  assert.equal(result.status, "fail");
  assert.match(result.summary, /exec cannot start: Authentication failed/);
  assert.match(result.summary, /DROIDE_API_KEY/);
  assert.equal(result.metadata?.["stage"], "model");
});

/* -------------------------------------------------------------------------- */
/* Whole catalogue                                                            */
/* -------------------------------------------------------------------------- */

test("--checks all consults only the injected HTTP client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "droide-doctor-all-"));
  // A tripwire: any check that falls back to the global `fetch` tries the
  // network, which a doctor test must never do.
  const globalFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error("a doctor check reached the network");
  };
  try {
    const recorder = recordingFetch((url) =>
      url.includes("api.github.com")
        ? new Response("", { status: 404 })
        : new Response("", { status: 200 }),
    );

    const report = await runDoctor({
      checks: parseChecks("all"),
      context: probeContext({
        factoryDir: directory,
        cwd: directory,
        fetch: recorder.fetch,
        resolveHost: async () => ["203.0.113.10"],
      }),
    });

    assert.equal(globalCalls, 0);
    assert.deepEqual(recorder.calls.map((call) => call.url).sort(), [
      "https://api.factory.ai/",
      "https://api.github.com/repos/z3r0xc/droide/releases/latest",
    ]);
    assert.deepEqual(
      report.checks.map((entry) => entry.name),
      [...parseChecks("all")],
    );
  } finally {
    globalThis.fetch = globalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
