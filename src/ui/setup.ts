/**
 * Terminal lifecycle for the interactive surface (spec B1, B18).
 *
 * Entering the TUI turns on exactly the modes the capability plan allows and
 * writes each enabling sequence once; `teardown()` writes the matching
 * disabling sequence for everything that was actually turned on, in reverse
 * order, and does so exactly once no matter how many exit paths race into it.
 * Nothing is written when stdout is not a TTY, so piping the CLI stays byte
 * clean.
 *
 * The safety net (`exit`, SIGINT/SIGTERM, an uncaught error) restores the
 * terminal only; it never decides the process's exit code. Signal handling is
 * injectable so tests drive it without touching the real process.
 */

import type { Capabilities } from "./capabilities.ts";

/** The sequences of B1, verbatim. */
export const TERMINAL_SEQUENCES = {
  alternateScreenOn: "\u001b[?1049h",
  alternateScreenOff: "\u001b[?1049l",
  focusOn: "\u001b[?1004h",
  focusOff: "\u001b[?1004l",
  bracketedPasteOn: "\u001b[?2004h",
  bracketedPasteOff: "\u001b[?2004l",
  colorSchemeOn: "\u001b[?2031h",
  colorSchemeOff: "\u001b[?2031l",
  mouseOn: "\u001b[?1000h\u001b[?1002h\u001b[?1006h",
  mouseOff: "\u001b[?1000l\u001b[?1002l\u001b[?1006l",
  tmuxExtendedKeysOn: "\u001b[>4;1m",
  tmuxExtendedKeysOff: "\u001b[>4;0m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
} as const;

/** What this launch is allowed to switch on. */
export interface TerminalPlan {
  /** `stdin.setRawMode(true)` on entry. */
  readonly raw: boolean;
  readonly alternateScreen: boolean;
  readonly focus: boolean;
  readonly bracketedPaste: boolean;
  readonly colorScheme: boolean;
  /** `on` enables reporting, `off` writes the off-sequences, `skip` writes nothing. */
  readonly mouse: "on" | "off" | "skip";
  readonly tmuxExtendedKeys: boolean;
  readonly hideCursor: boolean;
}

export interface TerminalPlanOptions {
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  /** `TMUX` or `STY` is set. */
  readonly tmux: boolean;
  /** A surface that wants mouse events is open (none in this vertical). */
  readonly ownsMouse?: boolean;
  /** Defaults to true; the alternate screen is where the TUI paints. */
  readonly alternateScreen?: boolean;
}

/**
 * Resolve the plan (B1, B18). A non-interactive capability record, or a
 * non-TTY, yields a plan that writes and changes nothing.
 */
export function planTerminal(
  capabilities: Capabilities,
  options: TerminalPlanOptions,
): TerminalPlan {
  const active = capabilities.interactive && options.stdoutIsTTY;
  if (!active) {
    return {
      raw: false,
      alternateScreen: false,
      focus: false,
      bracketedPaste: false,
      colorScheme: false,
      mouse: "skip",
      tmuxExtendedKeys: false,
      hideCursor: false,
    };
  }
  return {
    raw: options.stdinIsTTY,
    alternateScreen: options.alternateScreen ?? true,
    focus: true,
    bracketedPaste: true,
    colorScheme: true,
    mouse: options.ownsMouse === true ? "on" : "off",
    tmuxExtendedKeys: options.tmux,
    hideCursor: true,
  };
}

/** The process-level hooks the safety net needs. */
export interface SignalSource {
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
}

export type TerminationSignal = "SIGINT" | "SIGTERM";

export interface TerminalSetupOptions {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly plan: TerminalPlan;
  /** Defaults to the real process; tests pass a fake. */
  readonly signals?: SignalSource;
  /** Install the exit/signal/uncaught-error safety net. Default true. */
  readonly installSafetyNet?: boolean;
  /** Called after the terminal is restored because of a signal. */
  readonly onSignal?: (signal: TerminationSignal) => void;
}

/** A live terminal session. `teardown` is safe to call at any time, any number of times. */
export interface TerminalSession {
  readonly plan: TerminalPlan;
  readonly active: boolean;
  teardown: () => void;
}

