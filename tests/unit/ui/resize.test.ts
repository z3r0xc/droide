/**
 * Resize (spec B19): dimensions are props of the shell, so a new size re-wraps
 * the transcript and recomputes the header/composer budgets in the next frame.
 * The static-header contract needs Ink's <Static> region and lands with the
 * streaming slice; this test pins the reflow itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderShell } from "../../../src/ui/render.ts";
import { displayWidth } from "../../../src/ui/text.ts";
import type { TranscriptEntry } from "../../../src/ui/transcript.ts";
import { captureStream, frameLines, shellAt } from "./harness.ts";

const LONG_TEXT =
  "This paragraph is deliberately long so that it wraps at one width and " +
  "re-wraps at another, proving the transcript is laid out from the size " +
  "props rather than cached in a module constant.";

function longTranscript(): readonly TranscriptEntry[] {
  return [
    { kind: "user", text: "hello" },
    { kind: "assistant", text: LONG_TEXT },
    {
      kind: "tool",
      name: "Read",
      params: [["path", "src/a.ts"]],
      state: "success",
      result: "line one\nline two",
    },
  ];
}

function assistantRows(lines: readonly string[]): number {
  const start = lines.findIndex((line) => line.startsWith("⛬"));
  if (start < 0) return 0;
  let rows = 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "") === "") break;
    rows += 1;
  }
  return rows;
}

test("a width and height change reflows without throwing", async () => {
  const wide = shellAt(120, 40, {
    transcript: longTranscript(),
    changelog: true,
  });
  const { stdout, chunks } = captureStream(120, 40);
  const handle = await renderShell(wide, {
    stdout,
    columns: 120,
    rows: 40,
    debug: true,
  });

  try {
    const first = frameLines(chunks[0] ?? "");
    assert.ok(first.length > 0);

    const wideAssistant = assistantRows(first);

    const before = chunks.length;
    await handle.rerender(shellAt(80, 30, { transcript: longTranscript() }), {
      columns: 80,
      rows: 30,
    });
    const resized = frameLines(chunks.slice(before).join("\n"));

    assert.ok(resized.length > 0, "the resize produced a frame");
    for (const [index, line] of resized.entries()) {
      assert.ok(
        displayWidth(line) <= 80,
        `row ${String(index + 1)} fits 80 columns: ${line}`,
      );
    }
    assert.ok(
      resized.some((line) => line.includes("This paragraph")),
      "the transcript still renders after the resize",
    );
    assert.ok(
      assistantRows(resized) > wideAssistant,
      "the assistant body re-wraps at the narrower content width",
    );

    const beforeRows = chunks.length;
    await handle.rerender(
      shellAt(80, 24, { transcript: [{ kind: "user", text: "hello" }] }),
      { columns: 80, rows: 24 },
    );
    const shortRows = frameLines(chunks.slice(beforeRows).join("\n"));
    assert.ok(shortRows.length > 0, "a rows-only resize produced a frame");
    assert.ok(
      shortRows.length <= 24,
      "the short frame stays inside the terminal height",
    );
    assert.ok(
      shortRows.some((line) => line.includes("╔")),
      "height 24 selects the compact mini logo",
    );
    assert.ok(
      !shortRows.some((line) => line.includes("█")),
      "the full block logo is gone at 80×24",
    );
  } finally {
    await handle.unmount();
  }
});
