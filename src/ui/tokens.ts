/**
 * Terminal design tokens.
 *
 * Every colour, glyph, spacing value and interval below is transcribed from
 * `specs/95-terminal-ui.md` (clauses D1–D13). No component may declare a colour
 * or glyph literal of its own; `tests/unit/ui/tokens.test.ts` pins these tables
 * against the spec.
 *
 * The light theme of D5 (Mission Control) and D7 (syntax highlighting) is not
 * published by the spec — it only cites the light theme file. Those slots carry
 * `null` in their tables and therefore inherit the dark value in the light
 * palette; that is a documented gap, not an invented colour.
 */

/** The two shipped themes (B17). `auto` resolution is a later slice. */
export type ThemeName = "factory-dark" | "factory-light";

/** Colour depth the terminal can render, after B18 degradation. */
export type ColorDepth = "truecolor" | "256" | "16" | "none";

/** What `resolveColor` needs to pick an ink-compatible colour value. */
export interface ColorCapabilities {
  readonly colorDepth: ColorDepth;
  readonly theme: ThemeName;
}

/** One spec row: dark hex, and the light hex (or `null` when unpublished). */
type Pair = readonly [dark: string, light: string | null];

/**
 * Build the dark and light lookup objects from one literal pair table.
 * The cast is confined here; the token test asserts every produced value.
 */
function pairTable<const Table extends Record<string, Pair>>(
  pairs: Table,
): {
  readonly dark: { readonly [Key in keyof Table]: Table[Key][0] };
  readonly light: { readonly [Key in keyof Table]: string };
} {
  const dark: Record<string, string> = {};
  const light: Record<string, string> = {};
  for (const key of Object.keys(pairs)) {
    const pair = pairs[key] as Pair;
    dark[key] = pair[0];
    light[key] = pair[1] ?? pair[0];
  }
  return { dark, light } as {
    readonly dark: { readonly [Key in keyof Table]: Table[Key][0] };
    readonly light: { readonly [Key in keyof Table]: string };
  };
}

/**
 * D1 — Core palette: brand, borders, badges, status and git counters.
 * Role column of the spec table is the semantic contract; slot names are pinned.
 */
export const CORE_PALETTE = pairTable({
  primary: ["#d75f00", "#d75f00"],
  border: ["#878787", "#b0b0b0"],
  success: ["#afaf5f", "#2e7d32"],
  error: ["#d75f5f", "#c62828"],
  warning: ["#ffaf00", "#e65100"],
  spec: ["#afafff", "#0057a8"],
  agi: ["#afaf5f", "#2e7d32"],
  missionV2: ["#5fafd7", "#0057a8"],
  btw: ["#8fb9c9", "#3d7a92"],
  asciiArt: ["#d75f00", "#d75f00"],
  headerLogo: ["#eeeeee", "#000000"],
  toolName: ["#d7875f", "#b35900"],
  toolParam: ["#b2b2b2", "#5a5a5a"],
  hookBadgeBg: ["#af87ff", "#7b1fa2"],
  hookBadgeFg: ["#000000", "#ffffff"],
  toolBadgeBg: ["#FEB17F", "#ff9800"],
  toolBadgeFg: ["#000000", "#000000"],
  statusActive: ["#00ff00", "#00c853"],
  highlight: ["#d78700", "#e65100"],
  highlightDanger: ["#d75f5f", "#c62828"],
  disconnected: ["#ff8787", "#ef5350"],
  gitAdditions: ["#7db87a", "#659e62"],
  gitDeletions: ["#b87a7a", "#9e6262"],
});

/**
 * D2 — Text palette: body text, user bubble, help and menu text.
 * `text.selectionBg` falls back to `text.userBg` on light (resolved below).
 */
