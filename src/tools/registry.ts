/**
 * The tool registry.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B1 (unique id, shared llmId,
 * registration order decides lookup, side-effect metadata validated at
 * registration) and B7/B8 (input validated before the executor runs).
 *
 * No module here imports a tool; tools import this one.
 */
import type { ToolContext } from "./context.ts";
import { ToolFailure, ToolInputError, ToolRegistrationError } from "./errors.ts";
import {
  formatIssues,
  formatValidationFailure,
  parseInput,
  type Schema,
} from "./validate.ts";

/** The six declared sandbox classes (B1, Terms). */
export const SIDE_EFFECTS = [
  "filesystem-read",
  "filesystem-write",
  "network",
  "process",
  "external-service",
  "persistent-settings",
] as const;

export type SideEffect = (typeof SIDE_EFFECTS)[number];

const VALID_SIDE_EFFECTS: Readonly<Record<string, true>> = Object.fromEntries(
  SIDE_EFFECTS.map((effect) => [effect, true]),
);

/** A tool the model can call, with everything dispatch needs. */
export interface ToolDefinition {
  /** Registry key, e.g. `read-cli`. */
  readonly id: string;
  /** Model-facing name, e.g. `Read`. Several ids may share one. */
  readonly llmId: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly sideEffects: readonly SideEffect[];
  /**
   * Declared metadata only: the prompt is decided per call by
   * `permissions.decide` (B41).
   */
  readonly requiresConfirmation: boolean;
  /** Loaded only through `ToolSearch` (Terms). */
  readonly deferred?: boolean;
  /** Shown in UI tool selection (B4). */
  readonly visibleToUser?: boolean;
  /** Runs with input already validated by {@link ToolRegistry.dispatch}. */
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolSpec<TInput, TContext extends ToolContext> {
  readonly id: string;
  readonly llmId: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly sideEffects: readonly SideEffect[];
  readonly requiresConfirmation?: boolean;
  readonly deferred?: boolean;
  readonly visibleToUser?: boolean;
  run(input: TInput, context: TContext): Promise<unknown> | unknown;
}

/**
 * Builds a definition whose executor receives the validated input. The one
 * cast is a value conversion at a validated boundary; the registry is the only
 * caller that invokes `execute`.
 */
export function defineTool<TInput, TContext extends ToolContext>(
  spec: ToolSpec<TInput, TContext>,
): ToolDefinition {
  const definition: ToolDefinition = {
    id: spec.id,
    llmId: spec.llmId,
    displayName: spec.displayName,
    description: spec.description,
    inputSchema: spec.inputSchema,
    sideEffects: spec.sideEffects,
    requiresConfirmation: spec.requiresConfirmation === true,
    execute: async (input: unknown, context: ToolContext): Promise<unknown> =>
      spec.run(input as TInput, context as TContext),
  };
  return {
    ...definition,
    ...(spec.deferred === undefined ? {} : { deferred: spec.deferred }),
    ...(spec.visibleToUser === undefined
      ? {}
      : { visibleToUser: spec.visibleToUser }),
  };
}

export type ToolOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

function assertSideEffects(definition: ToolDefinition): void {
  const sideEffects: unknown = definition.sideEffects;
  if (!Object.hasOwn(definition, "sideEffects")) {
    throw new ToolRegistrationError(
      "Tool is missing sandbox side-effect metadata",
      definition.id,
    );
  }
  if (!Array.isArray(sideEffects)) {
    throw new ToolRegistrationError(
      "Tool has invalid sandbox side-effect metadata",
      definition.id,
    );
  }
  const invalid = sideEffects.filter(
    (entry: unknown) => typeof entry !== "string" || !Object.hasOwn(VALID_SIDE_EFFECTS, entry),
  );
  if (invalid.length > 0) {
    throw new ToolRegistrationError(
      "Tool has invalid sandbox side-effect metadata",
      definition.id,
    );
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly idsByLlmId = new Map<string, string[]>();
  private mutationCount = 0;

  /** Monotonic registration/removal count, stable across reads (B1). */
  get generation(): number {
    return this.mutationCount;
  }

  register(definition: ToolDefinition): void {
    assertSideEffects(definition);
    const previous = this.tools.get(definition.id);
    if (previous !== undefined) {
      this.removeFromLlmIndex(previous);
    }
    // A Map keeps the first insertion position for a replaced id, so the
    // catalog order never depends on re-registration.
    this.tools.set(definition.id, definition);
    const ids = this.idsByLlmId.get(definition.llmId) ?? [];
    if (!ids.includes(definition.id)) ids.push(definition.id);
    this.idsByLlmId.set(definition.llmId, ids);
    this.mutationCount += 1;
  }

  remove(toolId: string): boolean {
    const previous = this.tools.get(toolId);
    if (previous === undefined) return false;
    this.tools.delete(toolId);
    this.removeFromLlmIndex(previous);
    this.mutationCount += 1;
    return true;
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  get(toolId: string): ToolDefinition | undefined {
    return this.tools.get(toolId);
  }

  /** Every definition naming `llmId`, in registration order (B1). */
  byLlmId(llmId: string): readonly ToolDefinition[] {
    const ids = this.idsByLlmId.get(llmId) ?? [];
    return ids
      .map((id) => this.tools.get(id))
      .filter((tool): tool is ToolDefinition => tool !== undefined);
  }

  /** Every registered definition, in registration order. */
  all(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Validates `input` against the definition's schema, then runs it. A
   * validation failure never reaches the executor (B7); a {@link ToolFailure}
   * becomes the error result; any other throw propagates.
   */
  async dispatch(
    toolId: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolOutcome> {
    const definition = this.tools.get(toolId);
    if (definition === undefined) {
      return { ok: false, error: `Tool "${toolId}" is not registered.` };
    }
    const parsed = parseInput(definition.inputSchema, input);
    if (!parsed.ok) {
      return {
        ok: false,
        error: formatValidationFailure(
          definition.id,
          parsed.issues,
          definition.inputSchema,
        ),
      };
    }
    try {
      return { ok: true, value: await definition.execute(parsed.value, context) };
    } catch (error) {
      if (error instanceof ToolInputError) {
        return { ok: false, error: error.message };
      }
      if (error instanceof ToolFailure) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }
}

/** B8's issue list, exported for callers that validate outside dispatch. */
export { formatIssues };