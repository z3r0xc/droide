import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvalidSettingsError,
  UnknownSettingError,
} from "../../../src/config/errors.ts";
import {
  parseSettingsDocument,
  parseSettingsText,
} from "../../../src/config/schema.ts";

const SOURCE = "/tmp/settings.json";

test("a complete document validates into the typed settings shape", () => {
  const settings = parseSettingsDocument(
    {
      worktreeDirectory: "~/worktrees",
      enabledPlugins: { "acme@tools": true },
      theme: "dark",
      llmRequestTimeout: 30_000,
      trustedFolders: ["/work"],
      customModels: [
        {
          id: "mock",
          model: "mock-1",
          provider: "openai",
          baseUrl: "http://127.0.0.1:8080/v1",
          apiKey: "test",
        },
      ],
      mcp: {
        context7: { type: "stdio", command: "npx", args: ["-y", "context7"] },
        remote: {
          type: "http",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer x" },
        },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "Execute",
            hooks: [{ type: "command", command: "echo pre", timeout: 5 }],
          },
        ],
        hooksDisabled: false,
      },
      droids: { reviewer: { description: "Reviews code" } },
      skills: ["custom-skill"],
      outputStyles: { concise: { prompt: "Be terse." } },
      commands: ["lint"],
    },
    SOURCE,
  );

  assert.equal(settings.general?.worktreeDirectory, "~/worktrees");
  assert.equal(settings.general?.enabledPlugins?.["acme@tools"], true);
  assert.equal(settings.general?.customModels?.[0]?.provider, "openai");
  const context7 = settings.mcp?.["context7"];
  assert.ok(context7 !== undefined && "command" in context7);
  assert.equal(context7.command, "npx");
  assert.equal(settings.mcp?.["remote"]?.type, "http");
  assert.equal(settings.hooks?.PreToolUse?.[0]?.hooks[0]?.command, "echo pre");
  assert.equal(settings.hooks?.hooksDisabled, false);
  assert.deepEqual(settings.droids?.reviewer, { description: "Reviews code" });
  assert.deepEqual(settings.skills, ["custom-skill"]);
  assert.deepEqual(settings.commands, ["lint"]);
});

test("a wrong type names the offending key path", () => {
  assert.throws(
    () => parseSettingsDocument({ worktreeDirectory: 42 }, SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "worktreeDirectory");
      assert.match(error.message, /"worktreeDirectory"/);
      assert.match(error.message, /expected a string, got number/);
      return true;
    },
  );
});

test("a wrong nested type names the full dotted path", () => {
  assert.throws(
    () =>
      parseSettingsDocument(
        { mcp: { context7: { command: 7 } } },
        SOURCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "mcp.context7.command");
      return true;
    },
  );
});

test("a string is never coerced into a number", () => {
  assert.throws(
    () => parseSettingsDocument({ llmRequestTimeout: "30000" }, SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "llmRequestTimeout");
      return true;
    },
  );
});

test("an unknown top-level key is refused", () => {
  assert.throws(
    () => parseSettingsDocument({ notASetting: true }, SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof UnknownSettingError);
      assert.equal(error.keyPath, "notASetting");
      assert.match(error.message, /Unknown setting "notASetting"/);
      return true;
    },
  );
});

test("an unknown key inside a structured section is refused", () => {
  assert.throws(
    () =>
      parseSettingsDocument(
        { mcp: { context7: { command: "npx", nope: true } } },
        SOURCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof UnknownSettingError);
      assert.equal(error.keyPath, "mcp.context7.nope");
      return true;
    },
  );
});

test('the "general" wrapper is refused, as the subject refuses it', () => {
  assert.throws(
    () =>
      parseSettingsDocument({ general: { worktreeDirectory: "x" } }, SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "general");
      assert.match(error.message, /root of the document/);
      return true;
    },
  );
});

test("malformed JSON is an invalid-settings failure", () => {
  assert.throws(
    () => parseSettingsText('{ "worktreeDirectory": ', SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "");
      assert.match(error.message, /invalid JSON/);
      return true;
    },
  );
});

test("JSONC comments and trailing commas are accepted", () => {
  const settings = parseSettingsText(
    `{
      // a line comment
      "theme": "dark", /* and a block comment */
      "skills": ["one", "two",],
    }`,
    SOURCE,
  );
  assert.equal(settings.general?.theme, "dark");
  assert.deepEqual(settings.skills, ["one", "two"]);
});

test("comment markers inside strings survive JSONC stripping", () => {
  const settings = parseSettingsText(
    '{ "theme": "a//b/*c*/", "worktreeDirectory": "C:/x", }',
    SOURCE,
  );
  assert.equal(settings.general?.theme, "a//b/*c*/");
});

test("an unknown hook event is refused", () => {
  assert.throws(
    () => parseSettingsDocument({ hooks: { NotAnEvent: [] } }, SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof UnknownSettingError);
      assert.equal(error.keyPath, "hooks.NotAnEvent");
      return true;
    },
  );
});

test("a hook command must declare type command", () => {
  assert.throws(
    () =>
      parseSettingsDocument(
        { hooks: { Stop: [{ hooks: [{ type: "shell", command: "x" }] }] } },
        SOURCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "hooks.Stop.0.hooks.0.type");
      return true;
    },
  );
});

test("an unknown custom-model provider is refused", () => {
  assert.throws(
    () =>
      parseSettingsDocument(
        { customModels: [{ model: "m", provider: "acme" }] },
        SOURCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSettingsError);
      assert.equal(error.keyPath, "customModels.0.provider");
      return true;
    },
  );
});