import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TODO_MAX_ITEMS,
  TodoStore,
  createTodoTool,
  parseTodoList,
} from "../../../src/tools/todo.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { makeToolFixture } from "./helpers.ts";

test("numbered lines parse in line order with their statuses", () => {
  const items = parseTodoList(
    "1. [completed] First\n2. [in_progress] Second\n3. [pending] Third\n",
  );
  assert.deepEqual(
    items.map((item) => [item.status, item.content]),
    [
      ["completed", "First"],
      ["in_progress", "Second"],
      ["pending", "Third"],
    ],
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ["todo-1", "todo-2", "todo-3"],
  );
});

test("an array of objects is accepted for tolerance", () => {
  const items = parseTodoList([
    { content: "task", status: "pending" },
    { content: "other", status: "completed", priority: "high", id: "x" },
  ]);
  assert.deepEqual(items, [
    { content: "task", status: "pending", priority: "medium", id: "todo-1" },
    { content: "other", status: "completed", priority: "high", id: "x" },
  ]);
});

test("a line that is not in the documented form is refused", () => {
  assert.throws(
    () => parseTodoList("1. do the thing"),
    /Todo item 1 is not in the form "N\. \[status\] text"/,
  );
});

test("the item count and item length limits are enforced", () => {
  const lines = Array.from(
    { length: TODO_MAX_ITEMS + 1 },
    (_, index) => `${index + 1}. [pending] task`,
  ).join("\n");
  assert.throws(() => parseTodoList(lines), /Too many todo items: 51/);
  assert.throws(
    () => parseTodoList(`1. [pending] ${"x".repeat(501)}`),
    /longer than 500 characters/,
  );
});

test("the tool replaces the store's list and reports a summary", async () => {
  const fixture = makeToolFixture();
  try {
    const store = new TodoStore();
    const registry = new ToolRegistry();
    registry.register(createTodoTool(store));
    const outcome = await registry.dispatch(
      "todo_write",
      { todos: "1. [completed] done\n2. [in_progress] now" },
      fixture.context,
    );
    assert.deepEqual(outcome, {
      ok: true,
      value:
        "Updated todo list: 2 item(s) — 1 completed, 1 in progress, 0 pending.",
    });
    assert.equal(store.list().length, 2);
    assert.equal(store.list()[1]?.content, "now");
  } finally {
    fixture.cleanup();
  }
});