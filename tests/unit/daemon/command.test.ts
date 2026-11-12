/**
 * `droide daemon` wiring. Clauses: `specs/70` B2, B3, B5, B7, B8, B10, B11 and
 * B28 (the Remote Control refusal in this build).
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PRODUCT_VERSION } from "../../../src/cli/brand.ts";
import type { Environment, Platform } from "../../../src/config/paths.ts";
import {
  LOCAL_IDENTITY,
  REMOTE_CONTROL_UNAVAILABLE,
  daemonLogsPath,
  daemonServerOptions,
  environmentAuthPolicy,
  exportSettingsEnvironment,
  processParentChannel,
  runDaemonCommand,
  stderrLogger,
  type DaemonCommandDeps,
} from "../../../src/daemon/command.ts";
import type { LivenessPipeOpener } from "../../../src/daemon/liveness.ts";
import {
  DAEMON_VERSION,
  type DaemonLogger,
} from "../../../src/daemon/server.ts";
import type { DaemonTimers } from "../../../src/daemon/timers.ts";
import { ManualTimers } from "./helpers.ts";

function platformOf(): Platform {
  switch (process.platform) {
    case "win32":
      return "win32";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      throw new Error(`unsupported test platform: ${process.platform}`);
  }
}

function environmentOf(
  env: Readonly<Record<string, string | undefined>> = {},
): Environment {
  return {
    env,
    home: join(tmpdir(), "droide-daemon-home"),
    platform: platformOf(),
    cwd: join(tmpdir(), "droide-daemon-work"),
  };
}

interface Captured {
  readonly deps: DaemonCommandDeps;
  out(): string[];
  err(): string[];
  started(): Promise<void>;
}

interface CaptureOverrides {
  readonly signal?: AbortSignal;
  readonly timers?: DaemonTimers;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly openLiveness?: LivenessPipeOpener;
  readonly logger?: DaemonLogger;
}

function capture(
  environment: Environment,
  overrides: CaptureOverrides = {},
): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const banner = Promise.withResolvers<void>();
  return {
    deps: {
      environment,
      stdout: (line) => {
        out.push(line);
        if (line === "Press Ctrl+C to stop") banner.resolve();
      },
      stderr: (line) => err.push(line),
      bindRetryDelaysMs: [],
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
      ...(overrides.isProcessAlive === undefined
        ? {}
        : { isProcessAlive: overrides.isProcessAlive }),
      ...(overrides.openLiveness === undefined
        ? {}
        : { openLiveness: overrides.openLiveness }),
      ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    },
    out: () => out,
    err: () => err,
    started: () => banner.promise,
  };
}

test("the ambient DROIDE_API_KEY becomes the single accepted apiKey", () => {
  const policy = environmentAuthPolicy(
    environmentOf({ DROIDE_API_KEY: " fk-abc " }),
  );
  assert.deepEqual(policy.identity, LOCAL_IDENTITY);
  assert.equal(policy.apiKey, "fk-abc");
  assert.equal(policy.token, undefined);
  assert.equal(
    environmentAuthPolicy(environmentOf({ DROIDE_API_KEY: "sk-other" })).apiKey,
    undefined,
  );
  assert.equal(environmentAuthPolicy(environmentOf()).apiKey, undefined);
});

test("the daemon log path lives under the state dir", () => {
  const environment = environmentOf();
  assert.equal(
    daemonLogsPath(environment),
    join(environment.home, ".droide", "logs", "daemon.log"),
  );
  assert.equal(
    daemonLogsPath(
      environmentOf({
        DROIDE_HOME_OVERRIDE: environment.home,
        DROIDE_ENV: "development",
      }),
    ),
    join(environment.home, ".droide-dev", "logs", "daemon.log"),
  );
});

test("--settings is exported for the daemon process only when non-empty", () => {
  const env: Record<string, string | undefined> = {};
  exportSettingsEnvironment(undefined, env);
  exportSettingsEnvironment("", env);
  assert.equal(env["DROIDE_RUNTIME_SETTINGS_PATH"], undefined);
  exportSettingsEnvironment("/tmp/settings.json", env);
  assert.equal(env["DROIDE_RUNTIME_SETTINGS_PATH"], "/tmp/settings.json");
});

test("flags map onto the server configuration with unix winning over port", () => {
  const environment = environmentOf({ DROIDE_API_KEY: "fk-abc" });
  const options = daemonServerOptions(
    {
      port: 4321,
      host: "0.0.0.0",
      unixPath: "/tmp/daemon.sock",
      listen: "websocket",
      debug: true,
      remoteControl: false,
    },
    { ...capture(environment).deps, pid: 99 },
  );
  assert.equal(options.listen, "websocket");
  assert.equal(options.port, 4321);
  assert.equal(options.host, "0.0.0.0");
  assert.equal(options.unixPath, "/tmp/daemon.sock");
  assert.equal(options.pid, 99);
  assert.equal(options.homedir, environment.home);
  assert.equal(options.platform, environment.platform);
  assert.equal(options.version, undefined);
  assert.equal(options.logsPath, daemonLogsPath(environment));
  assert.deepEqual(options.auth, {
    identity: LOCAL_IDENTITY,
    apiKey: "fk-abc",
  });
  assert.equal(options.remoteControl, false);
  assert.deepEqual(options.methods, undefined);
});

test("an ipc-only daemon is configured with no socket", () => {
  const options = daemonServerOptions(
    { listen: "ipc", port: 1 },
    capture(environmentOf()).deps,
  );
  assert.equal(options.listen, "ipc");
  assert.equal(options.unixPath, undefined);
});

test("the default host is loopback and the version is the advertised one", () => {
  const options = daemonServerOptions(
    {},
    { ...capture(environmentOf()).deps, pid: 7 },
  );
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.pid, 7);
  assert.equal(DAEMON_VERSION, PRODUCT_VERSION);
});

test("debug logging writes everything; a normal run only writes failures", () => {
  const debugLines: string[] = [];
  const debug = stderrLogger((line) => debugLines.push(line), true);
  debug.debug("d");
  debug.info("i");
  debug.error("e");
  assert.deepEqual(debugLines, ["d", "i", "e"]);

  const quietLines: string[] = [];
  const quiet = stderrLogger((line) => quietLines.push(line), false);
  quiet.debug("d");
  quiet.info("i");
  quiet.error("e");
  assert.deepEqual(quietLines, ["e"]);
});

test("a process without an inherited IPC channel has none to report", () => {
  assert.equal(processParentChannel(), undefined);
});

test("runDaemonCommand prints the banner, stops on its signal and returns 0", async () => {
  const captured = capture(environmentOf());
  const controller = new AbortController();
  const exiting = runDaemonCommand(
    { port: 0 },
    { ...captured.deps, signal: controller.signal },
  );
  await captured.started();
  assert.equal(captured.out()[0], "Daemon running");
  assert.ok(
    captured
      .out()
      .some((line) => line.startsWith("WebSocket endpoint: ws://127.0.0.1:")),
  );
  assert.deepEqual(captured.err(), []);
  controller.abort();
  assert.equal(await exiting, 0);
});

test("runDaemonCommand refuses --remote-control with a startup failure", async () => {
  const captured = capture(environmentOf());
  const code = await runDaemonCommand(
    { port: 0, remoteControl: true },
    captured.deps,
  );
  assert.equal(code, 1);
  assert.deepEqual(captured.err(), [
    `Startup failed: ${REMOTE_CONTROL_UNAVAILABLE}`,
  ]);
  assert.deepEqual(captured.out(), []);
});

test("--listen ipc plus --remote-control reports the server's own refusal", async () => {
  const captured = capture(environmentOf());
  const code = await runDaemonCommand(
    { listen: "ipc", remoteControl: true },
    captured.deps,
  );
  assert.equal(code, 1);
  // The user-facing failure and the diagnostic log line both reach stderr,
  // because this build has no log file to write the second one to.
  assert.deepEqual(captured.err(), [
    "Startup failed: --listen ipc cannot be combined with --remote-control",
    "CLI daemon startup failed",
  ]);
});

test("a bind conflict returns 1 with Startup failed on stderr", async () => {
  const first = capture(environmentOf());
  const controller = new AbortController();
  const running = runDaemonCommand(
    { port: 0 },
    { ...first.deps, signal: controller.signal },
  );
  await first.started();
  const endpoint = first
    .out()
    .find((line) => line.startsWith("WebSocket endpoint: "));
  assert.ok(endpoint !== undefined);
  const port = Number(endpoint.split(":").pop());
  assert.ok(Number.isInteger(port) && port > 0);

  try {
    const second = capture(environmentOf());
    const code = await runDaemonCommand({ port }, second.deps);
    assert.equal(code, 1);
    assert.equal(second.err().length, 2);
    assert.match(second.err()[0] ?? "", /^Startup failed: .*EADDRINUSE/);
    assert.equal(second.err()[1], "CLI daemon startup failed");
  } finally {
    controller.abort();
    assert.equal(await running, 0);
  }
});

test("--parent-pid is wired into the running daemon and stops it when the parent dies", async () => {
  const timers = new ManualTimers();
  const captured = capture(environmentOf());
  const controller = new AbortController();
  let polls = 0;
  const exiting = runDaemonCommand(
    { port: 0, parentPid: 123_456 },
    {
      ...captured.deps,
      timers,
      signal: controller.signal,
      isProcessAlive: () => {
        polls += 1;
        return false;
      },
    },
  );
  try {
    await captured.started();
    timers.advance(2_000);
    assert.equal(await exiting, 0);
    assert.equal(polls, 1);
  } finally {
    controller.abort();
  }
});

test("--liveness-fd is wired into the running daemon and stops it when the pipe closes", async () => {
  const captured = capture(environmentOf());
  const controller = new AbortController();
  const pipeClose = Promise.withResolvers<() => void>();
  let stopped = false;
  const exiting = runDaemonCommand(
    { port: 0, livenessFd: 5 },
    {
      ...captured.deps,
      signal: controller.signal,
      openLiveness: (fd, onClose) => {
        assert.equal(fd, 5);
        pipeClose.resolve(onClose);
        return {
          stop() {
            stopped = true;
          },
        };
      },
    },
  );
  try {
    await captured.started();
    const onClose = await pipeClose.promise;
    onClose();
    assert.equal(await exiting, 0);
    assert.equal(stopped, true);
  } finally {
    controller.abort();
  }
});

test("a passed-in auth policy replaces the environment one", () => {
  const policy = { identity: { userId: "u", orgId: "o" }, token: "t" };
  const options = daemonServerOptions(
    {},
    {
      ...capture(environmentOf({ DROIDE_API_KEY: "fk-abc" })).deps,
      auth: policy,
    },
  );
  assert.equal(options.auth, policy);
});
