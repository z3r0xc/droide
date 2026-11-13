import assert from "node:assert/strict";
import { test } from "node:test";

import { type MockResponse, execArgs, runCli, withHarness } from "./harness.ts";

/** Never used: `--list-tools` must answer without a provider request. */
const UNUSED_SCRIPT: readonly MockResponse[] = [
  {
    kind: "http",
    status: 500,
    body: '{"error":{"message":"the provider must not be called"}}',
  },
];

test(
  "--list-tools prints the catalogue and exits without a prompt",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      UNUSED_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, ["-m", "custom:mock", "--list-tools"]),
        );

        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /^Available tools for mock-1$/m);
        assert.match(result.stdout, /^Autonomy: off$/m);
        // The text listing carries the model-facing name and the display name;
        // the registry id appears only in the JSON form.
        assert.match(result.stdout, /• Read \(Read\) - status: \w+/);
        assert.match(result.stdout, /• Grep \(Grep\) - status: \w+/);
        // The provider was never asked for anything.
        assert.equal(server.requests.length, 0);
      },
    );
  },
);

test(
  "--list-tools with a prompt still lists only, ignoring the prompt",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      UNUSED_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, ["-m", "custom:mock", "--list-tools", "hi"]),
        );

        assert.equal(result.code, 0);
        assert.equal(server.requests.length, 0);
        assert.match(result.stdout, /^Available tools for/m);
      },
    );
  },
);

test(
  "--list-tools with -o json is one line of the seven documented fields",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      UNUSED_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const result = await runCli(
          directory,
          execArgs(settingsPath, [
            "-m",
            "custom:mock",
            "-o",
            "json",
            "--list-tools",
          ]),
        );

        assert.equal(result.code, 0);
        assert.equal(server.requests.length, 0);
        assert.equal(result.stdout.trimEnd().split("\n").length, 1);
        const parsed: unknown = JSON.parse(result.stdout);
        assert.equal(Array.isArray(parsed), true);
        const entries = parsed as Array<Record<string, unknown>>;
        assert.equal(
          entries.some((entry) => entry["id"] === "read-cli"),
          true,
        );
        assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), [
          "category",
          "currentlyAllowed",
          "defaultAllowed",
          "description",
          "displayName",
          "id",
          "llmId",
        ]);
      },
    );
  },
);

test(
  "--list-tools answers with no credential and no model flag",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      UNUSED_SCRIPT,
      async ({ directory, settingsPath, server }) => {
        const text = await runCli(
          directory,
          execArgs(settingsPath, ["--list-tools"]),
        );
        assert.equal(text.code, 0);
        assert.equal(text.stderr, "");
        assert.match(text.stdout, /^Available tools for \S+$/m);

        const json = await runCli(
          directory,
          execArgs(settingsPath, ["--list-tools", "-o", "json"]),
        );
        assert.equal(json.code, 0);
        const rows = JSON.parse(json.stdout) as Record<string, unknown>[];
        assert.ok(rows.length > 0);
        for (const row of rows) {
          assert.deepEqual(Object.keys(row).sort(), [
            "category",
            "currentlyAllowed",
            "defaultAllowed",
            "description",
            "displayName",
            "id",
            "llmId",
          ]);
        }
        assert.equal(server.requests.length, 0);
      },
    );
  },
);
