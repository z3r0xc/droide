/**
 * Terminal capability detection (spec B18).
 *
 * The surface never reads `process.env` itself: the caller injects the
 * environment, platform and TTY flags, exactly as `src/config/` injects its
 * own environment. Probing is represented as a *plan* — this module does not
 * write to the terminal, so it stays deterministic and testable.
 */

import type { ColorDepth, ThemeName } from "./tokens.ts";

/** Everything the detector may look at. No hidden process access. */
export interface CapabilityEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

/** Which probes the interactive bootstrap may write (B18). */
export interface ProbePlan {
  /** The 24-bit colour probe (`ESC[48;2;1;2;3m` + DECRQSS). */
  readonly trueColor: boolean;
  /** The OSC 11 background-appearance probe. */
  readonly appearance: boolean;
}

/** The resolved rendering capabilities every component reads. */
export interface Capabilities {
  readonly colorDepth: ColorDepth;
  readonly theme: ThemeName;
  readonly interactive: boolean;
  readonly style: boolean;
  readonly hyperlinks: boolean;
  readonly probes: ProbePlan;
  readonly columns: number;
  readonly rows: number;
  readonly platform: "windows" | "posix";
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

function parseDimension(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `FORCE_COLOR` follows chalk's own vocabulary (B18). */
function forcedDepth(value: string): ColorDepth {
  switch (value) {
    case "0":
    case "false":
      return "none";
    case "2":
      return "256";
    case "3":
      return "truecolor";
    default:
      return "16";
  }
}

/** `COLORFGBG` last field → appearance (B18). */
export function parseColorFgBg(value: string | undefined): ThemeName {
  if (value === undefined) return "factory-dark";
  const fields = value.split(";");
  const last = fields[fields.length - 1]?.trim();
  if (last === "default" || last === "7" || last === "15") {
    return "factory-light";
  }
  return "factory-dark";
}

/**
 * Resolve colour depth and probe policy.
 *
 * The probe policy is deliberately conservative: `NO_COLOR`, `CI`, a non-TTY,
 * Windows, a dumb terminal, and `FORCE_COLOR` each suppress the probes in the
 * combinations B18 pins. A 256-colour or better resolved terminal needs no
 * probe at all.
 */
export function detectCapabilities(input: CapabilityEnvironment): Capabilities {
  const env = input.env;
  const term = env.TERM ?? "";
  const dumb = term === "dumb";
  const windows = input.platform === "win32";
  const tty = input.stdinIsTTY && input.stdoutIsTTY;
  const ci = env.CI !== undefined && env.CI !== "false";
  const noColor = env.NO_COLOR !== undefined;
  const forceColor = env.FORCE_COLOR;

  const colorDepth: ColorDepth = (() => {
    if (forceColor !== undefined) return forcedDepth(forceColor);
    if (dumb || !tty || noColor) return "none";
    const colorTerm = (env.COLORTERM ?? "").toLowerCase();
    if (
      colorTerm === "truecolor" ||
      colorTerm === "24bit" ||
      term.includes("truecolor") ||
      term.includes("24bit")
    ) {
      return "truecolor";
    }
    // Windows short-circuits the 24-bit probe (B18); assume ANSI-16 unless the
    // terminal advertises 256 colours in TERM.
    if (windows) return term.includes("256") ? "256" : "16";
    return term.includes("256") ? "256" : "16";
  })();

  const probesTrueColor =
    tty &&
    !dumb &&
    !windows &&
    !ci &&
    !noColor &&
    forceColor === undefined &&
    colorDepth === "16";

  const probesAppearance =
    tty &&
    !dumb &&
    !windows &&
    !ci &&
    !noColor &&
    forceColor !== "0" &&
    colorDepth === "16";

  return {
    colorDepth,
    // The appearance probe would refine this asynchronously; the surface starts
    // from the documented COLORFGBG fallback (B18). Probing is a later slice.
    theme: parseColorFgBg(env.COLORFGBG),
    interactive: tty && !dumb,
    style: colorDepth !== "none" && !dumb,
    hyperlinks: !dumb,
    probes: { trueColor: probesTrueColor, appearance: probesAppearance },
    columns: parseDimension(env.COLUMNS, DEFAULT_COLUMNS),
    rows: parseDimension(env.LINES, DEFAULT_ROWS),
    platform: windows ? "windows" : "posix",
  };
}