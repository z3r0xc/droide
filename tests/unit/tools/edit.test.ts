import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { editFile } from "../../../src/tools/fs/edit.ts";
import { readText } from "../../../src/tools/fs/read.ts";
import { makeToolFixture } from "./helpers.ts";

async function seed(path: string, content: string): Promise<void> {
  writeFileSync(path, content, "utf8");
}

test("an edit replaces the unique match and reports one replacement", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("edit.txt");
    await seed(file, "alpha beta gamma\n");
    await readText({ file_path: file }, fixture.context);
    const result = await editFile(
      { file_path: file, old_str: "beta", new_str: "BETA" },
      fixture.context,
    );
    assert.deepEqual(result, {
      success: true,
      file_path: file,
      replacements: 1,
    });
    assert.equal(readFileSync(file, "utf8"), "alpha BETA gamma\n");
  } finally {
    fixture.cleanup();
  }
});

test("an edit of a file that was not read is refused with the documented text", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("unread.txt");
    await seed(file, "x\n");
    await assert.rejects(
      editFile(
        { file_path: file, old_str: "x", new_str: "y" },
        fixture.context,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "Error: Cannot edit file that has not been read first. Please use the " +
            `Read tool on "${file}" before attempting to edit it.`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("an external change after the read is refused", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("changed.txt");
    await seed(file, "one\n");
    await readText({ file_path: file }, fixture.context);
    appendFileSync(file, "two\n");
    await assert.rejects(
      editFile(
        { file_path: file, old_str: "one", new_str: "1" },
        fixture.context,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          `Error: File "${file}" has been modified externally since it was last ` +
            "read. Please use the Read tool to get the latest version before editing.",
    );
  } finally {
    fixture.cleanup();
  }
});

test("an empty old_str against a non-empty file is refused", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("empty-old.txt");
    await seed(file, "content\n");
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile({ file_path: file, old_str: "", new_str: "x" }, fixture.context),
      /Error: old_str is empty, but the file is not empty\./,
    );
  } finally {
    fixture.cleanup();
  }
});

test("text that is not present is refused", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("missing.txt");
    await seed(file, "content\n");
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: "absent", new_str: "x" },
        fixture.context,
      ),
      /Error: The text to replace was not found in the file\./,
    );
  } finally {
    fixture.cleanup();
  }
});

test("an ambiguous match is refused unless change_all is set", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("ambiguous.txt");
    await seed(file, "x x\n");
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: "x", new_str: "y" },
        fixture.context,
      ),
      /Found 2 occurrences of the specified text, but change_all is false\./,
    );
    const result = await editFile(
      { file_path: file, old_str: "x", new_str: "y", change_all: true },
      fixture.context,
    );
    assert.equal(result.replacements, 2);
    assert.equal(readFileSync(file, "utf8"), "y y\n");
  } finally {
    fixture.cleanup();
  }
});

test("the line-join guard refuses a replacement that would swallow a newline", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("join.txt");
    await seed(file, "a\nb\n");
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: "a\n", new_str: "c" },
        fixture.context,
      ),
      /Error: old_str ends with a line break but new_str does not/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("the file's final-newline convention is preserved", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("nonewline.txt");
    await seed(file, "a\nb");
    await readText({ file_path: file }, fixture.context);
    await editFile(
      { file_path: file, old_str: "b", new_str: "B\n" },
      fixture.context,
    );
    assert.equal(readFileSync(file, "utf8"), "a\nB");
  } finally {
    fixture.cleanup();
  }
});

test("an edit preserves CRLF line endings", async () => {
  const fixture = makeToolFixture();
  try {
    const file = fixture.path("crlf-edit.txt");
    writeFileSync(file, "a\r\nb\r\n");
    await readText({ file_path: file }, fixture.context);
    await editFile(
      { file_path: file, old_str: "a", new_str: "x" },
      fixture.context,
    );
    assert.equal(readFileSync(file, "utf8"), "x\r\nb\r\n");
  } finally {
    fixture.cleanup();
  }
});

