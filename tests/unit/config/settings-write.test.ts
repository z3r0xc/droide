import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SettingsWriteError,
  lookupSettingsValue,
  removeSettingsValue,
  setSettingsValue,
  type SettingsWriteRefusal,
} from "../../../src/config/write.ts";

/**
 * The writer's contract is byte-level: a settings file belongs to its user, so
 * only the edited span may change. These cases pin the exact text, not just the
 * parsed value, because "still valid JSON" is not the promise.
 */

function workspace(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "droide-settings-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function write(root: string, name: string, text: string): string {
  const path = join(root, name);
  writeFileSync(path, text, "utf8");
  return path;
}

function refusal(code: SettingsWriteRefusal): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof SettingsWriteError && error.code === code;
}

test("replacing a value touches only that value's span", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\n  "theme": "light",\n  "locale": "en"\n}\n',
    );
    setSettingsValue(path, ["theme"], "dark");
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "theme": "dark",\n  "locale": "en"\n}\n',
    );
  } finally {
    bench.cleanup();
  }
});

test("a JSONC document keeps its comments, trailing commas and key order", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      [
        "{",
        "  // chosen by hand",
        '  "theme": "dark", /* keep this */',
        '  "enabledPlugins": {',
        '    "alpha": true,',
        "  },",
        '  "strictEnabledPlugins": false,',
        "}",
        "",
      ].join("\n"),
    );
    setSettingsValue(path, ["enabledPlugins", "zeta"], true, { sorted: true });
    assert.equal(
      readFileSync(path, "utf8"),
      [
        "{",
        "  // chosen by hand",
        '  "theme": "dark", /* keep this */',
        '  "enabledPlugins": {',
        '    "alpha": true,',
        '    "zeta": true,',
        "  },",
        '  "strictEnabledPlugins": false,',
        "}",
        "",
      ].join("\n"),
    );
  } finally {
    bench.cleanup();
  }
});

test("a sorted insert lands in key order and a plain one appends", () => {
  const bench = workspace();
  try {
    const fixture =
      '{\n  "enabledPlugins": {\n    "mike": true,\n    "zulu": true\n  }\n}\n';
    const sorted = write(bench.root, "sorted.json", fixture);
    setSettingsValue(sorted, ["enabledPlugins", "alpha"], true, {
      sorted: true,
    });
    assert.equal(
      readFileSync(sorted, "utf8"),
      '{\n  "enabledPlugins": {\n    "alpha": true,\n    "mike": true,\n    "zulu": true\n  }\n}\n',
    );

    const appended = write(bench.root, "appended.json", fixture);
    setSettingsValue(appended, ["enabledPlugins", "alpha"], true);
    assert.equal(
      readFileSync(appended, "utf8"),
      '{\n  "enabledPlugins": {\n    "mike": true,\n    "zulu": true,\n    "alpha": true\n  }\n}\n',
    );
  } finally {
    bench.cleanup();
  }
});

test("an empty object grows a multi-line member at its own indent", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\n  "enabledPlugins": {},\n  "theme": "dark"\n}\n',
    );
    setSettingsValue(path, ["enabledPlugins", "demo@team-tools"], true);
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "enabledPlugins": {\n    "demo@team-tools": true\n  },\n  "theme": "dark"\n}\n',
    );
  } finally {
    bench.cleanup();
  }
});

test("a missing file is a not-found refusal unless creation is asked for", () => {
  const bench = workspace();
  try {
    const path = join(bench.root, "settings.json");
    assert.throws(
      () => setSettingsValue(path, ["enabledPlugins", "demo"], true),
      refusal("not-found"),
    );

    setSettingsValue(path, ["enabledPlugins", "demo"], true, {
      createIfMissing: true,
    });
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "enabledPlugins": {\n    "demo": true\n  }\n}\n',
    );
  } finally {
    bench.cleanup();
  }
});

test("duplicate keys are an ambiguous-key refusal and the file is untouched", () => {
  const bench = workspace();
  try {
    const text =
      '{\n  "enabledPlugins": {\n    "alpha": true\n  },\n  "enabledPlugins": {\n    "beta": true\n  }\n}\n';
    const path = write(bench.root, "settings.json", text);
    assert.throws(
      () => setSettingsValue(path, ["enabledPlugins", "zeta"], true),
      refusal("ambiguous-key"),
    );
    assert.throws(
      () => lookupSettingsValue(path, ["enabledPlugins"]),
      refusal("ambiguous-key"),
    );
    assert.equal(readFileSync(path, "utf8"), text);
  } finally {
    bench.cleanup();
  }
});

test("a document that does not parse is an invalid-document refusal", () => {
  const bench = workspace();
  try {
    const text = '{\n  "theme": "dark"\n';
    const path = write(bench.root, "settings.json", text);
    assert.throws(
      () => setSettingsValue(path, ["theme"], "light"),
      refusal("invalid-document"),
    );
    assert.throws(
      () => removeSettingsValue(path, ["theme"]),
      refusal("invalid-document"),
    );
    assert.equal(readFileSync(path, "utf8"), text);
  } finally {
    bench.cleanup();
  }
});

test("a read-only file is a not-writable refusal and keeps its bytes", () => {
  const bench = workspace();
  try {
    const text = '{\n  "theme": "dark"\n}\n';
    const path = write(bench.root, "settings.json", text);
    chmodSync(path, 0o444);
    try {
      assert.throws(
        () => setSettingsValue(path, ["theme"], "light"),
        refusal("not-writable"),
      );
      assert.equal(readFileSync(path, "utf8"), text);
    } finally {
      chmodSync(path, 0o644);
    }
  } finally {
    bench.cleanup();
  }
});

