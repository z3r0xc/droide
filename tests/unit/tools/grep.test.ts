import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { grepFiles, type GrepContentLine } from "../../../src/tools/fs/grep.ts";
import { makeToolFixture } from "./helpers.ts";

test("file_paths mode lists matching files, absolute and sorted", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("a.txt"), "needle\n");
    writeFileSync(fixture.path("b.txt"), "nothing\n");
    assert.deepEqual(
      await grepFiles(
        { pattern: "needle", path: fixture.root },
        fixture.context,
      ),
      [fixture.path("a.txt")],
    );
  } finally {
    fixture.cleanup();
  }
});

test("content mode returns path, line, text and kind", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("content.txt");
    writeFileSync(file, "one\nneedle here\nthree\n");
    const result = await grepFiles(
      { pattern: "needle", path: fixture.root, output_mode: "content" },
      fixture.context,
    );
    assert.deepEqual(result, [
      { path: file, line: 2, text: "needle here", kind: "match" },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("context lines are included around a match", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("context.txt");
    writeFileSync(file, "before\nneedle\nafter\n");
    const result = await grepFiles(
      {
        pattern: "needle",
        path: fixture.root,
        output_mode: "content",
        context: 1,
      },
      fixture.context,
    );
    assert.deepEqual(
      (result as GrepContentLine[]).map((entry) => [entry.line, entry.kind]),
      [
        [1, "context"],
        [2, "match"],
        [3, "context"],
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("case_insensitive and fixed_string change the match", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("case.txt"), "NEEDLE\nprice is $5.00\n");
    assert.deepEqual(
      await grepFiles(
        { pattern: "needle", case_insensitive: true },
        fixture.context,
      ),
      [fixture.path("case.txt")],
    );
    assert.equal(
      await grepFiles({ pattern: "needle" }, fixture.context),
      "No matching files found",
    );
    assert.deepEqual(
      await grepFiles(
        { pattern: "$5.00", fixed_string: true },
        fixture.context,
      ),
      [fixture.path("case.txt")],
    );
  } finally {
    fixture.cleanup();
  }
});

test("glob_pattern and type filter the candidates", async () => {
  const fixture = makeToolFixture();
  try {
    mkdirSync(fixture.path("nested"));
    writeFileSync(fixture.path("nested", "one.ts"), "needle\n");
    writeFileSync(fixture.path("nested", "two.js"), "needle\n");
    assert.deepEqual(
      await grepFiles(
        { pattern: "needle", glob_pattern: "*.ts" },
        fixture.context,
      ),
      [fixture.path("nested", "one.ts")],
    );
    assert.deepEqual(
      await grepFiles({ pattern: "needle", type: "js" }, fixture.context),
      [fixture.path("nested", "two.js")],
    );
  } finally {
    fixture.cleanup();
  }
});

test("binary files are skipped", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(
      fixture.path("binary.bin"),
      Buffer.concat([Buffer.from("needle\0"), Buffer.alloc(20)]),
    );
    assert.equal(
      await grepFiles({ pattern: "needle" }, fixture.context),
      "No matching files found",
    );
  } finally {
    fixture.cleanup();
  }
});

test("content mode with no match returns the other documented string", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("x.txt"), "nothing\n");
    assert.equal(
      await grepFiles(
        { pattern: "needle", output_mode: "content" },
        fixture.context,
      ),
      "No matches found",
    );
  } finally {
    fixture.cleanup();
  }
});

test("head_limit caps the entries", async () => {
  const fixture = makeToolFixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(fixture.path(`f${index}.txt`), "needle\n");
    }
    const result = await grepFiles(
      { pattern: "needle", head_limit: 2 },
      fixture.context,
    );
    assert.equal((result as string[]).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("an invalid regular expression is refused", async () => {
  const fixture = makeToolFixture();
  try {
    await assert.rejects(
      grepFiles({ pattern: "(" }, fixture.context),
      /Invalid regular expression/,
    );
  } finally {
    fixture.cleanup();
  }
});
