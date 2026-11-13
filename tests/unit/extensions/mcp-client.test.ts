/**
 * The MCP client's unit behaviour: naming integration, cursor merging, result
 * rendering and the timeout/cancel classification. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B13, B15-B17, B20-B22.
 *
 * Nothing here spawns a process or opens a socket: the transport is a seam, so
 * every budget and every frame is deterministic.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  McpClient,
  MCP_PROTOCOL_VERSION,
  parseCallToolResult,
  renderToolCallResult,
  type McpToolInfo,
} from "../../../src/extensions/mcp/client.ts";
import type { McpStdioServerConfig } from "../../../src/extensions/mcp/config.ts";
import {
  McpCancelledError,
  McpError,
  McpProtocolError,
  McpTimeoutError,
  McpToolError,
} from "../../../src/extensions/mcp/errors.ts";
import {
  createMcpToolDefinitions,
  isMcpToolEnabled,
  type McpServerTools,
} from "../../../src/extensions/mcp/tools.ts";
import type {
  McpServerNotification,
  McpTimers,
  McpTransport,
  McpTransportRequestOptions,
} from "../../../src/extensions/mcp/transport.ts";
import type { ToolContext } from "../../../src/tools/context.ts";
import { ToolFailure } from "../../../src/tools/errors.ts";

const CONFIG: McpStdioServerConfig = {
  type: "stdio",
  command: "node",
  args: [],
  env: {},
  disabled: false,
};

const CONTEXT: ToolContext = {
  root: ".",
  environment: { env: {}, home: ".", platform: "linux", cwd: "." },
};

/** Timers that fire on the next microtask: a budget that is always exhausted. */
const IMMEDIATE_TIMERS: McpTimers = {
  set(callback) {
    queueMicrotask(callback);
    return () => {};
  },
};

type Handler = (
  method: string,
  params: unknown,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

class FakeTransport implements McpTransport {
  readonly sent: { readonly method: string; readonly params: unknown }[] = [];
  handler: Handler = async () => ({});
  closed = false;
  notifications: string[] = [];
  serverNotifications: ((notification: McpServerNotification) => void)[] = [];

  async request(
    method: string,
    params?: unknown,
    options: McpTransportRequestOptions = {},
  ): Promise<unknown> {
    this.sent.push({ method, params });
    return await this.handler(method, params, options.signal);
  }

  async notify(method: string): Promise<void> {
    this.notifications.push(method);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  setNotificationHandler(
    handler: (notification: McpServerNotification) => void,
  ): void {
    this.serverNotifications.push(handler);
  }

  /** Deliver a server notification the way a transport's stream would. */
  deliver(method: McpServerNotification["method"]): void {
    for (const handler of this.serverNotifications) {
      handler({ method, params: {} });
    }
  }
}

/** Answer `initialize`, then refuse to answer anything else. */
function connectOnly(transport: FakeTransport, after: Handler): FakeTransport {
  transport.handler = async (method, params, signal) => {
    if (method === "initialize") {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0.0.0" },
      };
    }
    return await after(method, params, signal);
  };
  return transport;
}

/** Reject on abort, as a real transport does when its request settles early. */
function rejectOnAbort(stage: "not_sent" | "in_flight"): Handler {
  return async (_method, _params, signal) => {
    const { promise, reject } = Promise.withResolvers<unknown>();
    signal?.addEventListener(
      "abort",
      () => {
        reject(
          new McpCancelledError(stage, "aborted", {
            server: "unit",
            transport: "stdio",
          }),
        );
      },
      { once: true },
    );
    return await promise;
  };
}

async function connectedClient(
  transport: FakeTransport,
  options: {
    timers?: McpTimers;
    now?: () => number;
    listTimeoutMs?: number;
    callTimeoutMs?: number;
    listingFailureTtlMs?: number;
  } = {},
): Promise<McpClient> {
  const client = new McpClient({
    server: "unit",
    config: CONFIG,
    transport,
    ...options,
  });
  await client.connect();
  return client;
}

function toolInfo(name: string): McpToolInfo {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    outputSchema: undefined,
  };
}

