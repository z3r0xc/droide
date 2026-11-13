/**
 * Plugin installation against a real temporary git marketplace. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B31 (layout), B37 (install), B38
 * (uninstall) and B39 (update).
 *
 * The marketplace is registered from a local directory, so the only git the
 * tests invoke is a local `rev-parse`; no case reaches the network and every
 * temporary root is removed in `finally`.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isRecord } from "../../../src/extensions/guards.ts";
import {
  installPlugin,
  installedPluginsPath,
  uninstallPlugin,
  updatePlugins,
  type PluginInstallDeps,
} from "../../../src/extensions/plugins/install.ts";
import {
  PluginOperationError,
  addMarketplace,
  defaultPluginIo,
  type PluginIo,
} from "../../../src/extensions/plugins/marketplace.ts";
import {
  commitFile,
  createMarketplaceRepo,
  createTempRoot,
  gitIn,
  localOnlyRunner,
  writeAt,
} from "./plugin-repo-fixtures.ts";

interface Sandbox {
  readonly stateDir: string;
  readonly projectDir: string;
  readonly repo: { readonly path: string; readonly head: string };
  readonly deps: PluginInstallDeps;
}

async function sandbox(
  root: string,
  options: { readonly plugins?: readonly string[] } = {},
): Promise<Sandbox> {
  const repo = createMarketplaceRepo(root, {
    directory: "team-tools",
    manifestName: "Team Tools",
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  const stateDir = join(root, "home", ".droide");
  const projectDir = join(root, "project", ".droide");
  const local = localOnlyRunner();
  await addMarketplace(
    repo.path,
    {},
    {
      scopeRoot: stateDir,
      timeoutMs: 60_000,
      runGit: local.runner,
    },
  );
  const deps: PluginInstallDeps = {
    scopes: { user: stateDir, project: projectDir },
    timeoutMs: 60_000,
    runGit: local.runner,
  };
  return {
    stateDir,
    projectDir,
    repo: { path: repo.path, head: repo.head },
    deps,
  };
}

function registryDocument(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(parsed));
  return parsed;
}

function entriesFor(
  path: string,
  id: string,
): readonly Record<string, unknown>[] {
  const plugins = registryDocument(path)["plugins"];
  assert.ok(isRecord(plugins));
  const entries = plugins[id];
  assert.ok(Array.isArray(entries));
  return entries.filter(isRecord);
}

test("install copies the plugin into the cache and records its entry", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const entry = await installPlugin("demo@team-tools", {}, bench.deps);

    assert.equal(entry.id, "demo@team-tools");
    assert.equal(entry.scope, "user");
    assert.equal(entry.version, bench.repo.head.slice(0, 12));
    assert.equal(
      entry.installPath,
      join(bench.stateDir, "plugins", "demo@team-tools", entry.version),
    );
    assert.equal(existsSync(join(entry.installPath, "SKILL.md")), true);

    const entries = entriesFor(
      installedPluginsPath(bench.stateDir),
      "demo@team-tools",
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.["installPath"], entry.installPath);
    assert.equal(entries[0]?.["source"], "team-tools");
    assert.match(
      String(entries[0]?.["marketplaceSourceHash"]),
      /^[0-9a-f]{64}$/u,
    );
  } finally {
    root.cleanup();
  }
});

test("the same id is refused in the other scope", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    await addMarketplace(
      bench.repo.path,
      {},
      {
        scopeRoot: bench.projectDir,
      },
    );
    await installPlugin("demo@team-tools", { scope: "project" }, bench.deps);

    await assert.rejects(
      installPlugin("demo@team-tools", {}, bench.deps),
      (error: unknown) =>
        error instanceof PluginOperationError && error.code === "plugin-exists",
    );
    assert.equal(existsSync(installedPluginsPath(bench.stateDir)), false);
  } finally {
    root.cleanup();
  }
});

test("unknown marketplaces and plugins are refused and nothing is written", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    await assert.rejects(
      installPlugin("demo@missing", {}, bench.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "marketplace-not-found",
    );
    await assert.rejects(
      installPlugin("absent@team-tools", {}, bench.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "plugin-not-found",
    );
    await assert.rejects(
      installPlugin("demo", {}, bench.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "plugin-id-invalid",
    );
    assert.equal(existsSync(installedPluginsPath(bench.stateDir)), false);
    assert.equal(existsSync(join(bench.stateDir, "settings.json")), false);
  } finally {
    root.cleanup();
  }
});

test("reinstalling in one scope replaces that entry and keeps other ids intact", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const other = {
      scope: "user",
      installPath: "/elsewhere/other",
      version: "1.0.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
      source: "elsewhere",
    };
    writeAt(
      bench.stateDir,
      "plugins/installed_plugins.json",
      `${JSON.stringify(
        { schemaVersion: 1, plugins: { "other@elsewhere": [other] } },
        null,
        2,
      )}\n`,
    );

    const first = await installPlugin("demo@team-tools", {}, bench.deps);
    commitFile(
      bench.repo.path,
      "plugins/demo/SKILL.md",
      "# changed\n",
      "second version",
    );
    const second = await installPlugin("demo@team-tools", {}, bench.deps);

    assert.notEqual(first.installPath, second.installPath);
    assert.equal(existsSync(first.installPath), false);
    assert.equal(existsSync(second.installPath), true);
    const document = registryDocument(installedPluginsPath(bench.stateDir));
    const plugins = document["plugins"];
    assert.ok(isRecord(plugins));
    assert.deepEqual(plugins["other@elsewhere"], [other]);
    assert.equal(
      entriesFor(installedPluginsPath(bench.stateDir), "demo@team-tools")
        .length,
      1,
    );
  } finally {
    root.cleanup();
  }
});

test("a source that climbs out of the marketplace is refused", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const manifest = JSON.stringify({
      name: "Team Tools",
      plugins: [{ name: "escape", source: "../../outside" }],
    });
    commitFile(
      bench.repo.path,
      ".droide-plugin/marketplace.json",
      manifest,
      "escaping source",
    );
    await assert.rejects(
      installPlugin("escape@team-tools", {}, bench.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "source-invalid",
    );
  } finally {
    root.cleanup();
  }
});

test("install writes the enablement entry, sorted, and is idempotent", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path, { plugins: ["demo", "second"] });
    writeAt(
      bench.stateDir,
      "settings.json",
      '{\n  "enabledPlugins": {\n    "mike@team-tools": true\n  }\n}\n',
    );
    await installPlugin("second@team-tools", {}, bench.deps);
    await installPlugin("demo@team-tools", {}, bench.deps);
    await installPlugin("demo@team-tools", {}, bench.deps);

    assert.equal(
      readFileSync(join(bench.stateDir, "settings.json"), "utf8"),
      [
        "{",
        '  "enabledPlugins": {',
        '    "demo@team-tools": true,',
        '    "mike@team-tools": true,',
        '    "second@team-tools": true',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  } finally {
    root.cleanup();
  }
});

test("install into a JSONC settings file leaves every other byte in place", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const text = [
      "{",
      "  // my settings",
      '  "theme": "dark", /* keep */',
      '  "enabledPlugins": {},',
      "  // a trailing note",
      '  "strictEnabledPlugins": false',
      "}",
      "",
    ].join("\n");
    writeAt(bench.stateDir, "settings.json", text);

    await installPlugin("demo@team-tools", {}, bench.deps);

    assert.equal(
      readFileSync(join(bench.stateDir, "settings.json"), "utf8"),
      [
        "{",
        "  // my settings",
        '  "theme": "dark", /* keep */',
        '  "enabledPlugins": {',
        '    "demo@team-tools": true',
        "  },",
        "  // a trailing note",
        '  "strictEnabledPlugins": false',
        "}",
        "",
      ].join("\n"),
    );
  } finally {
    root.cleanup();
  }
});

