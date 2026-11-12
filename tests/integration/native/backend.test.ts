/**
 * `Glob`/`Grep` discovery through a native helper. Contract:
 * `src/tools/native-backend.ts`, `specs/90-native-layer.md` (the helper
 * boundary) and `specs/30-tools-and-sandbox.md` B19/B20 (the tools' own
 * matching, ordering and refusals).
 *
 * Every helper here is a child process. The cases that only need the protocol
 * speak to `tests/fixtures/fake-native-helper.mjs` in `search` mode, which
 * implements `search.walk`, `search.text` and `path.resolve` over the
 * filesystem the way the Rust helper does. The parity case against the real
 * binary skips unless `DROIDE_NATIVE_BIN` names one, so `npm test` stays
 * hermetic.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { createNativeClient } from "../../../src/native/client.ts";
import type { ToolContext } from "../../../src/tools/context.ts";
import { globFiles } from "../../../src/tools/fs/glob.ts";
import { grepFiles } from "../../../src/tools/fs/grep.ts";
import {
  createSearchBackend,
  type SearchBackend,
} from "../../../src/tools/native-backend.ts";
import { makeToolFixture, type ToolFixture } from "../../unit/tools/helpers.ts";

const FAKE_HELPER = resolve(
  import.meta.dirname,
  "../../fixtures/fake-native-helper.mjs",
);
const REAL_HELPER = process.env["DROIDE_NATIVE_BIN"];

function writeTree(fixture: ToolFixture): void {
  mkdirSync(fixture.path("src", "nested"), { recursive: true });
  writeFileSync(
    fixture.path("src", "a.ts"),
    "export const a = 1;\n// needle one\n",
  );
  writeFileSync(
    fixture.path("src", "nested", "b.ts"),
    "needle two\nnothing else\n",
  );
  writeFileSync(fixture.path("src", "c.js"), "needle in javascript\n");
  writeFileSync(fixture.path("README.md"), "# demo\n");
}

function withBackend(
  fixture: ToolFixture,
  backend: SearchBackend,
): ToolContext {
  return { ...fixture.context, nativeBackend: backend };
}

async function helperBackend(
  mode: string,
  t: TestContext,
): Promise<SearchBackend> {
  const backend = await createSearchBackend({
    kind: "helper",
    helperPath: process.execPath,
    openHelper: (helperPath) =>
      createNativeClient({
        helperPath,
        helperArgs: [FAKE_HELPER, mode],
        env: { ...process.env },
      }),
  });
  t.after(() => backend.close());
  return backend;
}

test("no binary and no configuration means the local walk", async (t) => {
  const fixture = makeToolFixture();
  t.after(() => fixture.cleanup());
  writeTree(fixture);

  const missing = await createSearchBackend({
    kind: "helper",
    helperPath: join(fixture.dir, "not-built"),
  });
  t.after(() => missing.close());
  assert.equal(missing.kind, "local");
  assert.deepEqual(missing.diagnostics, []);

  const plain = await globFiles({ patterns: "**/*.ts" }, fixture.context);
  assert.deepEqual(
    await globFiles(
      { patterns: "**/*.ts" },
      withBackend(fixture, await createSearchBackend({ kind: "local" })),
    ),
    plain,
  );
  assert.deepEqual(plain, [
    fixture.path("src", "a.ts"),
    fixture.path("src", "nested", "b.ts"),
  ]);
});

test("a helper and the local walk return the same items in the same order", async (t) => {
  const fixture = makeToolFixture();
  t.after(() => fixture.cleanup());
  writeTree(fixture);

  let opened = 0;
  const helper = await createSearchBackend({
    kind: "helper",
    helperPath: process.execPath,
    openHelper: async (helperPath) => {
      opened += 1;
      return await createNativeClient({
        helperPath,
        helperArgs: [FAKE_HELPER, "search"],
        env: { ...process.env },
      });
    },
  });
  t.after(() => helper.close());
  assert.equal(helper.kind, "helper");
  assert.equal(opened, 1);
  assert.deepEqual(helper.diagnostics, []);

  const local = await createSearchBackend({ kind: "local" });
  const helperContext = withBackend(fixture, helper);
  const localContext = withBackend(fixture, local);

  assert.deepEqual(
    await globFiles({ patterns: "**/*.ts" }, helperContext),
    await globFiles({ patterns: "**/*.ts" }, localContext),
  );
  assert.deepEqual(
    await globFiles(
      { patterns: ["**/*.ts"], excludePatterns: ["**/nested/**"] },
      helperContext,
    ),
    await globFiles(
      { patterns: ["**/*.ts"], excludePatterns: ["**/nested/**"] },
      localContext,
    ),
  );
  assert.deepEqual(
    await grepFiles({ pattern: "needle" }, helperContext),
    await grepFiles({ pattern: "needle" }, localContext),
  );
  assert.deepEqual(
    await grepFiles(
      { pattern: "needle", output_mode: "content", context: 1 },
      helperContext,
    ),
    await grepFiles(
      { pattern: "needle", output_mode: "content", context: 1 },
      localContext,
    ),
  );
  assert.deepEqual(
    await grepFiles(
      { pattern: "NEEDLE", case_insensitive: true },
      helperContext,
    ),
    await grepFiles(
      { pattern: "NEEDLE", case_insensitive: true },
      localContext,
    ),
  );
  // A single named file is not a directory walk: the helper cannot narrow it.
  assert.deepEqual(
    await grepFiles(
      { pattern: "needle", path: fixture.path("src", "a.ts") },
      helperContext,
    ),
    await grepFiles(
      { pattern: "needle", path: fixture.path("src", "a.ts") },
      localContext,
    ),
  );
  // A regex the helper cannot pre-filter still answers from the same walk.
  assert.deepEqual(
    await grepFiles(
      { pattern: "n[e]+dle", output_mode: "content" },
      helperContext,
    ),
    await grepFiles(
      { pattern: "n[e]+dle", output_mode: "content" },
      localContext,
    ),
  );
  assert.deepEqual(helper.diagnostics, []);
});

