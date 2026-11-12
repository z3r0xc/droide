/**
 * Response validation at the native boundary. Contract: `protocol.ts`,
 * `specs/90-native-layer.md`, `crates/README.md`.
 *
 * The helper is an external process: a line it sends is parsed, never assumed.
 * These cases pin which shapes are accepted, that unknown envelope fields are
 * ignored, and that every rejected shape is a `NativeProtocolError` whose
 * message says what was wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NativeProtocolError } from "../../../src/native/errors.ts";
import {
  MAX_LINE_BYTES,
  MAX_PARAMS_BYTES,
  NATIVE_VERSION_METHOD,
  PROTOCOL_VERSION,
  isJsonObject,
  parseResponseLine,
  parseVersionResult,
} from "../../../src/native/protocol.ts";

function rejects(line: string, expected: RegExp): void {
  assert.throws(
    () => parseResponseLine(line),
    (error: unknown) => {
      assert.ok(error instanceof NativeProtocolError);
      assert.equal(error.name, "NativeProtocolError");
      assert.match(error.message, expected);
      return true;
    },
  );
}

test("the wire constants match the helper's documented protocol", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(NATIVE_VERSION_METHOD, "native.version");
  assert.equal(MAX_LINE_BYTES, 1 << 20);
  assert.ok(MAX_PARAMS_BYTES < MAX_LINE_BYTES);
});

test("a result response keeps its method-defined result unvalidated", () => {
  const response = parseResponseLine(
    '{"id":1,"result":{"protocol":1,"version":"0.0.0"}}',
  );

  assert.deepEqual(response, {
    kind: "result",
    id: 1,
    result: { protocol: 1, version: "0.0.0" },
  });
});

test("a result may be any JSON value, including null", () => {
  assert.deepEqual(parseResponseLine('{"id":2,"result":null}'), {
    kind: "result",
    id: 2,
    result: null,
  });
  assert.deepEqual(parseResponseLine('{"id":3,"result":[1,2]}'), {
    kind: "result",
    id: 3,
    result: [1, 2],
  });
});

test("an error response carries the helper's code and message", () => {
  assert.deepEqual(
    parseResponseLine(
      '{"id":4,"error":{"code":-32601,"message":"unknown method: nope"}}',
    ),
    { kind: "error", id: 4, code: -32601, message: "unknown method: nope" },
  );
});

test("an unattributable error has a null id", () => {
  assert.deepEqual(
    parseResponseLine(
      '{"id":null,"error":{"code":-32700,"message":"bad json"}}',
    ),
    { kind: "error", id: null, code: -32700, message: "bad json" },
  );
});

test("unknown envelope and error fields are ignored", () => {
  assert.deepEqual(
    parseResponseLine(
      '{"id":5,"result":{"a":1},"meta":{"took":2},"jsonrpc":"2.0"}',
    ),
    { kind: "result", id: 5, result: { a: 1 } },
  );
  assert.deepEqual(
    parseResponseLine(
      '{"id":6,"error":{"code":-32001,"message":"no","data":1},"x":0}',
    ),
    { kind: "error", id: 6, code: -32001, message: "no" },
  );
});

test("an empty line is refused", () => {
  rejects("", /response line is empty/);
});

test("non-JSON text is refused", () => {
  rejects("this is not a response", /not JSON/);
  rejects('{"id":1,"result":{', /not JSON/);
});

test("a JSON value that is not an object is refused", () => {
  for (const line of ["[]", '"text"', "null", "3", "true"]) {
    rejects(line, /not a JSON object/);
  }
});

test("a missing or mistyped id is refused", () => {
  rejects('{"result":{}}', /response id/);
  rejects('{"id":"1","result":{}}', /response id/);
  rejects('{"id":-1,"result":{}}', /response id/);
  rejects('{"id":1.5,"result":{}}', /response id/);
});

test("a result response with a null id is refused", () => {
  rejects('{"id":null,"result":{}}', /result response has a null id/);
});

test("an envelope with both or neither payload is refused", () => {
  rejects(
    '{"id":1,"result":{},"error":{"code":0,"message":"x"}}',
    /both result and error/,
  );
  rejects('{"id":1}', /neither result nor error/);
});

test("a mistyped error body is refused", () => {
  rejects('{"id":1,"error":null}', /error is not a JSON object/);
  rejects('{"id":1,"error":"nope"}', /error is not a JSON object/);
  rejects(
    '{"id":1,"error":{"code":"-1","message":"x"}}',
    /code is not an integer/,
  );
  rejects(
    '{"id":1,"error":{"code":-1.5,"message":"x"}}',
    /code is not an integer/,
  );
  rejects(
    '{"id":1,"error":{"code":-1,"message":5}}',
    /message is not a string/,
  );
});

test("a protocol error names the helper and method it was given", () => {
  assert.throws(
    () =>
      parseResponseLine("nope", {
        helperPath: "/opt/helper",
        method: "hash.sha256",
      }),
    (error: unknown) => {
      assert.ok(error instanceof NativeProtocolError);
      assert.equal(error.helperPath, "/opt/helper");
      assert.equal(error.method, "hash.sha256");
      assert.match(error.message, /helper \/opt\/helper/);
      assert.match(error.message, /method hash\.sha256/);
      assert.match(error.message, /not JSON/);
      return true;
    },
  );
});

test("a version result is decoded only when protocol and version are typed", () => {
  assert.deepEqual(parseVersionResult({ protocol: 1, version: "0.0.0" }), {
    protocol: 1,
    version: "0.0.0",
  });
  assert.deepEqual(
    parseVersionResult({ protocol: 2, version: "9.9.9", extra: true }),
    {
      protocol: 2,
      version: "9.9.9",
    },
  );
});

test("a malformed version result is refused", () => {
  for (const result of [
    null,
    [],
    "1",
    7,
    { version: "0.0.0" },
    { protocol: 1 },
  ]) {
    assert.throws(() => parseVersionResult(result), NativeProtocolError);
  }
  assert.throws(
    () => parseVersionResult({ protocol: "1", version: "0" }),
    /protocol/,
  );
  assert.throws(
    () => parseVersionResult({ protocol: -1, version: "0" }),
    /protocol/,
  );
  assert.throws(
    () => parseVersionResult({ protocol: 1.5, version: "0" }),
    /protocol/,
  );
  assert.throws(
    () => parseVersionResult({ protocol: 1, version: 42 }),
    /version/,
  );
});

test("the canonical object guard proves the container, not its fields", () => {
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject({ a: 1 }), true);
  for (const value of [null, 1, "x", [], true, undefined]) {
    assert.equal(isJsonObject(value), false);
  }
});
