/**
 * Envelope and frame contract. Clauses: `specs/70` B12–B14, B18 and the
 * "Wire constants" table.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DaemonProtocolError } from "../../../src/daemon/errors.ts";
import {
  COMPRESSED_PAYLOAD_TAG,
  DROIDE_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  JSON_RPC_ERRORS,
  LEGACY_DROIDE_API_VERSION,
  MAX_FRAME_BYTES,
  assertFrameWithinBounds,
  attachVersionMismatch,
  createErrorObject,
  createErrorResponse,
  createNotification,
  createRequest,
  createSuccessResponse,
  encodeBinaryFrame,
  envelopeVersionMismatch,
  isUuidV4,
  negotiateEncoding,
  parseBinaryFrame,
  parseEnvelopeValue,
  parseIpcFrame,
  parseTextFrame,
  protocolVersionMismatch,
  serializeEnvelope,
} from "../../../src/daemon/protocol.ts";

const ID = "0b8f2f0e-9b1a-4c3d-8e4f-1a2b3c4d5e6f";

function parseFailureOf(run: () => unknown): DaemonProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof DaemonProtocolError) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: "expected a protocol error" });
}

test("a request envelope carries the frozen fields and a UUID v4 id", () => {
  const envelope = createRequest("daemon.authenticate", { token: "t" });
  assert.equal(envelope.type, "request");
  assert.equal(envelope.jsonrpc, JSONRPC_VERSION);
  assert.equal(envelope.droideApiVersion, LEGACY_DROIDE_API_VERSION);
  assert.equal(envelope.droideProtocolVersion, DROIDE_PROTOCOL_VERSION);
  assert.equal(envelope.method, "daemon.authenticate");
  assert.ok(isUuidV4(envelope.id));
  assert.deepEqual(envelope.params, { token: "t" });
});

test("a request without params omits the member entirely", () => {
  const envelope = createRequest("daemon.logout");
  assert.equal(Object.hasOwn(envelope, "params"), false);
  assert.equal(JSON.stringify(envelope).includes('"params"'), false);
});

test("a success response echoes the request id and carries only result", () => {
  const envelope = createSuccessResponse(ID, { userId: "u", orgId: "o" });
  assert.equal(envelope.type, "response");
  assert.equal(envelope.id, ID);
  assert.deepEqual(envelope.result, { userId: "u", orgId: "o" });
  assert.equal(Object.hasOwn(envelope, "error"), false);
});

test("an error response carries error and no result, and null only for a parse failure", () => {
  const withId = createErrorResponse(ID, JSON_RPC_ERRORS.parse, "Parse error");
  assert.equal(Object.hasOwn(withId, "result"), false);
  assert.deepEqual(withId.error, { code: -32700, message: "Parse error" });
  assert.equal(withId.id, ID);

  const withNull = createErrorResponse(
    null,
    JSON_RPC_ERRORS.parse,
    "Parse error",
  );
  assert.equal(withNull.id, null);
});

test("createErrorObject omits data when it is absent", () => {
  assert.deepEqual(createErrorObject(-32603, "Internal server error"), {
    code: -32603,
    message: "Internal server error",
  });
  assert.deepEqual(createErrorObject(-32602, "bad", { issues: [] }), {
    code: -32602,
    message: "bad",
    data: { issues: [] },
  });
});

test("a serialized envelope parses back to the same object", () => {
  const envelopes = [
    createRequest("list_sessions", { limit: 1 }, { id: ID }),
    createSuccessResponse(ID, { ok: true }),
    createErrorResponse(ID, JSON_RPC_ERRORS.methodNotFound, "nope"),
    createNotification("daemon.connection_status", { platform: "linux" }),
  ];
  for (const envelope of envelopes) {
    assert.deepEqual(parseTextFrame(serializeEnvelope(envelope)), envelope);
  }
});

test("invalid JSON is a parse error with code -32700", () => {
  const error = parseFailureOf(() => parseTextFrame("{not json"));
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
  assert.equal(error.message, "Parse error");
});

test("an envelope with an unknown type is a parse error", () => {
  const error = parseFailureOf(() =>
    parseTextFrame(
      JSON.stringify({
        type: "event",
        jsonrpc: "2.0",
        droideApiVersion: "1.0.0",
      }),
    ),
  );
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
});

test("a response carrying both result and error is refused", () => {
  const error = parseFailureOf(() =>
    parseEnvelopeValue({
      type: "response",
      jsonrpc: "2.0",
      droideApiVersion: "1.0.0",
      id: ID,
      result: 1,
      error: { code: -32603, message: "both" },
    }),
  );
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
  assert.match(error.message, /exactly one of result or error/);
});

test("a response carrying neither result nor error is refused", () => {
  const error = parseFailureOf(() =>
    parseEnvelopeValue({
      type: "response",
      jsonrpc: "2.0",
      droideApiVersion: "1.0.0",
      id: ID,
    }),
  );
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
});

test("a success response with a null id is refused, an error response is not", () => {
  assert.equal(
    parseFailureOf(() =>
      parseEnvelopeValue({
        type: "response",
        jsonrpc: "2.0",
        droideApiVersion: "1.0.0",
        id: null,
        result: {},
      }),
    ).code,
    JSON_RPC_ERRORS.parse,
  );
  const parsed = parseEnvelopeValue({
    type: "response",
    jsonrpc: "2.0",
    droideApiVersion: "1.0.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
  assert.equal(parsed.type, "response");
});

test("a request id that is not a UUID v4 is refused", () => {
  const error = parseFailureOf(() =>
    parseEnvelopeValue({
      type: "request",
      jsonrpc: "2.0",
      droideApiVersion: "1.0.0",
      id: "1",
      method: "ping",
    }),
  );
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
  assert.match(error.message, /UUID v4/);
});

test("an empty method and a non-string jsonrpc are refused", () => {
  assert.equal(
    parseFailureOf(() =>
      parseEnvelopeValue({
        type: "notification",
        jsonrpc: "2.0",
        droideApiVersion: "1.0.0",
        method: "",
      }),
    ).code,
    JSON_RPC_ERRORS.parse,
  );
  assert.equal(
    parseFailureOf(() =>
      parseEnvelopeValue({
        type: "notification",
        jsonrpc: "1.0",
        droideApiVersion: "1.0.0",
        method: "ping",
      }),
    ).code,
    JSON_RPC_ERRORS.parse,
  );
});

test("_meta must be an object when present", () => {
  assert.equal(
    parseFailureOf(() =>
      parseEnvelopeValue({
        type: "notification",
        jsonrpc: "2.0",
        droideApiVersion: "1.0.0",
        method: "ping",
        _meta: "trace",
      }),
    ).code,
    JSON_RPC_ERRORS.parse,
  );
});

test("a frame above the 8 MiB ceiling is refused before it is parsed", () => {
  assert.doesNotThrow(() =>
    assertFrameWithinBounds("x".repeat(MAX_FRAME_BYTES)),
  );
  const error = parseFailureOf(() =>
    assertFrameWithinBounds("x".repeat(MAX_FRAME_BYTES + 1)),
  );
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
  assert.match(error.message, /above the 8388608-byte limit/);
});

test("serializeEnvelope refuses a result that would exceed one frame", () => {
  const error = parseFailureOf(() =>
    serializeEnvelope(createSuccessResponse(ID, "y".repeat(MAX_FRAME_BYTES))),
  );
  assert.equal(error.code, JSON_RPC_ERRORS.parse);
});

test("a binary frame round-trips through the 0x01 raw-deflate tag", () => {
  const envelope = createNotification("daemon.connection_status", {
    platform: "linux",
  });
  const bytes = encodeBinaryFrame(envelope);
  assert.equal(bytes[0], COMPRESSED_PAYLOAD_TAG);
  assert.deepEqual(parseBinaryFrame(bytes), envelope);
  assert.ok(bytes.length < serializeEnvelope(envelope).length);
});

test("a binary frame without the tag, or with broken deflate, is refused", () => {
  const envelope = createNotification("ping");
  const bytes = encodeBinaryFrame(envelope);
  const untagged = bytes.subarray(1);
  assert.equal(
    parseFailureOf(() => parseBinaryFrame(untagged)).code,
    JSON_RPC_ERRORS.parse,
  );
  assert.equal(
    parseFailureOf(() => parseBinaryFrame(Uint8Array.of(0x01, 0xff, 0xff)))
      .code,
    JSON_RPC_ERRORS.parse,
  );
  assert.equal(
    parseFailureOf(() => parseBinaryFrame(new Uint8Array())).code,
    JSON_RPC_ERRORS.parse,
  );
});

test("an IPC frame must be a JSON string", () => {
  const envelope = createRequest("ping", undefined, { id: ID });
  assert.deepEqual(parseIpcFrame(serializeEnvelope(envelope)), envelope);
  assert.equal(
    parseFailureOf(() => parseIpcFrame({ type: "request" })).code,
    JSON_RPC_ERRORS.parse,
  );
});

test("a missing protocol version is not a mismatch; a different one is", () => {
  assert.equal(protocolVersionMismatch("1.321.0", undefined), undefined);
  assert.equal(protocolVersionMismatch("1.321.0", ""), undefined);
  assert.equal(protocolVersionMismatch("1.321.0", "1.321.0"), undefined);
  assert.deepEqual(protocolVersionMismatch("1.321.0", "1.300.0"), {
    localFactoryProtocolVersion: "1.321.0",
    peerFactoryProtocolVersion: "1.300.0",
  });
});

test("envelopeVersionMismatch names the message type, method and request id", () => {
  const mismatch = envelopeVersionMismatch(
    createRequest("list_sessions", undefined, {
      id: ID,
      protocolVersion: "1.300.0",
    }),
    "1.321.0",
  );
  assert.deepEqual(mismatch, {
    localFactoryProtocolVersion: "1.321.0",
    peerFactoryProtocolVersion: "1.300.0",
    messageType: "request",
    method: "list_sessions",
    requestId: ID,
  });
  const notification = envelopeVersionMismatch(
    createNotification("daemon.connection_status", undefined, {
      protocolVersion: "1.300.0",
    }),
    "1.321.0",
  );
  assert.equal(notification?.method, "daemon.connection_status");
  assert.equal(Object.hasOwn(notification ?? {}, "requestId"), false);
});

test("attachVersionMismatch keeps existing data and adds the record", () => {
  const decorated = attachVersionMismatch(
    createErrorObject(-32601, "Method not found: x", { reason: "unknown" }),
    {
      localFactoryProtocolVersion: "1.321.0",
      peerFactoryProtocolVersion: "1.300.0",
    },
  );
  assert.deepEqual(decorated.data, {
    reason: "unknown",
    protocolVersionMismatch: {
      localFactoryProtocolVersion: "1.321.0",
      peerFactoryProtocolVersion: "1.300.0",
    },
  });
  const noData = attachVersionMismatch(createErrorObject(-32601, "x"), {
    localFactoryProtocolVersion: "1.321.0",
    peerFactoryProtocolVersion: "1.300.0",
  });
  assert.deepEqual(noData.data, {
    protocolVersionMismatch: {
      localFactoryProtocolVersion: "1.321.0",
      peerFactoryProtocolVersion: "1.300.0",
    },
  });
});

test("only deflate-raw is negotiated, and only when the client lists it", () => {
  assert.equal(negotiateEncoding(["gzip", "deflate-raw"]), "deflate-raw");
  assert.equal(negotiateEncoding(["gzip"]), undefined);
  assert.equal(negotiateEncoding(undefined), undefined);
  assert.equal(negotiateEncoding("deflate-raw"), undefined);
});
