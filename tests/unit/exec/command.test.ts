import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AppContext } from "../../../src/app/context.ts";
import type { Environment, Platform } from "../../../src/config/paths.ts";
import { resolvePath } from "../../../src/config/paths.ts";
import type { Settings } from "../../../src/config/schema.ts";
import {
  AUTHENTICATION_REQUIRED,
  ExecCommandError,
  resolveModelTarget,
  resolvePrompt,
  runExecCommand,
  type ExecArgv,
  type ExecCommandDeps,
} from "../../../src/exec/command.ts";
import { ExecUsageError } from "../../../src/exec/errors.ts";
import { CollectingStream } from "./helpers.ts";

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

interface TempEnvironment {
  readonly environment: Environment;
  readonly cleanup: () => Promise<void>;
}

async function tempEnvironment(): Promise<TempEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), "droide-exec-command-"));
  return {
    environment: {
      env: {},
      home: directory,
      platform: platformOf(),
      cwd: directory,
    },
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const UNUSED_CONTEXT = async (): Promise<AppContext> => {
  throw new Error("configuration must not be loaded");
};

function baseArgv(overrides: Partial<ExecArgv> = {}): ExecArgv {
  return {
    prompt: "say hi",
    file: undefined,
    outputFormat: "text",
    inputFormat: undefined,
    model: "gpt-6.1-sol",
    reasoningEffort: undefined,
    auto: undefined,
    skipPermissionsUnsafe: false,
    cwd: undefined,
    settings: undefined,
    sessionId: undefined,
    fork: undefined,
    mission: false,
    useSpec: false,
    disableBuiltinSkills: false,
    specModel: undefined,
    listTools: false,
    onlyTools: [],
    addTools: [],
    removeTools: [],
    appendSystemPrompt: undefined,
    appendSystemPromptFile: undefined,
    worktree: undefined,
    worktreeDir: undefined,
    tags: [],
    ...overrides,
  };
}

function makeDeps(
  environment: Environment,
  overrides: Partial<ExecCommandDeps> = {},
): ExecCommandDeps {
  return {
    program: "droide",
    environment,
    stdout: new CollectingStream(),
    stderr: new CollectingStream(),
    stdinIsTTY: true,
    readStdin: async () => "",
    clock: () => 0,
    nextId: () => "generated-id",
    createContext: UNUSED_CONTEXT,
    ...overrides,
  };
}

test("--file wins over the positional prompt and stdin", async () => {
  const temp = await tempEnvironment();
  try {
    await writeFile(join(temp.environment.cwd, "prompt.md"), "from-file");
    const prompt = await resolvePrompt({
      program: "droide",
      promptArg: "from-argv",
      file: "prompt.md",
      stdinIsTTY: false,
      readStdin: async () => "from-stdin",
      environment: temp.environment,
    });
    assert.equal(prompt, "from-file");
  } finally {
    await temp.cleanup();
  }
});

test("a positional prompt suppresses stdin", async () => {
  const temp = await tempEnvironment();
  try {
    const prompt = await resolvePrompt({
      program: "droide",
      promptArg: "from-argv",
      file: undefined,
      stdinIsTTY: false,
      readStdin: async () => "from-stdin",
      environment: temp.environment,
    });
    assert.equal(prompt, "from-argv");
  } finally {
    await temp.cleanup();
  }
});

test("stdin is read only when no prompt source was given", async () => {
  const temp = await tempEnvironment();
  try {
    const prompt = await resolvePrompt({
      program: "droide",
      promptArg: undefined,
      file: undefined,
      stdinIsTTY: false,
      readStdin: async () => "from-stdin",
      environment: temp.environment,
    });
    assert.equal(prompt, "from-stdin");
  } finally {
    await temp.cleanup();
  }
});

test("a missing prompt file names the resolved path", async () => {
  const temp = await tempEnvironment();
  try {
    const missing = resolvePath(temp.environment, "missing.md");
    await assert.rejects(
      resolvePrompt({
        program: "droide",
        promptArg: undefined,
        file: "missing.md",
        stdinIsTTY: true,
        readStdin: async () => "",
        environment: temp.environment,
      }),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message === `Prompt file not found: ${missing}`,
    );
  } finally {
    await temp.cleanup();
  }
});

test("an empty or whitespace-only prompt file is refused", async () => {
  const temp = await tempEnvironment();
  try {
    await writeFile(join(temp.environment.cwd, "empty.md"), " \n\t\n");
    const path = resolvePath(temp.environment, "empty.md");
    await assert.rejects(
      resolvePrompt({
        program: "droide",
        promptArg: undefined,
        file: "empty.md",
        stdinIsTTY: true,
        readStdin: async () => "",
        environment: temp.environment,
      }),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message === `Prompt file is empty: ${path}`,
    );
  } finally {
    await temp.cleanup();
  }
});

test("empty stdin, the dash syntax and a TTY are each refused", async () => {
  const temp = await tempEnvironment();
  try {
    await assert.rejects(
      resolvePrompt({
        program: "droide",
        promptArg: undefined,
        file: undefined,
        stdinIsTTY: false,
        readStdin: async () => "  \n",
        environment: temp.environment,
      }),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message.startsWith("No prompt received on stdin"),
    );

    await assert.rejects(
      resolvePrompt({
        program: "droide",
        promptArg: "-",
        file: undefined,
        stdinIsTTY: true,
        readStdin: async () => "",
        environment: temp.environment,
      }),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message.startsWith('The "-" syntax is no longer supported.'),
    );

    await assert.rejects(
      resolvePrompt({
        program: "droide",
        promptArg: undefined,
        file: undefined,
        stdinIsTTY: true,
        readStdin: async () => "",
        environment: temp.environment,
      }),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message.startsWith("No prompt provided. Usage:"),
    );
  } finally {
    await temp.cleanup();
  }
});

test("a failing stdin read is reported with its message", async () => {
  const temp = await tempEnvironment();
  try {
    await assert.rejects(
      resolvePrompt({
        program: "droide",
        promptArg: undefined,
        file: undefined,
        stdinIsTTY: false,
        readStdin: async () => {
          throw new Error("stream closed");
        },
        environment: temp.environment,
      }),
      (error: unknown) =>
        error instanceof ExecUsageError &&
        error.message === "Could not read the prompt from stdin: stream closed",
    );
  } finally {
    await temp.cleanup();
  }
});

const CUSTOM_SETTINGS: Settings = {
  customModels: [
    {
      id: "mock",
      model: "mock-1",
      provider: "openai",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "test",
    },
  ],
};

test("a custom model resolves its base URL, wire model and bearer header", () => {
  const target = resolveModelTarget({
    model: "custom:mock",
    reasoningEffort: "low",
    settings: CUSTOM_SETTINGS,
    env: {},
  });

  assert.equal(target.model, "custom:mock");
  assert.equal(target.wireModel, "mock-1");
  assert.equal(target.url.href, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(target.dialect, "chat");
  assert.equal(target.headers["Authorization"], "Bearer test");
  assert.equal(target.reasoningEffort, "low");
});

test("an anthropic custom model uses messages and the api-key header", () => {
  const target = resolveModelTarget({
    model: "custom:claude",
    reasoningEffort: undefined,
    settings: {
      customModels: [
        {
          id: "claude",
          model: "claude-mock",
          provider: "anthropic",
          baseUrl: "https://example.test/api",
          apiKey: "secret",
        },
      ],
    },
    env: {},
  });

  assert.equal(target.url.href, "https://example.test/api/messages");
  assert.equal(target.dialect, "anthropic");
  assert.equal(target.headers["x-api-key"], "secret");
  assert.equal(target.headers["anthropic-version"], "2023-06-01");
  assert.equal(target.reasoningEffort, "off");
});

test("an unknown, unconfigured or unsupported custom model is refused", () => {
  assert.throws(
    () =>
      resolveModelTarget({
        model: "custom:nope",
        reasoningEffort: undefined,
        settings: CUSTOM_SETTINGS,
        env: {},
      }),
    (error: unknown) =>
      error instanceof ExecCommandError &&
      error.message === "Invalid model: custom:nope",
  );

  assert.throws(
    () =>
      resolveModelTarget({
        model: "custom:bare",
        reasoningEffort: undefined,
        settings: {
          customModels: [{ id: "bare", model: "x", provider: "openai" }],
        },
        env: {},
      }),
    (error: unknown) =>
      error instanceof ExecCommandError &&
      error.message.includes("has no baseUrl configured"),
  );

  assert.throws(
    () =>
      resolveModelTarget({
        model: "custom:aws",
        reasoningEffort: undefined,
        settings: {
          customModels: [
            {
              id: "aws",
              model: "x",
              provider: "bedrock-converse",
              baseUrl: "https://example.test",
            },
          ],
        },
        env: {},
      }),
    (error: unknown) =>
      error instanceof ExecCommandError &&
      error.message.includes("cannot call"),
  );
});

test("a managed model needs DROIDE_API_KEY and routes through the proxy", () => {
  assert.throws(
    () =>
      resolveModelTarget({
        model: "gpt-6.1-sol",
        reasoningEffort: undefined,
        settings: {},
        env: {},
      }),
    (error: unknown) =>
      error instanceof ExecCommandError &&
      error.message === AUTHENTICATION_REQUIRED,
  );

  const target = resolveModelTarget({
    model: "gpt-6.1-sol",
    reasoningEffort: "medium",
    settings: {},
    env: {
      DROIDE_API_KEY: "key",
      FACTORY_API_BASE_URL: "https://api.example.test",
    },
  });
  assert.equal(
    target.url.href,
    "https://api.example.test/api/llm/o/v1/chat/completions",
  );
  assert.equal(target.headers["Authorization"], "Bearer key");
  assert.equal(target.reasoningEffort, "medium");
});

function fakeContext(environment: Environment, settings: Settings): AppContext {
  return {
    environment,
    settings,
    layers: [],
    droppedOverlays: [],
    paths: {
      factoryDir: "/factory",
      userSettingsFile: "/factory/settings.json",
      projectDir: "/project/.factory",
      projectSettingsFile: "/project/.factory/settings.json",
      sessionsDir: "/factory/sessions",
      sessionIndexDir: "/factory/cache/session-index",
      sessionIndexDatabase: "/factory/cache/session-index/index.db",
      cacheDir: "/factory/cache",
      logsDir: "/factory/logs",
      worktreesRoot: "/factory/worktrees",
    },
  };
}

test("an invalid --auto value fails before any configuration is read", async () => {
  const temp = await tempEnvironment();
  try {
    const stderr = new CollectingStream();
    const code = await runExecCommand(
      baseArgv({ auto: "extreme" }),
      makeDeps(temp.environment, { stderr }),
    );
    assert.equal(code, 1);
    assert.equal(
      stderr.text,
      "Invalid --auto value. Allowed values: low, medium, high.\n",
    );
  } finally {
    await temp.cleanup();
  }
});

test("--auto and --skip-permissions-unsafe are mutually exclusive", async () => {
  const temp = await tempEnvironment();
  try {
    const stderr = new CollectingStream();
    const code = await runExecCommand(
      baseArgv({ auto: "low", skipPermissionsUnsafe: true }),
      makeDeps(temp.environment, { stderr }),
    );
    assert.equal(code, 1);
    assert.equal(
      stderr.text,
      "Invalid flags: --auto and --skip-permissions-unsafe cannot be used together.\n",
    );
  } finally {
    await temp.cleanup();
  }
});

test("a file and a positional prompt are refused with the three options", async () => {
  const temp = await tempEnvironment();
  try {
    const stderr = new CollectingStream();
    const code = await runExecCommand(
      baseArgv({ prompt: "say hi", file: "prompt.md" }),
      makeDeps(temp.environment, { stderr }),
    );
    assert.equal(code, 1);
    assert.match(
      stderr.text,
      /^Cannot specify both a file \(-f\/--file\) and a prompt argument\.\nUse one of:\n/,
    );
    assert.match(stderr.text, /droide exec -f prompt\.txt/);
    assert.match(stderr.text, /droide exec "your prompt"/);
    assert.match(stderr.text, /cat prompt\.txt \| droide exec/);
  } finally {
    await temp.cleanup();
  }
});

test("an unimplemented tool-selection flag is refused, not ignored", async () => {
  const temp = await tempEnvironment();
  try {
    const stderr = new CollectingStream();
    const code = await runExecCommand(
      baseArgv({ onlyTools: ["Read"] }),
      makeDeps(temp.environment, { stderr }),
    );
    assert.equal(code, 1);
    assert.match(
      stderr.text,
      /Tool selection flags \(--only-tools, --add-tools, --remove-tools\) are not implemented/,
    );
  } finally {
    await temp.cleanup();
  }
});

test("a missing managed credential opens no provider and exits non-zero", async () => {
  const temp = await tempEnvironment();
  try {
    const environment: Environment = {
      ...temp.environment,
      env: { FACTORY_API_BASE_URL: "http://127.0.0.1:9" },
    };
    const stderr = new CollectingStream();
    let fetchCalls = 0;
    const noNetworkFetch: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("network must not be reached");
    };
    const code = await runExecCommand(
      baseArgv({ model: "gpt-6.1-sol" }),
      makeDeps(environment, {
        stderr,
        fetch: noNetworkFetch,
        createContext: async () => fakeContext(environment, {}),
      }),
    );

    assert.equal(code, 1);
    assert.equal(stderr.text, `${AUTHENTICATION_REQUIRED}\n`);
    assert.equal(fetchCalls, 0);
  } finally {
    await temp.cleanup();
  }
});
