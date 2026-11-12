#!/usr/bin/env node
/**
 * Fake MCP server for the client tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, the way a real stdio
 * server does, and answers `initialize` in every mode so a client can complete
 * its handshake and then observe the mode's fault.
 *
 * Modes: normal (default), paginated, lenient, tool-error, malformed, wrong-id,
 * hang, exit-mid, stubborn.
 *
 * `stubborn` ignores the end of stdin and keeps its event loop alive, so a
 * client's graceful close cannot work and only a kill ends it.
 *
 * When `FAKE_MCP_SERVER_PID_FILE` is set, the pid is written there before any
 * I/O so a test can prove the process is gone afterwards.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const MODES = new Set([
  "normal",
  "paginated",
  "lenient",
  "tool-error",
  "malformed",
  "wrong-id",
  "hang",
  "exit-mid",
  "stubborn",
]);

const PROTOCOL_VERSION = "2025-06-18";
const requested = process.argv[2] ?? "normal";
const mode = MODES.has(requested) ? requested : "normal";

const pidFile = process.env.FAKE_MCP_SERVER_PID_FILE;
if (pidFile !== undefined && pidFile !== "") {
  writeFileSync(pidFile, String(process.pid));
}

// The client may kill this process mid-write; a pipe error is not a failure.
process.stdout.on("error", () => {});
process.stdin.on("error", () => {});

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function tool(name, extra = {}) {
  return {
    name,
    description: `${name} from the fake server`,
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

function listPage(params) {
  const cursor = params?.cursor;
  if (mode === "paginated") {
    if (typeof cursor !== "string") {
      return {
        tools: [tool("alpha"), tool("beta")],
        nextCursor: "page-2",
      };
    }
    return { tools: [tool("gamma")] };
  }
  if (mode === "lenient") {
    return {
      tools: [
        tool("good"),
        tool("bad-output", { outputSchema: { type: "string" } }),
        { name: 42, description: "no name" },
        tool("good"),
      ],
    };
  }
  return {
    tools: [tool("echo"), tool("blocks"), tool("empty"), tool("nothing")],
  };
}

function callResult(id, params) {
  const name = params?.name;
  if (mode === "tool-error") {
    reply(id, {
      isError: true,
      content: [{ type: "text", text: "boom from the server" }],
    });
    return;
  }
  if (name === "echo") {
    reply(id, {
      content: [
        { type: "text", text: JSON.stringify(params?.arguments ?? {}) },
      ],
    });
    return;
  }
  if (name === "blocks") {
    reply(id, {
      content: [
        { type: "text", text: "plain text" },
        { type: "text", text: '{"a":1,"b":[2,3]}' },
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///note.txt" } },
      ],
    });
    return;
  }
  if (name === "empty") {
    reply(id, { content: [], structuredContent: { ok: true } });
    return;
  }
  if (name === "nothing") {
    reply(id, { content: [] });
    return;
  }
  fail(id, -32602, `unknown tool: ${String(name)}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, "request is not JSON");
    return;
  }

  const method = request?.method;
  const id = request?.id;
  const params = request?.params;
  if (typeof method !== "string") {
    fail(null, -32600, "request needs a method");
    return;
  }

  if (method === "notifications/initialized") return;

  if (typeof id !== "number") {
    fail(null, -32600, "request needs a numeric id");
    return;
  }

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fake-mcp", version: "0.0.0" },
    });
    return;
  }

  if (mode === "hang" && (method === "tools/list" || method === "tools/call")) {
    return;
  }

  if (method === "tools/list") {
    if (mode === "malformed") {
      process.stdout.write("this is not a frame\n");
      return;
    }
    if (mode === "wrong-id") {
      send({ jsonrpc: "2.0", id: id + 9_000, result: { tools: [] } });
      return;
    }
    if (mode === "exit-mid") {
      process.exit(9);
    }
    reply(id, listPage(params));
    return;
  }

  if (method === "tools/call") {
    callResult(id, params);
    return;
  }

  fail(id, -32601, `unknown method: ${method}`);
});

if (mode === "stubborn") {
  // Never exit on stdin end: only a kill can stop this server.
  setInterval(() => {}, 1_000);
} else {
  lines.on("close", () => {
    process.exit(0);
  });
}
