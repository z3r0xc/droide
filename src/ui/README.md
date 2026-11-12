# src/ui — terminal UI

React + Ink (`docs/adr/0006`), rendered from `specs/95-terminal-ui.md`.
Components are `.ts` files using `createElement` because Node's type stripping
runs `.ts` but not `.tsx`; there is no build step.

## Token model

`tokens.ts` transcribes D1–D13 as `readonly` data: seven theme tables (`CORE`,
`TEXT`, `DIFF`, `MARKDOWN`, `MISSION_CONTROL`, `SYNTAX`, `ANSI`), the D6 badge
slot order, and `GLYPHS`, `SPACING`, `BORDERS`, the logo rows, `SPINNERS` and
`TIMINGS`. The tables compose into `PALETTE_DARK` / `PALETTE_LIGHT`; components
never declare a colour or glyph literal, and pass slots through
`foreground()` / `background()`. D5 and D7 publish no light values, so those
slots inherit dark.

## Capability ladder

`capabilities.ts` maps an injected environment (never `process.env`) to a
`Capabilities` record: `colorDepth` (`truecolor → 256 → 16 → none`), `theme`,
`interactive`, `style`, `hyperlinks`, a `probes` plan, `columns`/`rows` and
`platform`. The ladder follows B18: `NO_COLOR`, `FORCE_COLOR`, `CI`, a non-TTY
or Windows suppress probes; `TERM=dumb` writes no hyperlinks and no colour.
`resolveColor(slot, caps)` applies the ladder, ending at `undefined` so no SGR
is emitted. The exact ANSI-16 slot per token is chalk's conversion, still Open
question 3; we use nearest RGB.

## Frames

`render.ts` mounts `Shell` on an injected `stdout` and resolves after the first
flushed frame. Tests use the harness in `tests/unit/ui/harness.ts`: a fake
writable plus `debug: true`, so Ink appends whole frames instead of repainting.
A frame is one chunk with SGR/OSC stripped and trailing spaces removed. Goldens
live in `tests/unit/ui/frames/`; re-record deliberately with
`UI_RECORD_FRAMES=1 node --test "tests/unit/ui/*.test.ts"`. Every mount is
unmounted in `finally`, and the frame tests render twice to prove determinism.

## Dispatch contract

`src/app/interactive.ts` is the only module that starts the surface:

- `canRunInteractive({ stdin, stdout })` is true only when both streams report
  `isTTY` (`specs/10-cli-surface.md` §B16, `specs/95-terminal-ui.md` §B18).
- `launchInteractive(context, streams)` is the production launcher;
  `runInteractiveShell(options)` is the session. Size, capabilities, clock,
  timers, the signal source and the mount are options: the module never reads
  `process`.
- `src/cli/commands/root.ts` dispatches through `DefaultCommandRuntime`. The
  production runtime reads `process` exactly once and loads this module with a
  dynamic `import()` only on a terminal launch, so `--help`, `--version`, the
  refusal and every subcommand never pay for React and Ink (a static import
  costs seconds of startup).
- With no prompt and a TTY pair the shell runs, and its result becomes the
  process's exit code. A prompt (which the shell cannot receive until the agent
  loop lands), half a TTY pair, or a terminal the capability ladder rejects
  (`TERM=dumb`) keeps the loud unfinished-mode exit 64. A prompt with a non-TTY
  stdin keeps the byte-identical refusal (exit 1) before any configuration is
  read.

## Lifecycle

`setup.ts` enters the terminal and returns a one-shot `teardown`. Entry writes
each enabling sequence once (B1); teardown writes the matching disabling
sequence in reverse and restores raw mode, and is safe to call from every path.
`runInteractiveShell` first removes its stdin/resize listeners and clears both
timers (the lone-ESC window and a deferred paste submit), then awaits the last
paint, unmounts Ink, and finally tears the terminal down. Ink's unmount restores
its own cursor; the shell's teardown restores what the shell turned on.

The safety net (`exit`, `uncaughtException`, `SIGINT`, `SIGTERM`) removes itself
and restores the terminal; it never selects the exit code. The shell maps a
signal to a code: `SIGINT` → 130, `SIGTERM` → 143, `/quit` → 0. A signal that
lands before the close path exists is remembered, not dropped. If mounting
throws after entry, the failure path tears the terminal down before the
rejection escapes. `tests/integration/ui/interactive.test.ts` asserts the exact
write list for the throwing-mount path, one disabling write per mode on quit and
on each signal, raw mode `[true, false]`, and no listener, timer or signal hook
left behind.

Deferred to later slices: the static/dynamic split and live-tail budget (B4),
the remaining renderers (R3, R6, R8–R13), markdown, the status banner (B12), the
full footer (B13), theme switching and OSC (B17), probe execution, sanitisation
(B20) and animation (B21).
