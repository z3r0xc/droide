/**
 * Plugin ids and manifests. Contract:
 * `specs/60-extensions-mcp-and-skills.md` B33, B37 and the Errors table.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_PLUGINS_SCHEMA_PREFIX,
  loadPluginManifest,
  parsePluginId,
  parsePluginManifest,
  PluginError,
  PLUGIN_MANIFEST_PATHS,
  pluginIdMessage,
} from "../../../src/extensions/plugins/manifest.ts";
import { createTempDirectory, writeFixture } from "./fixtures.ts";

function expectPluginError(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof PluginError && error.code === code;
}

test("test_plugin_manifest_validation: the id splits on the first @ at index 1 or later", () => {
  assert.deepEqual(parsePluginId("review-tools@team-tools"), {
    name: "review-tools",
    marketplace: "team-tools",
  });
  assert.deepEqual(parsePluginId("review@tools@extra"), {
    name: "review",
    marketplace: "tools@extra",
  });
});

test("test_plugin_manifest_validation: an invalid id uses the documented message", () => {
  for (const raw of ["review-tools", "@team-tools", "review-tools@", ""]) {
    assert.throws(
      () => parsePluginId(raw),
      expectPluginError("plugin-id-invalid"),
    );
    try {
      parsePluginId(raw);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `"${raw}" isn't a valid plugin name. Use plugin-name@marketplace, for example review-tools@team-tools.`,
      );
    }
  }
  assert.equal(
    pluginIdMessage("bad"),
    '"bad" isn\'t a valid plugin name. Use plugin-name@marketplace, for example review-tools@team-tools.',
  );
});

test("test_plugin_manifest_validation: both manifest paths are searched and a missing manifest is optional", () => {
  const temp = createTempDirectory();
  try {
    assert.deepEqual(PLUGIN_MANIFEST_PATHS, [
      ".droide-plugin/plugin.json",
      ".claude-plugin/plugin.json",
    ]);
    assert.equal(loadPluginManifest(temp.path).kind, "absent");
  } finally {
    temp.cleanup();
  }
});

test("test_plugin_manifest_validation: the factory manifest is JSONC and only hooks is read", () => {
  const temp = createTempDirectory();
  try {
    writeFixture(
      temp.path,
      ".droide-plugin/plugin.json",
      `{
        // the only key the loader reads
        "name": "ignored",
        "$schema": "${AGENT_PLUGINS_SCHEMA_PREFIX}v1/plugin.json",
        "hooks": { "PostToolUse": [{ "command": "echo done" }] },
      }`,
    );
    const loaded = loadPluginManifest(temp.path);
    assert.equal(loaded.kind, "present");
    if (loaded.kind !== "present") return;
    assert.equal(loaded.manifest.layout, "factory");
    assert.equal(loaded.manifest.agentPlugins, true);
    assert.equal(loaded.manifest.hooks?.kind, "event-map");
  } finally {
    temp.cleanup();
  }
});

test("test_plugin_manifest_validation: hooks accept an event map, event maps, or hook-file paths", () => {
  const path = "/plugin/.droide-plugin/plugin.json";
  const eventMap = parsePluginManifest(
    '{ "hooks": { "SessionStart": "echo hi" } }',
    path,
  );
  assert.equal(eventMap.hooks?.kind, "event-map");

  const eventMaps = parsePluginManifest(
    '{ "hooks": [{ "SessionStart": "a" }, { "SessionEnd": "b" }] }',
    path,
  );
  assert.equal(eventMaps.hooks?.kind, "event-maps");

  const files = parsePluginManifest(
    '{ "hooks": ["hooks/one.json", "hooks/two.json"] }',
    path,
  );
  assert.equal(files.hooks?.kind, "hook-files");
});

test("test_plugin_manifest_validation: malformed manifests are manifest-invalid", () => {
  const path = "/plugin/.droide-plugin/plugin.json";
  assert.throws(
    () => parsePluginManifest("{", path),
    expectPluginError("manifest-invalid"),
  );
  assert.throws(
    () => parsePluginManifest("[]", path),
    expectPluginError("manifest-invalid"),
  );
  assert.throws(
    () => parsePluginManifest('{ "hooks": 42 }', path),
    expectPluginError("manifest-invalid"),
  );
  assert.throws(
    () =>
      parsePluginManifest(
        '{ "hooks": ["hooks/one.json", { "Event": "x" }] }',
        path,
      ),
    expectPluginError("manifest-invalid"),
  );
});

test("test_plugin_manifest_validation: a Claude-layout manifest is the fallback", () => {
  const temp = createTempDirectory();
  try {
    writeFixture(
      temp.path,
      ".claude-plugin/plugin.json",
      '{ "hooks": ["hooks/hooks.json"] }',
    );
    const loaded = loadPluginManifest(temp.path);
    assert.equal(loaded.kind, "present");
    if (loaded.kind !== "present") return;
    assert.equal(loaded.manifest.layout, "claude");
    assert.equal(loaded.manifest.path.includes(".claude-plugin"), true);
  } finally {
    temp.cleanup();
  }
});

test("test_plugin_manifest_validation: an unreadable manifest is manifest-invalid, not absent", () => {
  const temp = createTempDirectory();
  try {
    writeFixture(temp.path, ".droide-plugin/plugin.json", "{}");
    assert.throws(
      () =>
        loadPluginManifest(temp.path, {
          readFile: (path) => {
            if (path.includes(".droide-plugin")) {
              const error = new Error("permission denied");
              Object.defineProperty(error, "code", { value: "EACCES" });
              throw error;
            }
            return "{}";
          },
        }),
      expectPluginError("manifest-invalid"),
    );
  } finally {
    temp.cleanup();
  }
});
