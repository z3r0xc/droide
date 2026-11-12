import assert from "node:assert/strict";
import { test } from "node:test";

import { runUpdateCommand } from "../../../src/cli/update-commands.ts";
import {
  MAX_RELEASE_BODY_BYTES,
  checkForUpdate,
  compareSemver,
  parseSemver,
} from "../../../src/update/check.ts";

const REPO = "owner/repo";

function releaseResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function check(fetchImpl: typeof fetch, currentVersion = "0.1.0") {
  return checkForUpdate({ repository: REPO, currentVersion, fetch: fetchImpl });
}

test("semver parsing accepts the two tag shapes and rejects the rest", () => {
  assert.deepEqual(parseSemver("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("1.2.3-beta.1"), [1, 2, 3]);
  assert.equal(parseSemver("release-1"), null);
  assert.equal(parseSemver("1.2"), null);
});

test("versions compare numerically", () => {
  assert.equal(compareSemver("1.10.0", "1.9.0"), 1);
  assert.equal(compareSemver("1.9.0", "1.10.0"), -1);
  assert.equal(compareSemver("1.9.0", "1.9.0"), 0);
  assert.equal(compareSemver("nope", "1.0.0"), null);
});

test("a newer release is reported as available", async () => {
  const result = await check(async () =>
    releaseResponse({
      tag_name: "v0.2.0",
      html_url: "https://example.test/r/0.2.0",
    }),
  );
  assert.deepEqual(result, {
    kind: "available",
    version: "0.2.0",
    url: "https://example.test/r/0.2.0",
    current: "0.1.0",
  });
});

test("the same or an older release means up to date", async () => {
  assert.deepEqual(
    await check(async () => releaseResponse({ tag_name: "v0.1.0" })),
    {
      kind: "current",
      version: "0.1.0",
    },
  );
  assert.deepEqual(
    await check(async () => releaseResponse({ tag_name: "v0.0.9" })),
    {
      kind: "current",
      version: "0.1.0",
    },
  );
});

test("a 404 is reported as an invisible feed, not as up to date", async () => {
  const result = await check(async () => new Response("", { status: 404 }));
  assert.deepEqual(result, {
    kind: "unavailable",
    reason:
      "no release feed visible to an anonymous client (no releases yet, or a private repository)",
  });
});

test("a rate-limited or failing feed is reported with the status", async () => {
  const result = await check(async () => new Response("", { status: 403 }));
  assert.equal(result.kind, "unavailable");
  assert.match(result.kind === "unavailable" ? result.reason : "", /403/);
});

test("a non-semver tag never upgrades", async () => {
  const result = await check(async () =>
    releaseResponse({ tag_name: "nightly" }),
  );
  assert.equal(result.kind, "unavailable");
  assert.match(
    result.kind === "unavailable" ? result.reason : "",
    /not a semantic version/,
  );
});

test("malformed JSON and an unexpected document are reported", async () => {
  const broken = await check(
    async () => new Response("{ nope", { status: 200 }),
  );
  assert.match(
    broken.kind === "unavailable" ? broken.reason : "",
    /malformed JSON/,
  );

  const array = await check(async () => new Response("[1,2]", { status: 200 }));
  assert.equal(array.kind, "unavailable");
});

test("an oversized body is refused instead of buffered", async () => {
  const huge = "x".repeat(MAX_RELEASE_BODY_BYTES + 10);
  const result = await check(async () => new Response(huge, { status: 200 }));
  assert.equal(result.kind, "unavailable");
  assert.match(result.kind === "unavailable" ? result.reason : "", /exceeds/);
});

test("a network failure is reported, never thrown", async () => {
  const result = await check(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  assert.equal(result.kind, "unavailable");
});

test("the request carries no credentials and no query parameters", async () => {
  let seen: URL | undefined;
  let headers: RequestInit["headers"] | undefined;
  const recordingFetch: typeof fetch = async (input, init) => {
    seen = input instanceof URL ? input : new URL(String(input));
    headers = init?.headers;
    return releaseResponse({ tag_name: "v0.0.1" });
  };
  await check(recordingFetch);

  assert.equal(
    seen?.toString(),
    `https://api.github.com/repos/${REPO}/releases/latest`,
  );
  assert.equal(seen?.search, "");
  assert.equal(JSON.stringify(headers).includes("authorization"), false);
});

function commandDeps() {
  let out = "";
  let err = "";
  let code = 0;
  return {
    deps: {
      currentVersion: "0.1.0",
      repository: REPO,
      fetch: (async () =>
        releaseResponse({ tag_name: "v0.1.0" })) as typeof fetch,
      write: (text: string) => {
        out += text;
      },
      writeError: (text: string) => {
        err += text;
      },
      setExitCode: (value: number) => {
        code = value;
      },
    },
    read: () => ({ out, err, code }),
  };
}

test("update without --check refuses with exit 2 and names the alternative", async () => {
  const { deps, read } = commandDeps();
  await runUpdateCommand({}, deps);
  assert.equal(read().code, 2);
  assert.match(read().err, /not implemented in this build/);
  assert.equal(read().out, "");
});

test("update --check reports up to date and exits 0", async () => {
  const { deps, read } = commandDeps();
  await runUpdateCommand({ check: true }, deps);
  assert.equal(read().code, 0);
  assert.match(read().out, /is up to date/);
});

test("update --check exits 1 when the feed is unavailable", async () => {
  const { deps, read } = commandDeps();
  await runUpdateCommand(
    { check: true },
    {
      ...deps,
      fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
    },
  );
  assert.equal(read().code, 1);
  assert.match(read().out, /no release feed visible/);
});

test("an available release prints the version and the page", async () => {
  const { deps, read } = commandDeps();
  await runUpdateCommand(
    { check: true },
    {
      ...deps,
      fetch: (async () =>
        releaseResponse({
          tag_name: "v9.9.9",
          html_url: "https://example.test/r",
        })) as typeof fetch,
    },
  );
  assert.equal(read().code, 0);
  assert.match(read().out, /9\.9\.9 is available \(running 0\.1\.0\)/);
  assert.match(read().out, /https:\/\/example\.test\/r/);
});
