/**
 * The tool layer's public surface.
 *
 * Contract: `specs/30-tools-and-sandbox.md` — the registry model, the six
 * side-effect classes, the permission algebra and the built-in tool set.
 */
import { readTool } from "./fs/read.ts";
import { createTool } from "./fs/write.ts";
import { editTool } from "./fs/edit.ts";
import { globTool } from "./fs/glob.ts";
import { grepTool } from "./fs/grep.ts";
import { lsTool } from "./fs/ls.ts";
import { ToolRegistry } from "./registry.ts";
import { executeTool } from "./shell/exec.ts";
import { TodoStore, createTodoTool } from "./todo.ts";

export interface CoreToolOptions {
  /** Where `TodoWrite` keeps its list; a fresh store by default. */
  readonly todoStore?: TodoStore;
}

/** A registry holding every built-in tool this layer implements. */
export function createCoreRegistry(options: CoreToolOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registerCoreTools(registry, options);
  return registry;
}

/** Adds the built-in tools to an existing registry, in catalog order. */
export function registerCoreTools(
  registry: ToolRegistry,
  options: CoreToolOptions = {},
): ToolRegistry {
  registry.register(readTool);
  registry.register(lsTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(createTool);
  registry.register(editTool);
  registry.register(executeTool);
  registry.register(createTodoTool(options.todoStore ?? new TodoStore()));
  return registry;
}

export {
  FileReadTracker,
  type ReadRecord,
  type ReadTracker,
  type ToolContext,
} from "./context.ts";
export {
  OutputLimitError,
  ToolFailure,
  ToolInputError,
  ToolRegistrationError,
} from "./errors.ts";
export {
  SIDE_EFFECTS,
  ToolRegistry,
  defineTool,
  type SideEffect,
  type ToolDefinition,
  type ToolOutcome,
} from "./registry.ts";
export {
  MODEL_RESULT_BUDGET_BYTES,
  MODEL_TEXT_BUDGET_BYTES,
  MAX_INLINE_OUTPUT_BYTES,
  boundText,
  cutNotice,
} from "./result.ts";
export {
  autonomyToNumber,
  decide,
  decideWithRefusal,
  effectiveAutonomy,
  mcpRefusal,
  parseRiskLevel,
  refusal,
  skipsConfirmations,
  type AutonomyLevel,
  type CommandPolicyDecision,
  type Decision,
  type InteractionMode,
  type PathClass,
  type PermissionContext,
  type PermissionRequest,
  type RiskLevel,
  type ToolClass,
} from "./permissions.ts";
export {
  formatIssues,
  formatValidationFailure,
  parseInput,
  parseStringList,
  type ObjectSchema,
  type Schema,
  type ValidationIssue,
  type ValidationResult,
} from "./validate.ts";
export { readText, readTool } from "./fs/read.ts";
export { createFile, createTool, writeFileAtomic } from "./fs/write.ts";
export { editFile, editTool } from "./fs/edit.ts";
export { globFiles, globTool } from "./fs/glob.ts";
export { grepFiles, grepTool, type GrepContentLine } from "./fs/grep.ts";
export { listDirectory, lsTool, type DirectoryEntry } from "./fs/ls.ts";
export { executeCommand, executeTool, type ExecResult } from "./shell/exec.ts";
export {
  TodoStore,
  createTodoTool,
  parseTodoList,
  todoTool,
  type TodoItem,
} from "./todo.ts";