import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAppContext } from "../../../src/app/context.ts";
import type { Environment } from "../../../src/config/paths.ts";

/**
 * Path rules are fixed per platform, so the fixture must use the host's: a
 * hard-coded platform builds expectations with the wrong separator.
 */
const HOST_PLATFORM: Environment["platform"] =
  process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";

async function fixture(): Promise<{
  root: string;
  home: string;
  project: string;
  environment: Environment;
}> {
  const root = await mkdtemp(join(tmpdir(), "droide-context-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".factory"), { recursive: true });
  await mkdir(join(home, ".factory"), { recursive: true });
  const environment: Environment = {
    env: {},
    home,
    // Path rules are fixed per platform, so the fixture must use the host's:
    // a hard-coded platform builds expectations with the wrong separator.
    platform: HOST_PLATFORM,
    cwd: project,
  };
  return { root, home, project, environment };
}

test("the user layer is read from the injected home", async () => {
  const { root, home, environment } = await fixture();
  try {
    await writeFile(
      join(home, ".factory", "settings.json"),
      JSON.stringify({ skills: ["user"] }),
    );

    const context = await createAppContext({ environment });

    assert.deepEqual(context.settings.skills, ["user"]);
    assert.deepEqual(
      context.layers.map((layer) => layer.level),
      ["user"],
    );
    assert.equal(
      context.paths.userSettingsFile,
      join(home, ".factory", "settings.json"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project layer wins over the user layer", async () => {
  const { root, home, project, environment } = await fixture();
  try {
    await writeFile(
      join(home, ".factory", "settings.json"),
      JSON.stringify({ skills: ["user"] }),
    );
    await writeFile(
      join(project, ".factory", "settings.json"),
      JSON.stringify({ skills: ["project"] }),
    );

    const context = await createAppContext({ environment });

    assert.deepEqual(context.settings.skills, ["project"]);
    assert.deepEqual(
      context.layers.map((layer) => layer.level),
      ["project", "user"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--settings wins over both layers and points at the overlay file", async () => {
  const { root, project, environment } = await fixture();
  try {
    const overlay = join(project, "overlay.json");
    await writeFile(overlay, JSON.stringify({ skills: ["overlay"] }));

    const context = await createAppContext({
      environment,
      settingsFlag: overlay,
    });

    assert.deepEqual(context.settings.skills, ["overlay"]);
    assert.deepEqual(
      context.layers.map((layer) => layer.level),
      ["runtime"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FACTORY_RUNTIME_SETTINGS_PATH applies when --settings is absent", async () => {
  const { root, project, environment } = await fixture();
  try {
    const overlay = join(project, "env-overlay.json");
    await writeFile(overlay, JSON.stringify({ skills: ["env"] }));

    const context = await createAppContext({
      environment: {
        ...environment,
        env: { FACTORY_RUNTIME_SETTINGS_PATH: overlay },
      },
    });

    assert.deepEqual(context.settings.skills, ["env"]);
    assert.equal(context.layers[0]?.level, "runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable overlay is dropped and reported, not fatal", async () => {
  const { root, project, environment } = await fixture();
  try {
    const missing = join(project, "does-not-exist.json");

    const context = await createAppContext({
      environment,
      settingsFlag: missing,
    });

    assert.equal(context.layers.length, 0);
    assert.equal(context.droppedOverlays.length, 1);
    assert.equal(context.droppedOverlays[0]?.path, missing);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--cwd moves the project layer and paths but not the user layer", async () => {
  const { root, home, project, environment } = await fixture();
  try {
    const other = join(root, "other");
    await mkdir(join(other, ".factory"), { recursive: true });
    await writeFile(
      join(home, ".factory", "settings.json"),
      JSON.stringify({ skills: ["user"] }),
    );
    await writeFile(
      join(other, ".factory", "settings.json"),
      JSON.stringify({ skills: ["other"] }),
    );

    const context = await createAppContext({ environment, cwd: other });

    assert.deepEqual(context.settings.skills, ["other"]);
    assert.equal(context.environment.cwd, other);
    assert.equal(context.paths.projectDir, join(other, ".factory"));
    assert.equal(
      context.paths.userSettingsFile,
      join(home, ".factory", "settings.json"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived paths stay inside the injected home and project", async () => {
  const { root, home, project, environment } = await fixture();
  try {
    const context = await createAppContext({ environment });

    assert.equal(context.paths.factoryDir, join(home, ".factory"));
    assert.equal(
      context.paths.sessionsDir.startsWith(join(home, ".factory")),
      true,
    );
    assert.equal(
      context.paths.cacheDir.startsWith(join(home, ".factory")),
      true,
    );
    assert.equal(
      context.paths.logsDir.startsWith(join(home, ".factory")),
      true,
    );
    assert.equal(
      context.paths.projectSettingsFile,
      join(project, ".factory", "settings.json"),
    );
    assert.equal(context.paths.worktreesRoot.includes(home), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed project settings file fails the context, naming the file", async () => {
  const { root, project, environment } = await fixture();
  try {
    const file = join(project, ".factory", "settings.json");
    await writeFile(file, "{ not json");

    await assert.rejects(
      createAppContext({ environment }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /settings\.json/);
        return true;
      },
    );
    assert.equal((await readFile(file, "utf8")).includes("not json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
