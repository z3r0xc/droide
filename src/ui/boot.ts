/**
 * Startup animation (spec 95 B22): the block-letter logo revealed, shimmered
 * and faded before the shell paints.
 *
 * The frames are computed from the logo rows, so there is no asset to keep in
 * step with the product name. Nothing here reads a clock: a caller supplies the
 * timer seam, and a test runs the whole sequence synchronously.
 */

import { TERMINAL_SEQUENCES } from "./setup.ts";
import { displayWidth } from "./text.ts";

/** How the reveal uncovers the logo: one frame per this many columns. */
export const REVEAL_COLUMNS_PER_FRAME = 12;

/** Frames held still between the reveal and the shimmer. */
export const HOLD_FRAMES = 2;

/** Columns the band advances per shimmer frame. */
export const SHIMMER_STEP_COLUMNS = 3;

/** Columns the shimmer band occupies at any one frame. */
export const SHIMMER_BAND_COLUMNS = 6;

/** How many density steps the fade walks before the logo is gone. */
export const FADE_STEPS = 4;

/** Milliseconds per reveal or shimmer frame. */
export const BOOT_FRAME_MS = 35;

/** Milliseconds per fade step. */
export const BOOT_FADE_MS = 120;

/** The density ladder, densest first. A missing entry fades to a space. */
const FADE_LADDER: Readonly<Record<string, readonly string[]>> = {
  "█": ["▓", "▒", "░", " "],
  "▐": ["#", "*", ".", " "],
  "▓": ["▒", "░", " ", " "],
  "▒": ["░", " ", " ", " "],
  "░": [" ", " ", " ", " "],
  "#": ["*", ".", " ", " "],
  "*": [".", " ", " ", " "],
  ".": [" ", " ", " ", " "],
};

const DEFAULT_FADE: readonly string[] = [".", " ", " ", " "];

/** One frame of the animation, already padded and centred. */
export interface BootFrame {
  /** The rows to write, each exactly `columns` wide or shorter when it cannot be. */
  readonly rows: readonly string[];
  /** How long this frame is held, in milliseconds. */
  readonly holdMs: number;
}

/**
 * Fade one character by `level` steps along the density ladder. `level` 0 is
 * the frame as drawn; a level past the ladder's end is a space.
 */
export function fadeCharacter(char: string, level: number): string {
  if (level <= 0) return char;
  const ladder = FADE_LADDER[char] ?? DEFAULT_FADE;
  const index = Math.min(level - 1, ladder.length - 1);
  return ladder[index] ?? " ";
}

/** Fade every glyph of a frame; whitespace is untouched. */
export function fadeFrame(
  rows: readonly string[],
  level: number,
): readonly string[] {
  if (level <= 0) return rows;
  return rows.map((row) =>
    Array.from(row, (char) =>
      char === " " ? char : fadeCharacter(char, level),
    ).join(""),
  );
}

/**
 * The logo uncovered up to `columns` display columns: a cell appears once its
 * column has been reached, so the sweep reads left to right.
 */
export function revealFrame(
  rows: readonly string[],
  columns: number,
): readonly string[] {
  const limit = Math.max(0, columns);
  return rows.map((row) =>
    Array.from(row, (char, index) => (index < limit ? char : " ")).join(""),
  );
}

/** A diagonal band of `░` crossing the logo at `offset`. */
export function shimmerFrame(
  rows: readonly string[],
  offset: number,
): readonly string[] {
  return rows.map((row, rowIndex) =>
    Array.from(row, (char, index) => {
      if (char === " ") return char;
      const bandStart = offset - rowIndex;
      const inBand =
        index >= bandStart && index < bandStart + SHIMMER_BAND_COLUMNS;
      return inBand ? "░" : char;
    }).join(""),
  );
}

/** Blank rows that put a frame of `height` rows in the middle of `rows`. */
function topPadding(
  height: number,
  rows: number | undefined,
): readonly string[] {
  if (rows === undefined) return [];
  const free = rows - height;
  if (free <= 0) return [];
  return Array.from({ length: Math.floor(free / 2) }, () => "");
}

/** Centre one row in `columns`, padding both sides; never truncates a glyph row. */
function centreRow(row: string, columns: number): string {
  const width = displayWidth(row);
  if (width >= columns) return row;
  const left = Math.floor((columns - width) / 2);
  return `${" ".repeat(left)}${row}`;
}

