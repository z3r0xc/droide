import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildToolListRows,
  renderToolListJson,
  renderToolListText,
} from "../../../src/exec/list-tools.ts";
import type { ToolDefinition } from "../../../src/tools/registry.ts";

function definition(
  id: string,
  llmId: string,
  displayName: string,
  category?: string,
): ToolDefinition {
  return {
    id,
    llmId,
    displayName,
    description: "does a thing",
    inputSchema: { type: "object" },
    sideEffects: [],
    requiresConfirmation: false,
    category,
  } as unknown as ToolDefinition;
}

const REGISTRY = [
  definition("read-cli", "Read", "Read"),
  definition("write-cli", "Write", "Write"),
  definition("grep_tool_cli", "Grep", "Grep"),
];

test("rows carry both allowances and the category", () => {
  const rows = buildToolListRows(
    REGISTRY,
    new Set(["Read", "Grep"]),
    new Set(["Read", "Write", "Grep"]),
  );

  assert.deepEqual(
    rows.map((row) => [row.llmId, row.defaultAllowed, row.currentlyAllowed]),
    [
      ["Grep", true, true],
      ["Read", true, true],
      ["Write", true, false],
    ],
  );
  assert.equal(
    rows.every((row) => row.category === "Other"),
    true,
  );
});

test("the text listing follows the documented shape", () => {
  const rows = buildToolListRows(
    REGISTRY,
    new Set(["Read"]),
    new Set(["Read", "Write"]),
  );
  const text = renderToolListText(rows, { model: "mock-1", autonomy: "low" });

  const lines = text.split("\n");
  assert.equal(lines[0], "Available tools for mock-1");
  assert.equal(lines[1], "Autonomy: low");
  assert.equal(lines[2], "");
  assert.equal(lines[3], "Other");
  assert.match(lines[4] ?? "", /^ {2}• Grep \(Grep\) - status: blocked$/);
  assert.match(lines[5] ?? "", /^ {2}• Read \(Read\) - status: allowed$/);
  assert.match(
    lines[6] ?? "",
    /^ {2}• Write \(Write\) - status: blocked override$/,
  );
});

test("a tool that is offered by default but blocked now is marked override", () => {
  const rows = buildToolListRows(
    [definition("write-cli", "Write", "Write")],
    new Set(),
    new Set(["Write"]),
  );
  assert.match(
    renderToolListText(rows, { model: "m", autonomy: "off" }),
    /status: blocked override/,
  );
});

test("the JSON listing is one line of the seven documented fields", () => {
  const rows = buildToolListRows(
    REGISTRY,
    new Set(["Read"]),
    new Set(["Read"]),
  );
  const text = renderToolListJson(rows);

  assert.equal(text.split("\n").length, 2);
  const parsed: unknown = JSON.parse(text);
  assert.equal(Array.isArray(parsed), true);
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  assert.deepEqual(Object.keys(first as Record<string, unknown>).sort(), [
    "category",
    "currentlyAllowed",
    "defaultAllowed",
    "description",
    "displayName",
    "id",
    "llmId",
  ]);
  assert.equal((first as { llmId: string }).llmId, "Grep");
});

test("every built-in tool declares one of the specified categories", async () => {
  const { createCoreRegistry } = await import("../../../src/tools/index.ts");

  const registry = createCoreRegistry();
  const allowed = new Set(registry.all().map((tool) => tool.llmId));
  const rows = buildToolListRows(registry.all(), allowed, allowed);

  const known = new Set(["Files", "Search", "Shell", "Tasks", "Other"]);
  for (const row of rows) {
    assert.ok(known.has(row.category), `${row.llmId} has ${row.category}`);
    assert.notEqual(row.category, "Other", `${row.llmId} declares no category`);
  }

  const files = rows
    .filter((row) => row.category === "Files")
    .map((row) => row.llmId);
  assert.deepEqual(files, ["Create", "Edit", "LS", "Read"]);
});

test("an MCP tool is grouped under MCP, not Other", async () => {
  const { createMcpToolDefinitions } =
    await import("../../../src/extensions/mcp/tools.ts");
  const called: string[] = [];
  const definitions = createMcpToolDefinitions([
    {
      name: "linear",
      config: {
        type: "http",
        url: "https://mcp.example.test",
        headers: {},
        disabled: false,
      },
      tools: [
        {
          name: "create_issue",
          description: "Create an issue",
          inputSchema: { type: "object" },
          outputSchema: undefined,
        },
      ],
      callTool: async (tool: string) => {
        called.push(tool);
        return { text: "ok", content: [], structuredContent: undefined };
      },
    },
  ]);

  const rows = buildToolListRows(definitions, new Set(), new Set());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.category, "MCP");
  assert.equal(called.length, 0);
});
