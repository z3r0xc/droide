import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatValidationFailure,
  parseInput,
  type ObjectSchema,
} from "../../../src/tools/validate.ts";

const schema: ObjectSchema = {
  kind: "object",
  properties: {
    name: { kind: "string", description: "The name." },
    count: {
      kind: "number",
      optional: true,
      default: 3,
      description: "A count.",
    },
    mode: {
      kind: "enum",
      values: ["fast", "slow"],
      optional: true,
      description: "How to run.",
    },
    tags: {
      kind: "array",
      optional: true,
      items: { kind: "string" },
      description: "Tags.",
    },
    enabled: { kind: "boolean", optional: true, description: "On or off." },
    either: {
      kind: "union",
      optional: true,
      options: [
        { kind: "string" },
        { kind: "array", items: { kind: "number" } },
      ],
      description: "A string or numbers.",
    },
  },
};

test("a valid input is returned with defaults filled in", () => {
  const result = parseInput(schema, { name: "x" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : undefined, {
    name: "x",
    count: 3,
  });
});

test("unknown keys are removed rather than rejected", () => {
  const result = parseInput(schema, { name: "x", extra: true });
  assert.equal(result.ok, true);
  assert.equal(
    result.ok && Object.hasOwn(result.value as object, "extra"),
    false,
  );
});

test("a missing required field reports its path", () => {
  const result = parseInput(schema, {});
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.issues, [
    { path: "input.name", message: "expected string" },
  ]);
});

test("a wrong type reports the expected and received types", () => {
  const result = parseInput(schema, { name: 4 });
  assert.deepEqual(result.ok ? [] : result.issues, [
    { path: "input.name", message: "expected string, received number" },
  ]);
});

test("enum, boolean and array item errors keep their paths", () => {
  const result = parseInput(schema, {
    name: "x",
    mode: "medium",
    enabled: "yes",
    tags: ["a", 2],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.issues.map((entry) => entry.path),
    ["input.mode", "input.tags.1", "input.enabled"],
  );
  assert.match(result.issues[0]?.message ?? "", /expected one of fast, slow/);
});

test("a union accepts either branch and reports the closest branch when neither matches", () => {
  assert.deepEqual(parseInput(schema, { name: "x", either: "text" }), {
    ok: true,
    value: { name: "x", count: 3, either: "text" },
  });
  const failed = parseInput(schema, { name: "x", either: [true] });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.ok ? [] : failed.issues, [
    { path: "input.either", message: "expected string, received array" },
  ]);
});

test("a number bound is enforced", () => {
  const bounded: ObjectSchema = {
    kind: "object",
    properties: {
      limit: { kind: "number", min: 1, description: "A limit." },
    },
  };
  const result = parseInput(bounded, { limit: 0 });
  assert.deepEqual(result.ok ? [] : result.issues, [
    { path: "input.limit", message: "expected a number >= 1" },
  ]);
});

test("the rejection text carries the parameter guide and the retry sentence", () => {
  const result = parseInput(schema, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  const text = formatValidationFailure("read-cli", result.issues, schema);
  assert.equal(
    text,
    "input.name: expected string\n\n" +
      'Tool "read-cli" accepts the following parameters:\n' +
      "- name (required): The name.\n" +
      "- count: A count.\n" +
      "- mode: How to run.\n" +
      "- tags: Tags.\n" +
      "- enabled: On or off.\n" +
      "- either: A string or numbers.\n\n" +
      "Please retry with valid parameters.",
  );
});