test("a helper that exits mid-call falls back to the local walk", async (t) => {
  const fixture = makeToolFixture();
  t.after(() => fixture.cleanup());
  writeTree(fixture);

  const backend = await helperBackend("exit-after-version", t);
  assert.equal(backend.kind, "helper");

  const expected = await globFiles({ patterns: "**/*.ts" }, fixture.context);
  assert.deepEqual(
    await globFiles({ patterns: "**/*.ts" }, withBackend(fixture, backend)),
    expected,
  );
  assert.equal(backend.diagnostics.length, 1);
  assert.equal(backend.diagnostics[0]?.code, "native-helper-failed");
  assert.match(backend.diagnostics[0]?.message ?? "", /failed path\.resolve/);

  // The backend stays degraded: later calls go local without another failure.
  assert.deepEqual(
    await grepFiles({ pattern: "needle" }, withBackend(fixture, backend)),
    await grepFiles({ pattern: "needle" }, fixture.context),
  );
  assert.equal(backend.diagnostics.length, 1);
});

test("containment refuses an escape through the helper", async (t) => {
  const fixture = makeToolFixture();
  t.after(() => fixture.cleanup());
  writeTree(fixture);

  const backend = await helperBackend("search", t);
  await assert.rejects(
    backend.contain(fixture.root, fixture.path("..", "escape")),
    /Cannot access a path outside the workspace root/,
  );
  // A relative folder is refused before the helper sees it, as before.
  await assert.rejects(
    globFiles(
      { patterns: "**/*.ts", folder: "../escape" },
      withBackend(fixture, backend),
    ),
    /file_path must be an absolute path, not a relative path/,
  );
  await assert.rejects(
    grepFiles(
      { pattern: "needle", path: "../escape" },
      withBackend(fixture, backend),
    ),
    /file_path must be an absolute path, not a relative path/,
  );
});

test("an absolute path outside the root is not a jail escape", async (t) => {
  const fixture = makeToolFixture();
  t.after(() => fixture.cleanup());
  writeTree(fixture);
  mkdirSync(fixture.path("..", "outside"), { recursive: true });
  writeFileSync(fixture.path("..", "outside", "loose.ts"), "");

  const backend = await helperBackend("search", t);
  assert.deepEqual(
    await globFiles(
      { patterns: "**/*.ts", folder: fixture.path("..", "outside") },
      withBackend(fixture, backend),
    ),
    [fixture.path("..", "outside", "loose.ts")],
  );
  assert.deepEqual(backend.diagnostics, []);
});

test(
  "the real helper answers the same tree as the local walk",
  { skip: REAL_HELPER === undefined },
  async (t) => {
    const fixture = makeToolFixture();
    t.after(() => fixture.cleanup());
    writeTree(fixture);

    const helper = await createSearchBackend({
      kind: "helper",
      helperPath: REAL_HELPER ?? "",
    });
    t.after(() => helper.close());
    assert.equal(helper.kind, "helper");

    const local = await createSearchBackend({ kind: "local" });
    assert.deepEqual(
      await globFiles({ patterns: "**/*.ts" }, withBackend(fixture, helper)),
      await globFiles({ patterns: "**/*.ts" }, withBackend(fixture, local)),
    );
    assert.deepEqual(
      await grepFiles(
        { pattern: "needle", output_mode: "content", context: 1 },
        withBackend(fixture, helper),
      ),
      await grepFiles(
        { pattern: "needle", output_mode: "content", context: 1 },
        withBackend(fixture, local),
      ),
    );
    assert.deepEqual(helper.diagnostics, []);
  },
);