/** A server slice whose `callTool` is the test's own spy. */
function serverTools(
  names: readonly string[],
  options: {
    enabledTools?: readonly string[];
    disabledTools?: readonly string[];
    callTool?: McpServerTools["callTool"];
  } = {},
): McpServerTools {
  return {
    name: "my-server",
    config: {
      ...CONFIG,
      ...(options.enabledTools === undefined
        ? {}
        : { enabledTools: options.enabledTools }),
      ...(options.disabledTools === undefined
        ? {}
        : { disabledTools: options.disabledTools }),
    },
    tools: names.map(toolInfo),
    callTool:
      options.callTool ??
      (async (_tool, args) => ({
        text: JSON.stringify(args),
        content: [],
        structuredContent: undefined,
      })),
  };
}

test("definitions take ids, llmIds and display names from naming.ts", () => {
  const definitions = createMcpToolDefinitions([
    serverTools(["echo", "plugin.tool", "plugin_tool"]),
  ]);
  assert.deepEqual(
    definitions.map((definition) => definition.id),
    [
      "mcp_my-server_echo",
      "mcp_my-server_plugin.tool",
      "mcp_my-server_plugin_tool",
    ],
  );
  assert.deepEqual(
    definitions.map((definition) => definition.displayName),
    [
      "[MCP] my-server:echo",
      "[MCP] my-server:plugin.tool",
      "[MCP] my-server:plugin_tool",
    ],
  );

  const [echo, dotted, underscored] = definitions;
  assert.equal(echo?.llmId, "my-server___echo");
  // The already-safe joined name keeps the clean llmId; the mutated sibling
  // gets an eight-character hash of its raw name (B17).
  assert.equal(underscored?.llmId, "my-server___plugin_tool");
  assert.match(dotted?.llmId ?? "", /^my-server___plugin_tool_[0-9a-f]{8}$/);
  assert.deepEqual(echo?.sideEffects, ["external-service"]);
  assert.equal(echo?.requiresConfirmation, true);
});

test("tool definitions honor enabledTools and let disabledTools win", () => {
  const allowlisted = createMcpToolDefinitions([
    serverTools(["echo", "other"], { enabledTools: ["my-server___echo"] }),
  ]);
  assert.deepEqual(
    allowlisted.map((definition) => definition.id),
    ["mcp_my-server_echo"],
  );

  const bare = createMcpToolDefinitions([
    serverTools(["echo", "other"], { enabledTools: ["other"] }),
  ]);
  assert.deepEqual(
    bare.map((definition) => definition.id),
    ["mcp_my-server_other"],
  );

  const both = createMcpToolDefinitions([
    serverTools(["echo"], {
      enabledTools: ["echo"],
      disabledTools: ["my-server___echo"],
    }),
  ]);
  assert.equal(both.length, 0);

  assert.equal(
    isMcpToolEnabled(CONFIG, "my-server", "echo"),
    true,
    "no filter means everything is enabled",
  );
});

test("the executor passes arguments through and renders the server's text", async () => {
  const calls: { tool: string; args: unknown }[] = [];
  const [definition] = createMcpToolDefinitions([
    serverTools(["echo"], {
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return {
          text: '{\n  "a": 1\n}',
          content: [],
          structuredContent: undefined,
        };
      },
    }),
  ]);
  assert.ok(definition !== undefined);
  const value = await definition.execute({ a: 1 }, CONTEXT);
  assert.deepEqual(calls, [{ tool: "echo", args: { a: 1 } }]);
  assert.equal(value, '{\n  "a": 1\n}');
});

test("a server failure reaches the registry as a ToolFailure", async () => {
  const [definition] = createMcpToolDefinitions([
    serverTools(["echo"], {
      callTool: async () => {
        throw new McpToolError("Error: boom", {
          server: "my-server",
          tool: "echo",
          text: "Error: boom",
        });
      },
    }),
  ]);
  assert.ok(definition !== undefined);
  await assert.rejects(
    definition.execute({}, CONTEXT),
    (error: unknown) =>
      error instanceof ToolFailure &&
      error.message === "Error: boom" &&
      error.toolId === "mcp_my-server_echo",
  );
});

test("cursor pages are requested in order and merged", async () => {
  const transport = connectOnly(
    new FakeTransport(),
    async (_method, params) => {
      const cursor = (params as { cursor?: string } | undefined)?.cursor;
      if (cursor === undefined) {
        return {
          tools: [toolInfo("alpha"), toolInfo("beta")],
          nextCursor: "p2",
        };
      }
      return { tools: [toolInfo("gamma")] };
    },
  );
  const client = await connectedClient(transport);
  const listing = await client.listTools();
  assert.deepEqual(
    listing.tools.map((tool) => tool.name),
    ["alpha", "beta", "gamma"],
  );
  assert.deepEqual(
    transport.sent
      .filter((entry) => entry.method === "tools/list")
      .map((entry) => entry.params),
    [{}, { cursor: "p2" }],
  );
  await client.close();
});