test("install at project scope records enablement in project settings", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    await addMarketplace(bench.repo.path, {}, { scopeRoot: bench.projectDir });
    await installPlugin("demo@team-tools", { scope: "project" }, bench.deps);

    assert.equal(existsSync(join(bench.stateDir, "settings.json")), false);
    assert.equal(
      readFileSync(join(bench.projectDir, "settings.json"), "utf8"),
      '{\n  "enabledPlugins": {\n    "demo@team-tools": true\n  }\n}\n',
    );
  } finally {
    root.cleanup();
  }
});

test("a settings file that cannot be written refuses the install outright", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const path = writeAt(
      bench.stateDir,
      "settings.json",
      '{ "theme": "dark" }\n',
    );
    chmodSync(path, 0o444);
    try {
      await assert.rejects(
        installPlugin("demo@team-tools", {}, bench.deps),
        (error: unknown) =>
          error instanceof PluginOperationError &&
          error.code === "settings-not-writable",
      );
      assert.equal(readFileSync(path, "utf8"), '{ "theme": "dark" }\n');
      assert.equal(existsSync(installedPluginsPath(bench.stateDir)), false);
      assert.equal(
        existsSync(join(bench.stateDir, "plugins", "demo@team-tools")),
        false,
      );
    } finally {
      chmodSync(path, 0o644);
    }
  } finally {
    root.cleanup();
  }
});

