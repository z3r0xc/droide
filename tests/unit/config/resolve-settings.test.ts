import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  InvalidSettingsError,
  UnreadableSettingsError,
} from "../../../src/config/errors.ts";
import type { Environment, Platform } from "../../../src/config/paths.ts";
import { resolveSettings } from "../../../src/config/resolve.ts";

const HOST_PLATFORM: Platform =
  process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";

interface Fixture {
  readonly root: string;
  readonly environment: Environment;
  readonly userSettings: string;
  readonly projectSettings: string;
  readonly overlay: string;
  readonly overlayFromEnv: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "droide-config-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(path.join(home, ".factory"), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  return {
    root,
    environment: {
      env: { FACTORY_HOME_OVERRIDE: home },
      home,
      platform: HOST_PLATFORM,
      cwd,
    },
    userSettings: path.join(home, ".factory", "settings.json"),
    projectSettings: path.join(cwd, ".factory", "settings.json"),
    overlay: path.join(root, "overlay.json"),
    overlayFromEnv: path.join(root, "overlay-env.json"),
  };
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

test("a user settings file applies when it is the only layer", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.userSettings, { worktreeDirectory: "/user" });

    const resolved = await resolveSettings(fixture.environment);

    assert.equal(resolved.settings.worktreeDirectory, "/user");
    assert.deepEqual(
      resolved.layers.map((layer) => layer.level),
      ["user"],
    );
    assert.deepEqual(resolved.overlay, { kind: "absent" });
  });
});

test("project settings override user settings", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.userSettings, {
      worktreeDirectory: "/user",
      theme: "dark",
    });
    await writeJson(fixture.projectSettings, { worktreeDirectory: "/project" });

    const resolved = await resolveSettings(fixture.environment);

    assert.equal(resolved.settings.worktreeDirectory, "/project");
    assert.equal(resolved.settings.theme, "dark");
    assert.deepEqual(
      resolved.layers.map((layer) => layer.level),
      ["project", "user"],
    );
  });
});

test("the runtime overlay overrides project settings", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.projectSettings, { worktreeDirectory: "/project" });
    await writeJson(fixture.overlay, { worktreeDirectory: "/runtime" });

    const resolved = await resolveSettings(fixture.environment, {
      flagSettings: fixture.overlay,
    });

    assert.equal(resolved.settings.worktreeDirectory, "/runtime");
    assert.equal(resolved.overlay.kind, "loaded");
    assert.deepEqual(
      resolved.layers.map((layer) => layer.level),
      ["runtime", "project"],
    );
  });
});

test("org policy outranks the runtime overlay", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.projectSettings, { worktreeDirectory: "/project" });
    await writeJson(fixture.overlay, { worktreeDirectory: "/runtime" });

    const resolved = await resolveSettings(fixture.environment, {
      flagSettings: fixture.overlay,
      orgSettings: { worktreeDirectory: "/org" },
    });

    assert.equal(resolved.settings.worktreeDirectory, "/org");
    assert.deepEqual(
      resolved.layers.map((layer) => layer.level),
      ["org", "runtime", "project"],
    );
  });
});

test("a key absent from every layer stays absent", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.userSettings, { theme: "dark" });
    await writeJson(fixture.projectSettings, { theme: "light" });

    const resolved = await resolveSettings(fixture.environment);

    assert.equal(resolved.settings.worktreeDirectory, undefined);
    assert.equal(resolved.settings.theme, "light");
  });
});

