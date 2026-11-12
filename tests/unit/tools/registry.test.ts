import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolContext } from "../../../src/tools/context.ts";
import { ToolFailure, ToolRegistrationError } from "../../../src/tools/errors.ts";
import {
  ToolRegistry,
  defineTool,
  type ToolDefinition,
} from "../../../src/tools/registry.ts";

const context: ToolContext = {
  root: "/workspace",
  environment: { env: {}, home: "/home", platform: "linux", cwd: "/workspace" },
};

function makeTool(
  id: string,
  llmId: string,
  run: () => unknown = () => "ok",
): ToolDefinition {
  return defineTool({
    id,
    llmId,
    displayName: id,
    description: id,
    inputSchema: {
      kind: "object",
      properties: { value: { kind: "string", description: "A value." } },
    },
    sideEffects: ["filesystem-read"],
    run,
  });
}

test("registration rejects a definition with no side-effect metadata", () => {
  const registry = new ToolRegistry();
  const broken = { ...makeTool("a", "A") } as Record<string, unknown>;
  delete broken.sideEffects;
  assert.throws(
    () => registry.register(broken as unknown as ToolDefinition),
    (error: unknown) =>
      error instanceof ToolRegistrationError &&
      error.message === "Tool is missing sandbox side-effect metadata" &&
      error.toolId === "a",
  );
});

test("registration rejects non-array and unknown side effects", () => {
  const registry = new ToolRegistry();
  const notArray = { ...makeTool("a", "A"), sideEffects: "network" };
  assert.throws(
    () => registry.register(notArray as unknown as ToolDefinition),
    /Tool has invalid sandbox side-effect metadata/,
  );
  const unknown = { ...makeTool("b", "B"), sideEffects: ["network", "telepathy"] };
  assert.throws(
    () => registry.register(unknown as unknown as ToolDefinition),
    /Tool has invalid sandbox side-effect metadata/,
  );
});

test("registration order is the catalog order and survives a replacement", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("a", "A"));
  registry.register(makeTool("b", "B"));
  registry.register(makeTool("c", "C"));
  registry.register(makeTool("b", "B", () => "replaced"));
  assert.deepEqual(
    registry.all().map((tool) => tool.id),
    ["a", "b", "c"],
  );
  assert.equal(registry.generation, 4);
});

test("several ids may share an llmId, in registration order", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("read-cli", "Read"));
  registry.register(makeTool("read-remote", "Read"));
  assert.deepEqual(
    registry.byLlmId("Read").map((tool) => tool.id),
    ["read-cli", "read-remote"],
  );
  assert.deepEqual(registry.byLlmId("Missing"), []);
});

test("lookup by id returns the definition; remove drops it from both indexes", () => {
  const registry = new ToolRegistry();
  const tool = makeTool("a", "A");
  registry.register(tool);
  assert.equal(registry.get("a"), tool);
  assert.equal(registry.has("a"), true);
  assert.equal(registry.remove("a"), true);
  assert.equal(registry.get("a"), undefined);
  assert.deepEqual(registry.byLlmId("A"), []);
  assert.equal(registry.remove("a"), false);
});

test("dispatch validates input before the executor runs", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registry.register(
    makeTool("a", "A", () => {
      calls += 1;
      return "ran";
    }),
  );
  const outcome = await registry.dispatch("a", { value: 1 }, context);
  assert.equal(calls, 0);
  assert.equal(outcome.ok, false);
  assert.match(
    outcome.ok ? "" : outcome.error,
    /accepts the following parameters/,
  );
});

test("dispatch returns the value and turns a ToolFailure into an error result", async () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("ok", "OK"));
  registry.register(
    makeTool("bad", "BAD", () => {
      throw new ToolFailure("refused by the tool");
    }),
  );
  assert.deepEqual(await registry.dispatch("ok", { value: "x" }, context), {
    ok: true,
    value: "ok",
  });
  assert.deepEqual(await registry.dispatch("bad", { value: "x" }, context), {
    ok: false,
    error: "refused by the tool",
  });
});

test("an unknown tool id is an error result, not a throw", async () => {
  const registry = new ToolRegistry();
  assert.deepEqual(await registry.dispatch("nope", {}, context), {
    ok: false,
    error: 'Tool "nope" is not registered.',
  });
});