test("uninstall removes the enablement entry and keeps the rest of the file", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const entry = await installPlugin("demo@team-tools", {}, bench.deps);
    writeAt(
      bench.stateDir,
      "settings.json",
      [
        "{",
        '  "theme": "dark",',
        "  // enablement",
        '  "enabledPlugins": {',
        '    "demo@team-tools": true,',
        '    "other@team-tools": false',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const removed = await uninstallPlugin("demo@team-tools", {}, bench.deps);
    assert.equal(removed.scope, "user");
    assert.equal(existsSync(entry.installPath), false);
    assert.equal(
      readFileSync(join(bench.stateDir, "settings.json"), "utf8"),
      [
        "{",
        '  "theme": "dark",',
        "  // enablement",
        '  "enabledPlugins": {',
        '    "other@team-tools": false',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const plugins = registryDocument(installedPluginsPath(bench.stateDir))[
      "plugins"
    ];
    assert.ok(isRecord(plugins));
    assert.equal(Object.hasOwn(plugins, "demo@team-tools"), false);
  } finally {
    root.cleanup();
  }
});

test("uninstall resolves the scope and reports an absent plugin", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    await addMarketplace(
      bench.repo.path,
      {},
      {
        scopeRoot: bench.projectDir,
      },
    );
    const entry = await installPlugin(
      "demo@team-tools",
      { scope: "project" },
      bench.deps,
    );

    const removed = await uninstallPlugin("demo@team-tools", {}, bench.deps);
    assert.equal(removed.scope, "project");
    assert.equal(existsSync(entry.installPath), false);

    await assert.rejects(
      uninstallPlugin("demo@team-tools", {}, bench.deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "plugin-not-installed",
    );
  } finally {
    root.cleanup();
  }
});

test("update replaces the copy only when the version differs", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    const entry = await installPlugin("demo@team-tools", {}, bench.deps);

    const unchanged = await updatePlugins("demo@team-tools", {}, bench.deps);
    assert.deepEqual(unchanged, {
      outcomes: [
        {
          id: "demo@team-tools",
          scope: "user",
          version: entry.version,
          changed: false,
        },
      ],
      missing: [],
    });

    const newHead = commitFile(
      bench.repo.path,
      "plugins/demo/SKILL.md",
      "# version two\n",
      "second version",
    );
    const updated = await updatePlugins("demo@team-tools", {}, bench.deps);
    const outcome = updated.outcomes[0];
    assert.equal(outcome?.changed, true);
    assert.equal(outcome?.version, newHead.slice(0, 12));
    assert.equal(existsSync(entry.installPath), false);

    const entries = entriesFor(
      installedPluginsPath(bench.stateDir),
      "demo@team-tools",
    );
    assert.equal(entries[0]?.["version"], newHead.slice(0, 12));
    assert.equal(existsSync(String(entries[0]?.["installPath"] ?? "")), true);

    const missing = await updatePlugins("absent@team-tools", {}, bench.deps);
    assert.deepEqual(missing, {
      outcomes: [],
      missing: ["absent@team-tools"],
    });
  } finally {
    root.cleanup();
  }
});

