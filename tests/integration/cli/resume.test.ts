/**
 * `droide resume` through the real process, against a scripted provider and a
 * temporary session index (`specs/10-cli-surface.md` §B22–B25).
 *
 * The point of these cases is the seam the unit tests inject: the prompt path
 * must be the same one `exec -s` uses, so the turn's records land in the named
 * session's transcript (or in a copy of it after `--fork`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { LAST_REQUIRES_TERMINAL } from "../../../src/cli/resume-commands.ts";
import {
  runCli,
  seedSession,
  storedRecords,
  textMessageRecord,
  withHarness,
  type MockResponse,
} from "../exec/harness.ts";

const OLD_SESSION = "5f0e0d0c-0b0a-4a09-8807-060504030201";
const OTHER_SESSION = "6f0e0d0c-0b0a-4a09-8807-060504030201";

/** One text answer, as the one-shot exec path consumes it. */
const ANSWER: readonly MockResponse[] = [
  {
    kind: "sse",
    chunks: [
      { choices: [{ delta: { content: "Hi." } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ],
  },
];

function providerEnvironment(server: { readonly url: string }): {
  readonly FACTORY_API_KEY: string;
  readonly FACTORY_API_BASE_URL: string;
} {
  return { FACTORY_API_KEY: "test", FACTORY_API_BASE_URL: server.url };
}

test(
  "a prompt continues the named session and appends after its history",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      ANSWER,
      async ({ directory, settingsPath, server }) => {
        const history = [textMessageRecord("old-user", "user", "hello", 1_000)];
        seedSession(directory, {
          sessionId: OLD_SESSION,
          records: history,
        });

        const result = await runCli(
          directory,
          ["resume", "--settings", settingsPath, OLD_SESSION, "next"],
          providerEnvironment(server),
        );

        assert.equal(result.stderr, "");
        assert.equal(result.code, 0);
        assert.equal(
          result.stdout.startsWith(`Resumed session ${OLD_SESSION}`),
          true,
          result.stdout,
        );
        assert.match(result.stdout, /Hi\.\n$/);

        const records = storedRecords(directory, OLD_SESSION);
        assert.deepEqual(records.slice(0, history.length), history);
        assert.ok(
          records.length > history.length,
          "the turn wrote nothing into the resumed transcript",
        );
      },
      () => ({ droidCoreModel: "mock-1" }),
    );
  },
);

test(
  "--fork continues a copy and leaves the original untouched",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      ANSWER,
      async ({ directory, settingsPath, server }) => {
        const history = [
          textMessageRecord("old-user", "user", "hello", 1_000),
          textMessageRecord("old-assistant", "assistant", "hi", 2_000),
        ];
        seedSession(directory, { sessionId: OLD_SESSION, records: history });

        const result = await runCli(
          directory,
          ["resume", "--fork", "--settings", settingsPath, OLD_SESSION, "next"],
          providerEnvironment(server),
        );

        assert.equal(result.stderr, "");
        assert.equal(result.code, 0);
        const header = new RegExp(
          `^Resumed session ([0-9a-f-]{36}) \\(forked from ${OLD_SESSION}\\)\n`,
        ).exec(result.stdout);
        assert.ok(header !== null, result.stdout);
        const forkedId = header[1];
        assert.ok(forkedId !== undefined);
        assert.notEqual(forkedId, OLD_SESSION);

        const forked = storedRecords(directory, forkedId);
        assert.deepEqual(forked.slice(0, history.length), history);
        assert.ok(forked.length > history.length);
        assert.deepEqual(storedRecords(directory, OLD_SESSION), history);
      },
      () => ({ droidCoreModel: "mock-1" }),
    );
  },
);

test(
  "no argument lists the stored sessions and exits 0",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      ANSWER,
      async ({ directory }) => {
        seedSession(directory, {
          sessionId: OLD_SESSION,
          records: [textMessageRecord("a", "user", "hello", 1_000)],
        });
        seedSession(directory, {
          sessionId: OTHER_SESSION,
          records: [textMessageRecord("b", "user", "later", 2_000)],
        });

        const result = await runCli(directory, ["resume"]);

        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /^Recent sessions:\n/);
        assert.ok(result.stdout.includes(OLD_SESSION));
        assert.ok(result.stdout.includes(OTHER_SESSION));
        // Newest first: the second session's later record leads.
        assert.ok(
          result.stdout.indexOf(OTHER_SESSION) <
            result.stdout.indexOf(OLD_SESSION),
        );
      },
      () => ({}),
    );
  },
);

test(
  "--last outside a terminal is refused with exit 1",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      ANSWER,
      async ({ directory }) => {
        const result = await runCli(directory, ["resume", "--last"]);

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, `${LAST_REQUIRES_TERMINAL}\n`);
      },
      () => ({}),
    );
  },
);

test(
  "an unknown session is refused before any model work",
  { timeout: 60_000 },
  async () => {
    await withHarness(
      ANSWER,
      async ({ directory }) => {
        const result = await runCli(directory, ["resume", OLD_SESSION]);

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, `Unknown session: ${OLD_SESSION}\n`);
      },
      () => ({}),
    );
  },
);