test("the --settings flag wins over FACTORY_RUNTIME_SETTINGS_PATH", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.overlay, { theme: "from-flag" });
    await writeJson(fixture.overlayFromEnv, { theme: "from-env" });

    const withFlag = await resolveSettings(
      {
        ...fixture.environment,
        env: {
          ...fixture.environment.env,
          FACTORY_RUNTIME_SETTINGS_PATH: fixture.overlayFromEnv,
        },
      },
      { flagSettings: fixture.overlay },
    );
    assert.equal(withFlag.settings.theme, "from-flag");

    const fromEnv = await resolveSettings({
      ...fixture.environment,
      env: {
        ...fixture.environment.env,
        FACTORY_RUNTIME_SETTINGS_PATH: fixture.overlayFromEnv,
      },
    });
    assert.equal(fromEnv.settings.theme, "from-env");

    const blankFlag = await resolveSettings(
      {
        ...fixture.environment,
        env: {
          ...fixture.environment.env,
          FACTORY_RUNTIME_SETTINGS_PATH: fixture.overlayFromEnv,
        },
      },
      { flagSettings: "   " },
    );
    assert.equal(blankFlag.settings.theme, "from-env");
  });
});

test("a missing overlay path is dropped and recorded, not fatal", async () => {
  await withFixture(async (fixture) => {
    const resolved = await resolveSettings(fixture.environment, {
      flagSettings: fixture.overlay,
    });

    assert.deepEqual(resolved.overlay, {
      kind: "dropped",
      path: fixture.overlay,
      reason: "file not found",
    });
    assert.deepEqual(resolved.layers, []);
  });
});

test("an overlay path that is a directory is dropped", async () => {
  await withFixture(async (fixture) => {
    await fs.mkdir(fixture.overlay);

    const resolved = await resolveSettings(fixture.environment, {
      flagSettings: fixture.overlay,
    });

    assert.equal(resolved.overlay.kind, "dropped");
    assert.equal(
      resolved.overlay.kind === "dropped" ? resolved.overlay.reason : "",
      "not a regular file",
    );
  });
});

test("invalid overlay content is not dropped", async () => {
  await withFixture(async (fixture) => {
    await fs.writeFile(fixture.overlay, "{", "utf8");

    await assert.rejects(
      resolveSettings(fixture.environment, { flagSettings: fixture.overlay }),
      InvalidSettingsError,
    );
  });
});

test("a malformed settings file names its path", async () => {
  await withFixture(async (fixture) => {
    await fs.writeFile(fixture.userSettings, '{ "theme": ', "utf8");

    await assert.rejects(
      resolveSettings(fixture.environment),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSettingsError);
        assert.equal(error.path, fixture.userSettings);
        assert.match(error.message, /invalid JSON/);
        return true;
      },
    );
  });
});

test("a settings path that is a directory is unreadable", async () => {
  await withFixture(async (fixture) => {
    await fs.mkdir(fixture.userSettings);

    await assert.rejects(
      resolveSettings(fixture.environment),
      UnreadableSettingsError,
    );
  });
});

test("an unknown key in a settings file is ignored", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.projectSettings, {
      notASetting: true,
      theme: "dark",
    });

    const resolved = await resolveSettings(fixture.environment);

    assert.deepEqual(resolved.settings, { theme: "dark" });
  });
});

test("lists replace and MCP servers replace whole when merging layers", async () => {
  await withFixture(async (fixture) => {
    await writeJson(fixture.userSettings, {
      skills: ["user-skill"],
      mcp: { svc: { command: "user-command" } },
    });
    await writeJson(fixture.projectSettings, {
      skills: ["project-skill"],
      mcp: { svc: { type: "http", url: "https://example.com/mcp" } },
    });

    const resolved = await resolveSettings(fixture.environment);

    assert.deepEqual(resolved.settings.skills, ["project-skill"]);
    const server = resolved.settings.mcp?.["svc"];
    assert.ok(server !== undefined);
    assert.equal(server.type, "http");
    assert.equal("command" in server, false);
  });
});

test("with no files anywhere the merged settings are empty", async () => {
  await withFixture(async (fixture) => {
    const resolved = await resolveSettings(fixture.environment);

    assert.deepEqual(resolved.settings, {});
    assert.deepEqual(resolved.layers, []);
  });
});
