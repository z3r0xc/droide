/**
 * Plugin source kinds, verification and provenance. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B34 (the six source kinds), B35
 * (checksum, npm identity and the provenance the load path re-authorizes) and
 * B36 (the strict allowlist and the token-host binding).
 *
 * Every artifact is local: a temporary git repository, a `file://` URL, a
 * directory, or bytes served by an injected `fetch`. No case reaches the
 * network, no case sleeps, and every temporary root is removed in `finally`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isRecord } from "../../../src/extensions/guards.ts";
import {
  installPlugin,
  installedPluginsPath,
  type PluginInstallDeps,
} from "../../../src/extensions/plugins/install.ts";
import { loadInstalledPlugins } from "../../../src/extensions/plugins/installed.ts";
import {
  MARKETPLACE_NOT_APPROVED_ERROR,
  PluginOperationError,
  addMarketplace,
  knownMarketplacesPath,
} from "../../../src/extensions/plugins/marketplace.ts";
import {
  ARCHIVE_LIMITS,
  NO_PLUGIN_POLICY,
  materializeSource,
  parsePluginSource,
  resolvePluginPolicy,
  type PluginPolicy,
  type PluginSource,
  type SourceDeps,
} from "../../../src/extensions/plugins/sources.ts";
import type { Settings } from "../../../src/config/schema.ts";
import {
  buildTarball,
  buildZip,
  createBareRepo,
  createMarketplaceRepo,
  createTempRoot,
  fakeFetch,
  gitIn,
  localGithubRunner,
  localOnlyRunner,
  writeAt,
} from "./plugin-repo-fixtures.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function policy(overrides: Partial<PluginPolicy> = {}): PluginPolicy {
  return { ...NO_PLUGIN_POLICY, ...overrides };
}

function registryDocument(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(parsed));
  return parsed;
}

/** A marketplace repository whose manifest lists the given plugin sources. */
function externalMarketplace(
  root: string,
  directory: string,
  plugins: readonly { readonly name: string; readonly source: unknown }[],
): string {
  const repo = join(root, directory);
  writeAt(
    repo,
    ".factory-plugin/marketplace.json",
    JSON.stringify({ name: directory, plugins }, null, 2),
  );
  gitIn(repo, ["init", "-q", "-b", "main"]);
  gitIn(repo, ["config", "user.email", "fixture@example.test"]);
  gitIn(repo, ["config", "user.name", "Fixture"]);
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-qm", "external sources"]);
  return repo;
}

async function bench(
  root: string,
  repository: string,
  options: {
    readonly fetch?: SourceDeps["fetch"];
    readonly policy?: PluginPolicy;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly limits?: SourceDeps["limits"];
    readonly timeoutSignal?: SourceDeps["timeoutSignal"];
  } = {},
): Promise<{
  readonly factoryDir: string;
  readonly projectDir: string;
  readonly deps: PluginInstallDeps;
}> {
  const factoryDir = join(root, "home", ".factory");
  const projectDir = join(root, "project", ".factory");
  await addMarketplace(repository, {}, { scopeRoot: factoryDir }).catch(
    (error: unknown) => {
      if (
        !(error instanceof PluginOperationError) ||
        error.code !== "marketplace-exists"
      )
        throw error;
    },
  );
  return {
    factoryDir,
    projectDir,
    deps: {
      scopes: { user: factoryDir, project: projectDir },
      timeoutMs: 60_000,
      policy: options.policy ?? NO_PLUGIN_POLICY,
      sourceDeps: {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.timeoutSignal === undefined
          ? {}
          : { timeoutSignal: options.timeoutSignal }),
      },
      ...(options.env === undefined ? {} : { env: options.env }),
    },
  };
}