test("a path outside the named root is refused", () => {
  const bench = workspace();
  try {
    const scope = join(bench.root, "scope");
    const elsewhere = join(bench.root, "elsewhere");
    mkdirSync(scope);
    mkdirSync(elsewhere);
    const path = write(elsewhere, "settings.json", '{ "theme": "dark" }\n');
    assert.throws(
      () => setSettingsValue(path, ["theme"], "light", { root: scope }),
      refusal("not-writable"),
    );
    assert.equal(readFileSync(path, "utf8"), '{ "theme": "dark" }\n');

    const inside = write(scope, "settings.json", '{ "theme": "dark" }\n');
    setSettingsValue(inside, ["theme"], "light", { root: scope });
    assert.equal(readFileSync(inside, "utf8"), '{ "theme": "light" }\n');
  } finally {
    bench.cleanup();
  }
});

test("a symlinked settings file is never written through", (context) => {
  const bench = workspace();
  try {
    const target = write(bench.root, "target.json", '{ "theme": "dark" }\n');
    const link = join(bench.root, "settings.json");
    try {
      symlinkSync(target, link, "file");
    } catch {
      context.skip("creating a symbolic link is not permitted here");
      return;
    }
    assert.throws(
      () => setSettingsValue(link, ["theme"], "light"),
      refusal("not-writable"),
    );
    assert.equal(readFileSync(target, "utf8"), '{ "theme": "dark" }\n');
  } finally {
    bench.cleanup();
  }
});

test("removing a member keeps its siblings and their comments", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      [
        "{",
        '  "theme": "dark",',
        "  // enablement",
        '  "enabledPlugins": {',
        '    "alpha": true,',
        '    "zeta": true',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(removeSettingsValue(path, ["enabledPlugins", "alpha"]), true);
    assert.equal(
      readFileSync(path, "utf8"),
      [
        "{",
        '  "theme": "dark",',
        "  // enablement",
        '  "enabledPlugins": {',
        '    "zeta": true',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  } finally {
    bench.cleanup();
  }
});

test("removing the last member takes the separator with it", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\n  "enabledPlugins": {\n    "alpha": true,\n    "zeta": true\n  }\n}\n',
    );
    assert.equal(removeSettingsValue(path, ["enabledPlugins", "zeta"]), true);
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "enabledPlugins": {\n    "alpha": true\n  }\n}\n',
    );
  } finally {
    bench.cleanup();
  }
});

test("removing the only member leaves an empty object, and an absent key is a no-op", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\n  "enabledPlugins": {\n    "alpha": true\n  }\n}\n',
    );
    assert.equal(removeSettingsValue(path, ["enabledPlugins", "alpha"]), true);
    assert.equal(readFileSync(path, "utf8"), '{\n  "enabledPlugins": {}\n}\n');

    const before = readFileSync(path, "utf8");
    assert.equal(removeSettingsValue(path, ["enabledPlugins", "alpha"]), false);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    bench.cleanup();
  }
});

test("lookup reports absence without a refusal", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\n  "enabledPlugins": {\n    "alpha": false\n  }\n}\n',
    );
    assert.deepEqual(lookupSettingsValue(path, ["enabledPlugins", "alpha"]), {
      present: true,
      value: false,
    });
    assert.deepEqual(lookupSettingsValue(path, ["enabledPlugins", "zeta"]), {
      present: false,
    });
    assert.deepEqual(
      lookupSettingsValue(join(bench.root, "absent.json"), ["theme"]),
      { present: false },
    );
  } finally {
    bench.cleanup();
  }
});

test("the file mode and a byte-order mark survive the write", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '\ufeff{ "theme": "dark" }\n',
    );
    if (process.platform !== "win32") chmodSync(path, 0o600);
    setSettingsValue(path, ["theme"], "light");
    const text = readFileSync(path, "utf8");
    assert.equal(text, '\ufeff{ "theme": "light" }\n');
    if (process.platform !== "win32")
      assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    bench.cleanup();
  }
});

test("no temporary file is left beside the document", () => {
  const bench = workspace();
  try {
    const path = write(bench.root, "settings.json", '{ "theme": "dark" }\n');
    setSettingsValue(path, ["theme"], "light");
    assert.deepEqual(readdirSync(bench.root), ["settings.json"]);
  } finally {
    bench.cleanup();
  }
});

test("a comment inside an object outlives the only member removed from it", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\n  "enabledPlugins": {\n    // kept by hand\n    "alpha": true\n  }\n}\n',
    );
    assert.equal(removeSettingsValue(path, ["enabledPlugins", "alpha"]), true);
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "enabledPlugins": {\n    // kept by hand\n    \n  }\n}\n',
    );
  } finally {
    bench.cleanup();
  }
});

test("inserted lines follow a CRLF document's line endings", () => {
  const bench = workspace();
  try {
    const path = write(
      bench.root,
      "settings.json",
      '{\r\n  "enabledPlugins": {\r\n    "alpha": true\r\n  }\r\n}\r\n',
    );
    setSettingsValue(path, ["enabledPlugins", "zeta"], true, { sorted: true });
    assert.equal(
      readFileSync(path, "utf8"),
      '{\r\n  "enabledPlugins": {\r\n    "alpha": true,\r\n    "zeta": true\r\n  }\r\n}\r\n',
    );
  } finally {
    bench.cleanup();
  }
});
