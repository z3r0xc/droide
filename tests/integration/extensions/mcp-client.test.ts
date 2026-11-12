/**
 * The MCP client against a real child process. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B10, B13, B14, B20-B22.
 *
 * Every case spawns `tests/fixtures/mcp-server.mjs` in one switch, drives the
 * client, and then proves the process is gone after `close()`: `process.kill`
 * with signal 0 asks the OS, so no test relies on the client's own bookkeeping.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createMcpClient,
  type McpClient,
} from "../../../src/extensions/mcp/client.ts";
import type { McpStdioServerConfig } from "../../../src/extensions/mcp/config.ts";
import {
  McpCancelledError,
  McpProtocolError,
  McpTimeoutError,
  McpToolError,
} from "../../../src/extensions/mcp/errors.ts";

const FIXTURE = resolve(import.meta.dirname, "../../fixtures/mcp-server.mjs");

interface RunningServer {
  readonly client: McpClient;
  readonly pid: number;
  readonly dir: string;
}

interface StartOptions {
  readonly listTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

/** Spawn the fixture in `mode` and complete the handshake. */
async function startServer(
  t: TestContext,
  mode: string,
  options: StartOptions = {},
): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "droide-mcp-client-"));
  const pidFile = join(dir, "server.pid");
  const config: McpStdioServerConfig = {
    type: "stdio",
    command: process.execPath,
    args: [FIXTURE, mode],
    env: {},
    disabled: false,
  };

  const client = await createMcpClient({
    server: `fake-${mode}`,
    config,
    baseEnv: { ...process.env, FAKE_MCP_SERVER_PID_FILE: pidFile },
    ...(options.listTimeoutMs === undefined
      ? {}
      : { listTimeoutMs: options.listTimeoutMs }),
    ...(options.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.callTimeoutMs }),
  });

  t.after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0, "the fixture wrote its pid");
  return { client, pid, dir };
}

/** Signal 0 asks the OS; EPERM would still mean the process exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code === "EPERM";
  }
}

/** Close, then prove the child is gone. */
async function assertClosed(server: RunningServer): Promise<void> {
  await server.client.close();
  assert.equal(alive(server.pid), false, "the server process is gone");
}

/** The rejection value of a promise that must not resolve. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to reject");
}

test("a handshake, listing and call round-trip, and close leaves no process", async (t) => {
  const server = await startServer(t, "normal");
  assert.equal(server.client.connected, true);
  assert.equal(server.client.protocolVersion, "2025-06-18");
  assert.equal(server.client.serverInfo?.name, "fake-mcp");

  const listing = await server.client.listTools();
  assert.deepEqual(
    listing.tools.map((tool) => tool.name),
    ["echo", "blocks", "empty", "nothing"],
  );
  assert.deepEqual(listing.skipped, []);

  const echoed = await server.client.callTool("echo", { a: 1 });
  assert.equal(echoed.text, '{\n  "a": 1\n}');
  assert.deepEqual(echoed.structuredContent, undefined);

  await assertClosed(server);
});

test("tools/list cursors are followed and their pages merged in order", async (t) => {
  const server = await startServer(t, "paginated");
  const listing = await server.client.listTools();
  assert.deepEqual(
    listing.tools.map((tool) => tool.name),
    ["alpha", "beta", "gamma"],
  );
  await assertClosed(server);
});

test("a non-conforming tool is skipped and reported, never fatal", async (t) => {
  const server = await startServer(t, "lenient");
  const listing = await server.client.listTools();
  assert.deepEqual(
    listing.tools.map((tool) => tool.name),
    ["good"],
  );
  assert.equal(listing.skipped.length, 3);
  assert.deepEqual(
    listing.skipped.map((entry) => entry.reason),
    [
      "outputSchema is not an object schema",
      "the tool has no name",
      "duplicate tool name",
    ],
  );
  await assertClosed(server);
});

test("content blocks become text and placeholders", async (t) => {
  const server = await startServer(t, "normal");

  const blocks = await server.client.callTool("blocks");
  assert.match(blocks.text, /plain text/);
  assert.match(blocks.text, /\{\n {2}"a": 1,\n {2}"b": \[\n {4}2,/);
  assert.match(blocks.text, /\[Image: image\/png, 4 base64 bytes\]/);
  assert.match(blocks.text, /\[Unsupported content block: resource\]/);

  const structured = await server.client.callTool("empty");
  assert.equal(structured.text, '{\n  "ok": true\n}');

  const nothing = await server.client.callTool("nothing");
  assert.equal(nothing.text, "[No content returned]");

  await assertClosed(server);
});

test("a server-reported failure is a typed tool error", async (t) => {
  const server = await startServer(t, "tool-error");
  const error = await rejection(server.client.callTool("echo", { a: 1 }));
  assert.ok(error instanceof McpToolError);
  assert.equal(error.message, "Error: boom from the server");
  assert.equal(error.text, "Error: boom from the server");
  assert.equal(error.server, "fake-tool-error");
  assert.equal(error.tool, "echo");
  await assertClosed(server);
});

test("a malformed frame fails the listing as a protocol error", async (t) => {
  const server = await startServer(t, "malformed");
  const error = await rejection(server.client.listTools());
  assert.ok(error instanceof McpProtocolError);
  assert.match(error.message, /not JSON/);
  await assertClosed(server);
});

test("an answer for a request that was never sent is a protocol error", async (t) => {
  const server = await startServer(t, "wrong-id");
  const error = await rejection(server.client.listTools());
  assert.ok(error instanceof McpProtocolError);
  assert.match(error.message, /which is not pending/);
  await assertClosed(server);
});

test("a silent server times out every request and close settles them", async (t) => {
  const server = await startServer(t, "hang", {
    callTimeoutMs: 150,
    listTimeoutMs: 150,
  });

  const results = await Promise.allSettled([
    server.client.callTool("echo"),
    server.client.callTool("blocks"),
    server.client.callTool("empty"),
  ]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof McpTimeoutError);
      assert.equal(result.reason.phase, "call");
      assert.equal(result.reason.timeoutMs, 150);
    }
  }

  const listed = await rejection(server.client.listTools());
  assert.ok(listed instanceof McpTimeoutError);
  assert.equal(listed.phase, "list");

  await assertClosed(server);
});

test("a cancelled call reports that it was already in flight", async (t) => {
  const server = await startServer(t, "hang", { callTimeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = server.client.callTool(
    "echo",
    {},
    {
      signal: controller.signal,
    },
  );
  await delay(60);
  controller.abort();

  const error = await rejection(pending);
  assert.ok(error instanceof McpCancelledError);
  assert.equal(error.stage, "in_flight");
  assert.equal(error.trigger, "aborted");
  assert.equal(error.transport, "stdio");
  await assertClosed(server);
});

test("a server that exits mid-session settles the call as in flight", async (t) => {
  const server = await startServer(t, "exit-mid");
  const error = await rejection(server.client.listTools());
  assert.ok(error instanceof McpCancelledError);
  assert.equal(error.stage, "in_flight");
  assert.equal(error.trigger, "transport_closed");
  assert.equal(error.message, "Stdio MCP server transport closed");
  await assertClosed(server);
});

test("close kills a server that ignores the end of stdin", async (t) => {
  const server = await startServer(t, "stubborn");
  assert.equal(alive(server.pid), true);
  await server.client.close();
  assert.equal(alive(server.pid), false, "the server process is gone");
});
