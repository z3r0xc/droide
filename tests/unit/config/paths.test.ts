import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expandTilde,
  factoryDir,
  factoryDirName,
  factoryHome,
  projectLocalSettingsFile,
  projectSettingsFile,
  resolvePath,
  sessionIndexDatabase,
  sessionsDir,
  tempDir,
  tempPath,
  userSettingsFile,
  worktreesRoot,
  type Environment,
} from "../../../src/config/paths.ts";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    env: {},
    home: "/home/tester",
    platform: "linux",
    cwd: "/work/project",
    ...overrides,
  };
}

test("factory dir follows the platform separator", () => {
  assert.equal(factoryDir(environment()), "/home/tester/.factory");
  assert.equal(
    factoryDir(
      environment({
        platform: "darwin",
        home: "/Users/tester",
        cwd: "/Users/tester/work",
      }),
    ),
    "/Users/tester/.factory",
  );
  assert.equal(
    factoryDir(
      environment({
        platform: "win32",
        home: "C:\\Users\\tester",
        cwd: "C:\\work",
      }),
    ),
    "C:\\Users\\tester\\.factory",
  );
});

test("sessions, cache and settings paths are placed under the factory dir", () => {
  const linux = environment();
  assert.equal(sessionsDir(linux), "/home/tester/.factory/sessions");
  assert.equal(
    sessionIndexDatabase(linux),
    "/home/tester/.factory/cache/session-index/index.db",
  );
  assert.equal(
    userSettingsFile(linux),
    "/home/tester/.factory/settings.json",
  );
  assert.equal(
    projectSettingsFile(linux),
    "/work/project/.factory/settings.json",
  );
  assert.equal(
    projectLocalSettingsFile(linux),
    "/work/project/.factory/settings.local.json",
  );
  assert.equal(tempPath(linux, "run", "x"), "/home/tester/.factory/temp/run/x");
  assert.equal(tempDir(linux), "/home/tester/.factory/temp");

  const windows = environment({
    platform: "win32",
    home: "C:\\Users\\tester",
    cwd: "C:\\work\\project",
  });
  assert.equal(
    sessionsDir(windows),
    "C:\\Users\\tester\\.factory\\sessions",
  );
  assert.equal(
    projectSettingsFile(windows),
    "C:\\work\\project\\.factory\\settings.json",
  );
});

test("FACTORY_HOME_OVERRIDE wins over the injected home", () => {
  const env = environment({
    env: { FACTORY_HOME_OVERRIDE: "/isolated/home" },
  });
  assert.equal(factoryHome(env), "/isolated/home");
  assert.equal(factoryDir(env), "/isolated/home/.factory");

  const empty = environment({ env: { FACTORY_HOME_OVERRIDE: "" } });
  assert.equal(factoryHome(empty), "/home/tester");
});

test("FACTORY_ENV selects the development directory name", () => {
  assert.equal(factoryDirName(environment()), ".factory");
  assert.equal(
    factoryDirName(environment({ env: { FACTORY_ENV: "production" } })),
    ".factory",
  );
  assert.equal(
    factoryDirName(environment({ env: { FACTORY_ENV: "development" } })),
    ".factory-dev",
  );
  assert.equal(
    factoryDir(environment({ env: { FACTORY_ENV: "development" } })),
    "/home/tester/.factory-dev",
  );
});

test("settings paths are expanded and anchored at the launch directory", () => {
  assert.equal(
    resolvePath(environment(), "~/cfg/settings.json"),
    "/home/tester/cfg/settings.json",
  );
  assert.equal(
    resolvePath(environment(), "cfg/settings.json"),
    "/work/project/cfg/settings.json",
  );
  assert.equal(expandTilde(environment(), "~"), "/home/tester");
  assert.equal(expandTilde(environment(), "~other/x"), "~other/x");

  const windows = environment({
    platform: "win32",
    home: "C:\\Users\\tester",
    cwd: "C:\\work\\project",
  });
  assert.equal(
    resolvePath(windows, "~\\cfg\\settings.json"),
    "C:\\Users\\tester\\cfg\\settings.json",
  );
  assert.equal(
    resolvePath(windows, "cfg\\settings.json"),
    "C:\\work\\project\\cfg\\settings.json",
  );
});

test("worktrees default under the factory dir and accept only absolute overrides", () => {
  const env = environment();
  assert.equal(worktreesRoot(env), "/home/tester/.factory/worktrees");
  assert.equal(worktreesRoot(env, "/mnt/worktrees"), "/mnt/worktrees");
  assert.equal(
    worktreesRoot(env, "~/worktrees"),
    "/home/tester/worktrees",
  );
  assert.equal(worktreesRoot(env, "relative/worktrees"), "/home/tester/.factory/worktrees");
  assert.equal(worktreesRoot(env, ""), "/home/tester/.factory/worktrees");
});