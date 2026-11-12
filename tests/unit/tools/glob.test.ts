import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { globFiles } from "../../../src/tools/fs/glob.ts";
import { makeToolFixture } from "./helpers.ts";

test("glob returns absolute paths for matching files, sorted", async () => {
  const fixture = makeToolFixture();
  try {
    mkdirSync(fixture.path("src"));
    writeFileSync(fixture.path("src", "b.ts"), "");
    writeFileSync(fixture.path("src", "a.ts"), "");
    writeFileSync(fixture.path("src", "c.js"), "");
    const result = await globFiles({ patterns: "**/*.ts" }, fixture.context);
    assert.deepEqual(result, [fixture.path("src", "a.ts"), fixture.path("src", "b.ts")]);
  } finally {
    fixture.cleanup();
  }
});

test("an array of patterns is accepted and excludes are applied", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("keep.ts"), "");
    writeFileSync(fixture.path("drop.test.ts"), "");
    const result = await globFiles(
      { patterns: ["*.ts"], excludePatterns: ["*.test.ts"] },
      fixture.context,
    );
    assert.deepEqual(result, [fixture.path("keep.ts")]);
  } finally {
    fixture.cleanup();
  }
});

test("hidden files are included", async () => {
  const fixture = makeToolFixture();
  try {
    mkdirSync(fixture.path(".github"));
    writeFileSync(fixture.path(".github", "workflow.yml"), "");
    const result = await globFiles({ patterns: ["**/*.yml"] }, fixture.context);
    assert.deepEqual(result, [fixture.path(".github", "workflow.yml")]);
  } finally {
    fixture.cleanup();
  }
});

test("an empty pattern list is refused with the documented text", async () => {
  const fixture = makeToolFixture();
  try {
    await assert.rejects(
      globFiles({ patterns: ["  "] }, fixture.context),
      /At least one pattern is required for glob search\./,
    );
  } finally {
    fixture.cleanup();
  }
});

test("no match is the documented string", async () => {
  const fixture = makeToolFixture();
  try {
    assert.equal(
      await globFiles({ patterns: "**/*.rs" }, fixture.context),
      "No matching files found",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a folder outside the workspace must be absolute", async () => {
  const fixture = makeToolFixture();
  try {
    await assert.rejects(
      globFiles({ patterns: "*.ts", folder: "sub" }, fixture.context),
      /file_path must be an absolute path, not a relative path/,
    );
  } finally {
    fixture.cleanup();
  }
});