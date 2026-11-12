/**
 * Capability matrix (spec B18, T6): injected environments resolve to the
 * documented colour depth, probe plan and fallback theme, and a terminal that
 * must not see escape sequences receives none from the shell.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectCapabilities,
  parseColorFgBg,
  type Capabilities,
  type CapabilityEnvironment,
} from "../../../src/ui/capabilities.ts";
import { resolveColor } from "../../../src/ui/tokens.ts";
import { renderShell } from "../../../src/ui/render.ts";
import {
  captureStream,
  frameLines,
  scriptedTranscript,
  shellAt,
} from "./harness.ts";

function environment(
  overrides: Partial<CapabilityEnvironment> = {},
  env: Readonly<Record<string, string | undefined>> = {},
): CapabilityEnvironment {
  return {
    env: { TERM: "xterm-256color", ...env },
    platform: "linux",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ...overrides,
  };
}

test("a TTY with a 256-colour TERM resolves to 256 colours without probing", () => {
  const caps = detectCapabilities(environment());
  assert.equal(caps.colorDepth, "256");
  assert.equal(caps.interactive, true);
  assert.equal(caps.style, true);
  assert.equal(caps.hyperlinks, true);
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
  assert.equal(caps.platform, "posix");
});

test("a truecolour COLORTERM resolves to truecolour without probing", () => {
  const caps = detectCapabilities(
    environment({}, { COLORTERM: "truecolor", TERM: "xterm-256color" }),
  );
  assert.equal(caps.colorDepth, "truecolor");
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
});

test("a plain 16-colour TTY still probes for 24-bit colour", () => {
  const caps = detectCapabilities(environment({}, { TERM: "xterm" }));
  assert.equal(caps.colorDepth, "16");
  assert.equal(caps.probes.trueColor, true);
  assert.equal(caps.probes.appearance, true);
  assert.equal(
    resolveColor("primary", caps),
    "yellow",
    "16-colour terminals get an ANSI-16 name, never a hex",
  );
});

test("no TTY disables colour, interactivity and both probes", () => {
  const caps = detectCapabilities(
    environment({ stdinIsTTY: false, stdoutIsTTY: false }),
  );
  assert.equal(caps.colorDepth, "none");
  assert.equal(caps.interactive, false);
  assert.equal(caps.style, false);
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
});

test("TERM=dumb disables colour, interactivity and hyperlinks", () => {
  const caps = detectCapabilities(environment({}, { TERM: "dumb" }));
  assert.equal(caps.colorDepth, "none");
  assert.equal(caps.interactive, false);
  assert.equal(caps.style, false);
  assert.equal(caps.hyperlinks, false);
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
});

test("NO_COLOR skips probing and falls back to COLORFGBG", () => {
  const caps = detectCapabilities(
    environment({}, { NO_COLOR: "1", COLORFGBG: "0;7" }),
  );
  assert.equal(caps.colorDepth, "none");
  assert.equal(caps.theme, "factory-light");
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
});

test("FORCE_COLOR skips the truecolour probe and wins over NO_COLOR", () => {
  const forced = detectCapabilities(
    environment({}, { FORCE_COLOR: "3", NO_COLOR: "1" }),
  );
  assert.equal(forced.colorDepth, "truecolor");
  assert.equal(forced.probes.trueColor, false);
  assert.equal(forced.probes.appearance, false);
});

test("FORCE_COLOR=0 skips both probes and forces no colour", () => {
  const caps = detectCapabilities(environment({}, { FORCE_COLOR: "0" }));
  assert.equal(caps.colorDepth, "none");
  assert.equal(caps.style, false);
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
});

test("CI skips both probes but keeps the terminal's colour depth", () => {
  const caps = detectCapabilities(environment({}, { CI: "1" }));
  assert.equal(caps.colorDepth, "256");
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
  assert.equal(detectCapabilities(environment({}, { CI: "false" })).probes.appearance, false);
});

test("win32 writes neither probe and resolves from COLORFGBG only", () => {
  const caps = detectCapabilities(
    environment({ platform: "win32" }, { TERM: "xterm", COLORFGBG: "0;8" }),
  );
  assert.equal(caps.platform, "windows");
  assert.equal(caps.colorDepth, "16");
  assert.equal(caps.theme, "factory-dark");
  assert.deepEqual(caps.probes, { trueColor: false, appearance: false });
});

test("COLORFGBG parsing follows the last field", () => {
  assert.equal(parseColorFgBg(undefined), "factory-dark");
  assert.equal(parseColorFgBg("15;0"), "factory-dark");
  assert.equal(parseColorFgBg("0;default"), "factory-light");
  assert.equal(parseColorFgBg("0;7"), "factory-light");
  assert.equal(parseColorFgBg("0;8"), "factory-dark");
  assert.equal(parseColorFgBg("0;3"), "factory-dark");
});

test("COLUMNS and LINES are read from the injected environment", () => {
  const defaults = detectCapabilities(environment());
  assert.equal(defaults.columns, 80);
  assert.equal(defaults.rows, 24);
  const sized = detectCapabilities(
    environment({}, { COLUMNS: "132", LINES: "43" }),
  );
  assert.equal(sized.columns, 132);
  assert.equal(sized.rows, 43);
  assert.equal(
    detectCapabilities(environment({}, { COLUMNS: "nope" })).columns,
    80,
  );
});

async function rawFrame(caps: Capabilities): Promise<string> {
  const { stdout, chunks } = captureStream(80, 24);
  const props = {
    ...shellAt(80, 24, { transcript: scriptedTranscript() }),
    capabilities: caps,
  };
  const handle = await renderShell(props, {
    stdout,
    columns: 80,
    rows: 24,
    debug: true,
  });
  try {
    return chunks[0] ?? "";
  } finally {
    await handle.unmount();
  }
}

test("terminals that forbid escape sequences receive none", async () => {
  const forbidden = [
    detectCapabilities(environment({ stdinIsTTY: false })),
    detectCapabilities(environment({}, { TERM: "dumb" })),
    detectCapabilities(environment({}, { NO_COLOR: "1" })),
    detectCapabilities(environment({}, { FORCE_COLOR: "0" })),
  ];
  for (const caps of forbidden) {
    assert.equal(caps.colorDepth, "none");
    const frame = await rawFrame(caps);
    assert.equal(
      frame.includes("\u001B"),
      false,
      `no escape bytes for depth ${caps.colorDepth}`,
    );
    assert.ok(frameLines(frame).length > 0, "the shell still renders text");
  }
});

test("a 16-colour terminal gets neither truecolour nor OSC palette bytes", async () => {
  const caps = detectCapabilities(environment({}, { TERM: "xterm" }));
  const frame = await rawFrame(caps);
  assert.equal(frame.includes("\u001B[48;2;"), false);
  assert.equal(frame.includes("\u001B]4;"), false);
});