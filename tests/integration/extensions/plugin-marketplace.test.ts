/**
 * Marketplaces against a real temporary git repository. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B31 (layout), B32 (manifest),
 * B34 (sources) and B40 (the `marketplace` CLI).
 *
 * Every repository operand is a `file://` URL or a path under the temporary
 * root, asserted after each case. No test reaches the network, no test uses a
 * fixed port, and every temporary root is removed in `finally`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isRecord } from "../../../src/extensions/guards.ts";
import {
  PluginOperationError,
  addMarketplace,
  defaultPluginIo,
  knownMarketplacesPath,
  listMarketplaces,
  marketplacesDirectory,
  parseMarketplaceSource,
  removeMarketplace,
  renderMarketplaceList,
  updateMarketplaces,
  type MarketplaceDeps,
  type PluginIo,
} from "../../../src/extensions/plugins/marketplace.ts";
import {
  commitFile,
  createMarketplaceRepo,
  createTempRoot,
  localOnlyRunner,
  writeAt,
} from "./plugin-repo-fixtures.ts";

function marketplaceDeps(
  root: string,
  runGit?: MarketplaceDeps["runGit"],
): MarketplaceDeps {
  const factoryDir = join(root, "home", ".factory");
  return {
    scopeRoot: factoryDir,
    timeoutMs: 60_000,
    ...(runGit === undefined ? {} : { runGit }),
  };
}

function readRegistry(root: string): string {
  return readFileSync(
    knownMarketplacesPath(join(root, "home", ".factory")),
    "utf8",
  );
}

test("add clones a file-URL marketplace, validates it and records provenance", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "team-tools",
      manifestName: "Team Tools",
    });
    const local = localOnlyRunner();
    const info = await addMarketplace(
      repo.url,
      {},
      marketplaceDeps(root.path, local.runner),
    );

    assert.equal(info.name, "team-tools");
    assert.equal(info.pluginCount, 1);
    assert.equal(info.displayName, "Team Tools");
    assert.equal(info.entry.commit, repo.head);
    assert.equal(info.entry.source.source, "url");
    assert.ok(
      info.entry.installLocation.startsWith(
        marketplacesDirectory(join(root.path, "home", ".factory")),
      ),
    );
    assert.ok(
      existsSync(
        join(info.entry.installLocation, ".factory-plugin", "marketplace.json"),
      ),
    );

    const registry: unknown = JSON.parse(readRegistry(root.path));
    assert.ok(isRecord(registry));
    const recorded = registry["team-tools"];
    assert.ok(isRecord(recorded));
    const source = recorded["source"];
    assert.ok(isRecord(source));
    assert.equal(source["source"], "url");
    assert.equal(source["url"], repo.url);
    assert.equal(recorded["commit"], repo.head);

    assert.deepEqual(
      local.operands.filter((operand) => operand.includes("://")),
      [repo.url],
    );
  } finally {
    root.cleanup();
  }
});

test("add refuses an existing name and leaves the registry byte-identical", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "team-tools",
      manifestName: "Team Tools",
    });
    const deps = marketplaceDeps(root.path);
    await addMarketplace(repo.url, {}, deps);
    const before = readRegistry(root.path);

    await assert.rejects(
      addMarketplace(repo.url, {}, deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "marketplace-exists",
    );
    assert.equal(readRegistry(root.path), before);
  } finally {
    root.cleanup();
  }
});

test("add validates the manifest before adopting and leaves no checkout on failure", async () => {
  const root = createTempRoot();
  try {
    const repo = join(root.path, "broken-marketplace");
    writeAt(repo, "README.md", "no manifest here\n");
    const local = localOnlyRunner();

    await assert.rejects(
      addMarketplace(repo, {}, marketplaceDeps(root.path, local.runner)),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "manifest-invalid",
    );
    assert.equal(
      existsSync(
        join(
          join(root.path, "home", ".factory"),
          "plugins",
          "known_marketplaces.json",
        ),
      ),
      false,
    );
    assert.equal(
      existsSync(
        join(
          marketplacesDirectory(join(root.path, "home", ".factory")),
          "broken-marketplace",
        ),
      ),
      false,
    );
  } finally {
    root.cleanup();
  }
});

test("--branch checks out that branch and records its pin", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "pinned-tools",
      manifestName: "Pinned Tools",
      branch: "release/1.0",
    });
    const info = await addMarketplace(
      repo.url,
      { branch: "release/1.0" },
      marketplaceDeps(root.path),
    );

    assert.equal(info.name, "pinned-tools@release-1.0");
    assert.equal(info.displayName, "Pinned Tools-branch");
    assert.equal(
      info.entry.source.source === "url" ? info.entry.source.ref : undefined,
      "release/1.0",
    );
  } finally {
    root.cleanup();
  }
});

test("add registers a local directory in place", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "local-tools",
      manifestName: "Local Tools",
    });
    const deps = marketplaceDeps(root.path);
    const info = await addMarketplace(repo.path, {}, deps);

    assert.equal(info.entry.source.source, "local");
    assert.equal(info.entry.installLocation, repo.path);
    assert.equal(info.entry.commit, repo.head);
  } finally {
    root.cleanup();
  }
});

test("list reports each marketplace with its plugin count", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "team-tools",
      manifestName: "Team Tools",
      plugins: ["demo", "second"],
    });
    const deps = marketplaceDeps(root.path);
    await addMarketplace(repo.url, {}, deps);

    const result = listMarketplaces(deps);
    assert.equal(result.marketplaces.length, 1);
    assert.equal(result.marketplaces[0]?.name, "team-tools");
    assert.equal(result.marketplaces[0]?.pluginCount, 2);
    const rendered = renderMarketplaceList(result);
    assert.match(rendered, /team-tools/);
    assert.match(rendered, /Team Tools/);
    assert.match(rendered, / 2 /);
  } finally {
    root.cleanup();
  }
});

test("update fetches a new commit and keeps the checkout in place", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "team-tools",
      manifestName: "Team Tools",
    });
    const deps = marketplaceDeps(root.path);
    const added = await addMarketplace(repo.url, {}, deps);

    const updatedManifest = JSON.stringify({
      name: "Team Tools",
      plugins: [
        { name: "demo", source: "plugins/demo" },
        { name: "second", source: "plugins/second" },
      ],
    });
    writeAt(repo.path, "plugins/second/SKILL.md", "# second\n");
    const newHead = commitFile(
      repo.path,
      ".factory-plugin/marketplace.json",
      updatedManifest,
      "second plugin",
    );

    const outcomes = await updateMarketplaces("team-tools", deps);
    assert.deepEqual(outcomes, [
      { name: "team-tools", ok: true, commit: newHead },
    ]);
    const listed = listMarketplaces(deps).marketplaces[0];
    assert.equal(listed?.pluginCount, 2);
    assert.equal(listed?.entry.installLocation, added.entry.installLocation);
  } finally {
    root.cleanup();
  }
});

test("update reports one failure without dropping the other marketplaces", async () => {
  const root = createTempRoot();
  try {
    const first = createMarketplaceRepo(root.path, {
      directory: "first-tools",
      manifestName: "First",
    });
    const second = createMarketplaceRepo(root.path, {
      directory: "second-tools",
      manifestName: "Second",
    });
    const deps = marketplaceDeps(root.path);
    await addMarketplace(first.url, {}, deps);
    await addMarketplace(second.url, {}, deps);

    // Commit a manifest without plugins so the second refresh fails validation.
    commitFile(
      second.path,
      ".factory-plugin/marketplace.json",
      "{}",
      "break the manifest",
    );
    const outcomes = await updateMarketplaces(undefined, deps);
    assert.equal(outcomes.length, 2);
    assert.equal(
      outcomes.find((entry) => entry.name === "first-tools")?.ok,
      true,
    );
    assert.equal(
      outcomes.find((entry) => entry.name === "second-tools")?.ok,
      false,
    );
  } finally {
    root.cleanup();
  }
});

test("remove unregisters and deletes only a checkout this build created", async () => {
  const root = createTempRoot();
  try {
    const repo = createMarketplaceRepo(root.path, {
      directory: "team-tools",
      manifestName: "Team Tools",
    });
    const local = createMarketplaceRepo(root.path, {
      directory: "local-tools",
      manifestName: "Local Tools",
    });
    const deps = marketplaceDeps(root.path);
    const cloned = await addMarketplace(repo.url, {}, deps);
    await addMarketplace(local.path, {}, deps);

    const removed = await removeMarketplace("team-tools", deps);
    assert.equal(removed.checkoutRemoved, true);
    assert.equal(existsSync(cloned.entry.installLocation), false);

    await removeMarketplace("local-tools", deps);
    assert.equal(existsSync(local.path), true);

    assert.deepEqual(JSON.parse(readRegistry(root.path)), {});
    await assert.rejects(
      removeMarketplace("team-tools", deps),
      (error: unknown) =>
        error instanceof PluginOperationError &&
        error.code === "marketplace-not-found",
    );
  } finally {
    root.cleanup();
  }
});

test("a throwing registry rename leaves known_marketplaces.json untouched", async () => {
  const root = createTempRoot();
  try {
    const first = createMarketplaceRepo(root.path, {
      directory: "first-tools",
      manifestName: "First",
    });
    const second = createMarketplaceRepo(root.path, {
      directory: "second-tools",
      manifestName: "Second",
    });
    await addMarketplace(first.path, {}, marketplaceDeps(root.path));
    const before = readRegistry(root.path);

    const failing: PluginIo = {
      ...defaultPluginIo,
      rename(from, to) {
        if (to.endsWith("known_marketplaces.json"))
          throw new Error("injected rename failure");
        defaultPluginIo.rename(from, to);
      },
    };
    await assert.rejects(
      addMarketplace(
        second.path,
        {},
        {
          scopeRoot: join(root.path, "home", ".factory"),
          io: failing,
        },
      ),
      (error: unknown) =>
        error instanceof PluginOperationError && error.code === "write-failed",
    );
    assert.equal(readRegistry(root.path), before);
  } finally {
    root.cleanup();
  }
});

test("a source is parsed into a local path, a github repo or a git URL", () => {
  const cwd = process.cwd();
  assert.deepEqual(parseMarketplaceSource("./repo", { cwd }), {
    source: "local",
    path: join(cwd, "repo"),
  });
  assert.deepEqual(
    parseMarketplaceSource("https://github.com/acme/tools.git"),
    {
      source: "github",
      repo: "acme/tools",
    },
  );
  assert.deepEqual(
    parseMarketplaceSource("https://github.com/acme/tools#release/1.0", {
      branch: "main",
    }),
    { source: "github", repo: "acme/tools", ref: "main" },
  );
  assert.deepEqual(
    parseMarketplaceSource("ssh://git@example.test/acme/tools"),
    {
      source: "url",
      url: "ssh://git@example.test/acme/tools",
    },
  );
  assert.throws(
    () => parseMarketplaceSource("not a repository"),
    (error: unknown) =>
      error instanceof PluginOperationError &&
      error.code === "marketplace-invalid-source",
  );
});
