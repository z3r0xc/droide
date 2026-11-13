/**
 * The pending queued-message list (B10), rendered.
 *
 * Frames are captured in Ink debug mode, stripped of SGR/OSC and compared as
 * ordered lines, so the queue's rows are asserted where the user sees them:
 * directly above the mode/model row, one row per message, oldest first.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderShell } from "../../../src/ui/render.ts";
import type { ShellProps } from "../../../src/ui/components/Shell.ts";
import {
  QUEUED_VISIBLE_ROWS,
  queuedListHeight,
  type QueuedRow,
} from "../../../src/ui/components/QueuedList.ts";
import { displayWidth } from "../../../src/ui/text.ts";
import { captureStream, frameLines, shellAt } from "./harness.ts";

async function renderFrame(props: ShellProps): Promise<readonly string[]> {
  const { stdout, chunks } = captureStream(props.width, props.height);
  const handle = await renderShell(props, {
    stdout,
    columns: props.width,
    rows: props.height,
    debug: true,
  });
  try {
    return frameLines(chunks[0] ?? "");
  } finally {
    await handle.unmount();
  }
}

function modeRowIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) => line.startsWith("Auto (Off)"));
  assert.notEqual(index, -1, "the mode row is on screen");
  return index;
}

function queuedRows(count: number): readonly QueuedRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    position: index + 1,
    text: `line ${String(index + 1)}`,
    mode: index % 2 === 0 ? ("queue" as const) : ("steer" as const),
  }));
}

test("queued lines paint above the mode row, in order, with their position", async () => {
  const lines = await renderFrame(
    shellAt(80, 24, {
      queued: [
        { position: 1, text: "run the unit tests", mode: "queue" },
        { position: 2, text: "then\ncommit", mode: "steer" },
      ],
    }),
  );

  const modeAt = modeRowIndex(lines);
  assert.equal(lines[modeAt - 2], "│ 1. run the unit tests");
  assert.equal(lines[modeAt - 1], "↳ 2. then commit", "one row per message");
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80, `row fits 80 columns: ${line}`);
  }
});

test("an empty queue takes no rows, so the frame is the unqueued frame", async () => {
  const plain = await renderFrame(shellAt(80, 24));
  const empty = await renderFrame(shellAt(80, 24, { queued: [] }));
  assert.deepEqual(empty, plain);
  assert.equal(
    plain.some((line) => /^[│↳] \d+\. /u.test(line)),
    false,
    "no queued row is painted",
  );
});

test("the list shows three rows and an overflow row for the rest", async () => {
  const rows = queuedRows(5);
  const lines = await renderFrame(shellAt(80, 24, { queued: rows }));
  const modeAt = modeRowIndex(lines);

  assert.equal(queuedListHeight(rows), QUEUED_VISIBLE_ROWS + 1);
  assert.equal(lines[modeAt - 4], "│ 1. line 1");
  assert.equal(lines[modeAt - 3], "↳ 2. line 2");
  assert.equal(lines[modeAt - 2], "│ 3. line 3");
  assert.equal(lines[modeAt - 1], "  ... 2 more queued");
});

test("a long queued line is truncated inside the row", async () => {
  const text = "a".repeat(200);
  const lines = await renderFrame(
    shellAt(80, 24, { queued: [{ position: 1, text, mode: "queue" }] }),
  );
  const modeAt = modeRowIndex(lines);
  const row = lines[modeAt - 1] ?? "";
  assert.ok(displayWidth(row) <= 80, "the row never wraps");
  assert.ok(row.endsWith("…"), "the tail is cut with the spec's ellipsis");
  assert.ok(row.startsWith("│ 1. aaa"));
});
