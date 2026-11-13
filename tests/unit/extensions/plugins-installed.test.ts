import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareVersions,
  loadInstalledPlugins,
  renderPluginList,
} from "../../../src/extensions/plugins/installed.ts";

async function scope(
  root: string,
  name: "home" | "project",
  document: unknown,
): Promise<string> {
  const base = join(root, name);
  await mkdir(join(base, "plugins"), { recursive: true });
  await writeFile(
    join(base, "plugins", "installed_plugins.json"),
    JSON.stringify(document, null, 2),
  );
  return base;
}

function entry(installPath: string, version: string): Record<string, string> {
  return { installPath, version, installedAt: "2026-01-01T00:00:00.000Z" };
}

test("both scopes are read and project entries shadow user entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const stateDir = await scope(root, "home", {
      schemaVersion: 1,
      plugins: {
        shared: [entry("/u/shared", "1.0.0")],
        "user-only": [entry("/u/one", "0.1.0")],
      },
    });
    const projectDir = await scope(root, "project", {
      schemaVersion: 1,
      plugins: { shared: [entry("/p/shared", "2.0.0")] },
    });

    const result = loadInstalledPlugins({ stateDir, projectDir });

    assert.equal(result.plugins.length, 2);
    const shared = result.plugins.find((plugin) => plugin.id === "shared");
    assert.equal(shared?.scope, "project");
    assert.equal(shared?.installPath, "/p/shared");
    assert.equal(
      result.plugins.find((plugin) => plugin.id === "user-only")?.scope,
      "user",
    );
    assert.equal(result.diagnostics.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the highest version wins when an id has several entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const stateDir = await scope(root, "home", {
      schemaVersion: 1,
      plugins: {
        demo: [
          entry("/p/1", "1.2.0"),
          entry("/p/2", "1.10.0"),
          entry("/p/3", "1.9.9"),
        ],
      },
    });
    await mkdir(join(root, "project"), { recursive: true });

    const record = loadInstalledPlugins({
      stateDir,
      projectDir: join(root, "project"),
    }).plugins[0];

    assert.equal(record?.version, "1.10.0");
    assert.equal(record?.installPath, "/p/2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabledPlugins false disables a plugin, absent means enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const stateDir = await scope(root, "home", {
      schemaVersion: 1,
      plugins: {
        on: [entry("/p/on", "1.0.0")],
        off: [entry("/p/off", "1.0.0")],
      },
    });
    await mkdir(join(root, "project"), { recursive: true });

    const result = loadInstalledPlugins({
      stateDir,
      projectDir: join(root, "project"),
      enabledPlugins: { off: false },
    });

    assert.equal(
      result.plugins.find((plugin) => plugin.id === "off")?.enabled,
      false,
    );
    assert.equal(
      result.plugins.find((plugin) => plugin.id === "on")?.enabled,
      true,
    );
    assert.match(renderPluginList(result), /2 plugins installed, 1 enabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed registry is a diagnostic, and the other scope still loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const projectDir = await scope(root, "project", {
      schemaVersion: 1,
      plugins: { fine: [entry("/p/fine", "1.0.0")] },
    });
    const home = join(root, "home");
    await mkdir(join(home, "plugins"), { recursive: true });
    await writeFile(join(home, "plugins", "installed_plugins.json"), "{ nope");

    const result = loadInstalledPlugins({ stateDir: home, projectDir });

    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]?.id, "fine");
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0]?.message ?? "", /not valid JSON/);
    assert.match(renderPluginList(result), /problems:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an entry without installPath is skipped with a diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const stateDir = await scope(root, "home", {
      schemaVersion: 1,
      plugins: { bad: [{ version: "1.0.0" }] },
    });
    await mkdir(join(root, "project"), { recursive: true });

    const result = loadInstalledPlugins({
      stateDir,
      projectDir: join(root, "project"),
    });

    assert.equal(result.plugins.length, 0);
    assert.match(
      result.diagnostics[0]?.message ?? "",
      /no entry with an installPath/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing registry is normal, not a diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const result = loadInstalledPlugins({
      stateDir: join(root, "home"),
      projectDir: join(root, "project"),
    });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.diagnostics, []);
    assert.match(renderPluginList(result), /^0 plugins installed, 0 enabled$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the scope filter narrows the listing", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-plugins-"));
  try {
    const stateDir = await scope(root, "home", {
      schemaVersion: 1,
      plugins: { u: [entry("/u", "1.0.0")] },
    });
    const projectDir = await scope(root, "project", {
      schemaVersion: 1,
      plugins: { p: [entry("/p", "1.0.0")] },
    });
    const result = loadInstalledPlugins({ stateDir, projectDir });

    assert.match(
      renderPluginList(result, { scope: "project" }),
      /1 plugin installed/,
    );
    assert.equal(
      renderPluginList(result, { scope: "project" }).includes(" u "),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("versions compare numerically, not lexically", () => {
  assert.equal(compareVersions("1.10.0", "1.2.0") > 0, true);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions(undefined, "1.0.0") < 0, true);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0") < 0, true);
});