test("every source kind is parsed and git-subdir without a path is refused", () => {
  assert.deepEqual(
    parsePluginSource({ source: "github", repo: "acme/tools", ref: "main" }),
    { source: "github", repo: "acme/tools", ref: "main" },
  );
  assert.deepEqual(
    parsePluginSource({ source: "url", url: "file:///tmp/tools#v1" }),
    { source: "url", url: "file:///tmp/tools#v1" },
  );
  assert.deepEqual(parsePluginSource({ source: "local", path: "/tmp/tools" }), {
    source: "local",
    path: "/tmp/tools",
  });
  assert.deepEqual(
    parsePluginSource({
      source: "git-subdir",
      url: "file:///tmp/tools",
      path: "plugins/demo/",
      sha: "A".repeat(40),
    }),
    {
      source: "git-subdir",
      url: "file:///tmp/tools",
      path: "plugins/demo",
      sha: "a".repeat(40),
    },
  );
  assert.deepEqual(
    parsePluginSource({
      source: "npm",
      package: "@acme/demo",
      version: "^1.2.0",
      registry: "https://registry.example.test",
      authTokenEnvVar: "FACTORY_PLUGIN_TOKEN_NPM",
    }),
    {
      source: "npm",
      package: "@acme/demo",
      version: "^1.2.0",
      registry: "https://registry.example.test",
      authTokenEnvVar: "FACTORY_PLUGIN_TOKEN_NPM",
    },
  );
  assert.deepEqual(
    parsePluginSource({
      source: "archive",
      url: "https://files.example.test/demo.zip",
      sha256: "B".repeat(64),
    }),
    {
      source: "archive",
      url: "https://files.example.test/demo.zip",
      sha256: "b".repeat(64),
    },
  );

  const invalid = (value: unknown) =>
    assert.throws(
      () => parsePluginSource(value),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-invalid",
    );
  invalid({ source: "git-subdir", url: "file:///tmp/tools" });
  invalid({ source: "git-subdir", url: "file:///tmp/tools", path: "../out" });
  invalid({ source: "npm", package: "demo", version: "file:../../../etc" });
  invalid({ source: "npm", package: "demo", registry: "http://insecure.test" });
  invalid({ source: "archive", url: "" });
  invalid({
    source: "archive",
    url: "file:///tmp/x.zip",
    authTokenEnvVar: "1BAD",
  });
  invalid({ source: "github", repo: "not a repository" });
  invalid({ source: "unknown", url: "file:///tmp/x" });
});

test("a local source is used in place", async () => {
  const root = createTempRoot();
  try {
    const directory = join(root.path, "local-plugin");
    writeAt(directory, ".factory-plugin/plugin.json", "{}\n");
    const materialized = await materializeSource(
      { source: "local", path: directory },
      { target: join(root.path, "unused") },
    );
    assert.equal(materialized.directory, directory);
    assert.equal(materialized.version, "local");
    assert.equal(existsSync(join(root.path, "unused")), false);
  } finally {
    root.cleanup();
  }
});

test("a github source clones through git and records its commit", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "team-tools",
      manifestName: "Team Tools",
    });
    const bare = createBareRepo(root.path, repo.path, "team-tools.git");
    const local = localGithubRunner(bare.path);
    const target = join(root.path, "checkout");
    const materialized = await materializeSource(
      { source: "github", repo: "acme/team-tools" },
      { target, deps: { runGit: local.runner, timeoutMs: 60_000 } },
    );
    assert.equal(materialized.version, repo.head.slice(0, 12));
    assert.equal(materialized.commit, repo.head);
    assert.equal(
      existsSync(join(target, ".factory-plugin", "marketplace.json")),
      true,
    );
    assert.deepEqual(local.urls, ["https://github.com/acme/team-tools.git"]);
  } finally {
    root.cleanup();
  }
});

test("a file:// url source clones with no network operand", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "url-tools",
      manifestName: "URL Tools",
    });
    const local = localOnlyRunner();
    const target = join(root.path, "checkout");
    const materialized = await materializeSource(
      { source: "url", url: repo.url },
      { target, deps: { runGit: local.runner, timeoutMs: 60_000 } },
    );
    assert.equal(materialized.version, repo.head.slice(0, 12));
    assert.deepEqual(
      local.operands.filter((operand) => operand.includes("://")),
      [repo.url],
    );
  } finally {
    root.cleanup();
  }
});

test("a git-subdir source publishes only the named subdirectory", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "subdir-tools",
      manifestName: "Subdir Tools",
    });
    const local = localOnlyRunner();
    const target = join(root.path, "checkout");
    const materialized = await materializeSource(
      {
        source: "git-subdir",
        url: repo.url,
        path: "plugins/demo",
      },
      { target, deps: { runGit: local.runner, timeoutMs: 60_000 } },
    );
    assert.equal(materialized.version, repo.head.slice(0, 12));
    assert.equal(materialized.commit, repo.head);
    assert.equal(existsSync(join(target, "SKILL.md")), true);
    assert.equal(
      existsSync(join(target, ".factory-plugin", "marketplace.json")),
      false,
    );
  } finally {
    root.cleanup();
  }
});

