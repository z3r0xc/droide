/**
 * Skill ledger, listing budget and activation. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B51, B53, B54, B56.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activateSkill,
  capSkillTrigger,
  discoverSkills,
  mergeDisabledSkillLedger,
  renderSkillsReminder,
  SKILLS_REMINDER_HEADER,
  skillListingBudget,
  type EffectiveSkill,
} from "../../../src/extensions/skills/discovery.ts";
import {
  createTempDirectory,
  skillMarkdown,
  writeFixture,
} from "./fixtures.ts";

function makeSkill(
  name: string,
  overrides: Partial<EffectiveSkill> = {},
): EffectiveSkill {
  return {
    name,
    bucket: "UserDir",
    filePath: `/skills/${name}/SKILL.md`,
    description: "",
    body: `Body of ${name}.`,
    status: "active",
    errors: [],
    warnings: [],
    enabled: true,
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: [],
    ...overrides,
  };
}

test("test_skill_disabled_ledger_union: the ledger unions across levels with no re-enable", () => {
  const ledger = mergeDisabledSkillLedger([["Foo"], ["bar", "foo"], []]);
  assert.deepEqual([...ledger].sort(), ["bar", "foo"]);
});

test("test_skill_disabled_ledger_union: a ledger winner stays disabled and shadows its duplicates", () => {
  const temp = createTempDirectory();
  try {
    writeFixture(
      temp.path,
      "user/flagged/SKILL.md",
      skillMarkdown("name: flagged\ndescription: user", "User body."),
    );
    writeFixture(
      temp.path,
      "project/flagged/SKILL.md",
      skillMarkdown("name: flagged\ndescription: project", "Project body."),
    );

    const result = discoverSkills({
      roots: [
        { bucket: "ProjectDir", dir: `${temp.path}/project` },
        { bucket: "UserDir", dir: `${temp.path}/user` },
      ],
      disabledSkills: ["Flagged"],
    });

    const winner = result.skills.find((skill) => skill.bucket === "ProjectDir");
    assert.equal(winner?.status, "disabled");
    assert.equal(winner?.disabledCause, "ledger");
    const shadowed = result.skills.find((skill) => skill.bucket === "UserDir");
    assert.equal(shadowed?.status, "shadowed");
  } finally {
    temp.cleanup();
  }
});

test("test_skill_disabled_ledger_union: enabled false disables with the frontmatter cause", () => {
  const temp = createTempDirectory();
  try {
    writeFixture(
      temp.path,
      "user/off/SKILL.md",
      skillMarkdown("name: off\ndescription: off\nenabled: false", "Off body."),
    );
    const result = discoverSkills({
      roots: [{ bucket: "UserDir", dir: `${temp.path}/user` }],
    });
    const skill = result.skills[0];
    assert.equal(skill?.status, "disabled");
    assert.equal(skill?.disabledCause, "frontmatter");
  } finally {
    temp.cleanup();
  }
});

test("test_skill_listing_budget_and_rendering: the trigger cap counts code points", () => {
  const ascii = "a".repeat(250);
  const capped = capSkillTrigger(ascii);
  assert.equal(Array.from(capped).length, 200);
  assert.equal(capped.endsWith("…"), true);

  const unicode = "😀".repeat(250);
  const cappedUnicode = capSkillTrigger(unicode);
  const codePoints = Array.from(cappedUnicode);
  assert.equal(codePoints.length, 200);
  assert.equal(codePoints.at(-1), "…");
  assert.ok(
    codePoints.every((codePoint) => codePoint === "😀" || codePoint === "…"),
  );

  assert.equal(capSkillTrigger("one\ntwo\tthree"), "one two three");
});

test("test_skill_listing_budget_and_rendering: the budget is 1.5% of 4 chars per token with an 8000 fallback", () => {
  assert.equal(skillListingBudget(undefined), 8000);
  assert.equal(skillListingBudget(0), 8000);
  assert.equal(skillListingBudget(1000), 60);
  assert.equal(skillListingBudget(2000), 120);
});

test("test_skill_listing_budget_and_rendering: names are reserved before triggers are spent", () => {
  const skills = [
    makeSkill("alpha", { description: "one" }),
    makeSkill("beta", { bucket: "ProjectPlugin", description: "two" }),
  ];

  const full = renderSkillsReminder(skills, { workingTokenLimit: 1000 });
  assert.equal(
    full,
    [SKILLS_REMINDER_HEADER, "alpha: one", "beta: two"].join("\n"),
  );

  // 267 tokens -> floor(267 * 6 / 100) = 16 chars: 11 for the names, 5 left.
  const tight = renderSkillsReminder(skills, { workingTokenLimit: 267 });
  assert.equal(
    tight,
    [SKILLS_REMINDER_HEADER, "alpha: one", "beta"].join("\n"),
  );
});

test("test_skill_listing_budget_and_rendering: builtin and automation triggers are never dropped", () => {
  const skills = [
    makeSkill("builtin-one", {
      bucket: "Builtin",
      description: "always shown",
      filePath: "builtin:builtin-one",
    }),
    makeSkill("auto-one", { bucket: "Automation", description: "also shown" }),
    makeSkill("plain", { description: "maybe" }),
  ];

  const rendered = renderSkillsReminder(skills, { workingTokenLimit: 10 });
  assert.equal(rendered.includes("builtin-one: always shown"), true);
  assert.equal(rendered.includes("auto-one: also shown"), true);
  assert.equal(rendered.split("\n").at(-1), "plain");
});

test("test_skill_listing_budget_and_rendering: only active model-invocable skills are listed", () => {
  const skills = [
    makeSkill("active"),
    makeSkill("hidden", { disableModelInvocation: true }),
    makeSkill("off", { status: "disabled", disabledCause: "ledger" }),
    makeSkill("shadowed", { status: "shadowed" }),
    makeSkill("broken", { status: "invalid", errors: ["bad"] }),
  ];
  const rendered = renderSkillsReminder(skills);
  assert.equal(rendered, [SKILLS_REMINDER_HEADER, "active"].join("\n"));
  assert.equal(renderSkillsReminder([]), "");
});

test("test_skill_tool_activation_payload: success returns the announced name and the body", () => {
  const skill = makeSkill("demo", {
    filePath: '/skills/a&b"c/SKILL.md',
    body: "# Demo\n\nUse it.",
  });
  const result = activateSkill([skill], "Demo");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.text,
    [
      'Skill "demo" is now active.',
      '<skill name="demo" filePath="/skills/a&amp;b&quot;c/SKILL.md">',
      "# Demo\n\nUse it.",
      "</skill>",
    ].join("\n"),
  );
});

test("test_skill_tool_activation_payload: refusals carry the documented identities", () => {
  const skills = [
    makeSkill("off", { status: "disabled", disabledCause: "ledger" }),
    makeSkill("broken", {
      status: "invalid",
      errors: ["Skill must have a name"],
    }),
    makeSkill("winner"),
    makeSkill("winner", {
      bucket: "ProjectPlugin",
      status: "shadowed",
      shadowedBy: { bucket: "UserDir", filePath: "/winner", sameBucket: false },
    }),
  ];

  const missing = activateSkill(skills, "nope");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "skillNotFound");

  const disabled = activateSkill(skills, "off");
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.code, "skillDisabled");

  const invalid = activateSkill(skills, "broken");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.code, "skillInvalid");
    assert.match(invalid.message, /Skill must have a name/);
  }

  // The winner of a shadowed name is what activates.
  const winner = activateSkill(skills, "winner");
  assert.equal(winner.ok, true);
});

test("test_skill_tool_activation_payload: an invalid document never masks the active winner", () => {
  const skills = [
    makeSkill("demo", {
      status: "invalid",
      errors: [
        "Skill name must contain only lowercase letters, numbers, and hyphens",
      ],
    }),
    makeSkill("demo"),
  ];
  const result = activateSkill(skills, "demo");
  assert.equal(result.ok, true);
});