export const TEXT_PALETTE = pairTable({
  "text.primary": ["#eeeeee", "#1a1a1a"],
  "text.secondary": ["#a8a8a8", "#4a4a4a"],
  "text.muted": ["#767676", "#6b6b6b"],
  "text.userText": ["#D8D4D2", "#000000"],
  "text.userBg": ["#262626", "#e8e8e8"],
  "text.selectionBg": ["#303030", null],
  "text.userSymbol": ["#d75f00", "#d75f00"],
  "text.helpKey": ["#908a86", "#000000"],
  "text.helpLabel": ["#645e5a", "#8a8a8a"],
  "text.menuTitle": ["#eeeeee", "#000000"],
  "text.menuSectionHeader": ["#eeeeee", "#000000"],
  "text.modelMultiplier": ["#5f8787", "#8a8a8a"],
  "text.queuedSymbol": ["#a04800", "#c47a30"],
  "text.queuedText": ["#8a8a8a", "#6b6b6b"],
  "text.info": ["#afafff", "#0057a8"],
});

/** D3 — Diff palette: line kind, gutters and hunk headers. */
export const DIFF_PALETTE = pairTable({
  "diff.added": ["#5fff5f", "#2e7d32"],
  "diff.addedBg": ["#0a2e10", "#90c898"],
  "diff.addedWordBg": ["#1a5a22", "#60a868"],
  "diff.removed": ["#ff5f5f", "#c62828"],
  "diff.removedBg": ["#2e0a0a", "#e8b0b4"],
  "diff.removedWordBg": ["#5a1a1a", "#c87878"],
  "diff.border": ["#585858", "#b0b0b0"],
  "diff.lineNumber": ["#767676", "#8a8a8a"],
  "diff.header": ["#5fafd7", "#0057a8"],
  "diff.unchanged": ["#767676", "#8a8a8a"],
  "diff.dimUnchanged": ["#5f5f5f", "#b0b0b0"],
});

/** D4 — Markdown palette: inline emphasis, code, links and headings. */
export const MARKDOWN_PALETTE = pairTable({
  "markdown.bold": ["#bcbcbc", "#1a1a1a"],
  "markdown.italic": ["#bcbcbc", "#4a4a4a"],
  "markdown.code": ["#8a8a8a", "#5a5a5a"],
  "markdown.link": ["#af87af", "#0057a8"],
  "markdown.heading": ["#dadada", "#1a1a1a"],
  "markdown.blockquote": ["#8a8a8a", "#6b6b6b"],
  "markdown.strikethrough": ["#8a8a8a", "#8a8a8a"],
});

/**
 * D5 — Mission Control palette (todo icons and panels).
 * Light values are not published by the spec, so they inherit the dark pair.
 */
export const MISSION_CONTROL_PALETTE = pairTable({
  "mc.emphasis": ["#eeeeee", null],
  "mc.primary": ["#dadada", null],
  "mc.secondary": ["#8a8a8a", null],
  "mc.tertiary": ["#626262", null],
  "mc.ghost": ["#3a3a3a", null],
  "mc.dataValue": ["#9e9e9e", null],
  "mc.paused": ["#dadada", null],
  "mc.border": ["#4e4e4e", null],
  "mc.active": ["#ff5f00", null],
  "mc.done": ["#afaf5f", null],
  "mc.fail": ["#af5f5f", null],
  "mc.info": ["#626262", null],
  "mc.ref": ["#5f8787", null],
  "mc.worker": ["#878787", null],
  "mc.progress": ["#00d75f", null],
  "mc.barFillFrom": ["#ff5f00", null],
  "mc.barFillTo": ["#ff5f00", null],
  "mc.barEmpty": ["#585858", null],
  "mc.hlBg": ["#bcbcbc", null],
  "mc.hlFg": ["#080808", null],
  "mc.t2": ["#e4e4e4", null],
  "mc.t4": ["#bcbcbc", null],
  "mc.t6": ["#b2b2b2", null],
  "mc.t9": ["#808080", null],
  "mc.t12": ["#626262", null],
  "mc.ts": ["#626262", null],
  "mc.qb": ["#585858", null],
});

