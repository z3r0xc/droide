/**
 * `TodoWrite` — the session's todo list.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B34: `todos` is a string of numbered
 * lines `N. [pending|in_progress|completed] text`, at most 50 items of 500
 * characters, list order is line order, and an array is accepted for tolerance.
 * The item shape is the runtime one (`content`, `status`, `priority`, `id`).
 */
import type { ToolContext } from "./context.ts";
import { ToolFailure } from "./errors.ts";
import { defineTool, type ToolDefinition } from "./registry.ts";
import type { ObjectSchema } from "./validate.ts";

export const TODO_MAX_ITEMS = 50;
export const TODO_ITEM_MAX_CHARS = 500;

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
  readonly id: string;
}

const STATUSES: Readonly<Record<string, TodoStatus>> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
};

const PRIORITIES: Readonly<Record<string, TodoPriority>> = {
  high: "high",
  medium: "medium",
  low: "low",
};

const TODO_LINE = /^\s*(\d+)\.\s*\[(pending|in_progress|completed)\]\s*(.+?)\s*$/;

export const todoInputSchema: ObjectSchema = {
  kind: "object",
  properties: {
    todos: {
      kind: "union",
      options: [
        {
          kind: "string",
          description:
            "Numbered lines: `1. [pending] text`; order is line order.",
        },
        {
          kind: "array",
          items: { kind: "any" },
          description: "The same items as objects (accepted for tolerance).",
        },
      ],
      description: "The updated todo list.",
    },
  },
};

export interface TodoInput {
  readonly todos: string | readonly unknown[];
}

function itemFromLine(line: string, index: number): TodoItem {
  const match = TODO_LINE.exec(line);
  if (match === null) {
    throw new ToolFailure(
      `Todo item ${index + 1} is not in the form "N. [status] text": ${line}`,
    );
  }
  const content = match[3] ?? "";
  if (content.length > TODO_ITEM_MAX_CHARS) {
    throw new ToolFailure(
      `Todo item ${index + 1} is longer than ${TODO_ITEM_MAX_CHARS} characters.`,
    );
  }
  return {
    content,
    status: STATUSES[match[2] ?? "pending"] ?? "pending",
    priority: "medium",
    id: `todo-${index + 1}`,
  };
}

function itemFromObject(value: unknown, index: number): TodoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolFailure(`Todo item ${index + 1} must be an object.`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const content = typeof record.content === "string" ? record.content : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  if (content === undefined || content.length === 0 || status === undefined) {
    throw new ToolFailure(
      `Todo item ${index + 1} is missing a non-empty content or a status.`,
    );
  }
  if (content.length > TODO_ITEM_MAX_CHARS) {
    throw new ToolFailure(
      `Todo item ${index + 1} is longer than ${TODO_ITEM_MAX_CHARS} characters.`,
    );
  }
  if (!Object.hasOwn(STATUSES, status)) {
    throw new ToolFailure(
      `Todo item ${index + 1} has an unknown status "${status}".`,
    );
  }
  const priority =
    typeof record.priority === "string" ? record.priority : "medium";
  return {
    content,
    status: STATUSES[status] ?? "pending",
    priority: Object.hasOwn(PRIORITIES, priority)
      ? (PRIORITIES[priority] ?? "medium")
      : "medium",
    id: typeof record.id === "string" ? record.id : `todo-${index + 1}`,
  };
}

/** Parses either accepted shape into the documented items (B34). */
export function parseTodoList(value: string | readonly unknown[]): TodoItem[] {
  const items =
    typeof value === "string"
      ? value
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line, index) => itemFromLine(line, index))
      : value.map((item, index) => itemFromObject(item, index));
  if (items.length > TODO_MAX_ITEMS) {
    throw new ToolFailure(
      `Too many todo items: ${items.length}; the maximum is ${TODO_MAX_ITEMS}.`,
    );
  }
  return items;
}

/** The in-memory list a `TodoWrite` call replaces. */
export class TodoStore {
  private current: readonly TodoItem[] = [];

  list(): readonly TodoItem[] {
    return this.current;
  }

  replace(items: readonly TodoItem[]): void {
    this.current = [...items];
  }
}

function summary(items: readonly TodoItem[]): string {
  const count = (status: TodoStatus): number =>
    items.filter((item) => item.status === status).length;
  return (
    `Updated todo list: ${items.length} item(s) — ` +
    `${count("completed")} completed, ${count("in_progress")} in progress, ` +
    `${count("pending")} pending.`
  );
}

/** Builds the tool; state is held by the supplied store. */
export function createTodoTool(store: TodoStore = new TodoStore()): ToolDefinition {
  return defineTool<TodoInput, ToolContext>({
    id: "todo_write",
    llmId: "TodoWrite",
    displayName: "TodoWrite",
    description: "Replace the session's todo list.",
    inputSchema: todoInputSchema,
    sideEffects: [],
    requiresConfirmation: false,
    visibleToUser: false,
    run: (input) => {
      const items = parseTodoList(input.todos);
      store.replace(items);
      return summary(items);
    },
  });
}

export const todoTool: ToolDefinition = createTodoTool();