import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expandTilde,
  stateDir,
  stateDirName,
  stateHome,
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
  assert.equal(stateDir(environment()), "/home/tester/.droide");
  assert.equal(
    stateDir(
      environment({
        platform: "darwin",
        home: "/Users/tester",
        cwd: "/Users/tester/work",
      }),
    ),
    "/Users/tester/.droide",
  );
  assert.equal(
    stateDir(
      environment({
        platform: "win32",
        home: "C:\\Users\\tester",
        cwd: "C:\\work",
      }),
    ),
    "C:\\Users\\tester\\.droide",
  );
});

test("sessions, cache and settings paths are placed under the factory dir", () => {
  const linux = environment();
  assert.equal(sessionsDir(linux), "/home/tester/.droide/sessions");
  assert.equal(
    sessionIndexDatabase(linux),
    "/home/tester/.droide/cache/session-index/index.db",
  );
  assert.equal(userSettingsFile(linux), "/home/tester/.droide/settings.json");
  assert.equal(
    projectSettingsFile(linux),
    "/work/project/.droide/settings.json",
  );
  assert.equal(
    projectLocalSettingsFile(linux),
    "/work/project/.droide/settings.local.json",
  );
  assert.equal(tempPath(linux, "run", "x"), "/home/tester/.droide/temp/run/x");
  assert.equal(tempDir(linux), "/home/tester/.droide/temp");

  const windows = environment({
    platform: "win32",
    home: "C:\\Users\\tester",
    cwd: "C:\\work\\project",
  });
  assert.equal(sessionsDir(windows), "C:\\Users\\tester\\.droide\\sessions");
  assert.equal(
    projectSettingsFile(windows),
    "C:\\work\\project\\.droide\\settings.json",
  );
});

test("DROIDE_HOME_OVERRIDE wins over the injected home", () => {
  const env = environment({
    env: { DROIDE_HOME_OVERRIDE: "/isolated/home" },
  });
  assert.equal(stateHome(env), "/isolated/home");
  assert.equal(stateDir(env), "/isolated/home/.droide");

  const empty = environment({ env: { DROIDE_HOME_OVERRIDE: "" } });
  assert.equal(stateHome(empty), "/home/tester");
});

test("DROIDE_ENV selects the development directory name", () => {
  assert.equal(stateDirName(environment()), ".droide");
  assert.equal(
    stateDirName(environment({ env: { DROIDE_ENV: "production" } })),
    ".droide",
  );
  assert.equal(
    stateDirName(environment({ env: { DROIDE_ENV: "development" } })),
    ".droide-dev",
  );
  assert.equal(
    stateDir(environment({ env: { DROIDE_ENV: "development" } })),
    "/home/tester/.droide-dev",
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
  assert.equal(worktreesRoot(env), "/home/tester/.droide/worktrees");
  assert.equal(worktreesRoot(env, "/mnt/worktrees"), "/mnt/worktrees");
  assert.equal(worktreesRoot(env, "~/worktrees"), "/home/tester/worktrees");
  assert.equal(
    worktreesRoot(env, "relative/worktrees"),
    "/home/tester/.droide/worktrees",
  );
  assert.equal(worktreesRoot(env, ""), "/home/tester/.droide/worktrees");
});
