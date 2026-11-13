/**
 * Geometry helpers pinned against the spec's row budgets: header rows (B3),
 * composer rows (B10), the mode border (B10) and footer fitting (B13).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildModeBorder,
  composerHeight,
  resolveComposerVisibleRows,
} from "../../../src/ui/components/Composer.ts";
import { fitFooter } from "../../../src/ui/components/Footer.ts";
import {
  headerHeight,
  headerGeometry,
} from "../../../src/ui/components/Header.ts";
import {
  queuedListHeight,
  type QueuedRow,
} from "../../../src/ui/components/QueuedList.ts";
import { statusLineHeight } from "../../../src/ui/components/StatusLine.ts";
import { displayWidth } from "../../../src/ui/text.ts";
import { headerContent } from "./harness.ts";

test("the compact header occupies 12 rows and the wide header 17", () => {
  assert.equal(headerHeight(80, 24, headerContent(false)), 12);
  assert.equal(headerHeight(120, 40, headerContent(true)), 17);
  assert.equal(headerHeight(120, 40, headerContent(false)), 17);
  assert.equal(
    headerHeight(80, 24, { ...headerContent(false), dev: true }),
    13,
    "the [DEV] row adds one row",
  );
  const compact = headerGeometry(80, 24, headerContent(false));
  assert.equal(compact.compact, true);
  assert.equal(compact.logoRows.length, 3);
  const wide = headerGeometry(120, 40, headerContent(true));
  assert.equal(wide.compact, false);
  assert.equal(wide.leftColWidth, 66);
  assert.equal(wide.logoRows.length, 6);
});

test("the composer is three rows with one draft line, plus one for a hint", () => {
  const base = { placeholder: "p", focused: true };
  assert.equal(composerHeight(24, { ...base, draft: "" }), 3);
  assert.equal(composerHeight(24, { ...base, draft: "one" }), 3);
  assert.equal(composerHeight(24, { ...base, draft: "one\n two\nthree" }), 5);
  assert.equal(composerHeight(24, { ...base, draft: "", hint: "hint" }), 4);
  assert.ok(resolveComposerVisibleRows(24, true) >= 1);
  assert.ok(
    resolveComposerVisibleRows(24, false) >=
      resolveComposerVisibleRows(24, true),
    "the idle composer window is at least as tall",
  );
});

test("the mode border fills the width and degrades at tiny widths", () => {
  const border = buildModeBorder("SPEC", "roaming", 40);
  assert.equal(displayWidth(border), 40);
  assert.match(border, /^╭── SPEC · roaming ─+╮$/u);
  const dropped = buildModeBorder(
    "SPEC",
    "a title far too long to fit here",
    20,
  );
  assert.equal(displayWidth(dropped), 20);
  assert.match(dropped, /^╭── SPEC ─+╮$/u);
  assert.equal(buildModeBorder("SPEC", "x", 2), "╭╮");
  assert.equal(buildModeBorder("SPEC", "x", 1), "╭");
});

test("the footer fits hints before it truncates statuses", () => {
  assert.equal(fitFooter(80, {}), "? for help");
  const wide = fitFooter(
    80,
    { hints: ["ctrl+O for transcript"], statuses: ["main"] },
    "posix",
  );
  assert.equal(displayWidth(wide), 80);
  assert.ok(wide.startsWith("? for help ctrl+O for transcript"));
  assert.ok(wide.endsWith("main"));

  const windows = fitFooter(
    80,
    { hints: ["a"], statuses: ["main"] },
    "windows",
  );
  assert.equal(windows, "? for help a | main");

  const narrow = fitFooter(
    24,
    { hints: ["first hint", "second hint"], statuses: ["main", "mcp"] },
    "posix",
  );
  assert.ok(displayWidth(narrow) <= 24);
  assert.ok(narrow.startsWith("? for help"));
});

test("the status-line height follows its configuration", () => {
  assert.equal(statusLineHeight(80, undefined), 0);
  assert.equal(statusLineHeight(80, { text: "" }), 0);
  assert.equal(statusLineHeight(80, { text: "one" }), 1);
  assert.equal(statusLineHeight(80, { text: "one\ntwo", maxRows: 2 }), 2);
  assert.equal(
    statusLineHeight(80, { text: "one\ntwo\nthree", maxRows: 9 }),
    3,
  );
});

test("the queued list takes one row per line, three visible, plus overflow", () => {
  const row = (position: number): QueuedRow => ({
    position,
    text: `line ${String(position)}`,
    mode: "queue",
  });
  assert.equal(queuedListHeight([]), 0);
  assert.equal(queuedListHeight([row(1)]), 1);
  assert.equal(queuedListHeight([row(1), row(2)]), 2);
  assert.equal(queuedListHeight([row(1), row(2), row(3)]), 3);
  assert.equal(queuedListHeight([row(1), row(2), row(3), row(4)]), 4);
  assert.equal(
    queuedListHeight(Array.from({ length: 8 }, (_x, i) => row(i + 1))),
    4,
  );
});
