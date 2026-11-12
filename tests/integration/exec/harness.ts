/**
 * Shared harness for exec integration tests: a scripted OpenAI-compatible mock
 * provider, a sandboxed home directory and a CLI child process. Nothing here
 * reaches the network or the real home directory.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Environment, Platform } from "../../../src/config/paths.ts";
import {
  sessionIndexDatabase,
  sessionsDir,
} from "../../../src/config/paths.ts";
import { projectKeyFor } from "../../../src/exec/session.ts";
import {
  openSessionStore,
  type SessionStore,
} from "../../../src/session/store.ts";
import type { JsonObject } from "../../../src/session/transcript.ts";
import { isRecord } from "../../../src/transport/schema.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const ENTRY = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));

export type MockResponse =
  | { readonly kind: "sse"; readonly chunks: readonly unknown[] }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly body: string;
    }
  | { readonly kind: "hang" };

export interface MockServer {
  readonly url: string;
  readonly requests: readonly string[];
  close(): Promise<void>;
}

export async function startMockServer(
  script: readonly MockResponse[],
): Promise<MockServer> {
  const requests: string[] = [];
  let posts = 0;
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
    request.resume();
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    const index = Math.min(posts, script.length - 1);
    posts += 1;
    const reply = script[index];
    if (reply === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":{"message":"no scripted reply"}}');
      return;
    }
    if (reply.kind === "http") {
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.body);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (reply.kind === "hang") return;
    for (const chunk of reply.chunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the mock provider did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close((error) => {
        if (error === undefined) closed.resolve();
        else closed.reject(error);
      });
      await closed.promise;
    },
  };
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function childEnvironment(directory: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: join(directory, "AppData"),
    FACTORY_HOME_OVERRIDE: directory,
    NO_COLOR: "1",
    TERM: "dumb",
    PATH: process.env.PATH ?? "",
  };
  for (const name of ["SYSTEMROOT", "windir", "Path"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Narrow parsed JSON without a cast; `isRecord` is the repo's one guard. */
export function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

/** A running CLI child whose stdin can be written to over time. */
export interface SpawningChild {
  readonly pid: number | undefined;
  readonly done: Promise<RunResult>;
  write(text: string): void;
  end(): void;
  signal(name: NodeJS.Signals): void;
  kill(): void;
  /** Observe stdout chunks as they arrive (drives signals without sleeping). */
  onStdout(listener: (chunk: string) => void): void;
}

export function spawnCli(
  directory: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): SpawningChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [ENTRY, ...args],
    {
      cwd: directory,
      env: { ...childEnvironment(directory), ...extraEnvironment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  // Watchdog, not a sleep: a failed assertion must not leave the child behind.
  const timer = setTimeout(() => child.kill(), 30_000);
  timer.unref();

  const done = new Promise<RunResult>((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });

  return {
    pid: child.pid,
    done,
    write(text) {
      child.stdin.write(text);
    },
    end() {
      child.stdin.end();
    },
    signal(name) {
      child.kill(name);
    },
    kill() {
      child.kill();
    },
    onStdout(listener) {
      child.stdout.on("data", (chunk: string) => listener(chunk));
    },
  };
}

export function runCli(
  directory: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<RunResult> {
  const child = spawnCli(directory, args, extraEnvironment);
  child.end();
  return child.done;
}

export interface Harness {
  readonly directory: string;
  readonly settingsPath: string;
  readonly server: MockServer;
}

export type ScriptSource =
  readonly MockResponse[] | ((directory: string) => readonly MockResponse[]);

export async function withHarness(
  scriptSource: ScriptSource,
  run: (harness: Harness) => Promise<void>,
  settings?: (server: MockServer) => unknown,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "droide-exec-cli-"));
  const script =
    typeof scriptSource === "function" ? scriptSource(directory) : scriptSource;
  const server = await startMockServer(script);
  try {
    await writeFile(join(directory, "fixture.txt"), "hello fixture\n");
    const settingsPath = join(directory, "settings.json");
    const document =
      settings === undefined
        ? {
            customModels: [
              {
                id: "mock",
                model: "mock-1",
                provider: "openai",
                baseUrl: `${server.url}/v1`,
                apiKey: "test",
              },
            ],
          }
        : settings(server);
    await writeFile(settingsPath, JSON.stringify(document));
    await run({ directory, settingsPath, server });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export function execArgs(
  settingsPath: string,
  rest: readonly string[],
): string[] {
  return ["exec", "--settings", settingsPath, ...rest];
}

export { REPO_ROOT };

/* -------------------------------------------------------------------------- */
/* Session fixtures                                                           */
/* -------------------------------------------------------------------------- */

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

/** The environment the spawned CLI sees for this sandbox. */
export function fixtureEnvironment(directory: string): Environment {
  return {
    env: { FACTORY_HOME_OVERRIDE: directory },
    home: directory,
    platform: platformOf(),
    cwd: directory,
  };
}

function openFixtureStore(directory: string): SessionStore {
  const environment = fixtureEnvironment(directory);
  return openSessionStore({
    dbPath: sessionIndexDatabase(environment),
    sessionsDir: sessionsDir(environment),
    clock: { now: () => 1_000 },
  });
}

/** A stored user or assistant text message, as `exec` writes one. */
export function textMessageRecord(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp = 1_000,
): JsonObject {
  return {
    type: "message",
    message: { id, role, content: [{ type: "text", text }] },
    timestamp,
  };
}

export interface SeedSessionInput {
  readonly sessionId: string;
  readonly records?: readonly JsonObject[];
  readonly archivedAt?: string;
}

/** Registers a session (and its transcript lines) before the CLI run starts. */
export function seedSession(directory: string, input: SeedSessionInput): void {
  const store = openFixtureStore(directory);
  try {
    store.registerSession({
      sessionId: input.sessionId,
      projectKey: projectKeyFor(
        directory,
        fixtureEnvironment(directory).platform,
      ),
      cwd: directory,
      firstEventAt: 1_000,
      ...(input.archivedAt === undefined
        ? {}
        : { archivedAt: input.archivedAt }),
    });
    for (const record of input.records ?? []) {
      store.appendTranscriptRecord(input.sessionId, record);
    }
  } finally {
    store.close();
  }
}

export function storedRecords(
  directory: string,
  sessionId: string,
): readonly JsonObject[] {
  const store = openFixtureStore(directory);
  try {
    return store.readSession(sessionId);
  } finally {
    store.close();
  }
}

/** Parsed stdout lines, asserting each one is a JSON object. */
export function parseStream(
  stdout: string,
): readonly Readonly<Record<string, unknown>>[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => recordOf(JSON.parse(line)));
}
