# Terminal UI (interactive TUI)

- **Target:** Factory AI `droid` 1.9.0
- **Status:** draft
- **Owner:** terminal-UI slice
- **Related:** `specs/00-context.md`, `specs/10-cli-surface.md` (mode selection, exit codes),
  `specs/80-exec-and-streaming.md` (what streams into the transcript),
  `specs/40-sessions-and-storage.md` (persisted message shapes),
  `docs/adr/0005-project-name-and-parity-normalisation.md` (program name is the only
  permitted difference; everything else here is parity-normalised)

## Purpose

The interactive terminal UI is the full-screen, alternate terminal surface a user reaches by
launching the CLI with no subcommand. It renders a scrolling transcript of the conversation, a
single-line composer, a status banner, a footer of hints and a configurable status line, and it
owns every keypress while it is mounted. This spec is a **visual and interaction contract**: a
developer must be able to rebuild the surface one-to-one — same rows, same colours, same glyphs,
same spacing, same keys, same user-visible English — from this document and its citations.

## Scope

Covers: the in-session TUI only — screen regions, design tokens, transcript item renderers,
composer, key bindings, paste handling, terminal capability degradation, theme resolution and
rendering-side acceptance tests.

Does **not** cover:

- which command starts the TUI, `--resume`/`--continue` selection, or exit codes → `specs/10-cli-surface.md`
- the daemon/session protocol that produces messages → `specs/80-exec-and-streaming.md`, `specs/40-sessions-and-storage.md`
- the Mission Control, Droids View, Workstream Control and plugin/marketplace full-screen
  surfaces. They are listed only as region owners the composer can be handed to (B2).
- native rendering (Kitty graphics, SVG→PNG rasterisation internals) beyond the tokens they consume.
- non-English locales. English strings are normative here because the parity harness runs with
  `LANG`/`locale` at English; the locale table (`en, it, ja, zh-CN, ko`) is data, not layout
  `[src/i18n/index.ts:1-30]`, `[packages/i18n/src/constants.ts:8-14]`.

Deliberately deferred: the settings/menu pickers (`/model`, `/settings`, …) render through the same
menu primitives as B10 and are specified by their own slices; where they matter for layout this
spec pins only the primitive (`MenuContainer`, `SelectableList`).

## Terms

| Term | Meaning |
|---|---|
| **frame** | The ordered list of rendered lines (rows) produced by one Ink render pass, without trailing space padding. Golden tests compare frames. |
| **row / column** | One terminal cell row / one terminal cell column. All widths are display columns (East-Asian wide = 2), never UTF-16 units. |
| **transcript** | The scrolling history region above the composer. |
| **composer** | The message input region: prompt, wrapped draft lines, hint row. |
| **item** | One renderable unit of the transcript (a user message, an assistant text block, a tool call, …). |
| **tool row** | The multi-line block a single tool invocation renders to. |
| **static region** | Items already committed to terminal scrollback via Ink's `<Static>`; they never repaint. |
| **dynamic region** | Items still live (streaming, or awaiting a decision); they repaint every frame. |
| **COLORS** | The process-wide active palette object, a proxy over the resolved theme `[src/components/chat/themedColors.ts:1-12]`. |
| **OSC palette override** | Writing `ESC ] 4;n;#rrggbb BEL` etc. so the terminal's own ANSI 0–15 slots take the theme's colours `[src/theme/ThemeEngine.ts:403-441]`. |
| **marker** | The one-column bold glyph that starts a transcript row (`⛬`, `>`, `●`). |
| **clamp** | Truncation at a display-width boundary, by grapheme cluster, never mid-cluster. |

## Observable behaviour

### B1 — Screen entry and exit

1. On an interactive launch the process sets raw mode, then enables, in this order: focus
   reporting (`ESC[?1004h`), bracketed paste (`ESC[?2004h`), colour-scheme reporting
   (`ESC[?2031h`), mouse reporting (`ESC[?1000h ESC[?1002h ESC[?1006h`, or the off-sequences when
   no surface owns the mouse), tmux extended keys (`ESC[>4;1m`, only when `TMUX` is set), and
   hides the cursor (`ESC[?25l`) `[src/utils/interactiveTerminalState.ts:88-118]`.
2. Every sequence the process turned on is turned off symmetrically on exit; the alternate screen
   is only left with `ESC[?1049l` when the process entered it, because on the main screen that
   sequence also restores the cursor and can move the shell prompt `[src/utils/interactiveTerminalState.ts:120-160]`.
3. While the theme is allowed to override terminal colours, the palette is restored on exit, and a
   `process.once('exit')` safety net writes the reset even on an abrupt exit `[src/theme/ThemeEngine.ts:443-470]`.
4. If the TUI is suspended (external editor), it renders nothing until resumed
   `[src/app.tsx:10166-10168]`.

### B2 — Region order

A frame is, top to bottom: **header (once)** → **transcript** → **input-area stack** →
**footer**. The input-area stack, in order, is: pinned Todo panel, compaction status, pending
queued-message list, mission intro, agent status banner (or a blank spacer row), the
mode/autonomy + model row, organisation/compliance banner, model-blocked notices, migration
status row, the composer (or the active pane), mission roster line, background-tasks panel, a
footer banner, the footer hint row, and finally the configurable status line
`[src/app.tsx:10644-10660]`, `[src/app.tsx:10690-10700]`, `[src/app.tsx:10720-10735]`,
`[src/app.tsx:10866-10880]`, `[src/app.tsx:10900-10912]`, `[src/app.tsx:10957-10970]`.

The transcript region is `width = terminal width`, and message content is laid out at
`contentWidth = max(1, terminalWidth - 6)` `[src/app.tsx:2216-2219]`. The composer is
`width = terminal width` `[src/app.tsx:2218]`.

### B3 — Header

The header paints once, inside the static region, and never repaints
`[src/components/Header.tsx:1-35]`. Its rows are laid out on a grid of `leftColWidth` columns
(`width` when the changelog column is hidden, else `floor(width * 0.55)`)
`[src/components/HeaderFrame.ts:396-397]`.

Row budget: `logoLines + 2 + (dev?1:0) + (version?2:0) + 5`
`[src/components/HeaderFrame.ts:407-408]`, with:

- `marginTop = 2`, `marginBottom = 1` normally; **both 0 when `height <= 24`**
  (`COMPACT_HEADER_MAX_HEIGHT = 24`) `[src/components/HeaderFrame.ts:61-63]`, `[src/components/HeaderFrame.ts:583-587]`.
- logo = the 6-row block-letter `DROID_HEADER_LOGO` when `!isHeightCompact && leftColWidth >= 58`,
  else the 3-row `DROID_HEADER_LOGO_MINI` `[src/components/HeaderFrame.ts:399-402]`,
  `[src/components/chat/constants.ts:153-166]`.
- logo is horizontally centred in `leftColWidth`; the `[DEV]` tag, version, tip, two shortcut
  lines and the status line are centred **under the logo** (`logoCol + floor((logoWidth-w)/2)`)
  `[src/components/HeaderFrame.ts:409-420]`.
- `[DEV]` (colour `asciiArt`, bold) only on non-production builds `[src/components/HeaderFrame.ts:422-426]`.
- version row: `v<cliVersion>` in `text.secondary` bold; airflow mode appends a suffix
  `[src/components/HeaderFrame.ts:428-429]`.
- tip row: `TIP: <tooltip>` where the tooltip is drawn uniformly at random from
  `HEADER_TOOLTIPS` with `FACTORY_ROUTER_TOOLTIP` weighted 3× and Missions tips withheld when
  Missions are hidden; clamped with a trailing `…` at `leftColWidth - 4`
  `[src/components/HeaderFrame.ts:60-80]`, `[src/components/HeaderFrame.ts:455-463]`,
  `[src/components/chat/constants.ts:168-215]`.
- two shortcut rows, then the status row: `Skills (N) ✓  MCPs (N) ✓  Connectors (N) ✓  AGENTS.md ✓`
  with `✓` in `statusActive`, `✗` in `error`, a 2-column gap between items, overflow wrapping to
  the row above and clipping after two rows `[src/components/HeaderFrame.ts:470-560]`.
- when `width >= 100` and a changelog is cached, a right column of width `width - leftColWidth`
  is drawn, separated by a single `│` in `asciiArt` `[src/components/HeaderFrame.ts:566-582]`.

Exact short-form row strings for the English build:

| Row | Text (literal) | Source |
|---|---|---|
| dev | `[DEV]` | `[src/components/HeaderFrame.ts:423]` |
| version | `v1.9.0` | `[src/components/HeaderFrame.ts:429]` |
| tip prefix | `TIP: ` | `en:header.tip` |
| shortcuts 1 | `shift+tab to cycle modes · ctrl+N to cycle models` | `en:header.shortcutsLine1` |
| shortcuts 2 | `ctrl+L for autonomy · tab for reasoning` | `en:header.shortcutsLine2` |
| status labels | `Skills`, `MCPs`, `Connectors`, `AGENTS.md` | `en:header.*Label` |

### B4 — Transcript commit model

Items are split into static (committed) and dynamic (live) lists; static items are emitted through
Ink `<Static>` and never re-render, dynamic items repaint each frame
`[src/components/StaticMessageList.tsx:19-42]`, `[src/components/DynamicMessageList.tsx:120-127]`.

While an answer streams, the dynamic tail is clipped to a bottom-anchored window: cap =
`min(10 rows, terminalHeight - inputRegionRows)` with a floor of 2 rows, and one row of the cap is
given to a header `---- N more lines hidden ----` (singular: `line hidden`)
`[src/components/chat/viewportBudget.ts:60-70]`, `[src/components/DynamicMessageList.tsx:60-115]`,
`en:streamingTail.hiddenLines`.

### B5 — Message renderers

Each item type renders as specified in **Transcript item renderers** below. Row-leading marker
colours and glyphs are normative; the general rule is: marker column = 1 cell, gap = 1.5 cells,
content width = `contentWidth` `[src/components/MessageItem.tsx:520-560]`.

### B6 — Tool rows

A tool row is: header line, optional preview, optional result block. Left margin is 3 columns;
inner content is a further 1 column `[src/components/tools/ToolDisplayShell.tsx:99-150]`.
Header content width is `max(20, contentWidth - 3)` `[src/components/tools/ToolDisplayShell.tsx:93-96]`.
While the tool runs, its name shimmers (per-character colour lerp toward `#e6e6e6`, 1000 ms cycle,
500 ms in fast mode) `[src/components/tools/ToolHeader.tsx:34-90]`.

Aborted invocations whose result is a user cancellation render the single line
`⎿ Interrupted` in `text.muted` instead of a result body, except for `Task` and `StartMissionRun`
`[src/components/tools/ToolDisplayShell.tsx:104-131]`.

### B7 — Text results

A text result prints `↳ ` then the text: markdown when the whole result fits and is markdown, plain
in `text.muted` otherwise, and in `error` colour when the call failed
`[src/components/tools/implementations/DefaultTool.tsx:141-165]`.