test("an archive source verifies its digest and installs through the marketplace", async () => {
  const root = createTempRoot();
  try {
    const archive = buildZip([
      { name: "skills/demo/SKILL.md", data: "# demo\n", method: "deflate" },
      { name: ".factory-plugin/plugin.json", data: "{}\n" },
    ]);
    const fetch = fakeFetch({
      "https://files.example.test/demo.zip": { body: archive },
    });
    const repo = externalMarketplace(root.path, "archive-tools", [
      {
        name: "demo",
        source: {
          source: "archive",
          url: "https://files.example.test/demo.zip",
          sha256: sha256(archive),
        },
      },
    ]);
    const scaffold = await bench(root.path, repo, { fetch: fetch.fetch });
    const entry = await installPlugin("demo@archive-tools", {}, scaffold.deps);

    assert.equal(entry.version, `archive-${sha256(archive).slice(0, 12)}`);
    assert.equal(
      existsSync(join(entry.installPath, "skills", "demo", "SKILL.md")),
      true,
    );
    assert.equal(entry.externalSource, undefined);
    const entries = registryDocument(installedPluginsPath(scaffold.factoryDir))[
      "plugins"
    ];
    assert.ok(isRecord(entries));
    const stored = entries["demo@archive-tools"];
    assert.ok(Array.isArray(stored));
    assert.equal(
      isRecord(stored[0]) ? stored[0]["externalSource"] : "x",
      undefined,
    );
    assert.match(
      String(isRecord(stored[0]) ? stored[0]["marketplaceSourceHash"] : ""),
      /^[0-9a-f]{64}$/u,
    );
  } finally {
    root.cleanup();
  }
});

