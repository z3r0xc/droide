/**
 * Skill frontmatter keys, defaults and validation. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B48, B49.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseFrontmatter,
  parseSkillDocument,
} from "../../../src/extensions/skills/discovery.ts";
import { skillMarkdown } from "./fixtures.ts";

const CONTEXT = {
  bucket: "UserDir" as const,
  filePath: "/skills/demo/SKILL.md",
};

function parse(frontmatter: string, body = "Do the thing.") {
  return parseSkillDocument(skillMarkdown(frontmatter, body), CONTEXT);
}

test("test_skill_frontmatter_keys_and_validation: name and description are required", () => {
  const valid = parse("name: demo\ndescription: A demo skill.");
  assert.equal(valid.valid, true);
  assert.equal(valid.name, "demo");
  assert.equal(valid.description, "A demo skill.");
  assert.equal(valid.body, "Do the thing.");
  assert.equal(valid.enabled, true);
  assert.equal(valid.userInvocable, true);
  assert.equal(valid.disableModelInvocation, false);

  const missingName = parse("description: No name.");
  assert.equal(missingName.valid, false);
  assert.ok(missingName.errors.includes("Skill must have a name"));

  const missingDescription = parse("name: demo");
  assert.equal(missingDescription.valid, false);
  assert.ok(
    missingDescription.errors.includes("Skill must have a description"),
  );
});

test("test_skill_frontmatter_keys_and_validation: names must be lowercase letters, numbers and hyphens", () => {
  const uppercase = parse("name: Demo\ndescription: x");
  assert.equal(uppercase.valid, false);
  assert.ok(
    uppercase.errors.includes(
      "Skill name must contain only lowercase letters, numbers, and hyphens",
    ),
  );

  const empty = parse('name: "---"\ndescription: x');
  assert.equal(empty.valid, false);
  assert.ok(
    empty.errors.includes(
      "Skill name must contain at least one letter or number",
    ),
  );
  assert.equal(empty.name, "");
});

test("test_skill_frontmatter_keys_and_validation: an empty body is invalid", () => {
  const parsed = parse("name: demo\ndescription: x", "");
  assert.equal(parsed.valid, false);
  assert.ok(parsed.errors.includes("Skill must have a system prompt"));
});

test("test_skill_frontmatter_keys_and_validation: flags and frontmatter defaults", () => {
  const parsed = parse(
    [
      "name: demo",
      "description: x",
      "enabled: false",
      "user-invocable: false",
      "disable-model-invocation: true",
    ].join("\n"),
  );
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.userInvocable, false);
  assert.equal(parsed.disableModelInvocation, true);
});

test("test_skill_frontmatter_keys_and_validation: allowed-tools accepts a list or a string, and tools is the alias", () => {
  const list = parse(
    [
      "name: demo",
      "description: x",
      "allowed-tools:",
      "  - Read",
      "  - Write",
    ].join("\n"),
  );
  assert.deepEqual(list.allowedTools, ["Read", "Write"]);

  const single = parse(
    ["name: demo", "description: x", "allowed-tools: Read"].join("\n"),
  );
  assert.deepEqual(single.allowedTools, ["Read"]);

  const alias = parse(
    ["name: demo", "description: x", "tools:", "  - Grep"].join("\n"),
  );
  assert.deepEqual(alias.allowedTools, ["Grep"]);
});

test("test_skill_frontmatter_keys_and_validation: warnings do not invalidate", () => {
  const longDescription = parse(`name: demo\ndescription: ${"d".repeat(201)}`);
  assert.equal(longDescription.valid, true);
  assert.ok(
    longDescription.warnings.some((warning) =>
      warning.includes("longer than 200"),
    ),
  );

  const badVersion = parse(
    ["name: demo", "description: x", "version: 1.0"].join("\n"),
  );
  assert.equal(badVersion.valid, true);
  assert.ok(
    badVersion.warnings.some((warning) => warning.includes("semantic version")),
  );

  const metadata = parse(
    ["name: demo", "description: x", "metadata:", "  owner: platform"].join(
      "\n",
    ),
  );
  assert.equal(metadata.valid, true);
});

test("test_skill_frontmatter_keys_and_validation: ambiguous YAML is rejected, not guessed", () => {
  const cases = [
    "name: demo\nname: duplicate\ndescription: x",
    "name: demo\ndescription: x\nallowed-tools: [Read, Write]",
    "name: demo\ndescription: a # inline comment",
    "name: demo\ndescription: x\nmetadata:\n\towner: platform",
    "name: demo\ndescription: |\n  block",
    "name: demo\ndescription: x\nbroken line",
  ];
  for (const frontmatter of cases) {
    assert.equal(
      parseFrontmatter(skillMarkdown(frontmatter, "body")).ok,
      false,
    );
  }

  const noFrontmatter = parseSkillDocument("just markdown", CONTEXT);
  assert.equal(noFrontmatter.valid, false);
  assert.equal(noFrontmatter.errors.length > 0, true);
});

test("test_skill_frontmatter_keys_and_validation: quoted scalars are parsed", () => {
  const parsed = parse(
    ["name: demo", 'description: "A: quoted # value"'].join("\n"),
  );
  assert.equal(parsed.valid, true);
  assert.equal(parsed.description, "A: quoted # value");
});
