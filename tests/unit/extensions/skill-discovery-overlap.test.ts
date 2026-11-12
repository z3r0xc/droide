/**
 * Skill discovery order, on-disk layout and collisions. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B46, B47, B50.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  discoverSkills,
  SKILL_BUCKET_ORDER,
  type SkillRoot,
} from "../../../src/extensions/skills/discovery.ts";
import {
  createTempDirectory,
  skillMarkdown,
  writeFixture,
} from "./fixtures.ts";

function addSkill(
  root: string,
  directory: string,
  name: string,
  description: string,
): void {
  writeFixture(
    root,
    `${directory}/${name}/SKILL.md`,
    skillMarkdown(
      `name: ${name}\ndescription: ${description}`,
      `Body of ${name}.`,
    ),
  );
}

test("test_skill_discovery_with_overlapping_names: the first bucket in priority order wins", () => {
  const temp = createTempDirectory();
  try {
    addSkill(temp.path, "project", "shared", "project description");
    addSkill(temp.path, "user", "shared", "user description");
    addSkill(temp.path, "plugin", "shared", "plugin description");
    addSkill(temp.path, "user", "only-user", "user only");
    // A folder without SKILL.md contributes nothing.
    writeFixture(temp.path, "user/empty-dir/README.md", "nothing here");

    const roots: readonly SkillRoot[] = [
      { bucket: "ProjectPlugin", dir: `${temp.path}/plugin` },
      { bucket: "UserDir", dir: `${temp.path}/user` },
      { bucket: "ProjectDir", dir: `${temp.path}/project` },
    ];
    const result = discoverSkills({ roots });
    const byName = new Map(
      result.skills.map((skill) => [`${skill.name}@${skill.bucket}`, skill]),
    );

    const winner = byName.get("shared@ProjectDir");
    assert.ok(winner);
    assert.equal(winner.status, "active");
    assert.equal(winner.description, "project description");

    assert.equal(byName.get("shared@UserDir")?.status, "shadowed");
    assert.equal(byName.get("shared@ProjectPlugin")?.status, "shadowed");
    assert.equal(byName.get("only-user@UserDir")?.status, "active");
    assert.equal(
      result.skills.some((skill) => skill.filePath.includes("empty-dir")),
      false,
    );

    const crossBucket = result.collisions.filter(
      (collision) => collision.name === "shared",
    );
    assert.equal(crossBucket.length, 2);
    assert.ok(crossBucket.every((collision) => collision.sameBucket === false));
  } finally {
    temp.cleanup();
  }
});

test("test_skill_discovery_with_overlapping_names: the first input in one bucket wins and records a collision", () => {
  const temp = createTempDirectory();
  try {
    addSkill(temp.path, "first", "same", "first description");
    addSkill(temp.path, "second", "same", "second description");

    const result = discoverSkills({
      roots: [
        { bucket: "UserDir", dir: `${temp.path}/first` },
        { bucket: "UserDir", dir: `${temp.path}/second` },
      ],
    });
    const active = result.skills.filter((skill) => skill.name === "same");
    assert.equal(active.length, 2);
    assert.equal(active[0]?.status, "active");
    assert.equal(active[0]?.description, "first description");
    assert.equal(active[1]?.status, "shadowed");
    assert.equal(active[1]?.shadowedBy?.sameBucket, true);
    assert.equal(result.collisions.length, 1);
    assert.equal(result.collisions[0]?.sameBucket, true);
    assert.equal(result.collisions[0]?.loser.filePath.includes("second"), true);
  } finally {
    temp.cleanup();
  }
});

test("test_skill_discovery_with_overlapping_names: an invalid name never wins or shadows", () => {
  const temp = createTempDirectory();
  try {
    addSkill(temp.path, "user", "---", "invalid name");
    addSkill(temp.path, "user", "valid", "valid skill");

    const result = discoverSkills({
      roots: [{ bucket: "UserDir", dir: `${temp.path}/user` }],
    });
    const invalid = result.skills.find((skill) => skill.rawName === "---");
    assert.ok(invalid);
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.name, "");
    assert.equal(result.collisions.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("test_skill_discovery_with_overlapping_names: all eleven buckets resolve in priority order", () => {
  const temp = createTempDirectory();
  try {
    const roots: SkillRoot[] = [];
    for (const [index, bucket] of SKILL_BUCKET_ORDER.entries()) {
      const directory = `bucket-${index}`;
      addSkill(temp.path, directory, `skill-${index}`, bucket);
      roots.push({ bucket, dir: `${temp.path}/${directory}` });
    }
    // Scramble the input to prove ordering comes from the bucket list.
    roots.reverse();

    const result = discoverSkills({ roots });
    assert.deepEqual(
      result.skills.map((skill) => skill.bucket),
      [...SKILL_BUCKET_ORDER],
    );
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      SKILL_BUCKET_ORDER.map((_, index) => `skill-${index}`),
    );
  } finally {
    temp.cleanup();
  }
});

test("test_skill_discovery_with_overlapping_names: disable-builtin empties only the builtin bucket", () => {
  const temp = createTempDirectory();
  try {
    addSkill(temp.path, "user", "file-skill", "a file skill");

    const result = discoverSkills({
      roots: [{ bucket: "UserDir", dir: `${temp.path}/user` }],
      builtinSkills: [
        {
          name: "builtin-skill",
          description: "a builtin",
          body: "Builtin body.",
        },
      ],
      disableBuiltinSkills: true,
    });

    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["file-skill"],
    );

    const enabled = discoverSkills({
      roots: [{ bucket: "UserDir", dir: `${temp.path}/user` }],
      builtinSkills: [
        {
          name: "builtin-skill",
          description: "a builtin",
          body: "Builtin body.",
        },
      ],
    });
    const builtin = enabled.skills.find(
      (skill) => skill.name === "builtin-skill",
    );
    assert.ok(builtin);
    assert.equal(builtin.filePath, "builtin:builtin-skill");
    assert.equal(builtin.bucket, "Builtin");
  } finally {
    temp.cleanup();
  }
});