test("a checksum mismatch fails the install", async () => {
  const root = createTempRoot();
  try {
    const archive = buildZip([{ name: "SKILL.md", data: "# demo\n" }]);
    const fetch = fakeFetch({
      "https://files.example.test/demo.zip": { body: archive },
    });
    const repo = externalMarketplace(root.path, "checksum-tools", [
      {
        name: "demo",
        source: {
          source: "archive",
          url: "https://files.example.test/demo.zip",
          sha256: "0".repeat(64),
        },
      },
    ]);
    const scaffold = await bench(root.path, repo, { fetch: fetch.fetch });
    await assert.rejects(
      installPlugin("demo@checksum-tools", {}, scaffold.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "checksum-mismatch",
    );
    assert.equal(fetch.urls.length, 1);
  } finally {
    root.cleanup();
  }
});

test("a malformed archive digest is refused before any download", async () => {
  const root = createTempRoot();
  try {
    const fetch = fakeFetch({});
    const repo = externalMarketplace(root.path, "digest-tools", [
      {
        name: "demo",
        source: {
          source: "archive",
          url: "https://files.example.test/demo.zip",
          sha256: "abc",
        },
      },
    ]);
    const scaffold = await bench(root.path, repo, { fetch: fetch.fetch });
    await assert.rejects(
      installPlugin("demo@digest-tools", {}, scaffold.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-invalid",
    );
    assert.deepEqual(fetch.urls, []);
  } finally {
    root.cleanup();
  }
});

test("the archive limits are the published numbers and each refusal is enforced", async () => {
  assert.deepEqual(ARCHIVE_LIMITS, {
    maxDownloadBytes: 256 * 1024 * 1024,
    downloadTimeoutMs: 120_000,
    maxRedirects: 5,
    maxEntries: 100_000,
    maxFileBytes: 512 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    maxCompressionRatio: 50,
  });

  const root = createTempRoot();
  try {
    const materialize = async (
      url: string,
      options: {
        readonly limits?: SourceDeps["limits"];
        readonly fetch?: SourceDeps["fetch"];
        readonly timeoutSignal?: SourceDeps["timeoutSignal"];
      },
    ) => {
      const directory = join(
        root.path,
        `out-${Math.random().toString(36).slice(2)}`,
      );
      return materializeSource(
        { source: "archive", url },
        {
          target: directory,
          deps: {
            ...(options.limits === undefined ? {} : { limits: options.limits }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.timeoutSignal === undefined
              ? {}
              : { timeoutSignal: options.timeoutSignal }),
          },
        },
      );
    };
    const refuses = async (
      detail: RegExp,
      url: string,
      options: Parameters<typeof materialize>[1],
    ) =>
      assert.rejects(
        materialize(url, options),
        (error: unknown) =>
          error instanceof PluginOperationError &&
          error.code === "archive-limit" &&
          detail.test(error.message),
      );

    const url = "https://files.example.test/demo.zip";
    const big = buildZip([{ name: "SKILL.md", data: "x".repeat(64) }]);
    await refuses(/larger than Droid allows/, url, {
      fetch: fakeFetch({ [url]: { body: big } }).fetch,
      limits: { ...ARCHIVE_LIMITS, maxDownloadBytes: 8 },
    });

    const tooMany = buildZip([
      { name: "skills/a/SKILL.md", data: "a" },
      { name: "skills/b/SKILL.md", data: "b" },
      { name: "skills/c/SKILL.md", data: "c" },
    ]);
    await refuses(/more than 2 files/, url, {
      fetch: fakeFetch({ [url]: { body: tooMany } }).fetch,
      limits: { ...ARCHIVE_LIMITS, maxEntries: 2 },
    });

    const largeFile = buildZip([{ name: "SKILL.md", data: "x".repeat(10) }]);
    await refuses(/file larger than Droid allows/, url, {
      fetch: fakeFetch({ [url]: { body: largeFile } }).fetch,
      limits: { ...ARCHIVE_LIMITS, maxFileBytes: 5 },
    });

    const total = buildZip([
      { name: "skills/a/SKILL.md", data: "x".repeat(6) },
      { name: "skills/b/SKILL.md", data: "y".repeat(6) },
    ]);
    await refuses(/larger than Droid allows/, url, {
      fetch: fakeFetch({ [url]: { body: total } }).fetch,
      limits: { ...ARCHIVE_LIMITS, maxFileBytes: 8, maxTotalBytes: 10 },
    });

    const bomb = buildZip([
      { name: "skills/a/SKILL.md", data: "a".repeat(4096), method: "deflate" },
    ]);
    await refuses(/expands far more than it should/, url, {
      fetch: fakeFetch({ [url]: { body: bomb } }).fetch,
      limits: { ...ARCHIVE_LIMITS, maxCompressionRatio: 2 },
    });

    const redirectFetch = fakeFetch({
      "https://files.example.test/a.zip": {
        status: 302,
        headers: { location: "https://files.example.test/b.zip" },
      },
      "https://files.example.test/b.zip": {
        status: 302,
        headers: { location: "https://files.example.test/b.zip" },
      },
    });
    await assert.rejects(
      materialize("https://files.example.test/a.zip", {
        fetch: redirectFetch.fetch,
        limits: { ...ARCHIVE_LIMITS, maxRedirects: 1 },
      }),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-fetch-failed" &&
        /redirected too many times/u.test(error.message),
    );

    const neverCalled = fakeFetch({});
    await assert.rejects(
      materialize(url, {
        fetch: neverCalled.fetch,
        timeoutSignal: () => AbortSignal.abort(),
      }),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-fetch-failed" &&
        /timed out/u.test(error.message),
    );
    assert.deepEqual(neverCalled.urls, []);
  } finally {
    root.cleanup();
  }
});

test("an npm source records its resolved identity and version", async () => {
  const root = createTempRoot();
  try {
    const tarball = buildTarball({
      "skills/demo/SKILL.md": "# demo\n",
      ".factory-plugin/plugin.json": "{}\n",
    });
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const resolved =
      "https://registry.example.test/demo-plugin/-/demo-plugin-1.2.0.tgz";
    const metadata = {
      "dist-tags": { latest: "1.2.0" },
      versions: {
        "1.2.0": { version: "1.2.0", dist: { tarball: resolved, integrity } },
      },
    };
    const fetch = fakeFetch({
      "https://registry.example.test/demo-plugin": {
        body: new TextEncoder().encode(JSON.stringify(metadata)),
      },
      [resolved]: { body: tarball },
    });
    const repo = externalMarketplace(root.path, "npm-tools", [
      {
        name: "demo",
        source: {
          source: "npm",
          package: "demo-plugin",
          version: "^1.2.0",
          registry: "https://registry.example.test",
        },
      },
    ]);
    const scaffold = await bench(root.path, repo, { fetch: fetch.fetch });
    const entry = await installPlugin("demo@npm-tools", {}, scaffold.deps);

    assert.equal(entry.version, "1.2.0");
    assert.deepEqual(entry.npm, {
      spec: "^1.2.0",
      version: "1.2.0",
      resolved,
      integrity,
    });
    assert.deepEqual(entry.externalSource, {
      source: "npm",
      package: "demo-plugin",
      version: "^1.2.0",
      registry: "https://registry.example.test",
    });
    assert.equal(
      existsSync(join(entry.installPath, "skills", "demo", "SKILL.md")),
      true,
    );

    const plugins = registryDocument(installedPluginsPath(scaffold.factoryDir))[
      "plugins"
    ];
    assert.ok(isRecord(plugins));
    const stored = plugins["demo@npm-tools"];
    assert.ok(Array.isArray(stored) && isRecord(stored[0]));
    assert.deepEqual(stored[0]["npm"], entry.npm);
  } finally {
    root.cleanup();
  }
});

test("provenance survives a round-trip and a changed source is refused on load", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "prov-tools",
      manifestName: "Prov Tools",
    });
    const factoryDir = join(root.path, "home", ".factory");
    const projectDir = join(root.path, "project", ".factory");
    await addMarketplace(repo.path, {}, { scopeRoot: factoryDir });
    await installPlugin(
      "demo@prov-tools",
      {},
      { scopes: { user: factoryDir, project: projectDir } },
    );

    const trusted = loadInstalledPlugins({ factoryDir, projectDir });
    assert.equal(trusted.plugins.length, 1);
    assert.deepEqual(trusted.diagnostics, []);

    const registry = registryDocument(knownMarketplacesPath(factoryDir));
    const recorded = registry["prov-tools"];
    assert.ok(isRecord(recorded) && isRecord(recorded["source"]));
    writeFileSync(
      knownMarketplacesPath(factoryDir),
      JSON.stringify(
        {
          "prov-tools": {
            ...recorded,
            source: { source: "local", path: join(root.path, "another-tools") },
          },
        },
        null,
        2,
      ),
    );

    const refused = loadInstalledPlugins({ factoryDir, projectDir });
    assert.deepEqual(refused.plugins, []);
    assert.equal(refused.diagnostics.length, 1);
    assert.match(refused.diagnostics[0]?.message ?? "", /no longer matches/u);
  } finally {
    root.cleanup();
  }
});