test("a throwing registry rename leaves installed_plugins.json untouched", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path, { plugins: ["demo", "second"] });
    await installPlugin("demo@team-tools", {}, bench.deps);
    const path = installedPluginsPath(bench.stateDir);
    const before = readFileSync(path, "utf8");

    const failing: PluginIo = {
      ...defaultPluginIo,
      rename(from, to) {
        if (to.endsWith("installed_plugins.json"))
          throw new Error("injected rename failure");
        defaultPluginIo.rename(from, to);
      },
    };
    await assert.rejects(
      installPlugin("second@team-tools", {}, { ...bench.deps, io: failing }),
      (error: unknown) =>
        error instanceof PluginOperationError && error.code === "write-failed",
    );
    assert.equal(readFileSync(path, "utf8"), before);
    // The enablement entry was written before the copy; the failed install
    // must not leave the plugin named in settings, and the earlier plugin's
    // entry must survive the undo.
    const settings = readFileSync(
      join(bench.stateDir, "settings.json"),
      "utf8",
    );
    assert.doesNotMatch(settings, /second@team-tools/u);
    assert.match(settings, /demo@team-tools/u);
  } finally {
    root.cleanup();
  }
});

test("an entry is written with a trailing newline and stable keys", async () => {
  const root = createTempRoot();
  try {
    const bench = await sandbox(root.path);
    await installPlugin("demo@team-tools", {}, bench.deps);
    const raw = readFileSync(installedPluginsPath(bench.stateDir), "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.match(raw, /"schemaVersion": 1/u);
    assert.match(raw, /"demo@team-tools"/u);
  } finally {
    root.cleanup();
  }
});

test("a Claude-layout plugin is translated into ours on install (B42)", async () => {
  const root = createTempRoot();
  try {
    const repo = join(root.path, "claude-tools");
    writeAt(
      repo,
      ".droide-plugin/marketplace.json",
      JSON.stringify(
        {
          name: "Claude Tools",
          description: "fixture",
          plugins: [{ name: "cplugin", source: "plugins/cplugin" }],
        },
        null,
        2,
      ),
    );
    writeAt(repo, "plugins/cplugin/.claude-plugin/plugin.json", "{}\n");
    writeAt(repo, "plugins/cplugin/agents/reviewer.md", "# reviewer\n");
    writeAt(
      repo,
      "plugins/cplugin/.mcp.json",
      JSON.stringify({ demo: { command: "node", args: ["server.js"] } }),
    );
    gitIn(repo, ["init", "-q", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "fixture@example.test"]);
    gitIn(repo, ["config", "user.name", "Fixture"]);
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-qm", "claude layout"]);

    const stateDir = join(root.path, "home", ".droide");
    const local = localOnlyRunner();
    await addMarketplace(
      repo,
      {},
      { scopeRoot: stateDir, timeoutMs: 60_000, runGit: local.runner },
    );
    const deps: PluginInstallDeps = {
      scopes: {
        user: stateDir,
        project: join(root.path, "project", ".droide"),
      },
      timeoutMs: 60_000,
      runGit: local.runner,
    };
    const entry = await installPlugin("cplugin@claude-tools", {}, deps);

    assert.equal(existsSync(join(entry.installPath, ".claude-plugin")), false);
    assert.equal(existsSync(join(entry.installPath, ".droide-plugin")), true);
    assert.equal(existsSync(join(entry.installPath, "agents")), false);
    assert.equal(
      existsSync(join(entry.installPath, "droids/reviewer.md")),
      true,
    );
    assert.equal(existsSync(join(entry.installPath, ".mcp.json")), false);
    const mcp = JSON.parse(
      readFileSync(join(entry.installPath, "mcp.json"), "utf8"),
    );
    assert.deepEqual(mcp, {
      mcpServers: { demo: { command: "node", args: ["server.js"] } },
    });
  } finally {
    root.cleanup();
  }
});
