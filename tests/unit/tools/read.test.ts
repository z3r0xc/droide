import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ToolFailure } from "../../../src/tools/errors.ts";
import {
  MAX_READ_IMAGE_BYTES,
  PNG_SIGNATURE,
  readFile,
  readTool,
} from "../../../src/tools/fs/read.ts";
import { readText } from "../../../src/tools/fs/read.ts";
import type { SpillFileSystem } from "../../../src/tools/fs/spill.ts";
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
    const content = `${Array.from({ length: 2000 }, () => line).join("\n")}\n`;
    writeText(file, content);
    const text = await readText({ file_path: file }, fixture.context);
    assert.match(
      text,
      /\[\.\.\. \d+ bytes cut from the middle of \d+; whole output: /,
    );
    // B12: the notice names the spill file, which holds the whole output.
    const path = spilledPath(text);
    assert.match(path, /[0-9a-f]{32}\.txt$/);
    assert.equal(readFileSync(path, "utf8"), content);
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

test("a PNG is returned as an image block with its media type", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("pixel.png");
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("pixel-bytes")]);
    writeFileSync(file, bytes);
    const output = await readFile({ file_path: file }, fixture.context);
    assert.equal(typeof output, "object");
    if (typeof output === "string") return;
    assert.equal(
      output.content,
      `Read of ${file}: image/png, ${bytes.length} bytes`,
    );
    assert.deepEqual(output.media, [
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/png",
          data: bytes.toString("base64"),
        },
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("a JPEG is returned as an image block with its media type", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("photo.jpg");
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("jpeg-bytes"),
    ]);
    writeFileSync(file, bytes);
    const output = await readFile({ file_path: file }, fixture.context);
    assert.equal(typeof output, "object");
    if (typeof output === "string") return;
    assert.equal(
      output.content,
      `Read of ${file}: image/jpeg, ${bytes.length} bytes`,
    );
    assert.equal(output.media[0]?.source.mediaType, "image/jpeg");
    assert.equal(
      output.media[0]?.source.data,
      Buffer.from(bytes).toString("base64"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a GIF is refused naming the supported media", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("anim.gif");
    writeFileSync(file, "GIF89a-rest");
    await assert.rejects(readText({ file_path: file }, fixture.context), {
      message:
        `Read of ${file}: image/gif content is not supported by this build; ` +
        "supported media are PNG and JPEG images up to 3 MiB. " +
        "Use Execute to convert it to text.",
    });
  } finally {
    fixture.cleanup();
  }
});

test("a PDF is refused naming the supported media", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("doc.pdf");
    writeFileSync(file, "%PDF-1.7\nrest");
    await assert.rejects(readText({ file_path: file }, fixture.context), {
      message:
        `Read of ${file}: PDF content is not supported by this build; ` +
        "supported media are PNG and JPEG images up to 3 MiB. " +
        "Use Execute to convert it to text.",
    });
  } finally {
    fixture.cleanup();
  }
});

test("an image over the cap is refused naming the cap", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("huge.png");
    const bytes = Buffer.alloc(MAX_READ_IMAGE_BYTES + 1);
    PNG_SIGNATURE.copy(bytes, 0);
    writeFileSync(file, bytes);
    await assert.rejects(readFile({ file_path: file }, fixture.context), {
      message:
        `Read of ${file}: image/png is ${bytes.length} bytes, over the ` +
        `${MAX_READ_IMAGE_BYTES} byte cap for an image a read may return; ` +
        "use Execute to resize or crop it first.",
    });
  } finally {
    fixture.cleanup();
  }
});

test("a credential file under the state directory is never readable", async () => {
  const fixture = makeToolFixture();
  try {
    const factory = `${fixture.home}/.droide`;
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

/** A seam whose directory can never be created, as an unwritable home would be. */
const UNWRITABLE_SEAM: SpillFileSystem = {
  async makedirs() {
    throw new Error("EACCES: permission denied");
  },
  async exists() {
    return false;
  },
  async write() {
    throw new Error("EACCES: permission denied");
  },
  async rename() {
    throw new Error("EACCES: permission denied");
  },
  async remove() {
    // Nothing was created, so there is nothing to clean up.
  },
};

function spillDirectory(fixture: { readonly home: string }): string {
  return join(fixture.home, ".droide", "tool-outputs");
}

function spilledPath(notice: string): string {
  const match = /whole output: (.*?)\]/.exec(notice);
  assert.ok(match !== null, "the cut notice names the whole output");
  const [, path] = match;
  assert.ok(path !== undefined);
  return path;
}

function longText(): string {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `line ${index} ${"x".repeat(40)}`,
  );
  return `${lines.join("\n")}\n`;
}

test("a read within its budget writes no spill file", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("small.txt");
    writeText(file, "one\ntwo\n");
    assert.equal(
      await readText({ file_path: file }, fixture.context),
      "one\ntwo\n",
    );
    assert.equal(existsSync(spillDirectory(fixture)), false);
  } finally {
    fixture.cleanup();
  }
});

test("an over-budget read spills the whole output to a content-addressed file named in the notice", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("large.txt");
    const content = longText();
    writeText(file, content);
    const whole = await readText({ file_path: file }, fixture.context, {
      budgetBytes: 1_000_000,
    });
    assert.equal(whole, content);
    const cut = await readText({ file_path: file }, fixture.context, {
      budgetBytes: 512,
    });
    assert.ok(cut.length < whole.length);
    assert.ok(cut.includes("bytes cut from the middle of"));
    const path = spilledPath(cut);
    const name = `${createHash("sha256").update(whole, "utf8").digest("hex").slice(0, 32)}.txt`;
    assert.equal(path, join(spillDirectory(fixture), name));
    assert.equal(readFileSync(path, "utf8"), whole);
    if (process.platform !== "win32") {
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally {
    fixture.cleanup();
  }
});

test("a second identical over-budget read reuses the same spill file", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("repeat.txt");
    writeText(file, longText());
    const first = await readText({ file_path: file }, fixture.context, {
      budgetBytes: 512,
    });
    const second = await readText({ file_path: file }, fixture.context, {
      budgetBytes: 512,
    });
    const path = spilledPath(first);
    assert.equal(spilledPath(second), path);
    assert.deepEqual(readdirSync(dirname(path)), [
      `${createHash("sha256").update(longText(), "utf8").digest("hex").slice(0, 32)}.txt`,
    ]);
    assert.equal(readFileSync(path, "utf8"), longText());
  } finally {
    fixture.cleanup();
  }
});

test("an unwritable spill directory falls back to the offset/limit notice", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("fallback.txt");
    writeText(file, longText());
    const cut = await readText({ file_path: file }, fixture.context, {
      budgetBytes: 512,
      spillFileSystem: UNWRITABLE_SEAM,
    });
    assert.ok(
      cut.includes(`whole output: ${file} (read it with offset and limit)]`),
      cut,
    );
    assert.equal(existsSync(spillDirectory(fixture)), false);
  } finally {
    fixture.cleanup();
  }
});