test("the strict allowlist refuses a marketplace and an external source", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "denied-tools",
      manifestName: "Denied Tools",
    });
    const denyAll = policy({ allowedSources: [] });
    await assert.rejects(
      addMarketplace(
        repo.path,
        {},
        {
          scopeRoot: join(root.path, "home", ".factory"),
          policy: { allowedSources: [] },
        },
      ),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-denied" &&
        error.message === MARKETPLACE_NOT_APPROVED_ERROR,
    );

    const scaffold = await bench(root.path, repo.path, { policy: policy() });
    await assert.rejects(
      installPlugin(
        "demo@denied-tools",
        {},
        { ...scaffold.deps, policy: denyAll },
      ),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-denied" &&
        error.message ===
          'Installing plugins from "denied-tools" is not allowed by organization policy',
    );
  } finally {
    root.cleanup();
  }
});

test("token hosts come from user and org settings only", () => {
  const userSettings: Settings = {
    pluginTokenHosts: { FACTORY_PLUGIN_TOKEN_DEMO: "files.example.test" },
  };
  assert.equal(
    resolvePluginPolicy(userSettings, [
      { level: "user", settings: userSettings },
    ]).tokenHosts.get("FACTORY_PLUGIN_TOKEN_DEMO"),
    "files.example.test",
  );
  assert.equal(
    resolvePluginPolicy(userSettings, [
      {
        level: "org",
        settings: {
          pluginTokenHosts: { FACTORY_PLUGIN_TOKEN_DEMO: "org.example.test" },
        },
      },
      { level: "user", settings: userSettings },
    ]).tokenHosts.get("FACTORY_PLUGIN_TOKEN_DEMO"),
    "org.example.test",
  );

  assert.throws(
    () =>
      resolvePluginPolicy(userSettings, [
        {
          level: "project",
          settings: {
            pluginTokenHosts: {
              FACTORY_PLUGIN_TOKEN_DEMO: "evil.example.test",
            },
          },
        },
      ]),
    (error: unknown) =>
      error instanceof PluginOperationError &&
      error.code === "settings-invalid" &&
      /user and organization settings/u.test(error.message),
  );
});