/**
 * D7 — Syntax highlighting palette (highlight.js token names).
 * Light values are not published by the spec, so they inherit the dark pair.
 */
export const SYNTAX_PALETTE = pairTable({
  "hljs.keyword": ["#afafff", null],
  "hljs.built_in": ["#5f8787", null],
  "hljs.type": ["#ffaf00", null],
  "hljs.literal": ["#ffaf00", null],
  "hljs.number": ["#ffaf00", null],
  "hljs.string": ["#00d75f", null],
  "hljs.doctag": ["#00d75f", null],
  "hljs.quote": ["#00d75f", null],
  "hljs.comment": ["#767676", null],
  "hljs.function": ["#5fafd7", null],
  "hljs.class": ["#5fafd7", null],
  "hljs.title": ["#5fafd7", null],
  "hljs.variable": ["#d75f5f", null],
  "hljs.attr": ["#d75f5f", null],
  "hljs.property": ["#5f8787", null],
  "hljs.tag": ["#d75f5f", null],
  "hljs.name": ["#d75f5f", null],
  "hljs.selector-tag": ["#d75f5f", null],
  "hljs.selector-class": ["#ffaf00", null],
  "hljs.selector-id": ["#ffaf00", null],
  "hljs.value": ["#00d75f", null],
  "hljs.params": ["#eeeeee", null],
  "hljs.meta": ["#767676", null],
  "hljs.regexp": ["#d75f5f", null],
  "hljs.operator": ["#eeeeee", null],
  "hljs.punctuation": ["#eeeeee", null],
  "hljs.symbol": ["#5f8787", null],
  "hljs.bullet": ["#5f8787", null],
  "hljs.link": ["#5fafd7", null],
  "hljs.emphasis": ["#eeeeee", null],
  "hljs.strong": ["#eeeeee", null],
  "hljs.section": ["#5fafd7", null],
  "hljs.addition": ["#00d75f", null],
  "hljs.deletion": ["#d75f5f", null],
  "hljs.subst": ["#eeeeee", null],
  "hljs.template-tag": ["#afafff", null],
  "hljs.template-variable": ["#d75f5f", null],
});

/**
 * D8 — Terminal ANSI palette written by the OSC 4 override, including the
 * foreground/background/cursor slots (OSC 10/11/12).
 */
export const ANSI_PALETTE = pairTable({
  "ansi.black": ["#1c1c1c", "#1a1a1a"],
  "ansi.red": ["#d75f5f", "#c62828"],
  "ansi.green": ["#00d75f", "#2e7d32"],
  "ansi.yellow": ["#ffaf00", "#e65100"],
  "ansi.blue": ["#5fafd7", "#0057a8"],
  "ansi.magenta": ["#afafff", "#7b1fa2"],
  "ansi.cyan": ["#5f8787", "#00695c"],
  "ansi.white": ["#dadada", "#f5f5f5"],
  "ansi.brightBlack": ["#767676", "#8a8a8a"],
  "ansi.brightRed": ["#ff5f5f", "#ef5350"],
  "ansi.brightGreen": ["#5fff5f", "#43a047"],
  "ansi.brightYellow": ["#ffd75f", "#ff9800"],
  "ansi.brightBlue": ["#87afd7", "#1e88e5"],
  "ansi.brightMagenta": ["#d7afff", "#ab47bc"],
  "ansi.brightCyan": ["#87d7d7", "#00897b"],
  "ansi.brightWhite": ["#eeeeee", "#ffffff"],
  "ansi.background": ["#1c1c1c", "#f5f5f5"],
  "ansi.foreground": ["#eeeeee", "#1a1a1a"],
  "ansi.cursor": ["#d75f00", "#d75f00"],
});