/** Centre a whole frame and drop the trailing spaces of each row. */
function centreFrame(
  rows: readonly string[],
  columns: number,
): readonly string[] {
  return rows.map((row) => centreRow(row, columns).replace(/\s+$/u, ""));
}

/**
 * Build the whole sequence for one terminal width. Reveal first, then two held
 * frames, the shimmer sweep (advancing two columns per frame), and the four fade
 * steps: about 1.4 s for the 52-column logo.
 */
export function bootFrames(
  logo: readonly string[],
  columns: number,
  rows?: number,
): readonly BootFrame[] {
  const width = logo.reduce((widest, row) => Math.max(widest, row.length), 0);
  const frames: BootFrame[] = [];
  const centre = (rowsOf: readonly string[]): readonly string[] => [
    ...topPadding(rowsOf.length, rows),
    ...centreFrame(rowsOf, columns),
  ];

  for (
    let reached = REVEAL_COLUMNS_PER_FRAME;
    reached < width;
    reached += REVEAL_COLUMNS_PER_FRAME
  ) {
    frames.push({
      rows: centre(revealFrame(logo, reached)),
      holdMs: BOOT_FRAME_MS,
    });
  }
  frames.push({ rows: centre(logo), holdMs: BOOT_FRAME_MS });

  const logoWidth = logo.reduce(
    (widest, row) => Math.max(widest, row.length),
    0,
  );
  const blankRows = logo.map(() => " ".repeat(logoWidth));
  for (let held = 0; held < HOLD_FRAMES; held += 1) {
    frames.push({
      rows: centreFrame(blankRows, columns),
      holdMs: BOOT_FRAME_MS,
    });
  }

  for (
    let offset = -logo.length;
    offset <= width;
    offset += SHIMMER_STEP_COLUMNS
  ) {
    frames.push({
      rows: centre(shimmerFrame(logo, offset)),
      holdMs: BOOT_FRAME_MS,
    });
  }

  for (let level = 1; level <= FADE_STEPS; level += 1) {
    frames.push({
      rows: centre(fadeFrame(logo, level)),
      holdMs: BOOT_FADE_MS,
    });
  }

  return frames;
}

/** What the animation needs from the process to draw itself. */
export interface BootAnimationIo {
  readonly write: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Play the sequence: clear, hide the cursor, one write per frame at the home
 * position, then the cursor back. The caller has already decided to play.
 */
export async function playBootAnimation(
  io: BootAnimationIo,
  frames: readonly BootFrame[],
): Promise<void> {
  if (frames.length === 0) return;
  io.write(`\u001b[2J\u001b[H${TERMINAL_SEQUENCES.hideCursor}`);
  try {
    for (const frame of frames) {
      io.write(`\u001b[H${frame.rows.join("\r\n")}\u001b[0J`);
      await io.sleep(frame.holdMs);
    }
  } finally {
    io.write(TERMINAL_SEQUENCES.showCursor);
  }
}

/** Everything the decision depends on, so a test can vary one input at a time. */
export interface BootAnimationInput {
  readonly setting: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interactive: boolean;
  readonly columns: number;
  readonly miniLogoWidth: number;
  readonly markerPresent: boolean;
}

export type BootAnimationDecision =
  | { readonly enabled: true; readonly markShown: boolean }
  | { readonly enabled: false; readonly reason: string };

/**
 * Decide whether this launch plays the animation (B22). The first reason found
 * wins, so the report says exactly why a launch stayed still.
 */
export function resolveBootAnimation(
  input: BootAnimationInput,
): BootAnimationDecision {
  const value = input.setting?.trim().toLowerCase();
  if (value === "off")
    return { enabled: false, reason: "logoAnimation is off" };
  const env = input.env;
  const noAnimation = env["DROIDE_NO_ANIMATION"]?.trim().toLowerCase();
  if (noAnimation === "1" || noAnimation === "true")
    return { enabled: false, reason: "DROIDE_NO_ANIMATION is set" };
  if (env["CI"] !== undefined && env["CI"] !== "")
    return { enabled: false, reason: "CI is set" };
  if (!input.interactive)
    return { enabled: false, reason: "stdout is not an interactive terminal" };
  if (input.columns < input.miniLogoWidth)
    return { enabled: false, reason: "the terminal is narrower than the logo" };

  if (value === "always") return { enabled: true, markShown: false };
  if (input.markerPresent)
    return { enabled: false, reason: "the animation was already shown" };
  return { enabled: true, markShown: true };
}
