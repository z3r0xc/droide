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

Deferred to later slices: the static/dynamic split and live-tail budget (B4),
the remaining renderers (R3, R6, R8–R13), markdown, keys and paste (B15, B16),
the status banner (B12), the full footer (B13), theme switching and OSC (B17),
probe execution, sanitisation (B20) and animation (B21).