test("a repeated listing is served from the cache until it is invalidated", async () => {
  let listings = 0;
  const transport = connectOnly(new FakeTransport(), async () => {
    listings += 1;
    return { tools: [toolInfo(`tool-${listings}`)] };
  });
  const client = await connectedClient(transport);

  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-1"],
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-1"],
  );
  assert.equal(listings, 1, "the second call reused the cached listing");

  transport.deliver("notifications/tools/list_changed");
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-2"],
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["tool-2"],
  );
  assert.equal(
    listings,
    2,
    "one re-read after the notification, not one per call",
  );

  await client.listTools({ refresh: true });
  assert.equal(listings, 3, "refresh bypasses the cache");
  await client.close();
});

test("a resources notification leaves the tool listing cache alone", async () => {
  let listings = 0;
  const transport = connectOnly(new FakeTransport(), async () => {
    listings += 1;
    return { tools: [] };
  });
  const client = await connectedClient(transport);
  await client.listTools();
  transport.deliver("notifications/resources/updated");
  await client.listTools();
  assert.equal(listings, 1);
  await client.close();
});

test("a repeated cursor is refused instead of looping", async () => {
  const transport = connectOnly(new FakeTransport(), async () => ({
    tools: [],
    nextCursor: "p2",
  }));
  const client = await connectedClient(transport);
  await assert.rejects(
    client.listTools(),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      /cursor "p2" twice/.test(error.message),
  );
  await client.close();
});

test("a listing failure is negative-cached for sixty seconds", async () => {
  let now = 1_000;
  let attempts = 0;
  const transport = connectOnly(new FakeTransport(), async () => {
    attempts += 1;
    throw new McpProtocolError(
      "The MCP server returned an invalid tools/list result",
      {
        server: "unit",
      },
    );
  });
  const client = await connectedClient(transport, { now: () => now });

  const first = await client.listTools().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(first instanceof McpProtocolError);

  now += 59_000;
  const second = await client.listTools().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(second, first, "the cached failure is rethrown unchanged");
  assert.equal(attempts, 1, "no second request inside the TTL");

  now += 1_001;
  const third = await client.listTools().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(third instanceof McpProtocolError);
  assert.notEqual(third, first, "the expired entry was replaced");
  assert.equal(attempts, 2);

  await client.listTools({ refresh: true }).catch(() => undefined);
  assert.equal(attempts, 3, "refresh clears the entry before asking");
  await client.close();
});

test("a cancelled listing is never cached", async () => {
  let attempts = 0;
  const transport = connectOnly(new FakeTransport(), async () => {
    attempts += 1;
    throw new McpCancelledError("not_sent", "client_closed", {
      server: "unit",
      transport: "stdio",
    });
  });
  const client = await connectedClient(transport);
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(client.listTools(), McpCancelledError);
  }
  assert.equal(attempts, 2);
  await client.close();
});

test("each phase reports its own timeout identity", async () => {
  const listTransport = connectOnly(
    new FakeTransport(),
    rejectOnAbort("in_flight"),
  );
  const listClient = await connectedClient(listTransport, {
    timers: IMMEDIATE_TIMERS,
    listTimeoutMs: 15_000,
  });
  const listError = await listClient.listTools().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(listError instanceof McpTimeoutError);
  assert.equal(listError.phase, "list");
  assert.equal(listError.timeoutMs, 15_000);
  await listClient.close();

  const callTransport = connectOnly(
    new FakeTransport(),
    rejectOnAbort("in_flight"),
  );
  const callClient = await connectedClient(callTransport, {
    timers: IMMEDIATE_TIMERS,
    callTimeoutMs: 180_000,
  });
  const callError = await callClient.callTool("slow").then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(callError instanceof McpTimeoutError);
  assert.equal(callError.phase, "call");
  assert.match(
    callError.message,
    /^MCP tool unit\/slow timed out after 180 seconds$/,
  );
  await callClient.close();
});