test("an edit still applies when its match lies outside every secret", async () => {
  const fixture = makeToolFixture();
  try {
    const secret = "sk-live-0123456789abcdefgh";
    const file = fixture.path("scrubbed-apply.txt");
    await seed(file, `region = "eu-west-1"\napi_key = "${secret}"\n`);
    await readText({ file_path: file }, fixture.context);
    const result = await editFile(
      { file_path: file, old_str: '"eu-west-1"', new_str: '"us-east-1"' },
      fixture.context,
    );
    assert.equal(result.replacements, 1);
    const written = readFileSync(file, "utf8");
    assert.equal(written, `region = "us-east-1"\napi_key = "${secret}"\n`);
    // The marker lives only in the matching view, never in the file.
    assert.ok(!written.includes("[redacted]"));
  } finally {
    fixture.cleanup();
  }
});

test("an edit whose old_str differs only inside a secret is refused as not found", async () => {
  const fixture = makeToolFixture();
  try {
    const secret = "sk-test-0123456789abcdef";
    const file = fixture.path("scrubbed-secret.txt");
    await seed(file, `api_key = "${secret}"\nmodel = "gpt-x"\n`);
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: `api_key = "${secret}"`, new_str: "x" },
        fixture.context,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Error: The text to replace was not found/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    assert.equal(
      readFileSync(file, "utf8"),
      `api_key = "${secret}"\nmodel = "gpt-x"\n`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("private-key blocks and bearer tokens are scrubbed from matching", async () => {
  const fixture = makeToolFixture();
  try {
    const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const file = fixture.path("scrubbed-key.txt");
    await seed(
      file,
      [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        body,
        "-----END OPENSSH PRIVATE KEY-----",
        `Authorization: Bearer ${token}`,
        "port = 8080",
        "",
      ].join("\n"),
    );
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: body, new_str: "redacted-body" },
        fixture.context,
      ),
      /Error: The text to replace was not found/,
    );
    await assert.rejects(
      editFile(
        { file_path: file, old_str: token, new_str: "token" },
        fixture.context,
      ),
      /Error: The text to replace was not found/,
    );
    const result = await editFile(
      { file_path: file, old_str: "port = 8080", new_str: "port = 9090" },
      fixture.context,
    );
    assert.equal(result.replacements, 1);
    assert.equal(
      readFileSync(file, "utf8"),
      [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        body,
        "-----END OPENSSH PRIVATE KEY-----",
        `Authorization: Bearer ${token}`,
        "port = 9090",
        "",
      ].join("\n"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("a DROIDE_API_KEY value from the environment is scrubbed from matching", async () => {
  const fixture = makeToolFixture();
  try {
    const secret = "dsk_env_0123456789";
    const context = {
      ...fixture.context,
      environment: {
        ...fixture.environment,
        env: { DROIDE_API_KEY: secret },
      },
    };
    const file = fixture.path("scrubbed-env.txt");
    await seed(file, `credential = ${secret}\nport = 8080\n`);
    await readText({ file_path: file }, context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: `credential = ${secret}`, new_str: "x" },
        context,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Error: The text to replace was not found/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    await editFile(
      { file_path: file, old_str: "port = 8080", new_str: "port = 9090" },
      context,
    );
    assert.equal(
      readFileSync(file, "utf8"),
      `credential = ${secret}\nport = 9090\n`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("an ambiguity refusal never quotes the file's secrets", async () => {
  const fixture = makeToolFixture();
  try {
    const secret = "sk-ambiguity-0123456789abcdef";
    const file = fixture.path("scrubbed-ambiguous.txt");
    await seed(file, `api_key = "${secret}"\nnote alpha\nnote alpha\n`);
    await readText({ file_path: file }, fixture.context);
    await assert.rejects(
      editFile(
        { file_path: file, old_str: "note alpha", new_str: "note beta" },
        fixture.context,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Error: Found 2 occurrences/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});
