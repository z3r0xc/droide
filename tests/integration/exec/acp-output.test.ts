/**
 * `droide exec -o acp` end to end: a real CLI child process speaking
 * newline-delimited JSON-RPC on stdin/stdout against a scripted mock provider.
 * Clauses: `specs/80` B52, `specs/60` B60-B66.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  execArgs,
  spawnCli,
  withHarness,
  type MockResponse,
  type SpawningChild,
} from "./harness.ts";
import { isRecord } from "../../../src/transport/schema.ts";

/** One scripted assistant answer with no tool calls. */
const DONE_SCRIPT: readonly MockResponse[] = [
  {
    kind: "sse",
    chunks: [
      { choices: [{ delta: { content: "Done." } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    ],
  },
];

type Frame = Readonly<Record<string, unknown>>;

/** Reads stdout as one JSON-RPC frame per line, with awaited matchers. */
class FrameFeed {
  readonly raw: string[] = [];
  readonly frames: Frame[] = [];
  readonly #waiters: {
    readonly match: (frame: Frame) => boolean;
    readonly resolve: (frame: Frame) => void;
  }[] = [];
  #buffer = "";

  constructor(child: SpawningChild) {
    child.onStdout((chunk) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline === -1) return;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        this.raw.push(line);
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("a frame must be a JSON object");
        this.#deliver(parsed);
      }
    });
  }

  #deliver(frame: Frame): void {
    const index = this.#waiters.findIndex((waiter) => waiter.match(frame));
    if (index === -1) {
      this.frames.push(frame);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    waiter?.resolve(frame);
  }

  next(match: (frame: Frame) => boolean = () => true): Promise<Frame> {
    const index = this.frames.findIndex(match);
    if (index !== -1) {
      const [frame] = this.frames.splice(index, 1);
      if (frame !== undefined) return Promise.resolve(frame);
    }
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.#waiters.push({ match, resolve });
    return promise;
  }

  response(id: number): Promise<Frame> {
    return this.next(
      (frame) => !Object.hasOwn(frame, "method") && frame.id === id,
    );
  }
}

function request(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function errorOf(frame: Frame): Frame {
  const error = frame.error;
  assert.ok(isRecord(error), "expected an error object");
  return error;
}

function sessionIdOf(frame: Frame): string {
  const result = frame.result;
  assert.ok(isRecord(result), "expected a result object");
  const sessionId = result.sessionId;
  assert.equal(typeof sessionId, "string");
  return sessionId as string;
}

test(
  "-o acp serves initialize, session/new and a full prompt, then exits 0",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const child = spawnCli(
          directory,
          execArgs(settingsPath, ["-o", "acp", "-m", "custom:mock"]),
        );
        const feed = new FrameFeed(child);

        child.write(request(1, "initialize", { protocolVersion: 1 }));
        const handshake = await feed.response(1);
        const result = handshake.result;
        assert.ok(isRecord(result));
        assert.equal(result.protocolVersion, 1);
        assert.deepEqual(result.agentInfo, {
          name: "droide",
          title: "Droide",
          version:
            result.agentInfo instanceof Object
              ? (result.agentInfo as Frame).version
              : undefined,
        });
        const authMethods = result.authMethods;
        assert.ok(Array.isArray(authMethods));
        assert.deepEqual(
          authMethods.map((method: unknown) =>
            isRecord(method) ? method.id : undefined,
          ),
          ["device-pairing", "droide-api-key"],
        );

        child.write(
          request(2, "session/new", { cwd: directory, mcpServers: [] }),
        );
        const sessionId = sessionIdOf(await feed.response(2));

        child.write(
          request(3, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "say done" }],
          }),
        );
        const updates: Frame[] = [];
        for (;;) {
          const frame = await feed.next(
            (candidate) =>
              Object.hasOwn(candidate, "method") || candidate.id === 3,
          );
          if (Object.hasOwn(frame, "method")) {
            updates.push(frame);
            continue;
          }
          assert.deepEqual(frame.result, { stopReason: "end_turn" });
          break;
        }
        assert.deepEqual(
          updates.map((frame) => {
            const params = frame.params;
            return isRecord(params) && isRecord(params.update)
              ? params.update.sessionUpdate
              : undefined;
          }),
          // B68: the session's command set is published once, after the
          // `session/new` response, so it reaches the client ahead of the
          // first turn's content; an unchanged set at the next prompt says
          // nothing.
          ["available_commands_update", "agent_message_chunk"],
        );

        child.end();
        const exited = await child.done;
        assert.equal(exited.code, 0);
        assert.equal(server.requests.length, 1);
        // Every stdout byte belongs to a frame: no banner, no trailing prose.
        for (const line of feed.raw) {
          assert.equal(JSON.parse(line).jsonrpc, "2.0");
        }
        assert.doesNotMatch(exited.stderr, /Error|Trace/);
      },
    );
  },
);

