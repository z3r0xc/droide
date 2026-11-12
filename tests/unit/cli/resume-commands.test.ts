/**
 * The `resume` command body (`specs/10-cli-surface.md` §B22–B25,
 * `specs/40-sessions-and-storage.md` §B17/B38–B40).
 *
 * Every case runs against a temporary SQLite index and a temporary sessions
 * directory; the exec path is injected so nothing here reaches a provider.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AppContext } from "../../../src/app/context.ts";
import type { Platform } from "../../../src/config/paths.ts";
import type { ExecArgv, ExecCommandDeps } from "../../../src/exec/command.ts";
import {
  FORK_NEEDS_ID,
  FORK_WITHOUT_PROMPT,
  LAST_REQUIRES_TERMINAL,
  LAST_WITH_ID,
  RESUME_LIST_LIMIT,
  archivedSession,
  invalidSessionId,
  parseSessionArgument,
  runResumeCommand,
  unknownSession,
  type ResumedSession,
  type ResumeCommandOptions,
  type ResumeDeps,
  type ResumeStreams,
} from "../../../src/cli/resume-commands.ts";
import {
  openSessionStore,
  type SessionStore,
} from "../../../src/session/store.ts";
import type { JsonObject } from "../../../src/session/transcript.ts";

const ID_A = "0f0e0d0c-0b0a-4a09-8807-060504030201";
const ID_B = "1f0e0d0c-0b0a-4a09-8807-060504030201";
const ID_C = "2f0e0d0c-0b0a-4a09-8807-060504030201";
const ID_FORK = "3f0e0d0c-0b0a-4a09-8807-060504030201";

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

function contextFor(directory: string): AppContext {
  return {
    environment: {
      env: {},
      home: directory,
      platform: platformOf(),
      cwd: join(directory, "project"),
    },
    paths: {
      stateDir: join(directory, "factory"),
      userSettingsFile: join(directory, "factory", "settings.json"),
      projectDir: join(directory, "project"),
      projectSettingsFile: join(
        directory,
        "project",
        ".droide",
        "settings.json",
      ),
      sessionsDir: join(directory, "factory", "sessions"),
      sessionIndexDir: join(directory, "factory", "index"),
      sessionIndexDatabase: join(directory, "factory", "index", "sessions.db"),
      cacheDir: join(directory, "factory", "cache"),
      logsDir: join(directory, "factory", "logs"),
      worktreesRoot: join(directory, "factory", "worktrees"),
    },
    settings: {},
    layers: [],
    droppedOverlays: [],
  };
}

function textMessage(text: string, timestamp: number): JsonObject {
  return {
    type: "message",
    message: {
      id: `message-${timestamp}`,
      role: "user",
      content: [{ type: "text", text }],
    },
    timestamp,
  };
}

interface SeedInput {
  readonly sessionId: string;
  readonly title?: string;
  readonly timestamp?: number;
  readonly cwd?: string;
  readonly archivedAt?: string;
  readonly records?: readonly JsonObject[];
}

function seed(
  store: SessionStore,
  context: AppContext,
  input: SeedInput,
): void {
  const timestamp = input.timestamp ?? 1_000;
  store.registerSession({
    sessionId: input.sessionId,
    projectKey: "",
    cwd: input.cwd ?? context.environment.cwd,
    ...(input.title === undefined ? {} : { title: input.title }),
    firstEventAt: timestamp,
    ...(input.archivedAt === undefined ? {} : { archivedAt: input.archivedAt }),
  });
  for (const record of input.records ?? [textMessage("hi", timestamp)]) {
    store.appendTranscriptRecord(input.sessionId, record);
  }
}

interface ExecCall {
  readonly argv: ExecArgv;
  readonly deps: ExecCommandDeps;
}

interface LaunchCall {
  readonly session: ResumedSession;
  readonly streams: ResumeStreams;
}

interface Captured {
  readonly deps: ResumeDeps;
  readonly opened: SessionStore[];
  readonly closed: boolean[];
  readonly execs: ExecCall[];
  readonly launches: LaunchCall[];
  stdout(): string;
  stderr(): string;
  code(): number;
}

interface HarnessOptions {
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly execCode?: number;
  readonly launchCode?: number;
  readonly nextId?: () => string;
}

function fakeStream(tty: boolean): NodeJS.WriteStream {
  return { isTTY: tty } as unknown as NodeJS.WriteStream;
}

function harness(context: AppContext, options: HarnessOptions = {}): Captured {
  let out = "";
  let err = "";
  const codes: number[] = [];
  const opened: SessionStore[] = [];
  const closed: boolean[] = [];
  const execs: ExecCall[] = [];
  const launches: LaunchCall[] = [];
  const stdin = {
    isTTY: options.stdinIsTTY === true,
  } as unknown as NodeJS.ReadStream;
  const stdout = fakeStream(options.stdoutIsTTY === true);

  const deps: ResumeDeps = {
    program: "droide",
    stdinIsTTY: options.stdinIsTTY === true,
    stdoutIsTTY: options.stdoutIsTTY === true,
    streams: { stdin, stdout },
    stderr: fakeStream(false),
    createContext: async () => context,
    openStore: (storeOptions) => {
      const store = openSessionStore(storeOptions);
      const index = opened.push(store) - 1;
      closed[index] = false;
      const close = store.close.bind(store);
      store.close = () => {
        closed[index] = true;
        close();
      };
      return store;
    },
    runExec: async (argv, execDeps) => {
      execs.push({ argv, deps: execDeps });
      return options.execCode ?? 0;
    },
    launchInteractive: async (_context, streams, session) => {
      launches.push({ session, streams });
      return options.launchCode ?? 0;
    },
    readStdin: async () => "",
    write: (text) => {
      out += text;
    },
    writeError: (text) => {
      err += text;
    },
    setExitCode: (code) => {
      codes.push(code);
    },
    clock: () => 1_000,
    nextId: options.nextId ?? (() => ID_FORK),
  };

  return {
    deps,
    opened,
    closed,
    execs,
    launches,
    stdout: () => out,
    stderr: () => err,
    code: () => codes.at(-1) ?? 0,
  };
}

function options(
  overrides: Partial<ResumeCommandOptions> = {},
): ResumeCommandOptions {
  return {
    sessionId: undefined,
    promptParts: [],
    fork: false,
    last: false,
    settings: undefined,
    cwd: undefined,
    ...overrides,
  };
}

async function withFixture(
  run: (context: AppContext, store: SessionStore) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "droide-resume-"));
  const context = contextFor(directory);
  const store = openSessionStore({
    dbPath: context.paths.sessionIndexDatabase,
    sessionsDir: context.paths.sessionsDir,
    clock: { now: () => 0 },
  });
  try {
    await run(context, store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function assertAllClosed(captured: Captured): void {
  assert.ok(captured.opened.length > 0, "the command never opened the store");
  for (const index of captured.closed.keys()) {
    assert.equal(captured.closed[index], true, `store ${index} is still open`);
  }
}

function recordsOf(
  context: AppContext,
  sessionId: string,
): readonly JsonObject[] {
  const store = openSessionStore({
    dbPath: context.paths.sessionIndexDatabase,
    sessionsDir: context.paths.sessionsDir,
    clock: { now: () => 0 },
  });
  try {
    return store.readSession(sessionId);
  } finally {
    store.close();
  }
}

test("a bare uuid, an app link and a deep link all name the session", () => {
  assert.equal(parseSessionArgument(ID_A), ID_A);
  assert.equal(
    parseSessionArgument(`  https://app.droide.ai/sessions/${ID_A}  `),
    ID_A,
  );
  assert.equal(parseSessionArgument(`droide://sessions/${ID_A}`), ID_A);
  assert.equal(parseSessionArgument(ID_A.toUpperCase()), null);
  assert.equal(parseSessionArgument("not-a-session"), null);
  assert.equal(
    parseSessionArgument("https://app.droide.ai/sessions/nope"),
    null,
  );
});

test("the listing is newest first, with id, title, count and timestamp", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, { sessionId: ID_A, title: "Alpha", timestamp: 1_000 });
    seed(store, context, { sessionId: ID_B, title: "Beta", timestamp: 3_000 });
    seed(store, context, { sessionId: ID_C, title: "Gamma", timestamp: 2_000 });
    const captured = harness(context);
    await runResumeCommand(options(), captured.deps);

    assert.equal(
      captured.stdout(),
      [
        "Recent sessions:",
        `  ${ID_B}  Beta · 1 message · 1970-01-01T00:00:03.000Z`,
        `  ${ID_C}  Gamma · 1 message · 1970-01-01T00:00:02.000Z`,
        `  ${ID_A}  Alpha · 1 message · 1970-01-01T00:00:01.000Z`,
        "",
      ].join("\n"),
    );
    assert.equal(captured.stderr(), "");
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("the listing is bounded and still starts with the newest session", async () => {
  await withFixture(async (context, store) => {
    const total = RESUME_LIST_LIMIT + 5;
    for (let index = 1; index <= total; index += 1) {
      const id = `4f0e0d0c-0b0a-4a09-8807-0605040302${index
        .toString(16)
        .padStart(2, "0")}`;
      seed(store, context, {
        sessionId: id,
        title: `Session ${index}`,
        timestamp: index * 1_000,
      });
    }
    const captured = harness(context);
    await runResumeCommand(options(), captured.deps);

    const lines = captured.stdout().trimEnd().split("\n");
    assert.equal(lines.length, RESUME_LIST_LIMIT + 1);
    assert.ok(lines[1]?.includes(`Session ${total} `));
    const oldestShown = total - RESUME_LIST_LIMIT + 1;
    assert.ok(lines.at(-1)?.includes(`Session ${oldestShown} `));
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("an empty store lists nothing and succeeds", async () => {
  await withFixture(async (context) => {
    const captured = harness(context);
    await runResumeCommand(options(), captured.deps);

    assert.equal(captured.stdout(), "No sessions found.\n");
    assert.equal(captured.stderr(), "");
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("a terminal without --last prints the same list, never a picker", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, { sessionId: ID_A, title: "Alpha" });
    const captured = harness(context, { stdinIsTTY: true, stdoutIsTTY: true });
    await runResumeCommand(options(), captured.deps);

    assert.match(captured.stdout(), /^Recent sessions:\n/);
    assert.ok(captured.stdout().includes(ID_A));
    assert.equal(captured.launches.length, 0);
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("an id in a pipe prints the resumed header and exits 0", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, { sessionId: ID_A, title: "Alpha" });
    const captured = harness(context);
    await runResumeCommand(options({ sessionId: ID_A }), captured.deps);

    assert.equal(captured.stdout(), `Resumed session ${ID_A} (Alpha)\n`);
    assert.equal(captured.stderr(), "");
    assert.equal(captured.launches.length, 0);
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("a session link resumes the session it names", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, { sessionId: ID_A, title: "Alpha" });
    const captured = harness(context);
    await runResumeCommand(
      options({ sessionId: `https://app.droide.ai/sessions/${ID_A}` }),
      captured.deps,
    );

    assert.equal(captured.stdout(), `Resumed session ${ID_A} (Alpha)\n`);
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("an id that is not a session id is refused before the store is used", async () => {
  await withFixture(async (context) => {
    const captured = harness(context);
    await runResumeCommand(options({ sessionId: "nope" }), captured.deps);

    assert.equal(captured.stdout(), "");
    assert.equal(captured.stderr(), `${invalidSessionId("nope")}\n`);
    assert.equal(captured.code(), 1);
    assertAllClosed(captured);
  });
});

test("an unknown session is refused with its own message", async () => {
  await withFixture(async (context) => {
    const captured = harness(context);
    await runResumeCommand(options({ sessionId: ID_A }), captured.deps);

    assert.equal(captured.stdout(), "");
    assert.equal(captured.stderr(), `${unknownSession(ID_A)}\n`);
    assert.equal(captured.code(), 1);
    assertAllClosed(captured);
  });
});

test("an archived session is refused, and so is forking it", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, {
      sessionId: ID_A,
      archivedAt: "2024-01-01T00:00:00.000Z",
    });

    const resumed = harness(context);
    await runResumeCommand(options({ sessionId: ID_A }), resumed.deps);
    assert.equal(resumed.stderr(), `${archivedSession("resume", ID_A)}\n`);
    assert.equal(resumed.code(), 1);

    const forked = harness(context);
    await runResumeCommand(
      options({ sessionId: ID_A, fork: true, promptParts: ["hello"] }),
      forked.deps,
    );
    assert.equal(forked.stderr(), `${archivedSession("fork", ID_A)}\n`);
    assert.equal(forked.code(), 1);
    assert.equal(forked.execs.length, 0);
    assertAllClosed(resumed);
    assertAllClosed(forked);
  });
});

test("--last without a terminal is refused before any work", async () => {
  await withFixture(async (context) => {
    const captured = harness(context);
    await runResumeCommand(options({ last: true }), captured.deps);

    assert.equal(captured.stdout(), "");
    assert.equal(captured.stderr(), `${LAST_REQUIRES_TERMINAL}\n`);
    assert.equal(captured.code(), 1);
    assert.equal(captured.opened.length, 0);
  });
});

test("--last with an id is refused", async () => {
  await withFixture(async (context) => {
    const captured = harness(context, { stdinIsTTY: true });
    await runResumeCommand(
      options({ last: true, sessionId: ID_A }),
      captured.deps,
    );

    assert.equal(captured.stderr(), `${LAST_WITH_ID}\n`);
    assert.equal(captured.code(), 1);
    assert.equal(captured.opened.length, 0);
  });
});

test("--fork without an id is refused", async () => {
  await withFixture(async (context) => {
    const captured = harness(context);
    await runResumeCommand(options({ fork: true }), captured.deps);

    assert.equal(captured.stderr(), `${FORK_NEEDS_ID}\n`);
    assert.equal(captured.code(), 1);
    assert.equal(captured.opened.length, 0);
  });
});

test("--fork with no prompt outside a terminal is refused", async () => {
  await withFixture(async (context) => {
    const captured = harness(context);
    await runResumeCommand(
      options({ fork: true, sessionId: ID_A }),
      captured.deps,
    );

    assert.equal(captured.stderr(), `${FORK_WITHOUT_PROMPT}\n`);
    assert.equal(captured.code(), 1);
    assert.equal(captured.opened.length, 0);
  });
});

test("a prompt runs one turn in the named session", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, { sessionId: ID_A, title: "Alpha" });
    const captured = harness(context, { execCode: 7 });
    await runResumeCommand(
      options({ sessionId: ID_A, promptParts: ["hello", "world"] }),
      captured.deps,
    );

    assert.equal(captured.stdout(), `Resumed session ${ID_A} (Alpha)\n`);
    assert.equal(captured.execs.length, 1);
    assert.equal(captured.execs[0]?.argv.sessionId, ID_A);
    assert.equal(captured.execs[0]?.argv.fork, undefined);
    assert.equal(captured.execs[0]?.argv.prompt, "hello world");
    assert.equal(captured.code(), 7);
    // The turn sees the configuration the resume command already resolved.
    const call = captured.execs[0];
    assert.ok(call !== undefined);
    const createContext = call.deps.createContext;
    assert.ok(createContext !== undefined);
    assert.equal(await createContext({}), context);
    assertAllClosed(captured);
  });
});

test("--fork copies the transcript and continues the new session", async () => {
  await withFixture(async (context, store) => {
    const history = [textMessage("first", 1_000), textMessage("second", 2_000)];
    seed(store, context, { sessionId: ID_A, title: "Alpha", records: history });
    const captured = harness(context, { execCode: 0 });
    await runResumeCommand(
      options({ sessionId: ID_A, fork: true, promptParts: ["hello"] }),
      captured.deps,
    );

    assert.equal(
      captured.stdout(),
      `Resumed session ${ID_FORK} (forked from ${ID_A})\n`,
    );
    assert.equal(captured.execs.length, 1);
    assert.equal(captured.execs[0]?.argv.sessionId, ID_FORK);
    assert.equal(captured.execs[0]?.argv.fork, undefined);
    assert.equal(captured.code(), 0);

    assert.deepEqual(recordsOf(context, ID_FORK), history);
    assert.deepEqual(recordsOf(context, ID_A), history);
    assertAllClosed(captured);
  });
});

test("--fork on a terminal hands the fork to the shell", async () => {
  await withFixture(async (context, store) => {
    const history = [textMessage("first", 1_000)];
    seed(store, context, { sessionId: ID_A, title: "Alpha", records: history });
    const captured = harness(context, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      launchCode: 130,
    });
    await runResumeCommand(
      options({ sessionId: ID_A, fork: true }),
      captured.deps,
    );

    assert.equal(captured.launches.length, 1);
    assert.equal(captured.launches[0]?.session.sessionId, ID_FORK);
    assert.equal(captured.code(), 130);
    assert.deepEqual(recordsOf(context, ID_FORK), history);
    assertAllClosed(captured);
  });
});

test("a terminal resumes the named session by handing it to the shell", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, { sessionId: ID_A, title: "Alpha" });
    const captured = harness(context, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      launchCode: 0,
    });
    await runResumeCommand(options({ sessionId: ID_A }), captured.deps);

    assert.equal(captured.launches.length, 1);
    assert.equal(captured.launches[0]?.session.sessionId, ID_A);
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("--last selects the newest session in this folder on a terminal", async () => {
  await withFixture(async (context, store) => {
    seed(store, context, {
      sessionId: ID_B,
      title: "Elsewhere",
      timestamp: 9_000,
      cwd: "/elsewhere",
    });
    seed(store, context, { sessionId: ID_A, title: "Here", timestamp: 1_000 });
    const captured = harness(context, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    await runResumeCommand(options({ last: true }), captured.deps);

    assert.equal(captured.stdout(), `Resumed session ${ID_A} (Here)\n`);
    assert.equal(captured.launches.length, 1);
    assert.equal(captured.launches[0]?.session.sessionId, ID_A);
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});

test("--last on an empty store exits 0 without a launch", async () => {
  await withFixture(async (context) => {
    const captured = harness(context, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    await runResumeCommand(options({ last: true }), captured.deps);

    assert.equal(captured.stdout(), "No sessions found.\n");
    assert.equal(captured.launches.length, 0);
    assert.equal(captured.code(), 0);
    assertAllClosed(captured);
  });
});
