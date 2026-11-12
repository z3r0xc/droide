import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  projectSettingsFile,
  userSettingsFile,
  type Environment,
} from "../../../src/config/paths.ts";
import { resolveSettings } from "../../../src/config/resolve.ts";

async function withTree(
  run: (environment: Environment) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "droide-config-int-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  try {
    await run({
      env: { FACTORY_HOME_OVERRIDE: home },
      home,
      platform:
        process.platform === "win32"
          ? "win32"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      cwd,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("resolves the on-disk layers for an isolated home and project", async () => {
  await withTree(async (environment) => {
    const userFile = userSettingsFile(environment);
    const projectFile = projectSettingsFile(environment);
    const overlayFile = path.join(environment.cwd, "overlay.json");

    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(
      userFile,
      `{
        // JSONC is accepted in every settings file
        "theme": "dark",
        "skills": ["user-skill",],
      }`,
      "utf8",
    );
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(
      projectFile,
      JSON.stringify({ theme: "light", locale: "en-GB" }),
      "utf8",
    );
    await fs.writeFile(
      overlayFile,
      JSON.stringify({ worktreeDirectory: "/runtime-worktrees" }),
      "utf8",
    );

    const resolved = await resolveSettings(environment, {
      flagSettings: overlayFile,
    });

    assert.equal(resolved.settings.general?.theme, "light");
    assert.equal(resolved.settings.general?.locale, "en-GB");
    assert.equal(
      resolved.settings.general?.worktreeDirectory,
      "/runtime-worktrees",
    );
    assert.deepEqual(resolved.settings.skills, ["user-skill"]);
    assert.deepEqual(
      resolved.layers.map((layer) => layer.source),
      [overlayFile, projectFile, userFile],
    );
    assert.ok(
      resolved.layers.every(
        (layer) =>
          layer.source.startsWith(environment.cwd) ||
          layer.source.startsWith(environment.home),
      ),
    );
  });
});

test("an explicit user settings path is anchored at the launch directory", async () => {
  await withTree(async (environment) => {
    await fs.mkdir(path.join(environment.cwd, "alt"), { recursive: true });
    await fs.writeFile(
      path.join(environment.cwd, "alt", "settings.json"),
      JSON.stringify({ theme: "alt" }),
      "utf8",
    );

    const resolved = await resolveSettings(environment, {
      userSettingsFile: "alt/settings.json",
    });

    assert.equal(resolved.settings.general?.theme, "alt");
    assert.deepEqual(
      resolved.layers.map((layer) => layer.level),
      ["user"],
    );
  });
});
