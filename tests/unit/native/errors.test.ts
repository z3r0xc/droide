/**
 * Typed failures at the native boundary. Contract: `src/native/errors.ts`.
 *
 * A caller must be able to tell a remote refusal from a broken boundary, a
 * missing helper from a slow one, without reading prose. Each class carries the
 * fields the decision needs, and its message names the method and the helper.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NativeError,
  NativeProtocolError,
  NativeTimeoutError,
  NativeUnavailableError,
} from "../../../src/native/errors.ts";

test("a remote error keeps the helper's code, method and path", () => {
  const error = new NativeError(
    -32602,
    "bad params",
    "hash.sha256",
    "/bin/helper",
  );

  assert.ok(error instanceof Error);
  assert.equal(error.name, "NativeError");
  assert.equal(error.code, -32602);
  assert.equal(error.method, "hash.sha256");
  assert.equal(error.helperPath, "/bin/helper");
  assert.match(error.message, /hash\.sha256/);
  assert.match(error.message, /-32602/);
  assert.match(error.message, /bad params/);
  assert.match(error.message, /\/bin\/helper/);
});

test("a protocol error names what is known and stays quiet about the rest", () => {
  const bare = new NativeProtocolError("response line is empty");
  assert.equal(bare.name, "NativeProtocolError");
  assert.equal(bare.helperPath, undefined);
  assert.equal(bare.method, undefined);
  assert.equal(bare.message, "native protocol error: response line is empty");

  const contexted = new NativeProtocolError("protocol 2 required 1", {
    helperPath: "/bin/helper",
    method: "native.version",
  });
  assert.match(contexted.message, /method native\.version/);
  assert.match(contexted.message, /helper \/bin\/helper/);
  assert.match(contexted.message, /protocol 2 required 1/);
});

test("a protocol error keeps the parse cause", () => {
  const cause = new SyntaxError("Unexpected token");
  const error = new NativeProtocolError("response line is not JSON", { cause });

  assert.equal(error.cause, cause);
});

test("an unavailable error always names the helper path", () => {
  const error = new NativeUnavailableError("exited with code 3", {
    helperPath: "/bin/helper",
    method: "native.version",
  });

  assert.equal(error.name, "NativeUnavailableError");
  assert.equal(error.helperPath, "/bin/helper");
  assert.equal(error.method, "native.version");
  assert.match(error.message, /\/bin\/helper/);
  assert.match(error.message, /exited with code 3/);
});

test("a timeout error names the method, the budget and the helper", () => {
  const error = new NativeTimeoutError("hash.sha256", 250, "/bin/helper");

  assert.equal(error.name, "NativeTimeoutError");
  assert.equal(error.method, "hash.sha256");
  assert.equal(error.timeoutMs, 250);
  assert.equal(error.helperPath, "/bin/helper");
  assert.match(error.message, /hash\.sha256/);
  assert.match(error.message, /250ms/);
  assert.match(error.message, /\/bin\/helper/);
});

test("the four failure classes are distinguishable with instanceof", () => {
  const errors = [
    new NativeError(-1, "remote", "m", "/h"),
    new NativeProtocolError("wire"),
    new NativeUnavailableError("gone", { helperPath: "/h" }),
    new NativeTimeoutError("m", 1, "/h"),
  ];

  for (const error of errors) {
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, "Error");
  }
  assert.equal(new Set(errors.map((error) => error.name)).size, 4);
});
