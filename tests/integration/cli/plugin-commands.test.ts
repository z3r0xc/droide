/**
 * `plugin` command bodies end to end. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B31-B40.
 *
 * The context is real (settings resolution included) but every path is under a
 * temporary root; git is the real binary through a runner that records every
 * operand, so the test can prove the source was a `file://` URL and nothing
 * reached the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { createAppContext } from "../../../src/app/context.ts";
import {
  runMarketplaceAdd,
  runMarketplaceList,
  runMarketplaceRemove,
  runMarketplaceUpdate,
  runPluginInstall,
  runPluginList,
  runPluginUninstall,
  runPluginUpdate,
  type PluginCommandDeps,
} from "../../../src/cli/plugin-commands.ts";
import type { Environment, Platform } from "../../../src/config/paths.ts";
import {
  createMarketplaceRepo,
  createTempRoot,
  localOnlyRunner,
} from "../extensions/plugin-repo-fixtures.ts";

const platform: Platform =
  process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";

interface Harness {
  readonly deps: PluginCommandDeps;
  readonly repo: { readonly path: string; readonly url: string };
  read(): { readonly out: string; readonly err: string; readonly code: number };
}

async function harness(root: string): Promise<Harness> {
  const repo = createMarketplaceRepo(root, {
    directory: "team-tools",
    manifestName: "Team Tools",
  });
  const home = join(root, "home");
  const project = join(root, "project");
  const environment: Environment = {
    env: {},
    home,
    platform,
    cwd: project,
  };
  const context = await createAppContext({ environment });
  const local = localOnlyRunner();
  let out = "";
  let err = "";
  let code = 0;
  const deps: PluginCommandDeps = {
    context,
    runGit: local.runner,
    write: (text) => {
      out += text;
    },
    writeError: (text) => {
      err += text;
    },
    setExitCode: (value) => {
      code = value;
    },
  };
  return {
    deps,
    repo: { path: repo.path, url: repo.url },
    read: () => ({ out, err, code }),
  };
}

test("the marketplace and install commands run through the CLI bodies", async () => {
  const root = createTempRoot("droide-plugin-cli-");
  try {
    const bench = await harness(root.path);

    await runMarketplaceAdd(bench.repo.url, {}, bench.deps);
    assert.match(
      bench.read().out,
      /Added marketplace "team-tools" \(1 plugin\)\./,
    );
    assert.equal(bench.read().code, 0);

    runMarketplaceList(bench.deps);
    assert.match(bench.read().out, /NAME\s+SOURCE\s+PLUGINS\s+DISPLAY NAME/);
    assert.match(bench.read().out, /Team Tools/);

    await runPluginInstall("demo@team-tools", {}, bench.deps);
    assert.match(
      bench.read().out,
      /Installed demo@team-tools \([0-9a-f]{7}\)\./,
    );
    assert.equal(bench.read().err, "");

    await runPluginList({}, bench.deps);
    assert.match(bench.read().out, /1 plugin installed, 1 enabled/);

    await runPluginUpdate("demo@team-tools", {}, bench.deps);
    assert.match(bench.read().out, /demo@team-tools is already up to date/);
    assert.equal(bench.read().code, 0);

    await runMarketplaceUpdate(undefined, bench.deps);
    assert.match(bench.read().out, /Updated marketplace "team-tools"\./);

    await runPluginUninstall("demo@team-tools", {}, bench.deps);
    assert.match(bench.read().out, /Uninstalled demo@team-tools\./);

    await runMarketplaceRemove("team-tools", bench.deps);
    assert.match(bench.read().out, /Removed marketplace "team-tools"\./);
    assert.equal(bench.read().code, 0);
  } finally {
    root.cleanup();
  }
});

test("a refused command reports on stderr and exits 1", async () => {
  const root = createTempRoot("droide-plugin-cli-");
  try {
    const bench = await harness(root.path);

    await runPluginInstall("demo@team-tools", {}, bench.deps);
    assert.match(
      bench.read().err,
      /Marketplace "team-tools" is not registered/,
    );
    assert.equal(bench.read().code, 1);

    await runPluginUpdate("demo@team-tools", { scope: "team" }, bench.deps);
    assert.match(bench.read().err, /Invalid --scope value: team/);
    assert.equal(bench.read().code, 1);

    await runMarketplaceUpdate("absent", bench.deps);
    assert.match(bench.read().err, /Marketplace "absent" is not registered/);
    assert.equal(bench.read().code, 1);
  } finally {
    root.cleanup();
  }
});
