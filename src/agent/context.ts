/**
 * System-prompt assembly.
 *
 * Contract: `specs/20-agent-loop.md` §B35–B42 (block order, project
 * instructions, appended prompts, budgets). The identity line names Droide:
 * the assistant states what it is, which is a claim we can stand behind
 * (provenance: `docs/adr/0003`).
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { DISPLAY } from "../cli/brand.ts";

/** Project instruction files, in the order the contract looks for them. */
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Per-file and total caps for injected project instructions. */
export const MAX_INSTRUCTION_FILE_BYTES = 32 * 1024;
export const MAX_INSTRUCTIONS_TOTAL_BYTES = 128 * 1024;

export interface SystemPromptInput {
  /** Skills reminder block, already rendered (see `src/extensions/skills`). */
  readonly skillsListing?: string;
  /** Project instruction documents, highest priority first. */
  readonly instructions?: readonly ProjectInstruction[];
  /** `--append-system-prompt` text, appended verbatim last. */
  readonly appendText?: string;
  /** `--append-system-prompt-file` contents, appended after `appendText`. */
  readonly appendFileText?: string;
  /** Extra environment facts rendered as a short block (already formatted). */
  readonly environment?: string;
}

export interface ProjectInstruction {
  /** Absolute path, shown to the model so it can re-read the file. */
  readonly path: string;
  readonly content: string;
  /** True when the file was cut at the per-file cap. */
  readonly truncated?: boolean;
}

/** The identity line. First block of every system prompt (§B36). */
export function identityLine(): string {
  return `You are ${DISPLAY}, an AI software engineering agent.`;
}

/**
 * Collect project instruction files by walking from `startDir` to the
 * filesystem root, then returning them top-down so the closest file comes last
 * (and therefore wins on conflict).
 *
 * Files larger than {@link MAX_INSTRUCTION_FILE_BYTES} are cut and marked; the
 * total is bounded by {@link MAX_INSTRUCTIONS_TOTAL_BYTES}.
 */
export async function loadProjectInstructions(
  startDir: string,
): Promise<readonly ProjectInstruction[]> {
  const directories: string[] = [];
  let current = resolve(startDir);
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const found: ProjectInstruction[] = [];
  for (const directory of directories.reverse()) {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      const path = join(directory, name);
      const content = await readCapped(path);
      if (content === undefined) continue;
      found.push({
        path,
        content: content.text,
        ...(content.truncated ? { truncated: true } : {}),
      });
    }
  }

  const bounded: ProjectInstruction[] = [];
  let total = 0;
  for (const instruction of found) {
    if (total >= MAX_INSTRUCTIONS_TOTAL_BYTES) break;
    const room = MAX_INSTRUCTIONS_TOTAL_BYTES - total;
    if (instruction.content.length <= room) {
      bounded.push(instruction);
      total += instruction.content.length;
      continue;
    }
    bounded.push({
      path: instruction.path,
      content: instruction.content.slice(0, room),
      truncated: true,
    });
    total = MAX_INSTRUCTIONS_TOTAL_BYTES;
  }
  return bounded;
}

async function readCapped(
  path: string,
): Promise<{ text: string; truncated: boolean } | undefined> {
  try {
    const buffer = await readFile(path);
    const text = buffer.toString("utf8");
    if (text.length <= MAX_INSTRUCTION_FILE_BYTES)
      return { text, truncated: false };
    return { text: text.slice(0, MAX_INSTRUCTION_FILE_BYTES), truncated: true };
  } catch {
    // Missing or unreadable instruction files are not an error: most projects
    // have none at every level.
    return undefined;
  }
}

/** Render one instruction document as a prompt block. */
export function renderInstructionBlock(
  instruction: ProjectInstruction,
): string {
  const notice = instruction.truncated === true ? " (truncated)" : "";
  return `<project_instructions path="${instruction.path}"${notice}>\n${instruction.content.trimEnd()}\n</project_instructions>`;
}

/**
 * Assemble the system prompt: identity, environment, skills listing, project
 * instructions, then the appended text. Blocks are separated by one blank line
 * and empty blocks are dropped (§B40).
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const blocks: string[] = [identityLine()];
  if (input.environment !== undefined && input.environment.trim().length > 0)
    blocks.push(input.environment.trimEnd());
  if (
    input.skillsListing !== undefined &&
    input.skillsListing.trim().length > 0
  ) {
    blocks.push(input.skillsListing.trimEnd());
  }
  for (const instruction of input.instructions ?? [])
    blocks.push(renderInstructionBlock(instruction));
  if (input.appendText !== undefined && input.appendText.trim().length > 0)
    blocks.push(input.appendText.trimEnd());
  if (
    input.appendFileText !== undefined &&
    input.appendFileText.trim().length > 0
  ) {
    blocks.push(input.appendFileText.trimEnd());
  }
  return `${blocks.join("\n\n")}\n`;
}