test("an archive token goes only to the host its variable is bound to", async () => {
  const root = createTempRoot();
  try {
    const archive = buildZip([
      { name: ".factory-plugin/plugin.json", data: "{}\n" },
      { name: "skills/demo/SKILL.md", data: "# demo\n" },
    ]);
    const url = "https://files.example.test/demo.zip";
    const fetch = fakeFetch({ [url]: { body: archive } });
    const source = {
      source: "archive",
      url,
      authTokenEnvVar: "FACTORY_PLUGIN_TOKEN_DEMO",
    } as const;
    const repo = externalMarketplace(root.path, "token-tools", [
      { name: "demo", source },
    ]);

    const bound = policy({
      tokenHosts: new Map([
        ["FACTORY_PLUGIN_TOKEN_DEMO", "files.example.test"],
      ]),
    });
    const allowed = await bench(root.path, repo, {
      fetch: fetch.fetch,
      policy: bound,
      env: { FACTORY_PLUGIN_TOKEN_DEMO: "secret-value" },
    });
    await installPlugin("demo@token-tools", {}, allowed.deps);
    assert.equal(fetch.headers[0]?.["Authorization"], "Bearer secret-value");

    const unbound = policy({
      tokenHosts: new Map([
        ["FACTORY_PLUGIN_TOKEN_DEMO", "other.example.test"],
      ]),
    });
    const refused = await bench(root.path, repo, {
      fetch: fetch.fetch,
      policy: unbound,
      env: { FACTORY_PLUGIN_TOKEN_DEMO: "secret-value" },
    });
    await assert.rejects(
      installPlugin("demo@token-tools", {}, refused.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-denied" &&
        /don't allow sending it/u.test(error.message),
    );
  } finally {
    root.cleanup();
  }
});

test("extraKnownMarketplaces registers on demand and a drifted source is refused", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "extra-tools",
      manifestName: "Extra Tools",
    });
    const factoryDir = join(root.path, "home", ".factory");
    const projectDir = join(root.path, "project", ".factory");
    const configured = policy({
      extraMarketplaces: new Map<string, PluginSource>([
        ["extra-tools", { source: "local", path: repo.path }],
      ]),
    });
    await installPlugin(
      "demo@extra-tools",
      {},
      { scopes: { user: factoryDir, project: projectDir }, policy: configured },
    );
    const registry = registryDocument(knownMarketplacesPath(factoryDir));
    assert.ok(isRecord(registry["extra-tools"]));

    const other = createMarketplaceRepo(root.path, {
      directory: "other-tools",
      manifestName: "Other Tools",
    });
    await assert.rejects(
      installPlugin(
        "demo@extra-tools",
        {},
        {
          scopes: { user: factoryDir, project: projectDir },
          policy: policy({
            extraMarketplaces: new Map<string, PluginSource>([
              ["extra-tools", { source: "local", path: other.path }],
            ]),
          }),
        },
      ),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-mismatch" &&
        error.message ===
          'Marketplace "extra-tools" does not match its configured source',
    );
  } finally {
    root.cleanup();
  }
});

test("a git-subdir plugin records its external source and commit", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "subdir-install",
      manifestName: "Subdir Install",
    });
    const manifest = {
      name: "Subdir Install",
      plugins: [
        {
          name: "demo",
          source: {
            source: "git-subdir",
            url: repo.url,
            path: "plugins/demo",
          },
        },
      ],
    };
    writeAt(
      repo.path,
      ".factory-plugin/marketplace.json",
      JSON.stringify(manifest, null, 2),
    );
    gitIn(repo.path, ["add", "-A"]);
    gitIn(repo.path, ["commit", "-qm", "git-subdir source"]);
    const head = gitIn(repo.path, ["rev-parse", "HEAD"]).trim();

    const factoryDir = join(root.path, "home", ".factory");
    const projectDir = join(root.path, "project", ".factory");
    const local = localOnlyRunner();
    await addMarketplace(repo.path, {}, { scopeRoot: factoryDir });
    const entry = await installPlugin(
      "demo@subdir-install",
      {},
      {
        scopes: { user: factoryDir, project: projectDir },
        runGit: local.runner,
        timeoutMs: 60_000,
        policy: policy(),
      },
    );
    assert.equal(entry.version, head.slice(0, 12));
    assert.equal(entry.externalCommit, head);
    assert.deepEqual(entry.externalSource, {
      source: "git-subdir",
      url: repo.url,
      path: "plugins/demo",
    });
    assert.equal(existsSync(join(entry.installPath, "SKILL.md")), true);
    const plugins = registryDocument(installedPluginsPath(factoryDir))[
      "plugins"
    ];
    assert.ok(isRecord(plugins));
    const stored = plugins["demo@subdir-install"];
    assert.ok(Array.isArray(stored) && isRecord(stored[0]));
    assert.deepEqual(stored[0]["externalSource"], entry.externalSource);
    assert.equal(stored[0]["externalCommit"], head);
  } finally {
    root.cleanup();
  }
});