test("a connect that never answers is a connect timeout that closes the transport", async () => {
  const transport = new FakeTransport();
  transport.handler = rejectOnAbort("in_flight");
  const client = new McpClient({
    server: "unit",
    config: { ...CONFIG, connectTimeout: 2_000 },
    transport,
    timers: IMMEDIATE_TIMERS,
  });
  const error = await client.connect().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof McpTimeoutError);
  assert.equal(error.phase, "connect");
  assert.equal(
    error.message,
    "MCP server connection timed out after 2 seconds",
  );
  assert.equal(transport.closed, true);
});

test("an already-aborted signal is not_sent and sends nothing", async () => {
  const transport = connectOnly(
    new FakeTransport(),
    rejectOnAbort("in_flight"),
  );
  const client = await connectedClient(transport);
  const before = transport.sent.length;
  const controller = new AbortController();
  controller.abort();

  const error = await client
    .callTool("echo", {}, { signal: controller.signal })
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  assert.ok(error instanceof McpCancelledError);
  assert.equal(error.stage, "not_sent");
  assert.equal(error.trigger, "aborted");
  assert.equal(transport.sent.length, before);
  await client.close();
});

test("cancelling a dispatched call keeps the transport's stage", async () => {
  const transport = connectOnly(
    new FakeTransport(),
    rejectOnAbort("in_flight"),
  );
  const client = await connectedClient(transport);
  const controller = new AbortController();
  const pending = client.callTool("echo", {}, { signal: controller.signal });
  controller.abort();

  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof McpCancelledError);
  assert.equal(error.stage, "in_flight");
  assert.equal(error.trigger, "aborted");
  await client.close();
});

test("a call on a closed client is not_sent and names the client", async () => {
  const transport = connectOnly(new FakeTransport(), async () => ({
    content: [],
  }));
  const client = await connectedClient(transport);
  await client.close();
  const error = await client.callTool("echo").then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof McpCancelledError);
  assert.equal(error.stage, "not_sent");
  assert.equal(error.trigger, "client_closed");
  assert.equal(error.server, "unit");
});

test("result blocks render text, JSON, images and placeholders", () => {
  const rendered = renderToolCallResult({
    content: [
      { kind: "text", text: "plain" },
      { kind: "text", text: '{"k":[1]}' },
      { kind: "image", mimeType: "image/png", data: "QUJD" },
      { kind: "other", blockType: "audio" },
    ],
    isError: false,
    structuredContent: undefined,
  });
  assert.equal(
    rendered.text,
    'plain\n{\n  "k": [\n    1\n  ]\n}\n[Image: image/png, 4 base64 bytes]\n[Unsupported content block: audio]',
  );
});

test("empty and error results use the spec's strings", () => {
  assert.equal(
    renderToolCallResult({
      content: [],
      isError: false,
      structuredContent: { ok: true },
    }).text,
    '{\n  "ok": true\n}',
  );
  assert.equal(
    renderToolCallResult({
      content: [],
      isError: false,
      structuredContent: undefined,
    }).text,
    "[No content returned]",
  );
  assert.equal(
    renderToolCallResult({
      content: [{ kind: "text", text: "boom" }],
      isError: true,
      structuredContent: undefined,
    }).text,
    "Error: boom",
  );
  assert.equal(
    renderToolCallResult({
      content: [],
      isError: true,
      structuredContent: { code: 7 },
    }).text,
    'Error: {\n  "code": 7\n}',
  );
  assert.equal(
    renderToolCallResult({
      content: [],
      isError: true,
      structuredContent: undefined,
    }).text,
    "Error: Unknown error occurred",
  );
});

test("a broken tools/call result is a protocol error, not a tool failure", () => {
  assert.throws(
    () => parseCallToolResult({ content: "nope" }, "unit", "echo"),
    (error: unknown) =>
      error instanceof McpProtocolError &&
      /content is not an array/.test(error.message),
  );
  assert.throws(
    () => parseCallToolResult({ content: [{ type: "text" }] }, "unit", "echo"),
    (error: unknown) =>
      error instanceof McpProtocolError && /text block/.test(error.message),
  );
  assert.throws(
    () => parseCallToolResult({ content: [], isError: "yes" }, "unit", "echo"),
    (error: unknown) => error instanceof McpProtocolError,
  );
});

test("every MCP failure carries the server name", () => {
  const failure = new McpTimeoutError("connect", 10_000, { server: "named" });
  assert.ok(failure instanceof McpError);
  assert.equal(failure.server, "named");
});
