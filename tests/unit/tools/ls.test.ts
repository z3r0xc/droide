import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { listDirectory } from "../../../src/tools/fs/ls.ts";
import { makeToolFixture } from "./helpers.ts";

test("entries are sorted by name with types and sizes from lstat", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("b.txt"), "abc");
    mkdirSync(fixture.path("a-dir"));
    const entries = await listDirectory({ directory_path: fixture.root }, fixture.context);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.type, entry.size]),
      [
        ["a-dir", "directory", entries[0]?.size],
        ["b.txt", "file", 3],
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("an omitted directory_path lists the workspace root", async () => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("only.txt"), "");
    assert.deepEqual(
      (await listDirectory({}, fixture.context)).map((entry) => entry.name),
      ["only.txt"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("ignore patterns conceal entries", async () => {
  const fixture = makeToolFixture();
  try {
    mkdirSync(fixture.path("node_modules"));
    writeFileSync(fixture.path("keep.txt"), "");
    writeFileSync(fixture.path("skip.log"), "");
    const entries = await listDirectory(
      { ignorePatterns: ["node_modules/**", "*.log"] },
      fixture.context,
    );
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["keep.txt"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("a symlink is reported as a symlink", async (context) => {
  const fixture = makeToolFixture();
  try {
    writeFileSync(fixture.path("target.txt"), "x");
    try {
      symlinkSync(fixture.path("target.txt"), fixture.path("link.txt"), "file");
    } catch {
      context.skip("file symlinks are unavailable on this machine");
      return;
    }
    const entries = await listDirectory({ directory_path: fixture.root }, fixture.context);
    assert.equal(entries.find((entry) => entry.name === "link.txt")?.type, "symlink");
  } finally {
    fixture.cleanup();
  }
});

test("a non-directory target is refused", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("file.txt");
    writeFileSync(file, "");
    await assert.rejects(
      listDirectory({ directory_path: file }, fixture.context),
      new RegExp(`^Not a directory: `),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a missing directory is refused", async () => {
  const fixture = makeToolFixture();
  try {
    await assert.rejects(
      listDirectory({ directory_path: fixture.path("absent") }, fixture.context),
      new RegExp(`^Directory does not exist: `),
    );
  } finally {
    fixture.cleanup();
  }
});