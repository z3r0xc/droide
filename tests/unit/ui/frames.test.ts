/**
 * Frame goldens (T2, T3) and frame determinism.
 *
 * Frames are captured in Ink debug mode, stripped of SGR/OSC and compared as
 * ordered lines with trailing space padding removed — the spec's definition of
 * a frame. Each scenario is rendered twice in this process to prove the output
 * is byte-stable, and every mount is unmounted before the next one.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderShell } from "../../../src/ui/render.ts";
import type { ShellProps } from "../../../src/ui/components/Shell.ts";
import { displayWidth } from "../../../src/ui/text.ts";
import type { TranscriptEntry } from "../../../src/ui/transcript.ts";
import {
  captureStream,
  frameLines,
  scriptedTranscript,
  shellAt,
} from "./harness.ts";

interface RenderedFrame {
  readonly lines: readonly string[];
  readonly raw: string;
}

async function renderFrame(props: ShellProps): Promise<RenderedFrame> {
  const { stdout, chunks } = captureStream(props.width, props.height);
  const handle = await renderShell(props, {
    stdout,
    columns: props.width,
    rows: props.height,
    debug: true,
  });
  try {
    const raw = chunks[0] ?? "";
    return { lines: frameLines(raw), raw };
  } finally {
    await handle.unmount();
    assert.equal(
      stdout.listenerCount("resize"),
      0,
      "unmount leaves no terminal listener behind",
    );
  }
}

function assertGolden(name: string, lines: readonly string[]): void {
  const url = new URL(`./frames/${name}`, import.meta.url);
  const text = `${lines.join("\n")}\n`;
  if (process.env["UI_RECORD_FRAMES"] === "1") {
    mkdirSync(dirname(fileURLToPath(url)), { recursive: true });
    writeFileSync(url, text);
    return;
  }
  const expected = frameLines(readFileSync(url, "utf8"));
  assert.deepEqual(lines, expected);
}

function assertWidth(lines: readonly string[], width: number): void {
  for (const [index, line] of lines.entries()) {
    assert.ok(
      displayWidth(line) <= width,
      `row ${String(index + 1)} is ${String(displayWidth(line))} columns: ${line}`,
    );
  }
}

test("frame at 80×24 (compact header, empty transcript)", async () => {
  const props = shellAt(80, 24);
  const first = await renderFrame(props);
  assertGolden("golden-80x24.txt", first.lines);

  assertWidth(first.lines, 80);
  assert.equal(
    first.raw.includes("\u001B"),
    false,
    "the capture is plain text",
  );
  assert.equal(first.lines.length, 18, "12 header rows + input stack + footer");
  assert.equal(
    first.lines[0],
    `${" ".repeat(29)}╔═══════════════════╗`,
    "mini logo is centred in 80 columns",
  );
  assert.equal(first.lines[4], `${" ".repeat(36)}v0.4.0`);
  assert.match(first.lines[11] ?? "", /^Skills \(0\) ✗ {2}MCPs \(0\) ✗/u);
  assert.equal(first.lines[12], "", "idle status-banner row is reserved");
  assert.match(
    first.lines[13] ?? "",
    /^Auto \(Off\) · all actions require approval +claude-sonnet-4-5$/u,
  );
  assert.match(first.lines[14] ?? "", /^╭─+╮$/u);
  assert.match(first.lines[15] ?? "", /^│ > Try "/u);
  assert.match(first.lines[16] ?? "", /^╰─+╯$/u);
  assert.equal(first.lines[17], "? for help");
});

test("frame at 120×40 (wide header, scripted transcript)", async () => {
  const props = shellAt(120, 40, {
    transcript: scriptedTranscript(),
    changelog: true,
  });
  const first = await renderFrame(props);
  assertGolden("golden-120x40.txt", first.lines);

  assertWidth(first.lines, 120);
  assert.equal(
    first.raw.includes("\u001B"),
    false,
    "the capture is plain text",
  );
  assert.equal(first.lines[0], "", "marginTop 2 above the wide header");
  assert.equal(first.lines[1], "");
  assert.match(
    first.lines[2] ?? "",
    /^ {7}█+.*│ New features$/u,
    "full logo starts on row 3 and the changelog column is separated by │",
  );
  assert.equal(
    first.lines.filter((line) => line.startsWith("Skills (0) ✗")).length,
    1,
    "the compact status row is replaced by the wide one",
  );

  const transcript = first.lines.slice(17, 24);
  assert.equal(transcript[0], "   hello", "user row: bar + two spaces");
  assert.match(transcript[2] ?? "", /^⛬ Hi there\.$/u);
  assert.match(transcript[4] ?? "", /^ {3}Read, path: "src\/a\.ts"$/u);
  assert.match(transcript[5] ?? "", /^ {4}↳ line one$/u);
  assert.match(transcript[6] ?? "", /^ {6}line two$/u);
  assert.equal(first.lines.at(-1), "? for help");
});

test("frames are deterministic across runs in the same process", async () => {
  const scenarios: readonly ShellProps[] = [
    shellAt(80, 24),
    shellAt(120, 40, { transcript: scriptedTranscript(), changelog: true }),
  ];
  for (const props of scenarios) {
    const first = await renderFrame(props);
    const second = await renderFrame(props);
    assert.deepEqual(second.lines, first.lines);
    assert.equal(second.raw, first.raw);
  }
});

test("mounting and unmounting leaves no process or terminal listeners", async () => {
  const exitListeners = process.listenerCount("exit");
  const beforeExitListeners = process.listenerCount("beforeExit");
  const frame = await renderFrame(shellAt(80, 24));
  assert.ok(frame.lines.length > 0);
  assert.equal(process.listenerCount("exit"), exitListeners);
  assert.equal(process.listenerCount("beforeExit"), beforeExitListeners);
});

test("unmount restores the cursor on an interactive terminal", async () => {
  const { stdout, chunks } = captureStream(80, 24);
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const handle = await renderShell(shellAt(80, 24), {
    stdout,
    columns: 80,
    rows: 24,
    interactive: true,
  });
  await handle.unmount();
  const output = chunks.join("");
  assert.ok(
    output.includes("\u001B[?25l"),
    "the cursor is hidden while mounted",
  );
  assert.ok(output.includes("\u001B[?25h"), "unmount restores the cursor");
  assert.equal(stdout.listenerCount("resize"), 0);
});

test("a configured status line renders below the footer", async () => {
  const frame = await renderFrame({
    ...shellAt(80, 24),
    statusLine: { text: "branch: main · clean", padding: 1, maxRows: 1 },
  });
  assert.equal(frame.lines.length, 19);
  assert.equal(frame.lines.at(-1), " branch: main · clean");
});

test("unknown transcript kinds and malformed items render nothing", async () => {
  const entries: readonly TranscriptEntry[] = [
    { kind: "diff", patch: "@@" },
    { kind: "todo", items: [] },
    { kind: "assistant" },
    { kind: "user", text: "visible" },
  ];
  const frame = await renderFrame(shellAt(24, 24, { transcript: entries }));
  const body = frame.lines.slice(12);
  assert.ok(
    body.some((line) => line.includes("visible")),
    "the known item still renders",
  );
  assert.equal(
    body.filter((line) => line.includes("diff") || line.includes("todo"))
      .length,
    0,
  );
});

test("an approval row prints its choices, keys and outcome", async () => {
  const approval: TranscriptEntry = {
    kind: "approval",
    toolName: "Write",
    summary: "file-edit · risk: high",
    options: [
      { choice: "once", label: "Yes, allow" },
      { choice: "session", label: "Yes, and always allow this session" },
      { choice: "deny", label: "No, cancel" },
    ],
    selected: 1,
  };
  const pending: readonly TranscriptEntry[] = [
    approval,
    { kind: "notice", text: "Cancelled" },
  ];
  const frame = await renderFrame(shellAt(80, 24, { transcript: pending }));
  assertWidth(frame.lines, 80);
  const text = frame.lines.join("\n");
  assert.match(text, /● Approval · Write\n/u);
  assert.match(text, /  file-edit · risk: high/u);
  assert.match(text, /> Yes, and always allow this session/u, "the selection");
  assert.match(text, / {2}Yes, allow/u);
  assert.match(text, / {2}No, cancel/u);
  assert.match(text, /↑↓ navigate · Enter select · Esc cancel/u);
  assert.match(text, /● Cancelled/u);

  const decided = await renderFrame(
    shellAt(80, 24, {
      transcript: [{ ...approval, decision: "deny" }],
    }),
  );
  const decidedText = decided.lines.join("\n");
  assert.match(decidedText, /● Approval · Write · denied/u);
  assert.equal(
    decidedText.includes("Yes, allow"),
    false,
    "the options are gone once answered",
  );
});