Preview caps: 4 lines / 1024 chars; the detailed view caps at 200 lines / 16 KiB
`[src/components/tools/implementations/DefaultTool.tsx:22-28]`. Truncation notices:
`... N more lines, press Ctrl+O to expand` (preview) and `↳ showing first S/T lines` (detailed)
`[src/components/tools/implementations/DefaultTool.tsx:56-120]`, `en:toolDisplay.moreLines`,
`en:toolDisplay.showingFirst`.

### B8 — Diffs

A diff row is a 10-column line-number gutter (4 right-aligned old + 1 space + 4 right-aligned new
+ 1 space of margin) followed by one space of indent then the content; added lines use
`diff.added` on `diff.addedBg`, removed `diff.removed` on `diff.removedBg`, unchanged
`diff.unchanged`/`diff.dimUnchanged`, and the "unchanged lines" separator prints as its own
dimmed row with one blank row above and below
`[src/components/DiffRenderer.tsx:195-220]`, `[src/components/DiffRenderer.tsx:436-475]`,
`[src/components/DiffRenderer.tsx:494-518]`. Inline diffs are capped at 20 lines and 500 rows in
the detailed transcript `[src/components/chat/constants.ts:15-25]`. With no hunks the block prints
`No changes` `en:diff.noChanges` `[src/components/DiffRenderer.tsx:630-640]`.

### B9 — Todos

The pinned Todo panel sits directly above the status banner. It prints `Plan · C/T`, then a
left-only bold border column, then one row per visible todo `Plan`, `C` completed of `T` total
`[src/components/PinnedTodoDisplay.tsx:78-108]`. Each todo row is `<icon> <content>` with
`✓` completed (struck through, icon in `mc.done`), `●` in progress (`text.primary`), `○` pending
(`text.muted`) `[src/components/TodoItem.tsx:1-48]`. Content is tail-truncated to `width - 4`
columns; the window is anchored on the last completed row (else the in-progress row, else the
first), and overflow prints `... N more, Alt/Option+P to view all`
`[src/components/PinnedTodoDisplay.tsx:40-76]`, `en:pinnedTodo.moreItemsHint`. The panel is hidden
when there are no todos or all are complete `[src/components/PinnedTodoDisplay.tsx:70-72]`.

### B10 — Composer

The composer renders, top to bottom: image-attachment chips (if any), the input frame, one
optional hint row, one optional vim-mode row `[src/components/chat/ChatInput.tsx:1510-1525]`,
`[src/components/chat/ChatInput.tsx:1527-1540]`.

The frame is mode-dependent:

- **Windows-like** (`process.platform === 'win32'`, and WSL as Windows-like): **no border**;
  `paddingX = 1`, `paddingY = 1` `[src/components/chat/viewportBudget.ts:113-133]`,
  `[src/utils/isWsl.ts:1-30]`.
- **Otherwise**: Ink `round` border in `COLORS.border`, dimmed while the composer is unfocused,
  `paddingX = 1`, `paddingY = 0` `[src/components/chat/ChatInput.tsx:1550-1575]`.
- **Spec/Mission mode (non-Windows)**: the top border is custom-drawn by
  `buildModeBorderText` — `╭── <label> · <title> ` then `─` fill then `╮`, degrading to `╭╮` at
  width 2 and `╭` at width 1, and dropping the ` · <title>` segment when it does not fit
  `[src/components/chat/ChatInput.tsx:156-177]`. The mode colour is `spec` (spec), `agi` (mission),
  `missionV2` (workstreams) `[src/components/chat/ChatInput.tsx:1399-1412]`.
- **Windows + named mode**: the mode label is printed on the first padding row as
  `<label> · <title>` `[src/components/chat/ChatInput.tsx:1420-1428]`.

Prompt symbols: first row `> ` (`primary`), bash mode ` ! ` (`success`), bash executing ` ⏳ `,
continuation rows two spaces, spec mode `> ` `[src/components/chat/ChatInput.tsx:110-116]`,
`[src/components/chat/ChatInput.tsx:405-425]`.

Placeholder precedence (first match wins): bash executing → `Executing command...`; session running
and not bash → `Enter to steer · Ctrl+Enter to queue`; Mission 2.0 → `Message the workstream lead`
/ `Message this agent`; not the first message → empty; spec mode → `Droid will research and plan
before making changes`; mission mode → `Mission control for huge projects`; else the startup
placeholder `Try "…"` chosen uniformly from 13 prompts
`[src/components/chat/ChatInput.tsx:240-290]`, `en:chatInput.*`, `en:placeholders.prompt0..12`.
Placeholder and unfocused text render dimmed `[src/components/chat/ChatInput.tsx:395-410]`.

The hint row (exactly one row) is chosen in descending priority: editor guidance → steer hint →
editor overflow hint `Ctrl+P to open in editor`, joined by ` · ` only while it fits
`[src/components/chat/ChatInput.tsx:176-238]`. It is indented 2 columns and truncated at the end
`[src/components/chat/ChatInput.tsx:1510-1516]`.

Visible draft rows: `max(1, viewportRows - 2)` where `viewportRows = max(3, min(terminalHeight - 8 -
2 - siblings, floor(terminalHeight * 0.33 if active else 0.9)))`
`[src/components/chat/viewportBudget.ts:1-40]`, `[src/components/chat/viewportBudget.ts:180-230]`.
When the draft is taller than the window, the first/last visible rows show `↑ N more` / `↓ N more`
in dim grey, each occupying one row, and the window follows the cursor
`[src/components/chat/ChatInput.tsx:1482-1499]`, `en:chatInput.moreAbove`, `en:chatInput.moreBelow`.

### B11 — Suggestions

File suggestions (`@`) render in a rounded, `border`-coloured box with 1 column of horizontal
padding, up to 6 rows, the selected row prefixed `> ` in `primary` and bold, others indented two
spaces; filename and path are separated by two spaces with the path in `text.muted`; a help line
two columns further left than the box's left edge, in `text.muted`, reads
`Use  to navigate, Tab/Enter to select, Esc to cancel` and appends ` • Showing S-E of T` when
paged `[src/components/SelectableList.tsx:55-140]`, `en:chatInput.navigationHint`,
`en:selectableList.showing`.

Command suggestions (`/`) render flush under the composer, indented 1 column, at most 6 rows
including one loading row and one notice row; each row is ` /<name>` (leading space) padded to the
longest visible command name plus `minPadding`, then the description in `text.muted`; unfiltered
menus group by section header (`text.menuSectionHeader`) and filtered menus right-align a source
column `[src/components/chat/CommandSuggestions.tsx:200-318]`, `[src/components/chat/constants.ts:46]`.

### B12 — Status banner

While the agent is not idle, one row above the mode/model row shows a spinner and a status text in
`primary` plus a hint in `text.muted` dim: `(Press ESC to stop)`, or `(Please wait)` while a
rewind/interrupt/new-session runs. The row is `paddingLeft 1`, `marginTop 1`, `marginBottom 1`;
when idle a single blank row is reserved in its place so the composer never jumps
`[src/app.tsx:10271-10285]`, `[src/utils/statusBannerHint.ts:1-30]`, `[src/app.tsx:10690-10695]`.

Status texts (literal, note the surrounding spaces in the source): `Thinking...`,
`Streaming...`, `Invoking tools...`, `Executing...`, `Waiting for tool confirmation...`,
`Compressing history...`, `Rewinding conversation...`, `Cancelling tools...`, `Starting new
session...`, `Planning N actions` / `Planning`, `Reviewing changes...`, `Pending confirmation...`
`[src/utils/tuiSpinner/status.ts:20-120]`. Spinner interval is fixed at 60 ms and the default
preset is `DotsClockwise`, except where a status pins its own preset
`[src/utils/tuiSpinner/status.ts:10-19]`.

### B13 — Footer

The footer is one row: left block then right block, separated by at least one space
`[src/components/FooterStatusRow.tsx:846-876]`. Left block = timer `[⏱ <duration>, context: N%]`
(when enabled) → pending-question count `N question set pending · /answer` → primary label →
side-chat tag → droids hint → next-loop summary, joined by ` | `; the first hint is separated by a
single space when there is no pending-question segment. Right block = archived indicator → pull
request / branch → `SANDBOX` → MCP → IDE. On Windows-like terminals the "right" block is appended
to the left block instead, separated by ` | ` `[src/components/FooterStatusRow.tsx:740-790]`,
`[src/components/FooterStatusRow.tsx:820-846]`. Hints shed their longest form first, then
themselves, until the row fits beside the statuses; statuses then truncate `[src/components/FooterStatusRow.tsx:712-740]`.

Primary label = config-issue count → update notice → `? for help`
`[src/components/FooterStatusRow.tsx:409-470]`, `en:footer.showHelp`. Timer format is
`⏱ 1m 05s` / `0s` from `formatDurationCompact`, and `context: 42%` from
`computeContextPercentage` `[src/components/FooterStatusRow.tsx:380-406]`, `en:assistantTimer.contextLabel`.

The footer is suppressed entirely while the command menu is open
`[src/app.tsx:10905-10908]`.

### B14 — Status line

When a `statusLine` command is configured, an extra region renders below the footer: at most
`maxRows` (1–3, default 1) rows, each wrapped to `width - 2*padding`, padded left and right by
`padding` (default 0), dimmed, with SGR preserved and middle truncation
`[src/components/StatusLine.tsx:130-201]`. With no configuration, or no output, the region takes no
rows `[src/components/StatusLine.tsx:130-133]`.

### B15 — Key bindings

Bindings are exactly those in the **Key bindings** table. Three sequencing rules are part of the
contract:

1. A lone `ESC` waits up to 400 ms for the rest of a sequence before counting as Escape; a run of
   ESCs flushes 150 ms after its first ESC, with a 650 ms tmux transport grace and a 20 ms
   grace-flush cap; an incomplete CSI closes 250 ms after its last byte
   `[src/keyboard/constants.ts:8-22]`.
2. Escape counting: 1 press = the `onEscape` action; 2 presses = clear a non-empty draft; 3+
   presses = restore the cleared draft and open the rewind menu. Without tmux the counter resets
   200 ms after the last press; under tmux it resolves 700 ms after the last press
   `[src/hooks/useChatKeyboardInput.ts:1138-1180]`, `[src/hooks/repeatedKeySequence.ts:1-20]`,
   `[src/hooks/constants.ts:155]`.
3. `Ctrl+C` never exits on the first press: it clears the draft/suggestions, then prints the
   ephemeral system message `Press Ctrl+C again to exit.` and arms a 2000 ms window; a second
   `Ctrl+C` inside the window exits. While a confirmation is open, `Ctrl+C` confirms it instead
   `[src/app.tsx:2463-2546]`, `en:process.ctrlCToExit`.

### B16 — Paste

A pasted chunk is sanitised (ANSI stripped, C0 controls except `\t`/`\n` removed) and inserted at
the cursor `[src/hooks/useChatKeyboardInput.ts:240-250]`.

