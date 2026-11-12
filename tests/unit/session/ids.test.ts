import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSessionIdFactory,
  isSessionId,
  type SessionIdFactory,
} from "../../../src/session/ids.ts";

function collect(factory: SessionIdFactory, count: number): string[] {
  return Array.from({ length: count }, () => factory.next());
}

test("ids are deterministic for one injected clock and counter", () => {
  const clock = { now: () => 1_700_000_000_000 };
  const first = collect(createSessionIdFactory(clock), 3);
  const second = collect(createSessionIdFactory(clock), 3);

  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 3);
});

test("ids have the UUIDv4 version and variant bits in lowercase", () => {
  const ids = collect(createSessionIdFactory({ now: () => 42 }), 16);
  for (const id of ids) {
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(isSessionId(id), true);
  }
});

test("the clock changes the id, so two sessions at different times differ", () => {
  let now = 10;
  const factory = createSessionIdFactory({ now: () => now });
  const first = factory.next();
  now = 11;
  const second = factory.next();
  assert.notEqual(first, second);
});

test("isSessionId rejects the wrong version, uppercase and non-UUID values", () => {
  assert.equal(isSessionId("8de06b5d-1db6-46e8-b909-d724036aa898"), true);
  assert.equal(isSessionId("8DE06B5D-1DB6-46E8-B909-D724036AA898"), false);
  assert.equal(isSessionId("8de06b5d-1db6-16e8-b909-d724036aa898"), false);
  assert.equal(isSessionId("session-1"), false);
  assert.equal(isSessionId(""), false);
});
