/**
 * The prompt a run starts with.
 *
 * Contract: `specs/20-agent-loop.md` §B35–B42 and
 * `specs/60-extensions-mcp-and-skills.md` §B53. This is the only place that
 * decides what goes into the system prompt: identity, environment facts, the
 * skills listing, project instruction files and the `--append-system-prompt`
 * flags, all through `buildSystemPrompt`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildSystemPrompt,
  loadProjectInstructions,
  type ProjectInstruction,
} from "../agent/context.ts";
import type { AppContext } from "./context.ts";
import {
  type InMemorySkill,
  type EffectiveSkill,
} from "../extensions/skills/discovery.ts";
import { loadSkills, skillsPromptBlock } from "../extensions/skills/load.ts";

/** Cap for `--append-system-prompt-file`, matching the instruction-file budget. */
export const MAX_APPEND_FILE_BYTES = 32 * 1024;

export interface BuildStartupPromptOptions {
  readonly context: AppContext;
  /** `--append-system-prompt`. */
  readonly appendSystemPrompt?: string;
  /** `--append-system-prompt-file`, read here. */
  readonly appendSystemPromptFile?: string;
  /** `--disable-builtin-skills`. */
  readonly disableBuiltinSkills?: boolean;
  readonly builtinSkills?: readonly InMemorySkill[];
  /** Injected skills (tests) instead of discovering from disk. */
  readonly skills?: readonly EffectiveSkill[];
  /** Injected instructions (tests). */
  readonly instructions?: readonly ProjectInstruction[];
  /** Working token window used for the skills budget. */
  readonly workingTokenLimit?: number;
  /** Injected date for the environment block (tests). */
  readonly today?: string;
}

async function readAppendFile(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const buffer = await readFile(absolute);
  const text = buffer.toString("utf8");
  return text.length <= MAX_APPEND_FILE_BYTES
    ? text
    : text.slice(0, MAX_APPEND_FILE_BYTES);
}

/**
 * Environment facts the model can rely on. No secrets, no clock: `today` is
 * passed by the caller so the block stays deterministic in tests.
 */
export function environmentBlock(context: AppContext, today?: string): string {
  const lines = [
    `<environment platform="${process.platform}" cwd="${context.environment.cwd}" />`,
  ];
  if (today !== undefined) lines.push(`Today: ${today}`);
  return lines.join("\n");
}

/** Assemble the run's system prompt. */
export async function buildStartupPrompt(
  options: BuildStartupPromptOptions,
): Promise<string> {
  const skills =
    options.skills ??
    loadSkills({
      environment: options.context.environment,
      ...(options.builtinSkills === undefined
        ? {}
        : { builtinSkills: options.builtinSkills }),
      ...(options.disableBuiltinSkills === true
        ? { disableBuiltinSkills: true }
        : {}),
    });
  const instructions =
    options.instructions ??
    (await loadProjectInstructions(options.context.environment.cwd));
  const appendFileText =
    options.appendSystemPromptFile === undefined
      ? undefined
      : await readAppendFile(options.appendSystemPromptFile);

  return buildSystemPrompt({
    environment: environmentBlock(options.context, options.today),
    skillsListing: skillsPromptBlock(skills, options.workingTokenLimit),
    ...(instructions.length === 0 ? {} : { instructions }),
    ...(options.appendSystemPrompt === undefined
      ? {}
      : { appendText: options.appendSystemPrompt }),
    ...(appendFileText === undefined ? {} : { appendFileText }),
  });
}
