/**
 * Startup animation (spec 95 B22): the frame sequence is computed from the
 * logo, never loaded, and the decision to play is a pure function of settings,
 * environment and terminal. No test waits on a clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOOT_FADE_MS,
  BOOT_FRAME_MS,
  REVEAL_COLUMNS_PER_FRAME,
  FADE_STEPS,
  bootFrames,
  fadeCharacter,
  fadeFrame,
  playBootAnimation,
  resolveBootAnimation,
  revealFrame,
  shimmerFrame,
} from "../../../src/ui/boot.ts";

const LOGO = ["███ ██", "█   █ ", "███ ██"];

test("the reveal uncovers the logo from the left and blank space stays blank", () => {
  assert.deepEqual(revealFrame(LOGO, 0), ["      ", "      ", "      "]);
  assert.deepEqual(revealFrame(LOGO, 4), ["███   ", "█     ", "███   "]);
  assert.deepEqual(revealFrame(LOGO, 99), LOGO);
});

test("the shimmer paints a diagonal band and leaves gaps alone", () => {
  const first = shimmerFrame(["████", "████", "████"], 0);
  assert.deepEqual(first, ["░░░░", "░░░░", "░░░░"]);

  // The band trails one column per row: at offset 4 only the first row keeps
  // a block, and the last two rows are behind the band.
  const later = shimmerFrame(["████", "████", "████"], 4);
  assert.deepEqual(later, ["████", "███░", "██░░"]);
  // A space is never painted.
  assert.deepEqual(shimmerFrame(["█ ██"], 0), ["░ ░░"]);
});

test("the fade walks the density ladder and ends in spaces", () => {
  assert.equal(fadeCharacter("█", 0), "█");
  assert.equal(fadeCharacter("█", 1), "▓");
  assert.equal(fadeCharacter("█", 2), "▒");
  assert.equal(fadeCharacter("█", 3), "░");
  assert.equal(fadeCharacter("█", 4), " ");
  assert.equal(fadeCharacter("█", 9), " ");
  assert.equal(fadeCharacter("x", 1), ".");
  assert.deepEqual(fadeFrame(["█ "], 1), ["▓ "]);
});

test("the sequence reveals, holds, shimmers and fades in that order", () => {
  // A logo wide enough to need more than one reveal step.
  const wide = ["█".repeat(30), "█".repeat(30), "█".repeat(30)];
  const frames = bootFrames(wide, 40);

  // The first frame is a partial sweep, not the whole logo.
  assert.equal(frames[0]?.rows[0]?.trim().length, REVEAL_COLUMNS_PER_FRAME);
  // The last reveal frame is the whole logo, followed by the two blank holds.
  const wholeIndex = frames.findIndex(
    (frame) => frame.rows[0]?.trim().length === 30,
  );
  assert.ok(wholeIndex > 0);
  assert.equal(frames[wholeIndex + 1]?.rows[0], "");
  assert.equal(frames[wholeIndex + 2]?.rows[0], "");
  // Then the shimmer, whose first row mixes blocks and the band.
  assert.match(frames[wholeIndex + 3]?.rows[0] ?? "", /░/u);

  // The last frame is fully faded, and the fade steps are the slow ones.
  const last = frames.at(-1);
  assert.ok(last !== undefined);
  assert.equal(
    last.rows.every((row) => row.trim() === ""),
    true,
  );
  assert.equal(last.holdMs, BOOT_FADE_MS);
  assert.equal(
    frames.filter((frame) => frame.holdMs === BOOT_FADE_MS).length,
    FADE_STEPS,
  );
});

test("every frame is centred and no wider than the terminal", () => {
  for (const frame of bootFrames(LOGO, 20)) {
    for (const row of frame.rows) {
      assert.ok(row.length <= 20, `row ${JSON.stringify(row)}`);
    }
  }
  // Centring: the logo is 6 wide, so (20 - 6) / 2 = 7 leading spaces.
  const whole = bootFrames(LOGO, 20).find((frame) =>
    frame.rows.some((row) => row.includes("███ ██")),
  );
  assert.equal(whole?.rows[0], "       ███ ██");
});

test("playing writes one frame per step, hides and restores the cursor once", async () => {
  const writes: string[] = [];
  const sleeps: number[] = [];
  const frames = bootFrames(LOGO, 20);
  await playBootAnimation(
    {
      write: (text) => writes.push(text),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    frames,
  );

  assert.equal(sleeps.length, frames.length);
  assert.equal(writes[0]?.includes("\u001b[?25l"), true);
  assert.equal(writes.at(-1), "\u001b[?25h");
  assert.equal(
    writes.filter((text) => text.startsWith("\u001b[H")).length,
    frames.length,
  );
});

test("an interrupted sequence still restores the cursor", async () => {
  const writes: string[] = [];
  await assert.rejects(
    playBootAnimation(
      {
        write: (text) => writes.push(text),
        sleep: () => Promise.reject(new Error("interrupted")),
      },
      bootFrames(LOGO, 20),
    ),
    /interrupted/,
  );
  assert.equal(writes.at(-1), "\u001b[?25h");
});

function decision(
  overrides: Partial<Parameters<typeof resolveBootAnimation>[0]>,
) {
  return resolveBootAnimation({
    setting: undefined,
    env: {},
    interactive: true,
    columns: 80,
    miniLogoWidth: 21,
    markerPresent: false,
    ...overrides,
  });
}

test("the decision names the first reason that stops the animation", () => {
  assert.deepEqual(decision({ setting: "off" }), {
    enabled: false,
    reason: "logoAnimation is off",
  });
  assert.equal(decision({ env: { DROIDE_NO_ANIMATION: "1" } }).enabled, false);
  assert.equal(
    decision({ env: { DROIDE_NO_ANIMATION: "TRUE" } }).enabled,
    false,
  );
  assert.equal(decision({ env: { CI: "true" } }).enabled, false);
  assert.equal(decision({ interactive: false }).enabled, false);
  assert.equal(decision({ columns: 10 }).enabled, false);
});

test("once plays until the marker exists; always ignores the marker", () => {
  assert.deepEqual(decision({}), { enabled: true, markShown: true });
  assert.deepEqual(decision({ setting: "once" }), {
    enabled: true,
    markShown: true,
  });
  assert.deepEqual(decision({ markerPresent: true }), {
    enabled: false,
    reason: "the animation was already shown",
  });
  assert.deepEqual(decision({ setting: "always", markerPresent: true }), {
    enabled: true,
    markShown: false,
  });
  assert.equal(decision({ setting: "ALWAYS" }).enabled, true);
  assert.equal(decision({ setting: "nonsense" }).enabled, true);
});

test("a frame is centred vertically when the terminal height is known", () => {
  const frames = bootFrames(LOGO, 40, 20);
  const first = frames[0];
  assert.ok(first !== undefined);
  // 20 rows - 3 logo rows = 17 free, so 8 blank rows lead the frame.
  assert.equal(
    first.rows.slice(0, 8).every((row) => row === ""),
    true,
  );
  assert.equal(first.rows[8]?.includes("█"), true);
  assert.equal(frames[0]?.rows.length, 8 + 3);
});
