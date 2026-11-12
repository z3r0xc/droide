import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Environment } from "../../../src/config/paths.ts";
import {
  loadSkills,
  skillRoots,
  skillsPromptBlock,
} from "../../../src/extensions/skills/load.ts";

async function fixture(): Promise<{ root: string; environment: Environment }> {
  const root = await mkdtemp(join(tmpdir(), "droide-skills-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".factory"), { recursive: true });
  return {
    root,
    environment: { env: {}, home, platform: "linux", cwd: project },
  };
}

async function writeSkill(
  directory: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const target = join(directory, "skills", name);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

test("skills are read from the user and project directories", async () => {
  const { root, environment } = await fixture();
  try {
    await writeSkill(
      join(environment.home, ".factory"),
      "user-skill",
      "from the user",
      "user body",
    );
    await writeSkill(
      join(environment.cwd, ".factory"),
      "project-skill",
      "from the project",
      "project body",
    );

    const skills = loadSkills({ environment });

    const names = skills.map((skill) => skill.name).sort();
    assert.deepEqual(names, ["project-skill", "user-skill"]);
    assert.equal(
      skills.find((skill) => skill.name === "project-skill")?.bucket,
      "ProjectDir",
    );
    assert.equal(
      skills.find((skill) => skill.name === "user-skill")?.bucket,
      "UserDir",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the listing block carries one line per skill, never the body", async () => {
  const { root, environment } = await fixture();
  try {
    await writeSkill(
      join(environment.cwd, ".factory"),
      "deploy",
      "ship it",
      "SECRET BODY TEXT",
    );

    const block = skillsPromptBlock(loadSkills({ environment }));

    assert.match(block, /deploy/);
    assert.match(block, /ship it/);
    assert.equal(block.includes("SECRET BODY TEXT"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a disabled skill is not listed", async () => {
  const { root, environment } = await fixture();
  try {
    await writeSkill(
      join(environment.cwd, ".factory"),
      "gone",
      "disabled one",
      "body",
    );

    const block = skillsPromptBlock(
      loadSkills({ environment, disabledSkills: ["gone"] }),
    );

    assert.equal(block.includes("gone"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builtin skills are controllable from settings", async () => {
  const { root, environment } = await fixture();
  try {
    const builtinSkills = [
      { name: "builtin-one", description: "shipped", body: "b" },
    ];
    const enabled = skillsPromptBlock(
      loadSkills({ environment, builtinSkills }),
    );
    assert.match(enabled, /builtin-one/);

    const disabled = skillsPromptBlock(
      loadSkills({ environment, builtinSkills, disableBuiltinSkills: true }),
    );
    assert.equal(disabled.includes("builtin-one"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty tree yields an empty block", async () => {
  const { root, environment } = await fixture();
  try {
    assert.equal(skillsPromptBlock(loadSkills({ environment })), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("roots are project-before-user and extra roots come first", () => {
  const environment: Environment = {
    env: {},
    home: "/home/u",
    platform: "linux",
    cwd: "/work/p",
  };
  const roots = skillRoots(environment, [
    { bucket: "OrgPlugin", dir: "/org/skills" },
  ]);
  assert.deepEqual(
    roots.map((root) => root.bucket),
    ["OrgPlugin", "ProjectDir", "UserDir"],
  );
});