interface ModePair {
  readonly on: string;
  readonly off: string;
}

function modesOf(plan: TerminalPlan): readonly ModePair[] {
  const pairs: ModePair[] = [];
  if (plan.alternateScreen) {
    pairs.push({
      on: TERMINAL_SEQUENCES.alternateScreenOn,
      off: TERMINAL_SEQUENCES.alternateScreenOff,
    });
  }
  if (plan.focus) {
    pairs.push({
      on: TERMINAL_SEQUENCES.focusOn,
      off: TERMINAL_SEQUENCES.focusOff,
    });
  }
  if (plan.bracketedPaste) {
    pairs.push({
      on: TERMINAL_SEQUENCES.bracketedPasteOn,
      off: TERMINAL_SEQUENCES.bracketedPasteOff,
    });
  }
  if (plan.colorScheme) {
    pairs.push({
      on: TERMINAL_SEQUENCES.colorSchemeOn,
      off: TERMINAL_SEQUENCES.colorSchemeOff,
    });
  }
  if (plan.mouse === "on") {
    pairs.push({
      on: TERMINAL_SEQUENCES.mouseOn,
      off: TERMINAL_SEQUENCES.mouseOff,
    });
  } else if (plan.mouse === "off") {
    // Nothing is turned on; the off-sequences merely assert that no surface
    // owns the mouse. They are written on entry and never "restored".
    pairs.push({
      on: TERMINAL_SEQUENCES.mouseOff,
      off: "",
    });
  }
  if (plan.tmuxExtendedKeys) {
    pairs.push({
      on: TERMINAL_SEQUENCES.tmuxExtendedKeysOn,
      off: TERMINAL_SEQUENCES.tmuxExtendedKeysOff,
    });
  }
  if (plan.hideCursor) {
    pairs.push({
      on: TERMINAL_SEQUENCES.hideCursor,
      off: TERMINAL_SEQUENCES.showCursor,
    });
  }
  return pairs;
}

/** The real process, adapted to the two methods the safety net needs. */
export function processSignals(): SignalSource {
  return {
    on(event, listener) {
      process.on(event, listener);
    },
    off(event, listener) {
      process.off(event, listener);
    },
  };
}

const SIGNALS: readonly TerminationSignal[] = ["SIGINT", "SIGTERM"];

/** Enter the interactive terminal and return its one-shot teardown. */
export function setupTerminal(options: TerminalSetupOptions): TerminalSession {
  const { stdin, stdout, plan } = options;
  const signals: SignalSource =
    options.signals ??
    (options.installSafetyNet === false ? nullSignalSource : processSignals());
  const safetyNet = options.installSafetyNet !== false;
  const modes = modesOf(plan);

  let torndown = false;
  const teardown = (): void => {
    if (torndown) return;
    torndown = true;
    if (safetyNet) removeSafetyNet();
    for (let index = modes.length - 1; index >= 0; index -= 1) {
      const off = modes[index]?.off ?? "";
      if (off.length > 0) stdout.write(off);
    }
    if (plan.raw) stdin.setRawMode(false);
  };

  const onSignal = (signal: TerminationSignal): void => {
    teardown();
    options.onSignal?.(signal);
  };
  const onExit = (): void => teardown();
  const onUncaught = (): void => teardown();
  const handlers: ReadonlyArray<readonly [string, () => void]> = safetyNet
    ? [
        ["exit", onExit],
        ["uncaughtException", onUncaught],
        ...SIGNALS.map((signal): readonly [string, () => void] => [
          signal,
          () => onSignal(signal),
        ]),
      ]
    : [];

  function removeSafetyNet(): void {
    for (const [event, handler] of handlers) signals.off(event, handler);
  }

  if (safetyNet) {
    for (const [event, handler] of handlers) signals.on(event, handler);
  }

  if (plan.raw) stdin.setRawMode(true);
  for (const mode of modes) stdout.write(mode.on);

  return { plan, active: modes.length > 0 || plan.raw, teardown };
}

const nullSignalSource: SignalSource = {
  on() {
    // Nothing to hook when the safety net is off.
  },
  off() {
    // Nothing to unhook.
  },
};