/** Every semantic colour slot name. */
export type PaletteSlot =
  | keyof typeof CORE_PALETTE.dark
  | keyof typeof TEXT_PALETTE.dark
  | keyof typeof DIFF_PALETTE.dark
  | keyof typeof MARKDOWN_PALETTE.dark
  | keyof typeof MISSION_CONTROL_PALETTE.dark
  | keyof typeof SYNTAX_PALETTE.dark
  | keyof typeof ANSI_PALETTE.dark;

/** The flat, theme-resolved palette every renderer reads (B17). */
function themePalette(theme: ThemeName): Readonly<Record<PaletteSlot, string>> {
  const side = theme === "factory-dark" ? "dark" : "light";
  return {
    ...CORE_PALETTE[side],
    ...TEXT_PALETTE[side],
    ...DIFF_PALETTE[side],
    ...MARKDOWN_PALETTE[side],
    ...MISSION_CONTROL_PALETTE[side],
    ...SYNTAX_PALETTE[side],
    ...ANSI_PALETTE[side],
    "text.selectionBg":
      side === "light"
        ? TEXT_PALETTE.light["text.userBg"]
        : TEXT_PALETTE.dark["text.selectionBg"],
  };
}

/** factory-dark resolved to one flat slot map. */
export const PALETTE_DARK: Readonly<Record<PaletteSlot, string>> =
  themePalette("factory-dark");

/** factory-light resolved to one flat slot map (unpublished slots inherit dark). */
export const PALETTE_LIGHT: Readonly<Record<PaletteSlot, string>> =
  themePalette("factory-light");

/** Resolve a theme name to its flat palette. */
export function paletteFor(
  theme: ThemeName,
): Readonly<Record<PaletteSlot, string>> {
  return theme === "factory-light" ? PALETTE_LIGHT : PALETTE_DARK;
}

/** Read a slot's literal hex for a theme, before capability degradation. */
export function themeColor(
  slot: PaletteSlot,
  theme: ThemeName = "factory-dark",
): string {
  return paletteFor(theme)[slot];
}

/** D12 — Glyph and icon set. `N` marks the counted notices. */
export const GLYPHS = {
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
} as const;

/** D10 — Spacing scale, in terminal cells. */
export const SPACING = {
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
} as const;

/** D11 — Borders and box characters. */
export const BORDERS = {
  round: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  markdownQuote: "│",
  markdownTableColumn: " │ ",
  markdownThematicBreak: "─",
  changelogDivider: "│",
  todoBorder: "│",
} as const;

/**
 * D11 — Mini logo (3 rows, 21 columns, `D R O I D` in the subject).
 * The letters are the parity-normalised program name; shape and width stay.
 */
export const LOGO_MINI_ROWS = [
  "╔═══════════════════╗",
  "║    D R O I D E    ║",
  "╚═══════════════════╝",
] as const;

/** D11 — Mini logo display width in columns. */
export const LOGO_MINI_WIDTH = 21;

/** D11 — Full logo height in rows. */
export const LOGO_FULL_HEIGHT = 6;

/**
 * D11 — Full logo (6 rows, block letters, 52 columns).
 * The subject spells its own name; the glyph shape and centring rule stay.
 */
export const LOGO_FULL_ROWS = [
  "██████   ██████   █████    ███████  ██████   ███████",
  "██   ██  ██   ██ ██   ██      █     ██   ██  ██     ",
  "██   ██  ██   ██ ██   ██      █     ██   ██  ██     ",
  "██   ██  ██████  ██   ██      █     ██   ██  █████  ",
  "██   ██  ██  ██  ██   ██      █     ██   ██  ██     ",
  "██████   ██   ██  █████    ███████  ██████   ███████",
] as const;