If the paste is longer than **400 characters** or has more than **8 lines**, it is replaced by a
placeholder `[<first 50 chars, newlines/tabs → space, trimmed>... <N> lines]`, where `N` is the
number of *visual* rows at the composer width (raw line count when width is unknown); a second
identical paste gets `, paste <k>` appended; the full original text is kept for submission
`[src/hooks/useChatKeyboardInput.ts:1000-1045]`, `[src/hooks/useChatKeyboardInput.ts:520-540]`.
`Alt+Shift+V` expands placeholders back to their text in the draft
`[src/hooks/useChatKeyboardInput.ts:2423-2432]`, `en:chatInput` has no string for this (the chord is
documented in `keyboardChords.pasteExpansion`).

For 100 ms after a paste, an `Enter` is treated as the paste's own trailing newline: dropped for an
unframed paste, deferred to the end of the window for a bracketed (framed) paste
`[src/components/chat/constants.ts:48-58]`, `[src/hooks/useChatKeyboardInput.ts:2480-2490]`.

`Ctrl+V`/`Cmd+V` first tries an image from the clipboard; a pasted image path is attached as an
image instead of text `[src/hooks/useChatKeyboardInput.ts:145-190]`. Attachments render as chips
`[Image N]` with `[x]` in `error` and a hint `Press Ctrl+D to remove all`
`[src/components/chat/ImageAttachment.tsx:40-130]`, `en:imageAttachment.*`.

### B17 — Colour resolution

Every themed component reads `COLORS.<slot>` at render time (never a module-level constant), so a
theme switch repaints the whole surface `[src/components/chat/themedColors.ts:1-12]`,
`[src/theme/themeColorState.ts:1-30]`.

The active theme is `factory-dark` or `factory-light`, or `auto` resolved from the detected terminal
appearance (light background → light theme), or a user theme from `~/.factory/themes/*.json`
validated by a Zod schema (`name`, `appearance`, `colors` required)
`[src/theme/ThemeEngine.ts:265-300]`, `[src/theme/themeLoader.ts:1-40]`.

The terminal's ANSI palette is overridden via OSC only when the `overrideTerminalColors` setting is
on, writing `ESC]10;fg`, `ESC]11;bg`, `ESC]12;cursor`, then `ESC]4;i;#hex` for indices 0–15 in the
fixed order black, red, green, yellow, blue, magenta, cyan, white, brightBlack … brightWhite
`[src/theme/ThemeEngine.ts:33-50]`, `[src/theme/ThemeEngine.ts:403-441]`.

### B18 — Terminal capability degradation

| Condition | Effect |
|---|---|
| `NO_COLOR` set | colour-probing is skipped (no truecolour probe, no OSC 11 appearance probe); theme falls back to `COLORFGBG`, else dark `[src/utils/trueColorDetector/index.ts:78-86]`, `[src/utils/terminalAppearanceDetector/index.ts:56-66]` |
| `FORCE_COLOR` set to any value | truecolour probe skipped — the user's own choice wins `[src/utils/trueColorDetector/index.ts:78-86]` |
| `FORCE_COLOR=0` | OSC 11 appearance probe skipped `[src/utils/terminalAppearanceDetector/index.ts:56-66]` |
| `CI` set and not `false` | both probes skipped `[src/utils/trueColorDetector/index.ts:78-86]`, `[src/utils/terminalAppearanceDetector/index.ts:56-66]` |
| not a TTY (stdin or stdout) | truecolour probe returns false; appearance falls back to `COLORFGBG`; the raw early-input shell is not started `[src/utils/trueColorDetector/index.ts:170-186]`, `[src/utils/terminalAppearanceDetector/index.ts:196-215]`, `[src/entrypoints/tui/bootstrap.ts:312-320]` |
| `process.platform === 'win32'` | truecolour probe short-circuits to false and appearance uses `COLORFGBG` only — legacy ConHost and most remote channels drop DCS/OSC replies `[src/utils/trueColorDetector/index.ts:175-181]`, `[src/utils/terminalAppearanceDetector/index.ts:188-196]` |
| chalk level ≥ 2 | no probe and no forcing (256-colour approximations are accepted as visually fine) `[src/utils/trueColorDetector/index.ts:196-206]` |
| 16-colour terminal | palette is emitted as hex; chalk down-converts to the nearest ANSI-16 slot. The exact slot per token is chalk's conversion, not ours → Open question 3 `[src/theme/themes/factory-dark.ts:6-12]` |
| `TERM=dumb` | OSC 8 hyperlinks are not written `[src/utils/hyperlinks.ts:100-112]` |