test(
  "-o acp answers a prompt with no credential as a protocol error and exits 1",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const child = spawnCli(
          directory,
          execArgs(settingsPath, ["-o", "acp"]),
        );
        const feed = new FrameFeed(child);

        // The handshake never needs a credential.
        child.write(request(1, "initialize", { protocolVersion: 1 }));
        const handshake = await feed.response(1);
        assert.ok(isRecord(handshake.result));

        child.write(
          request(2, "session/new", { cwd: directory, mcpServers: [] }),
        );
        const sessionId = sessionIdOf(await feed.response(2));

        child.write(
          request(3, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "needs a model" }],
          }),
        );
        const failed = errorOf(await feed.response(3));
        assert.equal(failed.code, -32603);
        assert.match(String(failed.message), /Authentication failed/);

        child.end();
        const exited = await child.done;
        assert.equal(exited.code, 1);
        // No provider request was attempted and the process reported nothing
        // but frames: a missing credential is the turn's error, not a crash.
        assert.equal(server.requests.length, 0);
        assert.doesNotMatch(exited.stderr, /Error|Trace/);
      },
    );
  },
);

test(
  "-o acp-daemon stays refused and exits 1 before any session work",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const exited = await spawnCli(
          directory,
          execArgs(settingsPath, ["-o", "acp-daemon", "-m", "custom:mock"]),
        ).done;
        assert.equal(exited.code, 1);
        assert.match(
          exited.stderr,
          /--output-format acp-daemon is not implemented in this build\./,
        );
        assert.equal(exited.stdout, "");
        assert.equal(server.requests.length, 0);
      },
    );
  },
);

test(
  "-o acp refuses --disable-builtin-skills before starting a session",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const exited = await spawnCli(
          directory,
          execArgs(settingsPath, [
            "-o",
            "acp",
            "-m",
            "custom:mock",
            "--disable-builtin-skills",
          ]),
        ).done;
        assert.equal(exited.code, 1);
        assert.equal(
          exited.stderr.trim(),
          "Invalid flags: --disable-builtin-skills is not supported in ACP modes.",
        );
        assert.equal(exited.stdout, "");
        assert.equal(server.requests.length, 0);
      },
    );
  },
);

test(
  "-o acp carries a prompt's image into the provider request (B65)",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const child = spawnCli(
          directory,
          execArgs(settingsPath, ["-o", "acp", "-m", "custom:mock"]),
        );
        const feed = new FrameFeed(child);

        child.write(request(1, "initialize", { protocolVersion: 1 }));
        assert.ok(isRecord((await feed.response(1)).result));
        child.write(
          request(2, "session/new", { cwd: directory, mcpServers: [] }),
        );
        const sessionId = sessionIdOf(await feed.response(2));

        child.write(
          request(3, "session/prompt", {
            sessionId,
            prompt: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              { type: "text", text: "what is this?" },
            ],
          }),
        );
        const done = await feed.response(3);
        assert.deepEqual(done.result, { stopReason: "end_turn" });

        // The image reached the wire as a data-URL part, not as dropped input.
        assert.equal(server.requests.length, 1);
        const body = server.bodies[0];
        assert.ok(body !== undefined);
        const sent = JSON.parse(body) as { messages?: unknown };
        assert.match(
          JSON.stringify(sent.messages),
          /"type":"image_url","image_url":\{"url":"data:image\/png;base64,aGVsbG8="}/,
        );
        assert.match(JSON.stringify(sent.messages), /what is this\?/);

        child.end();
        assert.equal((await child.done).code, 0);
      },
    );
  },
);

test(
  "-o acp refuses a prompt image whose type it cannot take (B65)",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      DONE_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const child = spawnCli(
          directory,
          execArgs(settingsPath, ["-o", "acp", "-m", "custom:mock"]),
        );
        const feed = new FrameFeed(child);

        child.write(request(1, "initialize", { protocolVersion: 1 }));
        assert.ok(isRecord((await feed.response(1)).result));
        child.write(
          request(2, "session/new", { cwd: directory, mcpServers: [] }),
        );
        const sessionId = sessionIdOf(await feed.response(2));

        child.write(
          request(3, "session/prompt", {
            sessionId,
            prompt: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/tiff" },
            ],
          }),
        );
        const failed = errorOf(await feed.response(3));
        assert.equal(failed.code, -32602);
        assert.equal(
          failed.message,
          "Invalid params: Unsupported prompt image type: image/tiff",
        );
        assert.equal(server.requests.length, 0);

        child.end();
        // B55: a prompt that could not be answered is a failed run.
        assert.equal((await child.done).code, 1);
      },
    );
  },
);
