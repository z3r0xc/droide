/**
 * The root command's dispatch contract (`specs/95-terminal-ui.md`,
 * `specs/10-cli-surface.md` §B16, §B20).
 *
 * The default command is exercised through its injected runtime: no process
 * mocking, no terminal, no module-loading tricks. Only a TTY pair may start the
 * shell; every other launch keeps the loud unfinished-mode exit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Command } from "commander";

import type {
  AppContext,
  CreateAppContextOptions,
} from "../../../src/app/context.ts";
import {
  isInteractiveTerminal,
  makeRootCommand,
  runDefaultCommand,
  type DefaultCommandRuntime,
  type LaunchInteractive,
  type LaunchStreams,
} from "../../../src/cli/commands/root.ts";
import { ConfigError } from "../../../src/config/errors.ts";

function streams(tty: boolean): {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
} {
  const stream = { isTTY: tty } as unknown;
  return {
    stdin: stream as NodeJS.ReadStream,
    stdout: stream as NodeJS.WriteStream,
  };
}

const CONTEXT: AppContext = {
  environment: {
    env: { TERM: "xterm-256color" },
    home: "/home/test",
    platform: "linux",
    cwd: "/project",
  },
  paths: {
    stateDir: "/home/test/.droide",
    userSettingsFile: "/home/test/.droide/settings.json",
    projectDir: "/project",
    projectSettingsFile: "/project/.droide/settings.json",
    sessionsDir: "/home/test/.droide/sessions",
    sessionIndexDir: "/home/test/.droide/index",
    sessionIndexDatabase: "/home/test/.droide/index/sessions.db",
    cacheDir: "/home/test/.droide/cache",
    logsDir: "/home/test/.droide/logs",
    worktreesRoot: "/home/test/.droide/worktrees",
  },
  settings: {},
  layers: [],
  droppedOverlays: [],
};

interface Harness {
  readonly runtime: DefaultCommandRuntime;
  readonly launchCalls: Array<{ context: AppContext; streams: LaunchStreams }>;
  readonly contextCalls: CreateAppContextOptions[];
  readonly stderr: string[];
  readonly exitCodes: number[];
  readonly unimplemented: string[];
  readonly setExitCodes: number[];
}

interface RuntimeOptions {
  readonly tty: boolean;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly launch?: LaunchInteractive;
  readonly createContextError?: Error;
}

function harness(options: RuntimeOptions): Harness {
  const launchCalls: Harness["launchCalls"] = [];
  const contextCalls: Harness["contextCalls"] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const unimplemented: string[] = [];
  const setExitCodes: number[] = [];
  const pair = streams(options.tty);
  const runtime: DefaultCommandRuntime = {
    stdin:
      options.stdinIsTTY === undefined
        ? pair.stdin
        : streams(options.stdinIsTTY).stdin,
    stdout:
      options.stdoutIsTTY === undefined
        ? pair.stdout
        : streams(options.stdoutIsTTY).stdout,
    stderr: {
      write(text: string) {
        stderr.push(text);
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    env: options.env ?? { TERM: "xterm-256color" },
    createContext: async (contextOptions) => {
      contextCalls.push(contextOptions);
      if (options.createContextError !== undefined) {
        throw options.createContextError;
      }
      return CONTEXT;
    },
    launchInteractive:
      options.launch ??
      (async (context, launched) => {
        launchCalls.push({ context, streams: launched });
        return 0;
      }),
    setExitCode: (code) => {
      setExitCodes.push(code);
    },
    exit: (code) => {
      exitCodes.push(code);
    },
    unimplemented: (command) => {
      unimplemented.push(command);
    },
  };
  return {
    runtime,
    launchCalls,
    contextCalls,
    stderr,
    exitCodes,
    unimplemented,
    setExitCodes,
  };
}

test("both streams must be terminals", () => {
  assert.equal(isInteractiveTerminal(streams(true)), true);
  assert.equal(
    isInteractiveTerminal({
      stdin: streams(true).stdin,
      stdout: streams(false).stdout,
    }),
    false,
  );
  assert.equal(
    isInteractiveTerminal({
      stdin: streams(false).stdin,
      stdout: streams(true).stdout,
    }),
    false,
  );
  assert.equal(isInteractiveTerminal(streams(false)), false);
});

test("a TTY pair with no prompt starts the shell and adopts its exit code", async () => {
  const probe = harness({
    tty: true,
    launch: async (context, launched) => {
      // The launcher receives the runtime's own streams and the built context.
      assert.equal(context, CONTEXT);
      assert.equal(launched.stdin.isTTY, true);
      assert.equal(launched.stdout.isTTY, true);
      return 7;
    },
  });

  await runDefaultCommand([], {}, probe.runtime);

  assert.deepEqual(probe.contextCalls, [{}]);
  assert.deepEqual(probe.stderr, []);
  assert.deepEqual(probe.exitCodes, []);
  assert.deepEqual(probe.unimplemented, []);
  assert.deepEqual(probe.setExitCodes, [7]);
});

test("half a TTY pair never starts the shell", async () => {
  for (const [stdinIsTTY, stdoutIsTTY] of [
    [true, false],
    [false, true],
  ] as const) {
    const probe = harness({ tty: true, stdinIsTTY, stdoutIsTTY });
    await runDefaultCommand([], {}, probe.runtime);

    assert.deepEqual(probe.launchCalls, []);
    assert.deepEqual(probe.setExitCodes, []);
    assert.deepEqual(probe.unimplemented, ["interactive"]);
    assert.deepEqual(probe.exitCodes, []);
  }
});

test("no terminal on either end stays loudly unimplemented", async () => {
  const probe = harness({ tty: false });
  await runDefaultCommand([], {}, probe.runtime);

  assert.deepEqual(probe.launchCalls, []);
  assert.deepEqual(probe.unimplemented, ["interactive"]);
  assert.deepEqual(probe.setExitCodes, []);
});

test("a prompt with a TTY is not dropped into a shell that cannot receive it", async () => {
  const probe = harness({ tty: true });
  await runDefaultCommand(["fix", "it"], {}, probe.runtime);

  assert.deepEqual(probe.contextCalls, [{}]);
  assert.deepEqual(probe.launchCalls, []);
  assert.deepEqual(probe.unimplemented, ["interactive"]);
});

test("a prompt without a TTY keeps the byte-identical refusal", async () => {
  const probe = harness({ tty: false });
  await runDefaultCommand(
    ["deploy"],
    { settings: "/tmp/s.json" },
    probe.runtime,
  );

  assert.equal(probe.stderr.length, 1);
  const text = probe.stderr[0] ?? "";
  assert.match(text, /^droide requires a terminal for interactive mode/u);
  assert.match(text, /ssh -t <host> droide/u);
  assert.match(text, /droide exec "<prompt>"/u);
  assert.match(text, /"deploy" is not a droide command/u);
  assert.match(text, /--help to list commands/u);
  assert.deepEqual(probe.exitCodes, [1]);
  assert.deepEqual(probe.contextCalls, []);
  assert.deepEqual(probe.launchCalls, []);
});

test("the runtime's environment decides the mintty hint, not the real process", async () => {
  const probe = harness({
    tty: false,
    env: { TERM_PROGRAM: "mintty" },
  });
  await runDefaultCommand(["hi"], {}, probe.runtime);

  assert.match(probe.stderr[0] ?? "", /winpty droide/u);
});

test("a configuration failure exits 1 before any terminal work", async () => {
  const probe = harness({
    tty: true,
    createContextError: new ConfigError("bad settings"),
  });
  await runDefaultCommand([], { settings: "/tmp/broken.json" }, probe.runtime);

  assert.deepEqual(probe.contextCalls, [{ settingsFlag: "/tmp/broken.json" }]);
  assert.deepEqual(probe.stderr, ["droide: bad settings\n"]);
  assert.deepEqual(probe.exitCodes, [1]);
  assert.deepEqual(probe.launchCalls, []);
});

test("a terminal the shell refuses falls back to the unfinished-mode exit", async () => {
  const { InteractiveUnavailableError } =
    await import("../../../src/app/interactive.ts");
  const probe = harness({
    tty: true,
    launch: async () => {
      throw new InteractiveUnavailableError();
    },
  });
  await runDefaultCommand([], {}, probe.runtime);

  assert.deepEqual(probe.unimplemented, ["interactive"]);
  assert.deepEqual(probe.setExitCodes, []);
});

test("the wired program runs the default command through the injected runtime", async () => {
  const probe = harness({ tty: true });
  const program = makeRootCommand(new Command(), probe.runtime);
  program.exitOverride();

  await program.parseAsync([process.execPath, "droide"]);

  assert.deepEqual(probe.contextCalls, [{}]);
  assert.deepEqual(probe.setExitCodes, [0]);
  assert.deepEqual(probe.unimplemented, []);
});
