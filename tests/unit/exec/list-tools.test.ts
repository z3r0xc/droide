import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToolList } from "../../../src/exec/list-tools.ts";
import type { ToolDefinition } from "../../../src/tools/registry.ts";
import type { LlmToolDefinition } from "../../../src/transport/llm.ts";

function definition(
  id: string,
  llmId: string,
  description: string,
): ToolDefinition {
  return {
    id,
    llmId,
    displayName: id,
    description,
    inputSchema: { type: "object" },
    sideEffects: [],
  } as unknown as ToolDefinition;
}

function offered(name: string): LlmToolDefinition {
  return { name, description: "", inputSchema: { type: "object" } };
}

const REGISTRY = [
  definition("read-cli", "Read", "Read a text file from the filesystem."),
  definition(
    "write-cli",
    "Write",
    "Create or overwrite a file with the given content.",
  ),
  definition(
    "grep_tool_cli",
    "Grep",
    "Search file contents with a regular expression. ".repeat(6),
  ),
];

test("the listing sorts by model-facing name and marks what is not offered", () => {
  const text = renderToolList(REGISTRY, [offered("Read"), offered("Grep")], {
    model: "mock-1",
    autonomy: "low",
    offered: 2,
    withheld: 1,
  });

  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "Tools for model mock-1 (autonomy: low) — 2 offered, 1 withheld",
  );

  const grep = lines.find((line) => line.includes("Grep"));
  const read = lines.find((line) => line.includes("Read"));
  const write = lines.find((line) => line.includes("Write"));
  assert.match(grep ?? "", /^ {4}Grep/);
  assert.match(read ?? "", /^ {4}Read/);
  assert.match(write ?? "", /^ {2}- /);
});

test("a long description is truncated with an ellipsis", () => {
  const text = renderToolList(REGISTRY, [], {
    model: "m",
    autonomy: "off",
    offered: 0,
    withheld: 3,
  });
  const grep = text.split("\n").find((line) => line.includes("Grep")) ?? "";
  assert.equal(grep.endsWith("…"), true);
  assert.equal(grep.length < 200, true);
});

test("an empty registry still prints the header and the legend", () => {
  const text = renderToolList([], [], {
    model: "m",
    autonomy: "off",
    offered: 0,
    withheld: 0,
  });
  assert.match(
    text,
    /^Tools for model m \(autonomy: off\) — 0 offered, 0 withheld$/m,
  );
  assert.match(text, /leading '-' marks a tool/);
});
