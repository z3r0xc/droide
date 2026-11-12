import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MAX_INSTRUCTION_FILE_BYTES,
  MAX_INSTRUCTIONS_TOTAL_BYTES,
  buildSystemPrompt,
  identityLine,
  loadProjectInstructions,
  renderInstructionBlock,
} from "../../../src/agent/context.ts";

test("the prompt starts with the identity line", () => {
  const prompt = buildSystemPrompt({});
  assert.equal(prompt.split("\n")[0], identityLine());
  assert.match(prompt, /^You are Droide, an AI software engineering agent\./);
  assert.equal(prompt.endsWith("\n"), true);
});

test("blocks appear in the documented order with blank-line separators", () => {
  const prompt = buildSystemPrompt({
    environment: "env block",
    skillsListing: "skills block",
    instructions: [{ path: "/repo/AGENTS.md", content: "project rules" }],
    appendText: "appended",
    appendFileText: "from file",
  });

  const order = [
    "You are Droide",
    "env block",
    "skills block",
    "<project_instructions",
    "appended",
    "from file",
  ];
  let cursor = -1;
  for (const needle of order) {
    const found = prompt.indexOf(needle);
    assert.equal(found > cursor, true, `${needle} is out of order`);
    cursor = found;
  }
  assert.equal(prompt.includes("\n\n\n"), false);
});

test("empty blocks are dropped rather than leaving blank gaps", () => {
  const prompt = buildSystemPrompt({
    environment: "   ",
    skillsListing: "",
    appendText: "  \n",
  });
  assert.equal(prompt, `${identityLine()}\n`);
});

test("an instruction block names the file so the model can re-read it", () => {
  const block = renderInstructionBlock({
    path: "/repo/AGENTS.md",
    content: "rules\n",
  });
  assert.equal(
    block.startsWith('<project_instructions path="/repo/AGENTS.md">'),
    true,
  );
  assert.equal(block.endsWith("</project_instructions>"), true);
  assert.equal(block.includes("rules"), true);
});

test("instructions are discovered from the root downwards, closest last", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-context-"));
  try {
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(nested, "AGENTS.md"), "nested rules");

    const instructions = await loadProjectInstructions(nested);

    assert.equal(instructions.length >= 2, true);
    const paths = instructions.map((entry) => entry.path);
    assert.equal(
      paths.indexOf(join(root, "AGENTS.md")) <
        paths.indexOf(join(nested, "AGENTS.md")),
      true,
    );
    assert.equal(
      instructions[instructions.length - 1]?.content,
      "nested rules",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both instruction file names are read when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-context-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "agents");
    await writeFile(join(root, "CLAUDE.md"), "claude");

    const instructions = await loadProjectInstructions(root);
    const names = instructions.map((entry) => entry.path.split(/[\\/]/).pop());
    assert.equal(names.includes("AGENTS.md"), true);
    assert.equal(names.includes("CLAUDE.md"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized instruction file is cut and marked", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-context-"));
  try {
    await writeFile(
      join(root, "AGENTS.md"),
      "x".repeat(MAX_INSTRUCTION_FILE_BYTES + 100),
    );

    const instructions = await loadProjectInstructions(root);
    const own = instructions.find(
      (entry) => entry.path === join(root, "AGENTS.md"),
    );

    assert.equal(own?.truncated, true);
    assert.equal(own?.content.length, MAX_INSTRUCTION_FILE_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the total instruction budget is bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-context-"));
  try {
    // Five levels of 32 KiB each exceed the 128 KiB total budget.
    const chunk = "y".repeat(MAX_INSTRUCTION_FILE_BYTES);
    let deepest = root;
    for (const level of ["a", "b", "c", "d"]) {
      deepest = join(deepest, level);
      await mkdir(deepest, { recursive: true });
      await writeFile(join(deepest, "AGENTS.md"), chunk);
    }
    await writeFile(join(root, "AGENTS.md"), chunk);

    const instructions = await loadProjectInstructions(deepest);
    const total = instructions.reduce(
      (sum, entry) => sum + entry.content.length,
      0,
    );

    assert.equal(total <= MAX_INSTRUCTIONS_TOTAL_BYTES, true);
    // Four full documents exhaust the budget; later ones are omitted, not
    // half-injected.
    assert.equal(instructions.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory with no instruction files yields none", async () => {
  const root = await mkdtemp(join(tmpdir(), "droide-context-"));
  try {
    const instructions = await loadProjectInstructions(root);
    assert.equal(
      instructions.some((entry) => entry.path.startsWith(root)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
