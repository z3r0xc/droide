import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildStartupPrompt,
  environmentBlock,
} from "../../../src/app/prompt.ts";
import { createAppContext } from "../../../src/app/context.ts";
import type { Environment } from "../../../src/config/paths.ts";

async function sandbox(): Promise<{
  root: string;
  environment: Environment;
  project: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "droide-prompt-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".droide"), { recursive: true });
  return {
    root,
    project,
    environment: { env: {}, home, platform: "linux", cwd: project },
  };
}

test("the prompt carries identity, environment, skills and instructions in order", async () => {
  const { root, project, environment } = await sandbox();
  try {
    await writeFile(join(project, "AGENTS.md"), "project rules");
    const skillDir = join(project, ".droide", "skills", "deploy");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: ship it\n---\n\nbody\n",
    );

    const context = await createAppContext({ environment });
    const prompt = await buildStartupPrompt({ context, today: "2026-01-01" });

    const order = [
      "You are Droide",
      "<environment",
      "Today: 2026-01-01",
      "deploy",
      "<project_instructions",
    ];
    let cursor = -1;
    for (const needle of order) {
      const index = prompt.indexOf(needle);
      assert.equal(index > cursor, true, `${needle} out of order`);
      cursor = index;
    }
    assert.match(prompt, /project rules/);
    assert.equal(prompt.endsWith("\n"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appended text and file contents come last", async () => {
  const { root, project, environment } = await sandbox();
  try {
    const appendFile = join(project, "extra.md");
    await writeFile(appendFile, "from the file");
    const context = await createAppContext({ environment });

    const prompt = await buildStartupPrompt({
      context,
      appendSystemPrompt: "from the flag",
      appendSystemPromptFile: appendFile,
    });

    assert.equal(
      prompt.indexOf("from the flag") < prompt.indexOf("from the file"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--disable-builtin-skills removes only builtin entries", async () => {
  const { root, project, environment } = await sandbox();
  try {
    const skillDir = join(project, ".droide", "skills", "local");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: local\ndescription: local one\n---\n\nbody\n",
    );
    const context = await createAppContext({ environment });

    const prompt = await buildStartupPrompt({
      context,
      builtinSkills: [{ name: "shipped", description: "builtin", body: "b" }],
      disableBuiltinSkills: true,
    });

    assert.match(prompt, /local/);
    assert.equal(prompt.includes("shipped"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized append file is cut at the documented budget", async () => {
  const { root, project, environment } = await sandbox();
  try {
    const appendFile = join(project, "big.md");
    await writeFile(appendFile, "x".repeat(64 * 1024));
    const context = await createAppContext({ environment });

    const prompt = await buildStartupPrompt({
      context,
      appendSystemPromptFile: appendFile,
    });

    assert.equal(prompt.includes("x".repeat(32 * 1024 + 1)), false);
    assert.equal(prompt.includes("x".repeat(32 * 1024)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the environment block names the platform and cwd without secrets", () => {
  const context = {
    environment: { cwd: "/work/p", env: { DROIDE_API_KEY: "sk-secret" } },
  };
  const block = environmentBlock(context as never, "2026-02-02");
  assert.match(block, /platform="/);
  assert.match(block, /cwd="\/work\/p"/);
  assert.match(block, /Today: 2026-02-02/);
  assert.equal(block.includes("sk-secret"), false);
});
