import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAppContext, type AppContext } from "../../../src/app/context.ts";
import { runPluginList } from "../../../src/cli/plugin-commands.ts";
import type { Environment } from "../../../src/config/paths.ts";

type SettingsDocument = Readonly<Record<string, unknown>>;

interface Fixture {
  readonly context: AppContext;
  readonly deps: Parameters<typeof runPluginList>[1];
  readonly read: () => {
    readonly out: string;
    readonly err: string;
    readonly code: number;
  };
  readonly cleanup: () => Promise<void>;
}

async function fixture(
  document: unknown | null,
  settings: SettingsDocument = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "droide-plugin-cmd-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const factoryDir = join(home, ".factory");
  await mkdir(join(factoryDir, "plugins"), { recursive: true });
  await mkdir(join(project, ".factory"), { recursive: true });
  if (document !== null) {
    await writeFile(
      join(factoryDir, "plugins", "installed_plugins.json"),
      JSON.stringify(document),
    );
  }
  if (Object.keys(settings).length > 0) {
    await writeFile(
      join(factoryDir, "settings.json"),
      JSON.stringify(settings),
    );
  }

  const environment: Environment = {
    env: {},
    home,
    platform: "linux",
    cwd: project,
  };
  const context = await createAppContext({ environment });

  let out = "";
  let err = "";
  let code = 0;
  return {
    context,
    deps: {
      context,
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
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("an invalid scope is refused before the registry is read", async () => {
  const sandbox = await fixture(null);
  try {
    await runPluginList({ scope: "team" }, sandbox.deps);
    const result = sandbox.read();
    assert.match(result.err, /Invalid --scope value: team/);
    assert.equal(result.out, "");
    assert.equal(result.code, 1);
  } finally {
    await sandbox.cleanup();
  }
});

test("a listing is rendered with id, version and scope", async () => {
  const sandbox = await fixture({
    schemaVersion: 1,
    plugins: { "demo@market": [{ installPath: "/p", version: "1.0.0" }] },
  });
  try {
    await runPluginList({}, sandbox.deps);
    const result = sandbox.read();
    assert.match(result.out, /1 plugin installed, 1 enabled/);
    assert.match(result.out, /demo@market\s+1\.0\.0\s+user\s+enabled/);
    assert.equal(result.code, 0);
  } finally {
    await sandbox.cleanup();
  }
});

test("enabledPlugins from settings reaches the listing", async () => {
  const sandbox = await fixture(
    {
      schemaVersion: 1,
      plugins: { muted: [{ installPath: "/p", version: "1.0.0" }] },
    },
    { enabledPlugins: { muted: false } },
  );
  try {
    await runPluginList({}, sandbox.deps);
    const result = sandbox.read();
    assert.match(result.out, /0 enabled/);
    assert.match(result.out, /muted\s+1\.0\.0\s+user\s+disabled/);
  } finally {
    await sandbox.cleanup();
  }
});

test("a broken registry exits 1 and still prints the listing", async () => {
  const sandbox = await fixture(null);
  try {
    await writeFile(
      join(
        sandbox.context.paths.factoryDir,
        "plugins",
        "installed_plugins.json",
      ),
      "{ broken",
    );
    await runPluginList({}, sandbox.deps);
    const result = sandbox.read();
    assert.match(result.out, /problems:/);
    assert.equal(result.code, 1);
  } finally {
    await sandbox.cleanup();
  }
});