`COLORFGBG` parsing: last field `default` → light; `7`/`15` → light; `0`/`8` → dark; anything else →
unknown → dark `[src/utils/terminalAppearanceDetector/index.ts:40-58]`. The truecolour probe writes
`ESC[48;2;1;2;3m` plus a DECRQSS SGR query (`ESC P$qm ESC\`) and accepts a reply containing the
sentinel in either `48;2;1;2;3` or `48:2::1:2:3` form, within 500 ms
`[src/utils/trueColorDetector/index.ts:15-35]`. The appearance probe writes OSC 11 within 500 ms
`[src/utils/terminalAppearanceDetector/index.ts:16-30]`. When the terminal provably supports 24-bit
colour but chalk resolved to ≤16, the app forces `FORCE_COLOR=3` and chalk level 3, then restores
the previous value immediately after the TUI module is imported so children do not inherit it
`[src/utils/trueColorDetector/index.ts:196-236]`.

### B19 — Resize

Widths and heights come from `useTerminalDimensions()` and are used per frame; there is no separate
resize event handling in components `[src/components/Header.tsx:15-25]`. The contract:

- content is re-wrapped at the new width; message text reflows, it is never clipped horizontally
  (`wrap="wrap"` on text bodies) `[src/components/MessageItem.tsx:455-500]`;
- the header is static and does **not** reflow — after a resize the committed header keeps its old
  width until the session is redrawn `[src/components/Header.tsx:1-35]`, `[src/app.tsx:10170-10175]`;
- the composer's visible-row budget, the diff/suggestion reserves, and the footer fitting algorithm
  all recompute from the new size (`resolveChatInputMaxVisibleRows`, `fitHelpSegments`)
  `[src/components/chat/viewportBudget.ts:180-230]`, `[src/components/common/StyledHelpText.tsx:20-45]`;
- a frame that fills the terminal must be avoided (it triggers Ink's scrollback-erasing repaint),
  which is why the live tail and input region carry explicit row budgets
  `[src/components/chat/viewportBudget.ts:30-55]`, `[src/components/DynamicMessageList.tsx:28-58]`.

### B20 — Text hygiene

All externally sourced text (model output, tool output, MCP names, mission titles, user paste) passes
through `sanitizeTerminalDisplayText` before rendering: control characters are dropped, and SGR is
stripped unless explicitly preserved `[src/utils/terminalSegments.ts:30-51]`. Widths are computed with
grapheme clusters and East-Asian width, so a double-width glyph occupies two columns
`[src/utils/terminalSegments.ts:75-105]`.

### B21 — Animation clock and spinners

All animation reads one shared 125 ms clock tick; spinners derive their frame from
`floor(tick / intervalMs)` and accept an offset so simultaneous spinners are desynchronised
`[src/utils/constants.ts:207]`, `[src/components/Spinner.tsx:1-38]`. Default preset frames
(`Dots`, 80 ms): `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` `[src/utils/tuiSpinner/constants.ts:70-73]`. Fast mode halves every
interval `[src/components/Spinner.tsx:22-30]`.

## Data & config

### Settings that change the surface

| Setting | Key | Effect | Source |
|---|---|---|---|
| theme | `general.theme` | `factory-dark` (default), `factory-light`, `auto`, or a user theme name | `[src/theme/applyThemeChange.ts:1-20]`, `[src/theme/ThemeEngine.ts:265-300]` |
| terminal override | `overrideTerminalColors` (bool) | enables OSC 4/10/11/12 palette writes | `[src/theme/applyThemeChange.ts:5-14]` |
| thinking in main view | `getShowThinkingInMainView()` | shows reasoning blocks in the transcript | `[src/app.tsx:10185]` |
| todo display mode | `getTodoDisplayMode()` | `Pinned` renders the panel above the composer | `[src/app.tsx:10648-10652]` |
| token usage indicator | `getShowTokenUsageIndicator()` | adds `context: N%` to the footer timer | `[src/components/FooterStatusRow.tsx:388-392]` |
| nerd font | `getNerdFont()` | prefixes the branch label with `` | `[src/components/FooterStatusRow.tsx:505-515]` |
| vim mode | `getVimMode()` | enables NORMAL/INSERT and the vim row | `[src/hooks/useChatKeyboardInput.ts:1990-2000]` |
| status line | `getStatusLine()` → `{command, padding, maxRows}` | renders the status-line region | `[src/components/StatusLine.tsx:130-160]` |
| fast mode | `useIsFastMode()` | halves spinner and shimmer periods | `[src/components/Spinner.tsx:22-30]` |

### Environment variables read by the surface

| Variable | Meaning | Source |
|---|---|---|
| `NO_COLOR`, `FORCE_COLOR`, `CI` | colour probing policy (B18) | `[src/utils/trueColorDetector/index.ts:78-86]` |
| `DROID_DISABLE_TRUECOLOR_PROBE` | force-off truecolour probing | `[src/utils/trueColorDetector/index.ts:78-86]` |
| `COLORFGBG` | appearance fallback | `[src/utils/terminalAppearanceDetector/index.ts:40-58]` |
| `TMUX` / `STY` | multiplexer; extended keys, 700 ms escape resolution, `TERM`-independent paste framing | `[src/utils/interactiveTerminalState.ts:26-34]`, `[src/hooks/repeatedKeySequence.ts:8-14]` |
| `TERM` | `dumb` disables hyperlinks | `[src/utils/hyperlinks.ts:100-112]` |
| `FACTORY_E2E_CLOCK_FILE` | pins the clock for deterministic timer/footer output | `[src/utils/e2eClock.ts:1-40]` |
| `FACTORY_DISABLE_EARLY_INPUT_SHELL`, `DROID_FORCE_BLOCKING_UPDATE` | opt out of the raw early-input shell | `[src/entrypoints/tui/bootstrap.ts:312-320]` |

### User theme file

`~/.factory/themes/<name>.json` (or `~/.factory-dev/themes/`), max 1 MiB per file, max 64 files;
`{ name, appearance: "dark"|"light", colors: {...} }`, unknown palette sections passed through,
invalid files skipped with a deferred warning `[src/theme/themeLoader.ts:1-45]`.

## Design tokens

All colour values below are literal. Semantic slot → dark hex → light hex. Where the dark theme
carries an ANSI-256 index comment, it is reproduced; the light theme does not use 256-safe values.

### D1 — Core palette

| Slot | Dark | Light | Role |
|---|---|---|---|
| `primary` | `#d75f00` (166) | `#d75f00` | brand orange: prompt, assistant marker, spinner, "question set pending" |
| `border` | `#878787` (102) | `#b0b0b0` | composer/menu borders |
| `success` | `#afaf5f` (41) | `#2e7d32` | bash prompt, menu selection |
| `error` | `#d75f5f` (167) | `#c62828` | failed tool text, `✗` status, remove buttons |
| `warning` | `#ffaf00` (214) | `#e65100` | warnings, `SANDBOX`, risk badges |
| `spec` | `#afafff` (147) | `#0057a8` | spec-mode accents |
| `agi` | `#afaf5f` | `#2e7d32` | mission-mode accents |
| `missionV2` | `terminal.ansi.blue` → `#5fafd7` | `#0057a8` | workstream accents (fallback when unset) |
| `btw` | `#8fb9c9` | `#3d7a92` | `/btw` side-chat tag |
| `asciiArt` | `#d75f00` | `#d75f00` | `[DEV]` tag, changelog divider |
| `headerLogo` | `#eeeeee` (255) | `#000000` | DROID logo |
| `toolName` | `#d7875f` (173) | `#b35900` | tool header name |
| `toolParam` | `#b2b2b2` (249) | `#5a5a5a` | tool header params, counts |
| `hookBadgeBg` / `hookBadgeFg` | `#af87ff` / `#000000` | `#7b1fa2` / `#ffffff` | hook badge |
| `toolBadgeBg` / `toolBadgeFg` | `#FEB17F` / `#000000` | `#ff9800` / `#000000` | subagent badge slot 0 |
| `statusActive` | `#00ff00` | `#00c853` | header `✓` |
| `highlight` | `#d78700` (172) | `#e65100` | menu option selection |
| `highlightDanger` | `#d75f5f` (167) | `#c62828` | destructive option, sandbox label |
| `disconnected` | `#ff8787` (210) | `#ef5350` | disconnected state |
| `gitAdditions` | `#7db87a` | `#659e62` | `+N` counts |
| `gitDeletions` | `#b87a7a` | `#9e6262` | `-N` counts |

Sources: `[src/theme/themes/factory-dark.ts:16-62]`, `[src/theme/themes/factory-light.ts:16-62]`.

### D2 — Text palette

| Slot | Dark | Light | Role |
|---|---|---|---|
| `text.primary` | `#eeeeee` (255) | `#1a1a1a` | default body text, model label |
| `text.secondary` | `#a8a8a8` (248) | `#4a4a4a` | header dim text, secondary status |
| `text.muted` | `#767676` (243) | `#6b6b6b` | hints, placeholders, result text, `↳` |
| `text.userText` | `#D8D4D2` | `#000000` | user message text |
| `text.userBg` | `#262626` (235) | `#e8e8e8` | user message background |
| `text.selectionBg` | `#303030` (236) | falls back to `userBg` | selected list row |
| `text.userSymbol` | `#d75f00` (166) | `#d75f00` | user message left bar |
| `text.helpKey` | `#908a86` | `#000000` | help-bar keys (bold) |
| `text.helpLabel` | `#645e5a` | `#8a8a8a` | help-bar labels |
| `text.menuTitle` / `menuSectionHeader` | `#eeeeee` | `#000000` | menu titles, section headers |
| `text.modelMultiplier` | `#5f8787` | `#8a8a8a` | `(1.5x)` multiplier |
| `text.queuedSymbol` / `queuedText` | `#a04800` / `#8a8a8a` | `#c47a30` / `#6b6b6b` | queued message bar/text |
| `text.info` | `#afafff` (from `spec`) | `#0057a8` | markdown table header; image chip border |

Sources: `[src/theme/themes/factory-dark.ts:63-92]`, `[src/theme/themes/factory-light.ts:62-88]`,
fallback chain `[src/theme/themeColorState.ts:32-48]`.

### D3 — Diff palette

| Slot | Dark | Light |
|---|---|---|
| `diff.added` | `#5fff5f` (83) | `#2e7d32` |
| `diff.addedBg` | `#0a2e10` | `#90c898` |
| `diff.addedWordBg` | `#1a5a22` | `#60a868` |
| `diff.removed` | `#ff5f5f` (203) | `#c62828` |
| `diff.removedBg` | `#2e0a0a` | `#e8b0b4` |
| `diff.removedWordBg` | `#5a1a1a` | `#c87878` |
| `diff.border` | `#585858` (240) | `#b0b0b0` |
| `diff.lineNumber` | `#767676` (243) | `#8a8a8a` |
| `diff.header` | `#5fafd7` (74) | `#0057a8` |
| `diff.unchanged` | `#767676` (243) | `#8a8a8a` |
| `diff.dimUnchanged` | `#5f5f5f` (59) | `#b0b0b0` |

Sources: `[src/theme/themes/factory-dark.ts:93-116]`, `[src/theme/themes/factory-light.ts:90-113]`.

### D4 — Markdown palette

| Slot | Dark | Light |
|---|---|---|
| `markdown.bold` | `#bcbcbc` (250) | `#1a1a1a` |
| `markdown.italic` | `#bcbcbc` (250) | `#4a4a4a` |
| `markdown.code` | `#8a8a8a` (245) | `#5a5a5a` |
| `markdown.link` | `#af87af` (139) | `#0057a8` |
| `markdown.heading` | `#dadada` (253) | `#1a1a1a` |
| `markdown.blockquote` | `#8a8a8a` (245) | `#6b6b6b` |
| `markdown.strikethrough` | `#8a8a8a` (245) | `#8a8a8a` |

Sources: `[src/theme/themes/factory-dark.ts:118-131]`, `[src/theme/themes/factory-light.ts:116-131]`.

### D5 — Mission Control palette (used by todo icons and panels)

`emphasis #eeeeee`, `primary #dadada`, `secondary #8a8a8a`, `tertiary #626262`, `ghost #3a3a3a`,
`dataValue #9e9e9e`, `paused #dadada`, `border #4e4e4e`, `active #ff5f00`, `done #afaf5f`,
`fail #af5f5f`, `info #626262`, `ref #5f8787`, `worker #878787`, `progress #00d75f`,
`barFillFrom #ff5f00`, `barFillTo #ff5f00`, `barEmpty #585858`, `hlBg #bcbcbc`, `hlFg #080808`,
`t2 #e4e4e4`, `t4 #bcbcbc`, `t6 #b2b2b2`, `t9 #808080`, `t12 #626262`, `ts #626262`, `qb #585858`
(dark; light equivalents at `[src/theme/themes/factory-light.ts:146-201]`)
`[src/theme/themes/factory-dark.ts:134-200]`.

### D6 — Subagent badge palette

Badge slots, in order, are `{bg: toolBadgeBg, fg: toolBadgeFg}`, `{bg: spec, fg: toolBadgeFg}`,
`{bg: hookBadgeBg, fg: hookBadgeFg}`, `{bg: success, fg: text.primary}`, `{bg: warning, fg: toolBadgeFg}`,
`{bg: error, fg: text.primary}`, `{bg: primary, fg: toolBadgeFg}`, `{bg: highlight, fg: toolBadgeFg}`.
Built-in subagent types map `worker → slot 0`, `explorer → slot 1`; any other type picks
`hash(type) mod 8` where `hash = (h*31 + code) mod 2147483647`
`[src/theme/themeColorState.ts:86-104]`, `[src/components/tools/implementations/subagentBadge.ts:1-50]`.
Placeholder (input still streaming) badge is `···` on `diff.border` with `text.muted`
`[src/components/tools/implementations/subagentBadge.ts:38-44]`.

### D7 — Syntax highlighting palette

`hljs-keyword #afafff`, `built_in #5f8787`, `type/literal/number #ffaf00`, `string/doctag/quote
#00d75f`, `comment #767676`, `function/class/title #5fafd7`, `variable/attr #d75f5f`, `property
#5f8787`, `tag/name/selector-tag #d75f5f`, `selector-class/id #ffaf00`, `value #00d75f`, `params
#eeeeee`, `meta #767676`, `regexp #d75f5f`, `operator/punctuation #eeeeee`, `symbol/bullet #5f8787`,
`link #5fafd7`, `emphasis/strong #eeeeee`, `section #5fafd7`, `addition #00d75f`, `deletion #d75f5f`,
`subst #eeeeee`, `template-tag #afafff`, `template-variable #d75f5f`
`[src/theme/themes/factory-dark.ts:203-278]`; light equivalents
`[src/theme/themes/factory-light.ts:204-280]`.

### D8 — Terminal ANSI palette (OSC 4 slots)

| Index | Name | Dark | Light |
|---|---|---|---|
| 0 | black | `#1c1c1c` | `#1a1a1a` |
| 1 | red | `#d75f5f` | `#c62828` |
| 2 | green | `#00d75f` | `#2e7d32` |
| 3 | yellow | `#ffaf00` | `#e65100` |
| 4 | blue | `#5fafd7` | `#0057a8` |
| 5 | magenta | `#afafff` | `#7b1fa2` |
| 6 | cyan | `#5f8787` | `#00695c` |
| 7 | white | `#dadada` | `#f5f5f5` |
| 8 | brightBlack | `#767676` | `#8a8a8a` |
| 9 | brightRed | `#ff5f5f` | `#ef5350` |
| 10 | brightGreen | `#5fff5f` | `#43a047` |
| 11 | brightYellow | `#ffd75f` | `#ff9800` |
| 12 | brightBlue | `#87afd7` | `#1e88e5` |
| 13 | brightMagenta | `#d7afff` | `#ab47bc` |
| 14 | brightCyan | `#87d7d7` | `#00897b` |
| 15 | brightWhite | `#eeeeee` | `#ffffff` |

Also `background #1c1c1c` / `#f5f5f5`, `foreground #eeeeee` / `#1a1a1a`, `cursor #d75f00` both
`[src/theme/themes/factory-dark.ts:281-328]`, `[src/theme/themes/factory-light.ts:283-323]`.

### D9 — Typography

The terminal surface is cell-based: the only typeface is the user's monospace font, and all layout
is expressed in columns and rows. No webfont is loaded into the terminal. Two fonts ship **only**
for rasterising SVG (Mermaid diagrams) to PNG:

| Asset | Value |
|---|---|
| font files | `src/fonts/Arimo-Regular.ttf`, `src/fonts/Arimo-Bold.ttf` (bundled as assets) `[src/utils/images/svg.ts:7-8]` |
| bold cut coverage | the bold cut covers exactly the regular cut's code points; a glyph missing from regular forces the text path `[src/utils/images/svg.ts:10-24]` |
| SVG sizing | absolute CSS units converted to px: `in 96`, `cm 96/2.54`, `mm 96/25.4`, `pt 96/72`, `pc 16`; text keeps its intrinsic `font-size` unless the markup has none `[src/utils/images/svg.ts:33-45]` |

Emphasis in the terminal: `bold` for markers, tool names, menu options and headers; `italic` for the
thinking label and code-fence language; `dimColor` for hints, placeholders, truncation notices,
status-line output and the unfocused composer frame.

### D10 — Spacing scale

| Token | Cells | Used by |
|---|---|---|
| transcript content inset | 6 (`terminalWidth - contentWidth`) | all message/tool content |
| assistant marker inset | 3 (`ASSISTANT_MESSAGE_INSET`) | compact/workstream views `[src/components/chat/constants.ts:33-37]` |
| user bubble inset | 3 (`USER_BUBBLE_INSET`) — bar 1 + padding 2 | user messages `[src/components/chat/constants.ts:39-42]` |
| tool row margin | 3 + inner 1 | tool rows `[src/components/tools/ToolDisplayShell.tsx:99-150]` |
| tool result indent | 4 (`TOOL_RESULT_INDENT`) | tool result text and images `[src/utils/constants.ts:344]` |
| thinking indent | 3 (`THINKING_INSET`) | reasoning block `[src/components/ThinkingDisplay.tsx:9-12]` |
| composer padding | x 1, y 1 (Windows) / x 1, y 0 (others) | frame `[src/components/chat/viewportBudget.ts:113-133]` |
| composer inner text width | `max(width - 10, 1)` | wrapping `[src/components/chat/viewportBudget.ts:136-140]` |
| menu padding | border 1 + x 1 | menus `[src/components/common/MenuContainer.tsx:44-55]` |
| menu min width | 78 | `MenuContainer` default `[src/components/common/MenuContainer.tsx:60-64]` |
| header left margin | 2 (`LEFT_MARGIN`) | header grid `[src/components/HeaderFrame.ts:57]` |
| status item gap | 2 | header status row `[src/components/HeaderFrame.ts:64]` |
| footer status separator | `" | "` (3) | footer `[src/components/FooterStatusRow.tsx:87-88]` |
| footer row gap | 1 | footer `[src/components/FooterStatusRow.tsx:88]` |
| help segment separator | 3 spaces | footer/help bars `[src/components/common/StyledHelpText.tsx:11-13]` |
| markdown list marker | 3 (`LIST_MARKER_WIDTH`), tail indent 2 | markdown `[src/components/renderMarkdown.tsx:64-65]` |
| markdown code inset | 2 (`CODE_TEXT_INSET`) | fenced code `[src/components/renderMarkdown.tsx:71]` |
| diff gutter | 10 (4+1+4+1) | diffs `[src/components/DiffRenderer.tsx:195-220]` |
| approval prompt indent | 2 (options), 2 (sections) | `[src/components/BatchToolConfirmationMessage.tsx:1225-1240]` |

### D11 — Borders and box characters

| Use | Characters | Source |
|---|---|---|
| Composer frame (non-Windows) | `round`: `╭ ╮ ╰ ╯ ─ │` | `[src/components/chat/ChatInput.tsx:1510-1520]` |
| Spec/mission composer top border | `╭── <label> · <title> ───╮`, degenerate `╭╮`, `╭` | `[src/components/chat/ChatInput.tsx:156-177]` |
| Menus / help sections / suggestions box | `round` border in `border` | `[src/components/common/MenuContainer.tsx:96-104]` |
| Pinned todo panel | left-only `bold` border column in `text.muted` | `[src/components/PinnedTodoDisplay.tsx:88-96]` |
| Markdown blockquote | left `single` border in `markdown.blockquote` | `[src/components/renderMarkdown.tsx:998-1015]` |
| Markdown code fence | left border in `text.muted` | `[src/components/renderMarkdown.tsx:405-424]` |
| Markdown thematic break | `─` repeated to content width | `[src/components/renderMarkdown.tsx:1027-1035]` |
| Markdown table column separator | `" │ "` | `[src/components/renderMarkdown.tsx:734]` |
| Diff line-number divider | `│` (documented position) | `[src/components/DiffRenderer.tsx:195-205]` |
| Header changelog divider | `│` in `asciiArt` | `[src/components/HeaderFrame.ts:578-581]` |
| Mini logo | `╔═══╗ / ║ D R O I D ║ / ╚═══╝` (21 columns) | `[src/components/chat/constants.ts:159-164]` |
| Full logo | 6-row block-letter `D R O I D` in `█` (see `DROID_ASCII`) | `[src/components/chat/constants.ts:133-153]` |

### D12 — Glyph and icon set

| Glyph | Meaning | Slot | Source |
|---|---|---|---|
| `⛬` | assistant message marker | `primary` | `[src/components/chat/constants.ts:31]` |
| `>` | user message marker (in `MessageItem`) | `text.userText` | `[src/components/MessageItem.tsx:540-555]` |
| `●` | tool/system message marker; todo in-progress | role colour / `text.primary` | `[src/components/MessageItem.tsx:540-555]`, `[src/components/TodoItem.tsx:20-24]` |
| `○` | todo pending | `text.muted` | `[src/components/TodoItem.tsx:20-24]` |
| `✓` | todo completed; header status ok | `mc.done` / `statusActive` | `[src/components/TodoItem.tsx:18-24]`, `[src/components/HeaderFrame.ts:466-467]` |
| `✗` | header status missing | `error` | `[src/components/HeaderFrame.ts:467-468]` |
| `⏳` | bash command executing prompt | `success` | `[src/components/chat/ChatInput.tsx:113]` |
| `!` (prompt ` ! `) | bash mode | `success` | `[src/components/chat/ChatInput.tsx:112]` |
| `↳` | result / child line: tool result, task progress, subagent rows, truncation notices | `text.muted` | `[src/components/tools/implementations/DefaultTool.tsx:155-165]` |
| `⎿` | interrupted notice prefix | `text.muted` | `[src/components/chat/constants.ts:44]` |
| `>` (selected) | selected list/menu row | `primary` / `success` | `[src/components/SelectableList.tsx:88-95]`, `[src/components/common/MenuOptionRow.tsx:15-22]` |
| `✕` | cancel option selected prefix | `highlightDanger` | `[src/agent/tool-confirmation.ts:150-153]` |
| `···` | placeholder subagent badge | `diff.border` bg | `[src/components/tools/implementations/subagentBadge.ts:38-44]` |
| `?` | help (shown in footer/`? for help`) | — | `en:footer.showHelp` |
| `↑ ↓ ← →` | help rows, navigation hints | — | `[src/components/help] en:keybindings.historyNavigation` |
| `↑ N more` / `↓ N more` | composer viewport indicators | `text.muted` | `[src/components/chat/ChatInput.tsx:1482-1499]` |
| `---- N more lines hidden ----` | clipped live-tail header | `text.muted` | `en:streamingTail.hiddenLines` |
| `⏱` | footer timer | `text.muted` | `[src/components/FooterStatusRow.tsx:395-406]` |
| `·` | inline separator in hints, mode borders, brief rows | `text.muted` | `[src/components/chat/ChatInput.tsx:118]` |
| `…` / `...` | truncation. `…` in header tip clamp; `...` in tool/paste notices | — | `[src/components/HeaderFrame.ts:458-462]`, `[src/components/tools/implementations/DefaultTool.tsx:22-28]` |
| `[Image N]`, `[x]` | image attachment chip, remove button | `text.info`, `error` | `en:imageAttachment.*` |
| `[DEV]` | non-production tag | `asciiArt` | `[src/components/HeaderFrame.ts:423]` |
| `` `|` `` | branch icon when nerd font is on | `toolName` bold | `[src/components/FooterStatusRow.tsx:82]` |

Spinner presets (all shipped, selectable): `Arrow ←↖↑↗→↘↓↙` (100 ms), `Arc ◜◠◝◞◡◟` (100),
`Balloon .oOo.` (120), `Bounce ⠁⠂⠄⡀⠄⠂` (120), `Breathe` (17 frames, 100), `CircleHalves ◐◓◑◒` (50),
`Dots ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (80, default), `Dots2 ⣾⣽⣻⢿⡿⣟⣯⣷` (80), `Dots3` (10 frames, 80),
…, `Speaker 🔈🔉🔊🔉` (160), `SquareCorners ◰◳◲◱` (180), `Toggle ⊶⊷` (250),
`Triangle ◢◣◤◥` (50), `Weather ☀️🌤⛅️🌥☁️🌧🌨⛈` (100)
`[src/utils/tuiSpinner/constants.ts:1-200]`.

### D13 — Animation timings

| Motion | Timing | Source |
|---|---|---|
| shared animation tick | 125 ms | `[src/utils/constants.ts:207]` |
| status banner spinner | 60 ms per frame, all states | `[src/utils/tuiSpinner/status.ts:10-13]` |
| default spinner | 80 ms | `[src/utils/tuiSpinner/constants.ts:70-73]` |
| fast mode | every spinner/shimmer interval halved | `[src/components/Spinner.tsx:22-30]` |
| tool-name shimmer sweep | 1000 ms cycle, 500 ms in fast mode, highlight `#e6e6e6`, width `max(3, floor(len*0.6))` | `[src/components/tools/ToolHeader.tsx:34-90]` |
| lone-ESC resolution | 400 ms | `[src/keyboard/constants.ts:9]` |
| ESC-run flush | 150 ms after first ESC; 650 ms tmux grace; 20 ms grace flush | `[src/keyboard/constants.ts:10-14]` |
| incomplete CSI close | 250 ms | `[src/keyboard/constants.ts:15]` |
| repeated-key reset | 200 ms (no tmux) / 700 ms (tmux) | `[src/hooks/repeatedKeySequence.ts:3-14]` |
| paste key guard | 100 ms | `[src/components/chat/constants.ts:55]` |
| double Ctrl+C exit window | 2000 ms | `[src/app.tsx:2544]` |
| file-suggestion debounce / loading delay | 100 ms / 200 ms | `[src/components/chat/constants.ts:105-112]` |
| truecolour probe / appearance probe | 500 ms each | `[src/utils/trueColorDetector/index.ts:22]`, `[src/utils/terminalAppearanceDetector/index.ts:21]` |
| status-line config poll | 1000 ms | `[src/components/StatusLine.tsx:120-127]` |

## Screen layout

### Frame at 80×24, new session, English, `factory-dark`, production build

`height = 24 ≤ 24` → compact header (no vertical margins), mini logo, 12 header rows. Transcript is
empty. Then the input-area stack: one reserved blank row, the mode/model row, the composer (3 rows:
Windows padding / border-row / one draft line / padding), no hint row, one footer row.

```
row  1  ╔═══════════════════╗                     (29 spaces, then 21 columns)
row  2  ║     D R O I D     ║
row  3  ╚═══════════════════╝
row  4  (blank)
row  5  v1.9.0                                   (centred under the logo)
row  6  (blank)
row  7  TIP: <random tooltip>                    (centred in 80)
row  8  (blank)
row  9  shift+tab to cycle modes · ctrl+N to cycle models
row 10  ctrl+L for autonomy · tab for reasoning
row 11  (blank)
row 12  Skills (0) ✗  MCPs (0) ✗  Connectors (0) ✗  AGENTS.md ✗
row 13  (reserved blank row for the idle status banner)
row 14  Auto (Med) · allow reversible commands                              <model label>
row 15  (composer padding, Windows) / ╭────…────╮ (elsewhere)
row 16  > Try "How do I handle errors in async functions?"
row 17  (composer padding, Windows) / ╰────…────╯ (elsewhere)
row 18  ? for help
```

Notes: the header is not padded right; no row carries trailing spaces except inside the composer
frame. On non-Windows the composer occupies `╭─╮`, `> …`, `╰─╯` (three rows) and a fourth row appears
only for the hint. With the status banner active, row 13 becomes
`<spinner> Thinking...  (Press ESC to stop)` with `paddingLeft 1`.

### Frame at 120×40, scripted transcript

At `width 120 ≥ 100` the header gains the changelog column and uses the full 6-row logo
(`leftColWidth = 66`, right column 54); `height 40 > 24` so the header keeps `marginTop 2` /
`marginBottom 1`. `contentWidth = 114`. The transcript below is ordered by B4, then the same
input-area stack as above; the footer splits into left hints and right statuses because the host is
not Windows-like.

```
row 1-2   (blank)
row 3-8   DROID block logo, centred in 66 columns; right column: "New features" │ divider
row 9     (blank)
row 10    v1.9.0
row 11    (blank)
row 12    TIP: …
row 13    (blank)
row 14-15 shortcuts lines
row 16    (blank)
row 17    status row
row 18-   transcript items (see renderers)
…         (reserved blank row) / status banner / mode+model row / composer / hint / footer
```

## Transcript item renderers

Common facts: content width `contentWidth`; marker column 1 cell + 1.5-cell gap; bodies wrap (never
horizontally clip); every renderer sanitises its text (B20).

| # | Item | Rendered as | Collapsed by default | Max lines |
|---|---|---|---|---|
| R1 | **User message** | one `backgroundColor = text.userBg` column as the accent bar (colour `text.userSymbol`, or `spec` when the message was sent in spec mode), then 2 columns of padding, then the text in `text.userText` (wrapping) with a trailing space; image attachments follow inside the same background at `contentWidth - 3` `[src/components/MessageItem.tsx:443-490]` | never | unbounded |
| R2 | **Assistant text** | marker `⛬` in `primary` bold, gap, then markdown rendered at `contentWidth` with heading colour `markdown.heading` `[src/components/MessageItem.tsx:520-560]`, `[src/components/MessageItem.tsx:560-600]` | never | unbounded |
| R3 | **Thinking block** | indent 3 columns, width `contentWidth - 3`; label `Thinking:` (or `Thinking (i/n):`, `Reasoning Summary:` / `Reasoning Summary (i/n):`) in `text.muted` italic, then the reasoning text as *italic* markdown in `text.muted` `[src/components/ThinkingDisplay.tsx:100-150]`, `en:thinking.*` | hidden unless `showThinking` is on; when hidden the block occupies no rows | unbounded |
| R4 | **Tool call** | 3-column margin; header = bold tool display name in `toolName` + `, `-joined params in `toolParam` (margin-left 1) + optional right-aligned suffix in `text.muted`; params are `key: "value"` with values truncated at 50 chars to `…`; pending names shimmer `[src/components/tools/ToolHeader.tsx:120-250]`, `[src/components/tools/implementations/DefaultTool.tsx:170-215]` | result body collapsed to the preview caps (B7) | header 1 row (+1 per wrapped param set); preview 4 rows |
| R5 | **Tool result** | inner margin 1 under the header: `↳ ` + text (`text.muted`), or markdown when it fits, or `error` text on failure `[src/components/tools/implementations/DefaultTool.tsx:141-165]` | yes — 4 lines / 1024 chars in the normal view | 200 lines / 16 KiB in Ctrl+O view |
| R6 | **Diff** | 10-column gutter (`old` 4 + space + `new` 4 + space) then a space then the line, backgrounds per D3; hunk context separators as their own dimmed row with one blank row above and below `[src/components/DiffRenderer.tsx:195-220]`, `[src/components/DiffRenderer.tsx:436-475]` | yes — 20 lines inline (`MAX_DIFF_LINES`), 500 rows detailed (`DETAILED_MAX_DIFF_ROWS`) | 20 / 500 |
| R7 | **Error** | ordinary message row: marker `●` in `error`, body in `error`; tool errors render `↳ <text>` in `error` with the `(error)` suffix in collapsed groups `[src/components/MessageItem.tsx:520-560]`, `en:toolDisplay.errorSuffix` | never | unbounded |
| R8 | **Todo list** | pinned panel (B9): `Plan · C/T` then border column then `✓/●/○ <content>` rows | yes — window anchored on the last completed item, overflow `... N more, Alt/Option+P to view all` | `maxVisibleRows` |
| R9 | **Subagent / task row** | header = badge (`Worker`, `Explorer`, `···` placeholder; `Resume <badge>` for resumes) + bold description in quotes `"<description>"` with ` - <complexity>` appended when present; then exactly 2 lines tall (header + status) to prevent jitter; status line `↳ Done (N tool uses · 1.2s)` or `↳ <progress label ≤80 chars>` or `⚠ Task failed` in `error` `[src/components/ToolExecutionItem.tsx:96-104]`, `[src/components/tools/implementations/TaskTool.tsx:229-400]`, `en:toolDisplay.task.*` | result body hidden; only the 2 header/status rows | 2 |
| R10 | **Plan / spec card** | header row only in the live region; the proposal body (plan or mission proposal) renders once in the static region via `ProposalDisplay`; approval/plan screens (`PlanDetailsScreen`, `ApprovalDetailsScreen`) replace the whole surface `[src/components/UnifiedToolDisplay.tsx:455-470]`, `[src/app.tsx:10880-10895]` | body outside the dynamic region | body unbounded in the full-screen view |
| R11 | **Approval prompt** | rounded `border` box, min width 78, 1 column padding: queue position `Approval N of M` (muted), section headers (`Commands (N): <risk>`, `File Edits (N):`, `File Creations (N):`, `Patches (N):`, `MCP tool to approve · <impact>`), bodies indented 2, then the options list (2-space indent, selected bold in `text.primary`, unselected `text.muted`) and a one-row help line `↑↓ navigate · Enter select · Esc cancel` (+ ` · Ctrl+O expand diff` / ` · Ctrl+O collapse` + ` · Alt/Option+E to inspect approval details`) `[src/components/BatchToolConfirmationMessage.tsx:820-870]`, `[src/components/BatchToolConfirmationMessage.tsx:1220-1240]`, `en:batchConfirmation.*` | diff detail collapsed | help line 1 row, variants as above |
| R12 | **System notice** | marker `●` in `text.muted`, body in `text.muted`; warnings prefix in `warning`; abort notice `⎿ Interrupted` `[src/components/MessageItem.tsx:520-560]`, `[src/components/chat/constants.ts:44]` | never | unbounded |
| R13 | **Collapsed tool group** | header `<Tool name> <N> <noun>` (noun: file/search/pattern/directory/URL/agent/item; plural per rules) + ` (<K> failed)` in `error`, then `↳ <subtitle>` for the first and two spaces for the rest, sliding window of the last 8 entries, overflow `Ctrl+O to view all` `[src/components/CollapsedToolGroup.tsx:470-640]`, `en:toolDisplay.countFailed`, `en:toolDisplay.ctrlOToViewAll` | compact mode collapses to header + one active subtitle | 1 + 8 |

## Key bindings

Two spelling systems exist and both are contractual: the **footer/help** spelling
(`formatChordLabelForFooter`: lower-case, `+`-joined, `Alt/Option` → `option` on macOS) and the
**key-hint** spelling (`formatChordLabelForKeyHint`: macOS modifier glyphs `⌃ ⌥ ⇧`, otherwise plain
`+`-joined) `[src/keyboard/keyboardChords.ts:600-660]`.

| Action | Keys | Precondition | Source |
|---|---|---|---|
| submit message | `Enter` | suggestions closed | `[src/hooks/useChatKeyboardInput.ts:1921-2010]` |
| queue message at end of loop | `Ctrl+Enter` | — | `[src/hooks/useChatKeyboardInput.ts:1950-2010]` |
| insert newline | `Shift+Enter`, `Ctrl+Enter` (as documented), `\` then `Enter`, raw LF | — | `[src/keyboard/keyboardChords.ts:470-480]`, `[src/hooks/useChatKeyboardInput.ts:2438-2448]` |
| newline / next row in suggestions | `↑` `↓` / `Tab` (menu open) | menu open | `[src/components/SelectableList.tsx:1-50]` |
| accept highlighted suggestion | `Tab` / `Enter` | menu open | `[src/components/chat/CommandSuggestions.tsx:1-40]`, `en:chatInput.navigationHint` |
| close menus | `Esc` | menu open | `[src/hooks/useChatKeyboardInput.ts:2066-2085]` |
| cancel / exit bash mode | `Esc` | — | `[src/hooks/useChatKeyboardInput.ts:2066-2085]` |
| clear draft → restore → rewind | `Esc` ×1 / ×2 / ×3 | ×2 needs a non-empty draft | `[src/hooks/useChatKeyboardInput.ts:1138-1180]` |
| cycle interaction mode | `Shift+Tab` (`Ctrl+T` on Windows-like) | menus closed | `[src/hooks/useChatKeyboardInput.ts:2103-2125]`, `[src/components/HelpPopup.tsx:390-400]` |
| cycle reasoning effort | `Tab` | menus closed | `[src/hooks/useChatKeyboardInput.ts:2127-2145]` |
| cycle model | `Ctrl+N` | menus closed | `[src/hooks/useChatKeyboardInput.ts:2200-2215]` |
| cycle autonomy level | `Ctrl+L` | — | `[src/keyboard/keyboardChords.ts:390-395]` |
| toggle detailed transcript | `Ctrl+O` | not in a blocking overlay | `[src/app.tsx:6097-6110]` |
| toggle plan screen | `Alt/Option+P` | — | `[src/keyboard/keyboardChords.ts:470-476]` |
| open help | `?` on empty input, `Ctrl+/` | — | `[src/hooks/useChatKeyboardInput.ts:2362-2366]`, `[src/hooks/useChatKeyboardInput.ts:2210-2220]` |
| toggle bash mode | `!` on empty input | — | `[src/hooks/useChatKeyboardInput.ts:2362-2370]`, `en:chatInput.bash*` |
| open editor with draft | `Ctrl+P` | — | `[src/hooks/useChatKeyboardInput.ts:2200-2210]`, `en:chatInput.editorOverflowHint` |
| copy input | `Ctrl+Shift+C` | — | `[src/keyboard/keyboardChords.ts:430-440]` |
| paste text or image | `Ctrl+V` / `Cmd+V` | — | `[src/hooks/useChatKeyboardInput.ts:2220-2230]` |
| expand pasted block | `Alt+Shift+V` | placeholder present | `[src/keyboard/keyboardChords.ts:445-450]` |
| delete draft attachments (fallback: forward delete) | `Ctrl+D` | attachments present | `[src/hooks/useChatKeyboardInput.ts:2506-2520]` |
| review queued messages | `Ctrl+R` | queued messages exist | `[src/hooks/useChatKeyboardInput.ts:2150-2160]` |
| pull top queued message into input | `Ctrl+G` | queued messages exist | `[src/hooks/useChatKeyboardInput.ts:2160-2170]` |
| queued-review: close / delete / send now | `Ctrl+R` or `Esc` / `Ctrl+D` / `Enter` | review mode | `[src/app.tsx:4100-4135]` |
| open mission control | `Ctrl+T` | — | `[src/app.tsx:6340-6352]` |
| open side chat | `Ctrl+Y` | no blocking overlay | `[src/app.tsx:6467-6490]` |
| dismiss / restore changelog | `Ctrl+J` | changelog present | `[src/app.tsx:6520-6540]` |
| open Droids view | `Alt/Option+S`, or `←` from an empty composer | — | `[src/keyboard/keyboardChords.ts:455-462]`, `[src/components/FooterStatusRow.tsx:90-93]` |
| toggle auto-compaction | `Alt+X` | — | `[src/keyboard/keyboardChords.ts:465-470]` |
| inspect approval details | `Alt/Option+E` | approval open | `[src/keyboard/keyboardChords.ts:470-480]` |
| transcript scroll (one row / one turn / page) | `Alt+↑/↓`, `Alt+PageUp/PageDown`, `Alt/Option+Shift+↑/↓` jump oldest/newest | — | `[src/keyboard/keyboardChords.ts:400-440]` |
| history navigation | `↑` / `↓` | suggestions closed | `[src/hooks/useChatKeyboardInput.ts:2250-2300]` |
| cursor word moves | `Option+B` / `Option+F`, `Ctrl+←` / `Ctrl+→` | — | `[src/keyboard/keyboardChords.ts:520-540]` |
| line start / end | `Ctrl+A` / `Ctrl+E`, `Home` / `End` | — | `[src/keyboard/keyboardChords.ts:540-560]` |
| delete previous char | `Backspace`, `Ctrl+H` | — | `[src/keyboard/keyboardChords.ts:560-580]` |
| delete next char | `Delete`, `Ctrl+D` | no attachments | `[src/keyboard/keyboardChords.ts:575-590]` |
| delete previous / next word | `Ctrl+W` / `Option+Backspace`; `Option+D` / `Ctrl+Delete` | — | `[src/keyboard/keyboardChords.ts:585-610]` |
| delete to line start / end | `Ctrl+U` / `Ctrl+K` | — | `[src/keyboard/keyboardChords.ts:605-625]` |
| exit | `Ctrl+C` twice within 2000 ms, or `/quit` | — | `[src/app.tsx:2463-2546]` |
| confirm open exit prompt | `Ctrl+C` | exit-confirm pane open | `[src/app.tsx:2475-2482]` |

Slash-command completion rules: a `/` at the start of the draft opens the command menu, seeded from
the command catalog with hidden commands filtered and the deployment/airgap filter applied; typing
narrows by name match with keyword matches grouped after name matches; the menu shows at most 6
rows including loading/notice rows; `Tab`/`Enter` accept, `Esc` cancels; while the menu is open the
footer row is replaced by the menu `[src/components/chat/ChatInput.tsx:600-700]`,
`[src/components/chat/CommandSuggestions.tsx:200-260]`, `[src/app.tsx:10905-10908]`.
File completion: `@` opens a debounced (100 ms) search; results list up to 6 rows with
`filename  path`, hidden files included `[src/components/chat/constants.ts:93-112]`,
`[src/components/chat/ChatInput.tsx:780-800]`.

## Errors

| Trigger | Observable effect |
|---|---|
| Theme file invalid / unreadable | file skipped, previous theme stays active, deferred startup warning (no user-facing row) `[src/theme/themeLoader.ts:30-45]` |
| Truecolour probe write fails | warning logged, colour handling unchanged, probe result false `[src/utils/trueColorDetector/index.ts:120-140]` |
| OSC 11 probe fails/times out | falls back to `COLORFGBG`, else dark; one warning `[src/utils/terminalAppearanceDetector/index.ts:95-130]` |
| Status-line command fails | the status row shows the failure text naming the failure and the way out instead of an empty row `[src/components/StatusLine.tsx:28-40]` |
| Copy input fails | ephemeral system message `Failed to copy input to clipboard.` `en:chatInput.copyError` |
| Clipboard image paste fails | `Failed to attach clipboard image: <error>` (warning row) `en:imageAttachment.failedClipboard` |
| Image pasted while the model cannot take images | `⚠ <model> doesn't support images. Please switch models to attach images.` `en:imageAttachment.modelNoImageSupport` |
| Tool cancelled by user | `⎿ Interrupted` (tool rows) / `Cancelled by user` `en:toolDisplay.cancelledByUser` |
| All models blocked | error row under the mode/model row: `All models are blocked based on your settings. …` `en:appMessages.allModelsBlocked` |
| Daemon startup failed (empty session) | header banner `⚠ Daemon startup failed` + body naming `~/.factory/logs/daemon-stderr.log` `[src/app.tsx:10177-10186]` |

## Acceptance tests

Frames are compared as ordered lines with no trailing-space padding. Fixtures are synthetic.

| Clause | Test id | Fixture |
|---|---|---|
| B1 | `tests/ui/test_screen_sequences` | `fixtures/ui/screen-sequences.txt` — asserts the exact byte order of enter/leave sequences |
| B2, B3 | `tests/ui/test_header_80x24`, `test_header_120x40` | `fixtures/ui/header-compact.txt`, `fixtures/ui/header-wide.txt` |
| B4 | `tests/ui/test_static_dynamic_split` | `fixtures/ui/stream.jsonl` |
| B5, R1–R13 | `tests/ui/test_golden_frame_80x24`, `test_golden_frame_120x40` | `fixtures/ui/transcript.jsonl` |
| B6, B7, R4, R5 | `tests/ui/test_tool_row` | `fixtures/ui/tool-read.json` |
| B8, R6 | `tests/ui/test_diff_row` | `fixtures/ui/diff-simple.patch` |
| B9, R8 | `tests/ui/test_pinned_todo` | `fixtures/ui/todos.json` |
| B10 | `tests/ui/test_composer_layout` | `fixtures/ui/composer-cases.json` |
| B11 | `tests/ui/test_suggestions` | `fixtures/ui/commands.json`, `fixtures/ui/files.json` |
| B12 | `tests/ui/test_status_banner` | `fixtures/ui/states.json` |
| B13, B14 | `tests/ui/test_footer_fit`, `test_status_line` | `fixtures/ui/footer-widths.json`, `fixtures/ui/statusline.json` |
| B15 | `tests/ui/test_key_sequences` | `fixtures/ui/keys.jsonl` |
| B16 | `tests/ui/test_paste_thresholds` | `fixtures/ui/pastes.json` |
| B17 | `tests/ui/test_palette_tokens` | `fixtures/ui/palette.json` |
| B18 | `tests/ui/test_capability_matrix` | `fixtures/ui/env-matrix.json` |
| B19 | `tests/ui/test_resize_reflow` | `fixtures/ui/resize.jsonl` |
| B20 | `tests/ui/test_sanitization_widths` | `fixtures/ui/hostile-text.json` |
| B21 | `tests/ui/test_animation_timings`, `test_palette_tokens` | `fixtures/ui/ticks.json` |

**T1 — `test_palette_tokens`.** Input: the resolved `factory-dark` theme. Expected: for each row of
D1–D8, `COLORS.<slot>` equals the literal hex in this spec; the OSC sequence builder emits
`ESC]10;#eeeeee BEL ESC]11;#1c1c1c BEL ESC]12;#d75f00 BEL` then `ESC]4;0;#1c1c1c BEL` … `ESC]4;15;#eeeeee BEL`
in index order. Failure message names the slot and both values.

**T2 — `test_golden_frame_80x24`.** Input: the scripted transcript in
`fixtures/ui/transcript.jsonl` (one user message `hello`, one assistant text block `Hi there.`, one
`Read` tool call on `src/a.ts` with a 2-line result, one completed `TodoWrite` with two todos
`wire the reader` (completed) and `write the test` (in progress)), 80×24, `factory-dark`, English,
`placeholders.prompt0` pinned, clock pinned by `FACTORY_E2E_CLOCK_FILE`. Expected: the exact frame
`fixtures/ui/golden-80x24.txt`. Structural assertions that must also hold: every row ≤ 80 columns;
header rows identical to the row list in "Screen layout"; the user row starts with one
`text.userBg`-coloured column then two spaces; the assistant row starts `⛬ `; the tool header row
starts with three spaces then `Read`; the tool result row starts with four spaces then `↳ `; the
todo panel row starts `Plan · 1/2`; the composer row starts `> `; the last row equals
`? for help` when the terminal is Windows-like, else `<hints>            <statuses>`.

**T3 — `test_golden_frame_120x40`.** Same fixture at 120×40, wide header (changelog column present
with a fixed fixture changelog). Expected: `fixtures/ui/golden-120x40.txt`. Additional assertions:
`contentWidth` wrapping changes the assistant block's wrap points exactly at 114 columns; the
footer renders left hints and right statuses separated by ≥ 1 space and the row is ≤ 120 columns.

**T4 — `test_key_sequences`.** Each case is `(initial buffer, cursor, keys, expected buffer, expected
cursor, expected side effect)`. Mandatory cases:

| Case | Input | Expected |
|---|---|---|
| K1 | empty, `Enter` | no submit (empty draft) |
| K2 | `hi`, `Enter` | submit `hi`, buffer ``, cursor 0 |
| K3 | `hi`, `Shift+Enter` | buffer `hi\n`, cursor 3 |
| K4 | `hi`, `Ctrl+Enter` | submit with `queuePlacement: EndOfLoop`, buffer `` |
| K5 | `abc`, `Esc` | onEscape invoked, buffer unchanged |
| K6 | `abc`, `Esc Esc` | buffer ``, cursor 0 |
| K7 | `abc`, `Esc Esc Esc` | buffer `abc` restored and rewind menu opened |
| K8 | `abc def`, `Ctrl+W` | buffer `abc `, cursor 4 |
| K9 | `abc` with cursor 1, `Ctrl+K` | buffer `a`, cursor 1 |
| K10 | `abc`, `Ctrl+A` then `Ctrl+E` | cursor 0 then 3 |
| K11 | `abc`, `Ctrl+C` | buffer ``, cursor 0, ephemeral message `Press Ctrl+C again to exit.` |
| K12 | `abc`, `Ctrl+C` twice inside 2000 ms | process exits, trigger `CtrlC` |
| K13 | any, `Ctrl+V` | paste path invoked once (text or image) |
| K14 | 500-char single-line paste | buffer contains `[<50 chars>... 7 lines]` at width 80 and the map holds the original |
| K15 | 9-line paste | placeholder created (line count > 8) |
| K16 | 400-char paste | not wrapped (threshold is strictly greater) |
| K17 | paste then `Enter` within 100 ms, unframed | Enter dropped, no submit |
| K18 | `@src` | file suggestions open, ≤ 6 rows |
| K19 | `/he` | command suggestions open, filtered rows include `/help` |
| K20 | `?` on empty buffer | help opened, buffer stays empty |

**T5 — `test_resize_reflow`.** Render the T3 fixture at 120 wide, then at 80: expect the transcript
rows to re-wrap at 74 columns, the header rows to stay byte-identical (static), the composer to
switch from bordered to the platform layout only if the platform changed, and the footer to drop
its lowest-priority hint whole rather than clipping it.

**T6 — `test_capability_matrix`.** For each row of B18's table, with the given env and TTY state,
assert which probe bytes (if any) were written to stdout and which theme resolved. Notable:
`win32` writes neither probe; `NO_COLOR=1` writes neither probe; `FORCE_COLOR=3` writes neither
probe; 16-colour mode writes the palette OSC only when `overrideTerminalColors` is on.

## Evidence

All `src/…` and `packages/…` paths below resolve under `evidence/original/windows-x64/`; all
`en:…` references are the English locale bundle recovered from the shipped chunk
`evidence/extracted/windows-x64/chunk-j2hk0tf4.js` (the `common` namespace).

| Evidence | Supports | Method |
|---|---|---|
| `src/theme/themes/factory-dark.ts:16-328` | D1–D8, B17 | reading |
| `src/theme/themes/factory-light.ts:16-323` | D1–D8, B17 | reading |
| `src/theme/themeColorState.ts:28-115` | D6, B17 | reading |
| `src/theme/ThemeEngine.ts:33-50,403-470` | B1, B17, D8 | reading |
| `src/theme/themeLoader.ts:1-45` | B17, Data & config | reading |
| `src/theme/applyThemeChange.ts:1-29` | B17 | reading |
| `src/utils/terminalTheme/index.ts:1-11` | B17 | reading |
| `src/components/chat/themedColors.ts:1-12` | B17 | reading |
| `src/components/chat/constants.ts:15-215` | B9, B10, B11, D11, D12 | reading |
| `src/components/chat/ChatInput.tsx:110-260,360-500,1350-1624` | B10, B11, D12 | reading |
| `src/components/chat/viewportBudget.ts:1-260` | B10, B19, D10 | reading |
| `src/components/chat/wrapText.ts:1-120` | B19 | reading |
| `src/components/chat/CommandSuggestions.tsx:200-318` | B11 | reading |
| `src/components/HeaderFrame.ts:55-588` | B3, D11 | reading |
| `src/components/Header.tsx:1-35` | B3, B19 | reading |
| `src/components/MessageItem.tsx:400-609` | R1, R2, R7, R12 | reading |
| `src/components/ThinkingDisplay.tsx:1-152` | R3 | reading |
| `src/components/TodoItem.tsx:1-48`, `src/components/PinnedTodoDisplay.tsx:1-108` | B9, R8 | reading |
| `src/components/UnifiedToolDisplay.tsx:1-553` | B6, B7, R4, R5, R10 | reading |
| `src/components/ToolExecutionItem.tsx:1-106` | R9 | reading |
| `src/components/tools/ToolDisplayShell.tsx:45-180` | B6, D10 | reading |
| `src/components/tools/ToolHeader.tsx:34-250` | R4, D13 | reading |
| `src/components/tools/implementations/DefaultTool.tsx:1-215` | B7, R4, R5 | reading |
| `src/components/tools/implementations/TaskTool.tsx:229-470` | R9 | reading |
| `src/components/tools/implementations/subagentBadge.ts:1-50` | D6, R9 | reading |
| `src/components/tools/implementations/TodoWrite.tsx:1-60` | R8 | reading |
| `src/components/CollapsedToolGroup.tsx:300-640` | R13 | reading |
| `src/components/DiffRenderer.tsx:190-680` | B8, R6, D10 | reading |
| `src/components/BatchToolConfirmationMessage.tsx:330-420,820-1240` | R11 | reading |
| `src/agent/tool-confirmation.ts:80-190` | R11 (option labels, `✕`) | reading |
| `src/components/common/MenuContainer.tsx:1-140`, `MenuOptionRow.tsx:1-45` | R11, D10, D11 | reading |
| `src/components/SelectableList.tsx:55-148` | B11, D12 | reading |
| `src/components/common/StyledHelpText.tsx:1-61` | B13, D10 | reading |
| `src/components/FooterStatusRow.tsx:80-876` | B13, D10, D12 | reading |
| `src/components/StatusLine.tsx:28-201` | B14 | reading |
| `src/components/Spinner.tsx:1-38`, `src/utils/tuiSpinner/*` | B21, D12, D13 | reading |
| `src/utils/constants.ts:207,344` | D13, D10 | reading |
| `src/utils/terminalSegments.ts:30-120,579-670` | B13, B20, D10 | reading |
| `src/keyboard/constants.ts:1-22`, `src/keyboard/keyboardChords.ts:1-660` | B15, D13, Key bindings | reading |
| `src/hooks/useChatKeyboardInput.ts:240-250,520-540,1000-1045,1138-1180,1921-2200,2380-2600` | B15, B16, Key bindings | reading |
| `src/hooks/repeatedKeySequence.ts:1-20`, `src/hooks/constants.ts:155` | B15, D13 | reading |
| `src/app.tsx:2216-2219,2463-2546,4100-4160,6097-6110,6335-6360,6467-6540,9990-10120,10170-10290,10620-10660,10825-11120` | B2, B12, B13, B15, B19 | reading |
| `src/utils/interactiveTerminalState.ts:26-170` | B1 | reading |
| `src/utils/trueColorDetector/index.ts:15-236` | B18 | reading |
| `src/utils/terminalAppearanceDetector/index.ts:16-238` | B17, B18 | reading |
| `src/utils/terminalCapabilities.ts:1-162` | B18 | reading |
| `src/utils/hyperlinks.ts:100-112` | B18 (`TERM=dumb`) | reading |
| `src/utils/isWsl.ts:1-60` | B10 (platform layout) | reading |
| `src/entrypoints/tui/bootstrap.ts:300-340` | B18 (non-TTY) | reading |
| `src/utils/e2eClock.ts:1-40` | Test determinism | reading |
| `src/utils/images/svg.ts:1-60` | D9 | reading |
| `src/components/renderMarkdown.tsx:64-71,382-425,560-640,940-1035` | R2, D10, D11, D12 | reading |
| `src/components/chat/ImageAttachment.tsx:1-130` | B16 | reading |
| `en:chatInput.*`, `en:statusBar.*`, `en:pinnedTodo.*`, `en:toolDisplay.*`, `en:batchConfirmation.*`, `en:confirmation.*`, `en:imageAttachment.*`, `en:streamingTail.*`, `en:assistantTimer.*`, `en:footer.*`, `en:process.ctrlCToExit`, `en:header.*`, `en:keybindings.*`, `en:helpSections.*`, `en:placeholders.*`, `en:thinking.*` | all literal strings | extraction from the English locale chunk |

## Open questions

1. **`marginRight={1.5}` rounding.** `MessageItem` uses a 1.5-column gap between marker and body
   `[src/components/MessageItem.tsx:519]`, while the constant `ASSISTANT_MESSAGE_INSET = 3`
   describes a 3-column inset `[src/components/chat/constants.ts:33-35]`. Which value the reference
   frame actually shows (1, 2, or a fractional cell) is not established; settled by reading one
   committed frame's column positions. Blocks exact column assertions in T2 for R1/R2.
2. **Trailing-space policy.** Assumed: rows are emitted at their natural width (Ink pads only inside
   boxes with an explicit background/border). Settled by hex-dumping a committed frame.
3. **Exact 16-colour mapping.** chalk's hex→ANSI-16 conversion is used, but the spec does not pin
   which slot each semantic token lands in. Settled by running the reference with `FORCE_COLOR=1`
   and capturing SGR, or by adopting `color-convert`'s documented ansi16 heuristic. Blocks the
   "16-colour terminal sees" column of B18.
4. **Subagent row height.** `Task` rows are hard-clamped to 2 rows
   `[src/components/ToolExecutionItem.tsx:95-104]` while the compact renderer can emit a Done line
   that includes a duration `[src/components/tools/implementations/TaskTool.tsx:280-300]`; whether
   the duration is visible or clipped at 80 columns is unverified.
5. **Change of shell spelling for `Ctrl+Enter`.** `keyboardChords.insertNewline` documents
   `Shift+Enter / Ctrl+Enter / \+Enter` `[src/keyboard/keyboardChords.ts:470-480]` but the Enter
   handler routes `Ctrl+Enter` to queue-at-end-of-loop
   `[src/hooks/useChatKeyboardInput.ts:1950-1970]`. Resolved behaviour (documented): `Shift+Enter`
   and `\`+`Enter` insert a newline; `Ctrl+Enter` submits queued. The help pane still prints
   `\ + Enter` for new line `[src/components/HelpPopup.tsx:360-372]`. Blocks nothing; recorded for
   fidelity of the help pane.
6. **Header on resize.** Assumed static (documented at `[src/components/Header.tsx:1-35]`); whether
   a `redrawSession()` triggered by other events repaints the header at the new width is not
   established.
7. **Diff `+`/`-` prefixes.** Line prefixes come from the unified-diff text generated upstream
   (`generateUnifiedDiff`), not from the renderer; the renderer's own contribution is the gutter,
   one leading space and the background. Settled by inspecting `utils/diff-utils.ts` output, owned by
   the exec/diff slice.

## Clean-room notes

**Must reproduce (the contract).**

1. The exact region order of B2 and the fact that the footer (and status line) disappear while a
   command menu is open.
2. Every colour literal in D1–D8 with the same semantic slot names and the same light/dark pairs;
   the OSC palette override sequence and its index order.
3. Every glyph and literal string in D11, D12 and the renderers' tables — including `⛬`, `↳`,
   `⎿`, `✓ ● ○`, `✕`, `···`, `---- N more lines hidden ----`, `Plan · C/T`, `? for help`,
   `TIP: `, `[DEV]`, `[x]`.
4. All spacing values in D10 (6-column transcript inset, 3-column tool margin, 4-column result
   indent, 3-column thinking indent, 10-column diff gutter, 78-column menu min width).
5. The row budgets: 4-line/1 KiB tool preview, 200-line/16 KiB detailed view, 20-line inline diff,
   6-row suggestion menus, 2-row task rows, capped live tail with hidden-lines header.
6. Every key binding in the table, the three ESC sequencing rules, the 2000 ms double-`Ctrl+C`
   window, and the 400-char/8-line paste thresholds with the `[<50 chars>... N lines]` placeholder.
7. The capability matrix of B18, including no probes on Windows, no probes under `NO_COLOR`/
   `FORCE_COLOR`/`CI`, and `COLORFGBG` as the only fallback.
8. Header geometry (centred logo, centred tip/version/shortcut/status rows, 12-row compact budget,
   100-column changelog split) and the `width - 6` transcript inset.

**Explicitly not part of the contract.**

- The program name, banner text that names the product, and the ASCII logo's letters: replaced by
  the parity-normalised name per `docs/adr/0005-project-name-and-parity-normalisation.md`. Glyph
  shapes and centring rules stay.
- Which random tooltip/placeholder appears on a given launch (uniform choice is the contract, the
  outcome is not).
- Exact timing of frames (only intervals and windows are contractual) and terminal-specific
  rendering of the same SGR bytes.
- i18n for non-English locales: the string *sets* exist, but this spec pins English only.
- Mission Control, Droids View, Workstream Control, plugin and marketplace surfaces, and every
  `MenuContainer` submenu's own copy.
- Native image protocols, SVG→PNG rasterisation quality, and the fonts' internal metrics.
- Persisted settings file location and merge rules → `specs/40-sessions-and-storage.md`.