/** D12 — Shipped spinner presets, frame strings and their intervals. */
export const SPINNERS = {
  arrow: { frames: "←↖↑↗→↘↓↙", intervalMs: 100 },
  arc: { frames: "◜◠◝◞◡◟", intervalMs: 100 },
  balloon: { frames: ".oOo.", intervalMs: 120 },
  bounce: { frames: "⠁⠂⠄⡀⠄⠂", intervalMs: 120 },
  circleHalves: { frames: "◐◓◑◒", intervalMs: 50 },
  dots: { frames: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", intervalMs: 80 },
  dots2: { frames: "⣾⣽⣻⢿⡿⣟⣯⣷", intervalMs: 80 },
  speaker: { frames: "🔈🔉🔊🔉", intervalMs: 160 },
  squareCorners: { frames: "◰◳◲◱", intervalMs: 180 },
  toggle: { frames: "⊶⊷", intervalMs: 250 },
  triangle: { frames: "◢◣◤◥", intervalMs: 50 },
  weather: { frames: "☀️🌤⛅️🌥☁️🌧🌨⛈", intervalMs: 100 },
} as const;

/** D13 — Animation timings and input windows, in milliseconds. */
export const TIMINGS = {
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
} as const;

/** Nearest ANSI-16 colour for a hex value (chalk-compatible name). */
const ANSI16_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
] as const;

const ANSI16_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

function parseHex(hex: string): readonly [number, number, number] {
  const value = hex.replace(/^#/u, "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return [red, green, blue];
}

function distanceSquared(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return red * red + green * green + blue * blue;
}

/** xterm's 256-colour cube for indices 16–231. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function ansi256Rgb(index: number): readonly [number, number, number] {
  if (index < 16) {
    return ANSI16_RGB[index] ?? [0, 0, 0];
  }
  if (index < 232) {
    const offset = index - 16;
    const red = CUBE_LEVELS[Math.floor(offset / 36)] ?? 0;
    const green = CUBE_LEVELS[Math.floor((offset % 36) / 6)] ?? 0;
    const blue = CUBE_LEVELS[offset % 6] ?? 0;
    return [red, green, blue];
  }
  const level = 8 + (index - 232) * 10;
  return [level, level, level];
}

/** Nearest xterm-256 index. The exact slot is chalk's own conversion (B18). */
export function nearestAnsi256(hex: string): number {
  const target = parseHex(hex);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 256; index += 1) {
    const distance = distanceSquared(target, ansi256Rgb(index));
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Nearest ANSI-16 colour name. The exact slot is chalk's own conversion (B18). */
export function nearestAnsi16(hex: string): (typeof ANSI16_NAMES)[number] {
  const target = parseHex(hex);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ANSI16_RGB.length; index += 1) {
    const rgb = ANSI16_RGB[index] ?? [0, 0, 0];
    const distance = distanceSquared(target, rgb);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return ANSI16_NAMES[best] ?? "white";
}

/**
 * Resolve a palette slot to a value Ink can render, degrading through the
 * documented ladder: truecolour hex → xterm-256 → ANSI-16 name → nothing.
 * Returning `undefined` is the "no colour" terminal: no SGR is written.
 */
export function resolveColor(
  slot: PaletteSlot,
  capabilities: ColorCapabilities,
): string | undefined {
  const hex = themeColor(slot, capabilities.theme);
  switch (capabilities.colorDepth) {
    case "truecolor":
      return hex;
    case "256":
      return `ansi256(${nearestAnsi256(hex)})`;
    case "16":
      return nearestAnsi16(hex);
    case "none":
      return undefined;
  }
}

/** Foreground props for `<Text>`, or nothing when the terminal takes no colour. */
export function foreground(
  slot: PaletteSlot,
  capabilities: ColorCapabilities,
): { readonly color: string } | Record<string, never> {
  const color = resolveColor(slot, capabilities);
  return color === undefined ? {} : { color };
}

/** Background props for `<Text>`/`<Box>`, or nothing without colour. */
export function background(
  slot: PaletteSlot,
  capabilities: ColorCapabilities,
): { readonly backgroundColor: string } | Record<string, never> {
  const color = resolveColor(slot, capabilities);
  return color === undefined ? {} : { backgroundColor: color };
}
