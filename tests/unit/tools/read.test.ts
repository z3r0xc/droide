import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { ToolFailure } from "../../../src/tools/errors.ts";
import { readTool } from "../../../src/tools/fs/read.ts";
import { readText } from "../../../src/tools/fs/read.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { makeToolFixture } from "./helpers.ts";

function writeText(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}

test("a short file is returned whole", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("short.txt");
    writeText(file, "one\ntwo\nthree");
    assert.equal(
      await readText({ file_path: file }, fixture.context),
      "one\ntwo\nthree",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a ranged read appends the showing-lines note", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("range.txt");
    writeText(file, "a\nb\nc\nd\ne");
    assert.equal(
      await readText({ file_path: file, offset: 2, limit: 2 }, fixture.context),
      "b\nc\n\n[Showing lines 2-3 of 5 total lines]",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a negative offset counts from the end", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("tail.txt");
    writeText(file, "a\nb\nc\nd\ne");
    assert.equal(
      await readText(
        { file_path: file, offset: -2, limit: 5 },
        fixture.context,
      ),
      "d\ne\n\n[Showing lines 4-5 of 5 total lines]",
    );
  } finally {
    fixture.cleanup();
  }
});

test("line_numbers renders the N→ prefix", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("numbered.txt");
    writeText(file, "alpha\nbeta");
    assert.equal(
      await readText(
        { file_path: file, offset: 1, limit: 1, line_numbers: true },
        fixture.context,
      ),
      "1→alpha\n\n[Showing lines 1-1 of 2 total lines]",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a non-positive limit is refused with the documented text", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("x.txt");
    writeText(file, "x");
    await assert.rejects(
      readText({ file_path: file, limit: 0 }, fixture.context),
      (error: unknown) =>
        error instanceof ToolFailure &&
        error.message === "limit must be a positive number",
    );
  } finally {
    fixture.cleanup();
  }
});

test("Read refuses a relative path", async () => {
  const fixture = makeToolFixture();
  try {
    const registry = new ToolRegistry();
    registry.register(readTool);
    const outcome = await registry.dispatch(
      "read-cli",
      { file_path: "relative.txt" },
      fixture.context,
    );
    assert.deepEqual(outcome, {
      ok: false,
      error: "file_path must be an absolute path, not a relative path",
    });
  } finally {
    fixture.cleanup();
  }
});

test("a relative path that climbs out of the root is refused", async () => {
  const fixture = makeToolFixture();
  try {
    await assert.rejects(
      readText({ file_path: "../escape.txt" }, fixture.context, {
        requireAbsolute: false,
      }),
      /Cannot access a path outside the workspace root: "\.\.\/escape\.txt"/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("UTF-16LE with a BOM is decoded and LF-normalised without the BOM", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("utf16.txt");
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("héllo\r\nworld\r\n", "utf16le"),
      ]),
    );
    assert.equal(
      await readText({ file_path: file }, fixture.context),
      "héllo\nworld\n",
    );
  } finally {
    fixture.cleanup();
  }
});

test("BOM-less UTF-16LE is recognised by the NUL pattern", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("utf16-nobom.txt");
    writeFileSync(file, Buffer.from("hello\nworld\n", "utf16le"));
    assert.equal(
      await readText({ file_path: file }, fixture.context),
      "hello\nworld\n",
    );
  } finally {
    fixture.cleanup();
  }
});

test("CRLF is normalised to LF", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("crlf.txt");
    writeText(file, "a\r\nb\r\n");
    assert.equal(
      await readText({ file_path: file }, fixture.context),
      "a\nb\n",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a long declaration file opens as a numbered outline", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("outline.ts");
    const lines: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      lines.push(
        index % 10 === 0 ? `export function fn${index}() {` : `  x${index}();`,
      );
    }
    writeText(file, `${lines.join("\n")}\n`);
    const text = await readText({ file_path: file }, fixture.context);
    assert.match(text, /^1→export function fn0\(\) \{/);
    assert.match(
      text,
      /\[Outline: 25 declaration lines of 251; files over 200 lines open as an outline\. Read with offset \(and limit\) for the lines you need\]$/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a markdown file is never outlined", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("notes.md");
    const lines = Array.from(
      { length: 250 },
      (_, index) => `# heading ${index}`,
    );
    writeText(file, `${lines.join("\n")}\n`);
    const text = await readText({ file_path: file }, fixture.context);
    assert.doesNotMatch(text, /\[Outline:/);
  } finally {
    fixture.cleanup();
  }
});

test("an over-budget read carries the middle-cut notice", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("wide.txt");
    const line = "x".repeat(99);
    writeText(file, `${Array.from({ length: 2000 }, () => line).join("\n")}\n`);
    const text = await readText({ file_path: file }, fixture.context);
    assert.match(
      text,
      /\[\.\.\. \d+ bytes cut from the middle of \d+; whole output: /,
    );
    assert.match(text, /\(read it with offset and limit\)\]/);
  } finally {
    fixture.cleanup();
  }
});

test("a large file whose window exceeds 5 MiB is refused", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("huge.txt");
    writeText(file, `${"y".repeat(9 * 1024 * 1024)}\n`);
    await assert.rejects(
      readText({ file_path: file, offset: 1, limit: 1 }, fixture.context),
      /would load over 5 MiB for the requested lines/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a symlink that leaves the workspace root is refused", async (context) => {
  const fixture = makeToolFixture();
  try {
    const outside = fixture.path("..", "outside");
    mkdirSync(outside, { recursive: true });
    writeText(`${outside}/secret.txt`, "secret");
    const link = fixture.path("link");
    try {
      symlinkSync(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      context.skip("symlinks are unavailable on this machine");
      return;
    }
    await assert.rejects(
      readText(
        { file_path: `${link}/secret.txt`, offset: 1, limit: 1 },
        fixture.context,
      ),
      /Cannot access a path whose symlinks could not be resolved/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("image content is refused instead of decoded", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("image.png");
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        Buffer.from("rest"),
      ]),
    );
    await assert.rejects(
      readText({ file_path: file }, fixture.context),
      /image and PDF content is not supported/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a credential file under the Factory dir is never readable", async () => {
  const fixture = makeToolFixture();
  try {
    const factory = `${fixture.home}/.factory`;
    mkdirSync(factory, { recursive: true });
    const file = `${factory}/config.json`;
    writeText(file, "{}");
    await assert.rejects(readText({ file_path: file }, fixture.context), {
      message: /^Sandbox: read denied to /,
    });
  } finally {
    fixture.cleanup();
  }
});

test("an absolute path outside the workspace root is allowed", async () => {
  const fixture = makeToolFixture();
  try {
    const outside = fixture.path("..", "outside.txt");
    writeText(outside, "outside\n");
    assert.equal(
      await readText({ file_path: outside }, fixture.context),
      "outside\n",
    );
  } finally {
    fixture.cleanup();
  }
});
