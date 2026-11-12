/**
 * ACP wire contract: envelopes, params, prompt formatting, MCP conversion and
 * permission mapping. Clauses: `specs/60` B62, B64-B66, B68, B69.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACP_ERROR_CODES,
  ACP_MAX_FRAME_BYTES,
  ACP_PROTOCOL_VERSION,
  AcpProtocolError,
  agentMessageChunk,
  authMethodsFor,
  buildInitializeResult,
  convertAcpMcpServer,
  createAcpFailure,
  createAcpNotification,
  createAcpRequest,
  createAcpSuccess,
  createSessionUpdateNotification,
  extractImagesFromPrompt,
  formatPromptForExec,
  mapOptionsToAcp,
  mapOutcomeToKind,
  parseAcpContentBlock,
  parseAcpFrame,
  parseAcpMessage,
  parseAcpMcpServer,
  parseAuthenticateParams,
  parseInitializeParams,
  parseNewSessionParams,
  parsePermissionResponse,
  parsePromptParams,
  permissionResponseToOutcome,
  serializeAcpMessage,
  type AcpContentBlock,
} from "../../../src/acp/protocol.ts";

function protocolError(run: () => void): AcpProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof AcpProtocolError) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: "expected a protocol error" });
}

test("envelopes: requests, notifications and responses classify by shape", () => {
  assert.deepEqual(
    parseAcpMessage({ jsonrpc: "2.0", id: 4, method: "initialize" }),
    { jsonrpc: "2.0", id: 4, method: "initialize" },
  );
  assert.deepEqual(
    parseAcpMessage({ jsonrpc: "2.0", method: "session/cancel", params: {} }),
    { jsonrpc: "2.0", method: "session/cancel", params: {} },
  );
  assert.deepEqual(
    parseAcpMessage({ jsonrpc: "2.0", id: "a", result: { ok: true } }),
    { jsonrpc: "2.0", id: "a", result: { ok: true } },
  );
  assert.deepEqual(
    parseAcpMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }),
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    },
  );
});

test("envelopes: every malformed shape is refused with its JSON-RPC code", () => {
  assert.equal(
    protocolError(() => parseAcpFrame("{")).code,
    ACP_ERROR_CODES.parse,
  );
  for (const value of [
    [],
    { jsonrpc: "1.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", method: "" },
    { jsonrpc: "2.0", id: null, method: "initialize" },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } },
    { jsonrpc: "2.0", id: null, result: 1 },
    { jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: 1, message: 2 } },
  ]) {
    assert.equal(
      protocolError(() => parseAcpMessage(value)).code,
      ACP_ERROR_CODES.invalidRequest,
      JSON.stringify(value),
    );
  }
});

test("envelopes: a frame above the ceiling is a parse error", () => {
  const oversized = `{"jsonrpc":"2.0","method":"x","params":"${"a".repeat(80)}"}`;
  const error = protocolError(() => parseAcpFrame(oversized, 64));
  assert.equal(error.code, ACP_ERROR_CODES.parse);
  assert.match(error.message, /above the 64-byte limit/);
  assert.equal(ACP_MAX_FRAME_BYTES, 8 * 1024 * 1024);
});

test("envelopes: builders round-trip through the parser", () => {
  const request = createAcpRequest(7, "session/prompt", { sessionId: "s" });
  assert.deepEqual(parseAcpMessage(request), request);
  const notification = createAcpNotification("session/cancel", {
    sessionId: "s",
  });
  assert.deepEqual(parseAcpMessage(notification), notification);
  const success = createAcpSuccess(7, { stopReason: "end_turn" });
  assert.deepEqual(parseAcpMessage(success), success);
  const failure = createAcpFailure(null, -32700, "Parse error");
  assert.deepEqual(parseAcpMessage(failure), failure);
  assert.equal(
    serializeAcpMessage(createAcpSuccess(1, "x")),
    '{"jsonrpc":"2.0","id":1,"result":"x"}',
  );
});

test("initialize: params are validated and the result carries B62's surface", () => {
  assert.deepEqual(
    parseInitializeParams({
      protocolVersion: 1,
      clientCapabilities: { terminal: true },
      clientInfo: { name: "zed", version: "1.0", title: "Zed" },
    }),
    {
      protocolVersion: 1,
      clientCapabilities: { terminal: true },
      clientInfo: { name: "zed", version: "1.0", title: "Zed" },
    },
  );
  assert.equal(
    protocolError(() => parseInitializeParams({ protocolVersion: 70000 })).code,
    ACP_ERROR_CODES.invalidParams,
  );

  const result = buildInitializeResult({
    name: "droide",
    version: "0.4.0",
    title: "Factory Droid",
  });
  assert.equal(result.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.deepEqual(result.agentInfo, {
    name: "droide",
    version: "0.4.0",
    title: "Factory Droid",
  });
  assert.deepEqual(result.agentCapabilities.sessionCapabilities, {
    list: {},
    resume: {},
    close: {},
    fork: {},
  });
  assert.deepEqual(result.agentCapabilities.promptCapabilities, {
    image: true,
    embeddedContext: true,
  });
  assert.deepEqual(result.agentCapabilities.mcpCapabilities, {
    http: true,
    sse: true,
  });
  assert.deepEqual(result.agentCapabilities.auth, { logout: {} });
  assert.deepEqual(result.agentCapabilities._meta, {
    "terminal-auth": true,
  });
  assert.deepEqual(
    result.authMethods.map((method) => method.id),
    ["device-pairing", "factory-api-key"],
  );
  assert.deepEqual(
    authMethodsFor("customer-prem").map((method) => method.id),
    ["customer-prem"],
  );
});

test("authenticate: the method id is required", () => {
  assert.deepEqual(parseAuthenticateParams({ methodId: "device-pairing" }), {
    methodId: "device-pairing",
  });
  assert.equal(
    protocolError(() => parseAuthenticateParams({})).code,
    ACP_ERROR_CODES.invalidParams,
  );
});

test("session/new: MCP servers convert to the session shape (B64)", () => {
  const params = parseNewSessionParams({
    cwd: "/work",
    mcpServers: [
      {
        name: "shell",
        command: "node",
        args: ["server.mjs"],
        env: [{ name: "TOKEN", value: "abc" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
      {
        type: "sse",
        name: "events",
        url: "https://example.test/sse",
        headers: [],
      },
    ],
  });
  assert.equal(params.cwd, "/work");
  assert.deepEqual(params.mcpServers, [
    {
      type: "stdio",
      name: "shell",
      command: "node",
      args: ["server.mjs"],
      env: { TOKEN: "abc" },
    },
    {
      type: "http",
      name: "remote",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer x" },
    },
    {
      type: "sse",
      name: "events",
      url: "https://example.test/sse",
      headers: {},
    },
  ]);
});

test("session/new: the acp transport is refused with invalid params (B64)", () => {
  const server = parseAcpMcpServer({
    type: "acp",
    name: "client-mcp",
    serverId: "m1",
  });
  const error = protocolError(() => convertAcpMcpServer(server));
  assert.equal(error.code, ACP_ERROR_CODES.invalidParams);
  assert.match(
    error.message,
    /MCP servers with the acp transport are not supported/,
  );
  assert.deepEqual(error.data, { name: "client-mcp" });

  const paramsError = protocolError(() =>
    parseNewSessionParams({
      cwd: "/work",
      mcpServers: [{ type: "acp", name: "client-mcp", serverId: "m1" }],
    }),
  );
  assert.equal(paramsError.code, ACP_ERROR_CODES.invalidParams);
});

test("prompt: text, links, embedded context and images are parsed (B65)", () => {
  const blocks: AcpContentBlock[] = [
    { type: "text", text: "please review" },
    { type: "resource_link", uri: "file:///work/src/main.ts" },
    {
      type: "resource",
      resource: {
        uri: "file:///work/notes.md",
        mimeType: "text/markdown",
        text: "# notes",
      },
    },
    {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    },
    {
      type: "resource",
      resource: {
        uri: "file:///work/shot.png",
        mimeType: "image/png",
        blob: "aGVsbG8=",
      },
    },
  ];
  for (const block of blocks) {
    assert.deepEqual(parseAcpContentBlock(block), block);
  }
  assert.equal(
    formatPromptForExec(blocks),
    [
      "please review",
      "[@main.ts](file:///work/src/main.ts)",
      "[@notes.md](file:///work/notes.md)",
      "[@shot.png](file:///work/shot.png)",
      '<context ref="file:///work/notes.md">\n# notes\n</context>',
      "[Embedded image (image/png)]",
    ].join("\n"),
  );
  assert.deepEqual(
    extractImagesFromPrompt(blocks).map((image) => image.mimeType),
    ["image/png", "image/png"],
  );
  assert.equal(formatPromptForExec([{ type: "text", text: "  " }]), "");

  const params = parsePromptParams({
    sessionId: "s",
    prompt: [{ type: "text", text: "hi" }],
  });
  assert.deepEqual(params, {
    sessionId: "s",
    prompt: [{ type: "text", text: "hi" }],
  });
  assert.equal(
    protocolError(() =>
      parsePromptParams({ sessionId: "s", prompt: [{ type: "nope" }] }),
    ).code,
    ACP_ERROR_CODES.invalidParams,
  );
});

test("permissions: outcomes map to ACP kinds (B69)", () => {
  const kinds: Readonly<Record<string, string>> = {
    proceed_once: "allow_once",
    proceed_edit: "allow_once",
    proceed_always: "allow_always",
    proceed_always_tools: "allow_always",
    proceed_always_server: "allow_always",
    proceed_auto_run: "allow_always",
    proceed_auto_run_low: "allow_always",
    proceed_auto_run_medium: "allow_always",
    proceed_auto_run_high: "allow_always",
    cancel: "reject_once",
    something_else: "allow_once",
  };
  for (const [outcome, kind] of Object.entries(kinds)) {
    assert.equal(mapOutcomeToKind(outcome), kind, outcome);
  }
});

test("permissions: labels use the batch quantifier and short forms (B69)", () => {
  const once = mapOptionsToAcp([{ value: "proceed_once", label: "Proceed" }]);
  assert.deepEqual(once, [
    { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
  ]);
  const both = mapOptionsToAcp(
    [
      { value: "proceed_once", label: "Proceed" },
      { value: "cancel", label: "Cancel" },
    ],
    2,
  );
  assert.deepEqual(
    both.map((option) => option.name),
    ["Allow both", "Cancel"],
  );
  const all = mapOptionsToAcp(
    [
      { value: "proceed_auto_run_low", label: "Auto" },
      { value: "proceed_always", label: "Always allow" },
    ],
    3,
  );
  assert.deepEqual(
    all.map((option) => option.name),
    ["Allow all & auto-run (low risk)", "Allow all always"],
  );
});

test("permissions: a response resolves to a confirmation outcome", () => {
  assert.equal(
    permissionResponseToOutcome({
      outcome: "selected",
      optionId: "proceed_always",
    }),
    "proceed_always",
  );
  assert.equal(permissionResponseToOutcome({ outcome: "cancelled" }), "cancel");
  assert.equal(
    permissionResponseToOutcome({
      outcome: "selected",
      optionId: "proceed_once",
    }),
    "proceed_once",
  );
  assert.equal(
    permissionResponseToOutcome(
      { outcome: "selected", optionId: "proceed_once" },
      ["cancel"],
    ),
    "cancel",
  );
  assert.equal(
    permissionResponseToOutcome({
      outcome: "selected",
      optionId: "proceed_new_session",
    }),
    "cancel",
  );
  assert.deepEqual(
    parsePermissionResponse({
      outcome: { outcome: "selected", optionId: "proceed_once" },
    }),
    { outcome: "selected", optionId: "proceed_once" },
  );
  assert.equal(
    protocolError(() =>
      parsePermissionResponse({ outcome: { outcome: "selected" } }),
    ).code,
    ACP_ERROR_CODES.invalidParams,
  );
});

test("session updates: one notification carries one typed update (B68)", () => {
  const notification = createSessionUpdateNotification(
    "s",
    agentMessageChunk("hello", "m1"),
  );
  assert.deepEqual(notification, {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "m1",
      },
    },
  });
});
