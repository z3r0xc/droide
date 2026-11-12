import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ToolFailure } from "../../../src/tools/errors.ts";
import { createFile, writeFileAtomic } from "../../../src/tools/fs/write.ts";
import { makeToolFixture } from "./helpers.ts";

test("a new file is written with a trailing newline", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("new.txt");
    const result = await createFile({ file_path: file, content: "hello" }, fixture.context);
    assert.deepEqual(result, { success: true, file_path: file, created: true });
    assert.equal(readFileSync(file, "utf8"), "hello\n");
  } finally {
    fixture.cleanup();
  }
});

test("an overwrite keeps the file's CRLF line ending", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("crlf.txt");
    writeFileSync(file, "a\r\nb\r\n");
    await createFile({ file_path: file, content: "c\nd" }, fixture.context);
    assert.equal(readFileSync(file, "utf8"), "c\r\nd\r\n");
  } finally {
    fixture.cleanup();
  }
});

test("an overwrite preserves a UTF-16LE BOM and encoding", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("utf16.txt");
    writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\r\n", "utf16le")]),
    );
    await createFile({ file_path: file, content: "x" }, fixture.context);
    const bytes = readFileSync(file);
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
    assert.equal(bytes.subarray(2).toString("utf16le"), "x\r\n");
  } finally {
    fixture.cleanup();
  }
});

test("creating at an existing directory is refused with the documented text", async () => {
  const fixture = makeToolFixture();
  try {
    const directory = fixture.path("dir");
    mkdirSync(directory);
    await assert.rejects(
      createFile({ file_path: directory, content: "x" }, fixture.context),
      (error: unknown) =>
        error instanceof ToolFailure &&
        error.message ===
          `Error: Cannot create file at "${directory}" because a directory already exists there.`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a protected write is refused and nothing is created", async () => {
  const fixture = makeToolFixture();
  try {
    const factory = join(fixture.home, ".factory");
    mkdirSync(factory, { recursive: true });
    const target = join(factory, "settings.json");
    await assert.rejects(
      createFile({ file_path: target, content: "{}" }, fixture.context),
      (error: unknown) =>
        error instanceof ToolFailure &&
        error.message === `Sandbox: write denied to ${target}`,
    );
    assert.equal(existsSync(target), false);
  } finally {
    fixture.cleanup();
  }
});

test("a relative path that climbs out of the root is refused", async () => {
  const fixture = makeToolFixture();
  try {
    await assert.rejects(
      createFile({ file_path: "../escape.txt", content: "x" }, fixture.context),
      /Cannot access a path outside the workspace root/,
    );
    assert.equal(existsSync(fixture.path("..", "escape.txt")), false);
  } finally {
    fixture.cleanup();
  }
});

test("a failed atomic write leaves neither a partial target nor a temp file", async () => {
  const fixture = makeToolFixture();
  try {
    const target = fixture.path("occupied");
    mkdirSync(target);
    // Renaming a file over a non-empty directory fails on every platform.
    writeFileSync(`${target}/inside.txt`, "x");
    await assert.rejects(writeFileAtomic(target, Buffer.from("new")));
    assert.equal(readdirSync(target).join(","), "inside.txt");
    assert.deepEqual(
      readdirSync(fixture.root).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test("a successful write leaves no temp file behind", async () => {
  const fixture = makeToolFixture();
  try {
    await createFile({ file_path: fixture.path("clean.txt"), content: "x" }, fixture.context);
    assert.deepEqual(
      readdirSync(fixture.root).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});