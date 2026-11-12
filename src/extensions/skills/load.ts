/**
 * Skills loading and prompt injection.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B46–B56. Discovery itself
 * lives in `discovery.ts` (buckets, frontmatter, collisions); this module is the
 * thin layer that turns the app's paths into roots, runs discovery, and renders
 * the listing block the system prompt carries.
 *
 * The listing is deliberately *not* the skill bodies: a skill's markdown enters
 * the conversation only when it is activated (`activateSkill`).
 */
import type { Environment } from "../../config/paths.ts";
import { factoryDir, projectDir } from "../../config/paths.ts";
import { join } from "node:path";

import {
  type EffectiveSkill,
  type InMemorySkill,
  type SkillRoot,
  discoverSkills,
  renderSkillsReminder,
} from "./discovery.ts";

export interface LoadSkillsOptions {
  readonly environment: Environment;
  /** Builtin skills shipped with this build. */
  readonly builtinSkills?: readonly InMemorySkill[];
  /** Merged `disabledSkills` ledger from settings. */
  readonly disabledSkills?: readonly string[];
  /** `--disable-builtin-skills`. */
  readonly disableBuiltinSkills?: boolean;
  /** Override the roots (tests, plugins, mission directories). */
  readonly extraRoots?: readonly SkillRoot[];
}

/** Roots this build reads, highest priority first. */
export function skillRoots(
  environment: Environment,
  extraRoots: readonly SkillRoot[] = [],
): readonly SkillRoot[] {
  return [
    ...extraRoots,
    // Project before user: a repository may shadow a personal skill.
    { bucket: "ProjectDir", dir: join(projectDir(environment), "skills") },
    { bucket: "UserDir", dir: join(factoryDir(environment), "skills") },
  ];
}

/** Discover the effective skill set. Never throws: unreadable roots are empty. */
export function loadSkills(
  options: LoadSkillsOptions,
): readonly EffectiveSkill[] {
  const result = discoverSkills({
    roots: skillRoots(options.environment, options.extraRoots ?? []),
    ...(options.builtinSkills === undefined
      ? {}
      : { builtinSkills: options.builtinSkills }),
    ...(options.disabledSkills === undefined
      ? {}
      : { disabledSkills: options.disabledSkills }),
    ...(options.disableBuiltinSkills === true
      ? { disableBuiltinSkills: true }
      : {}),
  });
  return result.skills;
}

/**
 * The one-line-per-skill block the system prompt carries, or `""` when there is
 * nothing to list. Token budget comes from the spec (1.5% of the window, capped).
 */
export function skillsPromptBlock(
  skills: readonly EffectiveSkill[],
  workingTokenLimit?: number,
): string {
  return renderSkillsReminder(
    skills,
    workingTokenLimit === undefined ? {} : { workingTokenLimit },
  );
}
