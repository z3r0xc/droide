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
        assert.match(
          result.stdout,
          /^Tools for model mock-1 \(autonomy: off\)/m,
        );
        assert.match(result.stdout, /read-cli/);
        assert.match(result.stdout, /grep_tool_cli/);
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
        assert.match(result.stdout, /^Tools for model/m);
      },
    );
  },
);
