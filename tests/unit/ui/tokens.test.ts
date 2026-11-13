/**
 * The token tables are the design contract (spec D1–D13). Every literal below
 * is retyped from `specs/95-terminal-ui.md`; a failure names the table, slot and
 * both values.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANSI_PALETTE,
  BORDERS,
  CORE_PALETTE,
  DIFF_PALETTE,
  GLYPHS,
  LOGO_FULL_HEIGHT,
  LOGO_FULL_ROWS,
  LOGO_MINI_ROWS,
  LOGO_MINI_WIDTH,
  MARKDOWN_PALETTE,
  MISSION_CONTROL_PALETTE,
  PALETTE_DARK,
  PALETTE_LIGHT,
  SPACING,
  SPINNERS,
  SUBAGENT_BADGE_SLOTS,
  SYNTAX_PALETTE,
  TEXT_PALETTE,
  TIMINGS,
  nearestAnsi256,
  paletteFor,
  resolveColor,
  themeColor,
} from "../../../src/ui/tokens.ts";
import { displayWidth } from "../../../src/ui/text.ts";

type PairRow<Slot extends string> = readonly [Slot, string, string];

function assertPairs<Slot extends string>(
  clause: string,
  table: {
    readonly dark: Readonly<Record<Slot, string>>;
    readonly light: Readonly<Record<Slot, string>>;
  },
  rows: readonly PairRow<Slot>[],
): void {
  for (const [slot, dark, light] of rows) {
    assert.equal(table.dark[slot], dark, `${clause} ${slot} dark`);
    assert.equal(table.light[slot], light, `${clause} ${slot} light`);
  }
}

type CoreSlot = keyof typeof CORE_PALETTE.dark;
const CORE_ROWS: readonly PairRow<CoreSlot>[] = [
  ["primary", "#d75f00", "#d75f00"],
  ["border", "#878787", "#b0b0b0"],
  ["success", "#afaf5f", "#2e7d32"],
  ["error", "#d75f5f", "#c62828"],
  ["warning", "#ffaf00", "#e65100"],
  ["spec", "#afafff", "#0057a8"],
  ["agi", "#afaf5f", "#2e7d32"],
  ["missionV2", "#5fafd7", "#0057a8"],
  ["btw", "#8fb9c9", "#3d7a92"],
  ["asciiArt", "#d75f00", "#d75f00"],
  ["headerLogo", "#eeeeee", "#000000"],
  ["toolName", "#d7875f", "#b35900"],
  ["toolParam", "#b2b2b2", "#5a5a5a"],
  ["hookBadgeBg", "#af87ff", "#7b1fa2"],
  ["hookBadgeFg", "#000000", "#ffffff"],
  ["toolBadgeBg", "#FEB17F", "#ff9800"],
  ["toolBadgeFg", "#000000", "#000000"],
  ["statusActive", "#00ff00", "#00c853"],
  ["highlight", "#d78700", "#e65100"],
  ["highlightDanger", "#d75f5f", "#c62828"],
  ["disconnected", "#ff8787", "#ef5350"],
  ["gitAdditions", "#7db87a", "#659e62"],
  ["gitDeletions", "#b87a7a", "#9e6262"],
];

type TextSlot = keyof typeof TEXT_PALETTE.dark;
const TEXT_ROWS: readonly PairRow<TextSlot>[] = [
  ["text.primary", "#eeeeee", "#1a1a1a"],
  ["text.secondary", "#a8a8a8", "#4a4a4a"],
  ["text.muted", "#767676", "#6b6b6b"],
  ["text.userText", "#D8D4D2", "#000000"],
  ["text.userBg", "#262626", "#e8e8e8"],
  ["text.selectionBg", "#303030", "#303030"],
  ["text.userSymbol", "#d75f00", "#d75f00"],
  ["text.helpKey", "#908a86", "#000000"],
  ["text.helpLabel", "#645e5a", "#8a8a8a"],
  ["text.menuTitle", "#eeeeee", "#000000"],
  ["text.menuSectionHeader", "#eeeeee", "#000000"],
  ["text.modelMultiplier", "#5f8787", "#8a8a8a"],
  ["text.queuedSymbol", "#a04800", "#c47a30"],
  ["text.queuedText", "#8a8a8a", "#6b6b6b"],
  ["text.info", "#afafff", "#0057a8"],
];

type DiffSlot = keyof typeof DIFF_PALETTE.dark;
const DIFF_ROWS: readonly PairRow<DiffSlot>[] = [
  ["diff.added", "#5fff5f", "#2e7d32"],
  ["diff.addedBg", "#0a2e10", "#90c898"],
  ["diff.addedWordBg", "#1a5a22", "#60a868"],
  ["diff.removed", "#ff5f5f", "#c62828"],
  ["diff.removedBg", "#2e0a0a", "#e8b0b4"],
  ["diff.removedWordBg", "#5a1a1a", "#c87878"],
  ["diff.border", "#585858", "#b0b0b0"],
  ["diff.lineNumber", "#767676", "#8a8a8a"],
  ["diff.header", "#5fafd7", "#0057a8"],
  ["diff.unchanged", "#767676", "#8a8a8a"],
  ["diff.dimUnchanged", "#5f5f5f", "#b0b0b0"],
];

type MarkdownSlot = keyof typeof MARKDOWN_PALETTE.dark;
const MARKDOWN_ROWS: readonly PairRow<MarkdownSlot>[] = [
  ["markdown.bold", "#bcbcbc", "#1a1a1a"],
  ["markdown.italic", "#bcbcbc", "#4a4a4a"],
  ["markdown.code", "#8a8a8a", "#5a5a5a"],
  ["markdown.link", "#af87af", "#0057a8"],
  ["markdown.heading", "#dadada", "#1a1a1a"],
  ["markdown.blockquote", "#8a8a8a", "#6b6b6b"],
  ["markdown.strikethrough", "#8a8a8a", "#8a8a8a"],
];

type MissionSlot = keyof typeof MISSION_CONTROL_PALETTE.dark;
const MISSION_ROWS: readonly PairRow<MissionSlot>[] = [
  ["mc.emphasis", "#eeeeee", "#eeeeee"],
  ["mc.primary", "#dadada", "#dadada"],
  ["mc.secondary", "#8a8a8a", "#8a8a8a"],
  ["mc.tertiary", "#626262", "#626262"],
  ["mc.ghost", "#3a3a3a", "#3a3a3a"],
  ["mc.dataValue", "#9e9e9e", "#9e9e9e"],
  ["mc.paused", "#dadada", "#dadada"],
  ["mc.border", "#4e4e4e", "#4e4e4e"],
  ["mc.active", "#ff5f00", "#ff5f00"],
  ["mc.done", "#afaf5f", "#afaf5f"],
  ["mc.fail", "#af5f5f", "#af5f5f"],
  ["mc.info", "#626262", "#626262"],
  ["mc.ref", "#5f8787", "#5f8787"],
  ["mc.worker", "#878787", "#878787"],
  ["mc.progress", "#00d75f", "#00d75f"],
  ["mc.barFillFrom", "#ff5f00", "#ff5f00"],
  ["mc.barFillTo", "#ff5f00", "#ff5f00"],
  ["mc.barEmpty", "#585858", "#585858"],
  ["mc.hlBg", "#bcbcbc", "#bcbcbc"],
  ["mc.hlFg", "#080808", "#080808"],
  ["mc.t2", "#e4e4e4", "#e4e4e4"],
  ["mc.t4", "#bcbcbc", "#bcbcbc"],
  ["mc.t6", "#b2b2b2", "#b2b2b2"],
  ["mc.t9", "#808080", "#808080"],
  ["mc.t12", "#626262", "#626262"],
  ["mc.ts", "#626262", "#626262"],
  ["mc.qb", "#585858", "#585858"],
];

type SyntaxSlot = keyof typeof SYNTAX_PALETTE.dark;
const SYNTAX_ROWS: readonly PairRow<SyntaxSlot>[] = [
  ["hljs.keyword", "#afafff", "#afafff"],
  ["hljs.built_in", "#5f8787", "#5f8787"],
  ["hljs.type", "#ffaf00", "#ffaf00"],
  ["hljs.literal", "#ffaf00", "#ffaf00"],
  ["hljs.number", "#ffaf00", "#ffaf00"],
  ["hljs.string", "#00d75f", "#00d75f"],
  ["hljs.doctag", "#00d75f", "#00d75f"],
  ["hljs.quote", "#00d75f", "#00d75f"],
  ["hljs.comment", "#767676", "#767676"],
  ["hljs.function", "#5fafd7", "#5fafd7"],
  ["hljs.class", "#5fafd7", "#5fafd7"],
  ["hljs.title", "#5fafd7", "#5fafd7"],
  ["hljs.variable", "#d75f5f", "#d75f5f"],
  ["hljs.attr", "#d75f5f", "#d75f5f"],
  ["hljs.property", "#5f8787", "#5f8787"],
  ["hljs.tag", "#d75f5f", "#d75f5f"],
  ["hljs.name", "#d75f5f", "#d75f5f"],
  ["hljs.selector-tag", "#d75f5f", "#d75f5f"],
  ["hljs.selector-class", "#ffaf00", "#ffaf00"],
  ["hljs.selector-id", "#ffaf00", "#ffaf00"],
  ["hljs.value", "#00d75f", "#00d75f"],
  ["hljs.params", "#eeeeee", "#eeeeee"],
  ["hljs.meta", "#767676", "#767676"],
  ["hljs.regexp", "#d75f5f", "#d75f5f"],
  ["hljs.operator", "#eeeeee", "#eeeeee"],
  ["hljs.punctuation", "#eeeeee", "#eeeeee"],
  ["hljs.symbol", "#5f8787", "#5f8787"],
  ["hljs.bullet", "#5f8787", "#5f8787"],
  ["hljs.link", "#5fafd7", "#5fafd7"],
  ["hljs.emphasis", "#eeeeee", "#eeeeee"],
  ["hljs.strong", "#eeeeee", "#eeeeee"],
  ["hljs.section", "#5fafd7", "#5fafd7"],
  ["hljs.addition", "#00d75f", "#00d75f"],
  ["hljs.deletion", "#d75f5f", "#d75f5f"],
  ["hljs.subst", "#eeeeee", "#eeeeee"],
  ["hljs.template-tag", "#afafff", "#afafff"],
  ["hljs.template-variable", "#d75f5f", "#d75f5f"],
];

type AnsiSlot = keyof typeof ANSI_PALETTE.dark;
const ANSI_ROWS: readonly PairRow<AnsiSlot>[] = [
  ["ansi.black", "#1c1c1c", "#1a1a1a"],
  ["ansi.red", "#d75f5f", "#c62828"],
  ["ansi.green", "#00d75f", "#2e7d32"],
  ["ansi.yellow", "#ffaf00", "#e65100"],
  ["ansi.blue", "#5fafd7", "#0057a8"],
  ["ansi.magenta", "#afafff", "#7b1fa2"],
  ["ansi.cyan", "#5f8787", "#00695c"],
  ["ansi.white", "#dadada", "#f5f5f5"],
  ["ansi.brightBlack", "#767676", "#8a8a8a"],
  ["ansi.brightRed", "#ff5f5f", "#ef5350"],
  ["ansi.brightGreen", "#5fff5f", "#43a047"],
  ["ansi.brightYellow", "#ffd75f", "#ff9800"],
  ["ansi.brightBlue", "#87afd7", "#1e88e5"],
  ["ansi.brightMagenta", "#d7afff", "#ab47bc"],
  ["ansi.brightCyan", "#87d7d7", "#00897b"],
  ["ansi.brightWhite", "#eeeeee", "#ffffff"],
  ["ansi.background", "#1c1c1c", "#f5f5f5"],
  ["ansi.foreground", "#eeeeee", "#1a1a1a"],
  ["ansi.cursor", "#d75f00", "#d75f00"],
];

test("D1 core palette matches the spec", () => {
  assertPairs("D1", CORE_PALETTE, CORE_ROWS);
});

test("D2 text palette matches the spec, including the light selection fallback", () => {
  assertPairs("D2", TEXT_PALETTE, TEXT_ROWS);
});

test("D3 diff palette matches the spec", () => {
  assertPairs("D3", DIFF_PALETTE, DIFF_ROWS);
});

test("D4 markdown palette matches the spec", () => {
  assertPairs("D4", MARKDOWN_PALETTE, MARKDOWN_ROWS);
});

test("D5 mission-control palette matches the spec (light inherits dark)", () => {
  assertPairs("D5", MISSION_CONTROL_PALETTE, MISSION_ROWS);
});

test("D6 subagent badge slots match the spec order and palette references", () => {
  assert.deepEqual(SUBAGENT_BADGE_SLOTS, [
    { bg: "toolBadgeBg", fg: "toolBadgeFg" },
    { bg: "spec", fg: "toolBadgeFg" },
    { bg: "hookBadgeBg", fg: "hookBadgeFg" },
    { bg: "success", fg: "text.primary" },
    { bg: "warning", fg: "toolBadgeFg" },
    { bg: "error", fg: "text.primary" },
    { bg: "primary", fg: "toolBadgeFg" },
    { bg: "highlight", fg: "toolBadgeFg" },
  ]);
});

test("D7 syntax palette matches the spec (light inherits dark)", () => {
  assertPairs("D7", SYNTAX_PALETTE, SYNTAX_ROWS);
});

test("D8 terminal ANSI palette matches the spec", () => {
  assertPairs("D8", ANSI_PALETTE, ANSI_ROWS);
});

test("resolved palettes contain every slot and respect the theme", () => {
  const slots = [
    ...CORE_ROWS,
    ...TEXT_ROWS,
    ...DIFF_ROWS,
    ...MARKDOWN_ROWS,
    ...MISSION_ROWS,
    ...SYNTAX_ROWS,
    ...ANSI_ROWS,
  ] as const;
  for (const [slot, dark, light] of slots) {
    if (slot === "text.selectionBg") continue;
    assert.equal(PALETTE_DARK[slot], dark, `dark ${slot}`);
    assert.equal(PALETTE_LIGHT[slot], light, `light ${slot}`);
    assert.equal(
      themeColor(slot, "droide-dark"),
      dark,
      `themeColor dark ${slot}`,
    );
    assert.equal(
      themeColor(slot, "droide-light"),
      light,
      `themeColor light ${slot}`,
    );
    assert.equal(paletteFor("droide-dark"), PALETTE_DARK);
    assert.equal(paletteFor("droide-light"), PALETTE_LIGHT);
  }
  assert.equal(
    PALETTE_LIGHT["text.selectionBg"],
    PALETTE_LIGHT["text.userBg"],
    "light selection background falls back to userBg",
  );
});

test("D10 spacing matches the spec", () => {
  const expected = {
    transcriptInset: 6,
    assistantMarkerInset: 3,
    userBubbleInset: 3,
    userBarWidth: 1,
    userPadding: 2,
    assistantGap: 1,
    toolRowMargin: 3,
    toolRowInner: 1,
    toolResultIndent: 4,
    thinkingIndent: 3,
    composerPaddingX: 1,
    composerPaddingYWindows: 1,
    composerPaddingYDefault: 0,
    composerInnerTextInset: 10,
    menuPadding: 2,
    menuMinWidth: 78,
    headerLeftMargin: 2,
    statusItemGap: 2,
    footerStatusSeparator: 3,
    footerRowGap: 1,
    helpSegmentSeparator: 3,
    markdownListMarker: 3,
    markdownListTailIndent: 2,
    markdownCodeInset: 2,
    diffGutterBox: 10,
    diffGutter: 11,
    approvalOptionIndent: 2,
    approvalSectionIndent: 2,
  };
  assert.deepEqual(SPACING, expected);
});

test("D12 glyph set matches the spec", () => {
  const expected = {
    assistantMarker: "⛬",
    userMarker: ">",
    toolMarker: "●",
    todoPending: "○",
    todoInProgress: "●",
    todoCompleted: "✓",
    statusOk: "✓",
    statusMissing: "✗",
    bashExecuting: "⏳",
    bashMode: "!",
    resultPrefix: "↳",
    interrupted: "⎿",
    selected: ">",
    cancel: "✕",
    placeholderBadge: "···",
    help: "?",
    arrowUp: "↑",
    arrowDown: "↓",
    arrowLeft: "←",
    arrowRight: "→",
    timer: "⏱",
    separator: "·",
    ellipsis: "…",
    ellipsisAscii: "...",
    moreAbove: "↑ N more",
    moreBelow: "↓ N more",
    hiddenLines: "---- N more lines hidden ----",
    devTag: "[DEV]",
    imageChip: "[Image N]",
    imageRemove: "[x]",
    branchNerd: "",
  };
  assert.deepEqual(GLYPHS, expected);
});

test("D11 borders and logos match the spec geometry", () => {
  assert.deepEqual(BORDERS.round, {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  });
  assert.equal(LOGO_MINI_ROWS.length, 3);
  assert.equal(LOGO_MINI_WIDTH, 21);
  for (const row of LOGO_MINI_ROWS)
    assert.equal(displayWidth(row), LOGO_MINI_WIDTH);
  assert.equal(LOGO_FULL_ROWS.length, LOGO_FULL_HEIGHT);
  assert.equal(LOGO_FULL_HEIGHT, 6);
  for (const row of LOGO_FULL_ROWS) {
    assert.equal(displayWidth(row), 52, "full logo rows share one width");
  }
});

test("D12 spinner presets match the spec", () => {
  assert.deepEqual(SPINNERS.dots, { frames: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", intervalMs: 80 });
  assert.deepEqual(SPINNERS.arrow, { frames: "←↖↑↗→↘↓↙", intervalMs: 100 });
  assert.deepEqual(SPINNERS.circleHalves, { frames: "◐◓◑◒", intervalMs: 50 });
  assert.deepEqual(SPINNERS.toggle, { frames: "⊶⊷", intervalMs: 250 });
  assert.deepEqual(SPINNERS.triangle, { frames: "◢◣◤◥", intervalMs: 50 });
});

test("D13 timings match the spec", () => {
  const expected = {
    animationTickMs: 125,
    statusSpinnerMs: 60,
    defaultSpinnerMs: 80,
    fastModeFactor: 0.5,
    toolShimmerCycleMs: 1000,
    toolShimmerFastCycleMs: 500,
    toolShimmerHighlight: "#e6e6e6",
    toolShimmerWidthFactor: 0.6,
    escapeSequenceMs: 400,
    escapeRunFlushMs: 150,
    tmuxEscapeGraceMs: 650,
    graceFlushMs: 20,
    incompleteCsiMs: 250,
    repeatedKeyResetMs: 200,
    repeatedKeyResetTmuxMs: 700,
    pasteKeyGuardMs: 100,
    doubleCtrlCWindowMs: 2000,
    fileSuggestionDebounceMs: 100,
    fileSuggestionLoadingMs: 200,
    probeTimeoutMs: 500,
    statusLinePollMs: 1000,
  };
  assert.deepEqual(TIMINGS, expected);
});

test("resolveColor degrades truecolour to 256 to 16 to nothing", () => {
  const truecolor = resolveColor("primary", {
    colorDepth: "truecolor",
    theme: "droide-dark",
  });
  assert.equal(truecolor, "#d75f00");

  // The spec's own ANSI-256 comments for three D1 slots.
  assert.equal(nearestAnsi256("#d75f00"), 166);
  assert.equal(nearestAnsi256("#878787"), 102);
  assert.equal(nearestAnsi256("#d78700"), 172);
  assert.equal(
    resolveColor("primary", { colorDepth: "256", theme: "droide-dark" }),
    "ansi256(166)",
  );

  // Nearest ANSI-16 by squared RGB distance; the speced slot per token is
  // chalk's conversion (B18, Open question 3), so this pins our documented one.
  assert.equal(
    resolveColor("primary", { colorDepth: "16", theme: "droide-dark" }),
    "yellow",
  );
  assert.equal(
    resolveColor("primary", { colorDepth: "none", theme: "droide-dark" }),
    undefined,
  );
});
