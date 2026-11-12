import assert from "node:assert/strict";
import { test } from "node:test";

import { PROGRAM } from "../../../src/cli/brand.ts";
import type { ExecHelpModels } from "../../../src/cli/exec-help.ts";
import { renderExecHelp } from "../../../src/cli/exec-help.ts";
import { execHelpModels } from "../../../src/cli/models.ts";

const SECTION_HEADINGS = [
  "Stream JSON-RPC Mode:",
  "Autonomy Levels:",
  "Mission Mode:",
  "Session Flags:",
  "Tool Controls:",
  "Available Models:",
  "Model details:",
  "Pinning the Latest Model:",
  "Authentication:",
  "Examples:",
] as const;

const page = renderExecHelp(execHelpModels());

function minimalModels(): ExecHelpModels {
  return {
    models: [
      { id: "a", name: "A" },
      { id: "wide-id", name: "Wide" },
    ],
    defaultModelId: "a",
    modelDetails: [
      {
        name: "A",
        supportsReasoning: false,
        supported: ["none"],
        defaultReasoningEffort: "none",
      },
    ],
    ignoredFlags: ["--x"],
  };
}

test("the page starts with the exec usage line", () => {
  assert.equal(
    page.split("\n")[0],
    `Usage: ${PROGRAM} exec [options] [prompt]`,
  );
  assert.ok(page.startsWith(`Usage: ${PROGRAM} exec [options] [prompt]\n`));
});

test("every section heading appears exactly once, in order", () => {
  let previous = -1;
  for (const heading of SECTION_HEADINGS) {
    const occurrences = page.split(`\n${heading}\n`).length - 1;
    assert.equal(occurrences, 1, `${heading} must appear once as a heading`);
    const index = page.indexOf(`\n${heading}\n`);
    assert.ok(
      index > previous,
      `${heading} must come after the previous heading`,
    );
    previous = index;
  }
});

test("a model row is padded to the widest id", () => {
  const rendered = renderExecHelp(minimalModels());
  const lines = rendered.split("\n");

  // "wide-id" is the widest id (7); ids pad to 8, then two spaces before the name.
  assert.ok(lines.includes(`  wide-id   Wide`));
  assert.ok(lines.includes(`  a${" ".repeat(9)}A (default)`));
});

test("(default) marks exactly one model", () => {
  assert.equal(page.split("(default)").length - 1, 1);
  assert.ok(
    page.includes("\n  gpt-6.1-sol                  GPT-6.1 Sol (default)\n"),
  );
});

test("the page ends with a single newline", () => {
  assert.ok(page.endsWith("\n"));
  assert.ok(!page.endsWith("\n\n"));
});
