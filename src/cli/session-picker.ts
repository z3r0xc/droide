/**
 * The terminal session picker (`resume` with no id).
 *
 * Contract: `specs/10-cli-surface.md` B22 — a terminal gets a choice, a pipe
 * gets the bounded list. The picker is a small raw-mode surface rather than an
 * Ink tree: `resume` must not pay for React and the whole shell only to print
 * ten lines, and the same rule keeps `--help` cheap (ADR 0012).
 *
 * It draws caller-supplied labels and reports an index, so every word on screen
 * belongs to the command (`resume-commands.ts`); this module owns only the
 * keyboard, the cursor and the repaint.
 *
 * Keys: ↑/↓ (or k/j) move, Enter picks, `q` (or Esc, Ctrl+C) aborts.
 */
export interface PickerStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

export interface PickerOptions {
  /** Rows drawn at once; the window scrolls around the selection. */
  readonly maxVisible?: number;
  /** The line above the rows; the command's own wording. */
  readonly title?: string;
}

export const PICKER_MAX_VISIBLE = 10;
export const PICKER_HINT = "↑/↓ select · enter resume · q quit";

type PickerKey = "up" | "down" | "select" | "abort" | "wait" | null;

/** One key from the front of `buffer`; `rest` is what a later chunk continues. */
function takeKey(buffer: string): {
  readonly key: PickerKey;
  readonly rest: string;
} {
  if (buffer.startsWith("\u001b[A") || buffer.startsWith("\u001bOA")) {
    return { key: "up", rest: buffer.slice(3) };
  }
  if (buffer.startsWith("\u001b[B") || buffer.startsWith("\u001bOB")) {
    return { key: "down", rest: buffer.slice(3) };
  }
  // A terminal may deliver one arrow-key sequence in several reads: hold a
  // prefix until the rest arrives instead of reading it as several keys.
  if (buffer === "\u001b" || buffer === "\u001b[" || buffer === "\u001bO") {
    return { key: "wait", rest: buffer };
  }
  const first = buffer[0] ?? "";
  const rest = buffer.slice(1);
  switch (first) {
    case "\r":
    case "\n":
      return { key: "select", rest };
    case "q":
    case "Q":
    case "\u0003":
      return { key: "abort", rest };
    case "k":
      return { key: "up", rest };
    case "j":
      return { key: "down", rest };
    default:
      // Escape on its own, and every other unbound key, does nothing.
      return { key: null, rest };
  }
}

/**
 * Ask the terminal which label to take.
 *
 * @returns the chosen index, or `null` when the user aborted.
 */
export function runSessionPicker(
  labels: readonly string[],
  streams: PickerStreams,
  options: PickerOptions = {},
): Promise<number | null> {
  if (labels.length === 0) return Promise.resolve(null);
  const maxVisible = Math.max(
    1,
    Math.min(options.maxVisible ?? PICKER_MAX_VISIBLE, labels.length),
  );
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const stdin = streams.stdin;
  const stdout = streams.stdout;
  // The documented read: a pipe has no raw mode, and the caller never reaches
  // here without a terminal, but the guard keeps the picker safe either way.
  const setRawMode =
    "setRawMode" in stdin && typeof stdin.setRawMode === "function"
      ? stdin.setRawMode.bind(stdin)
      : undefined;

  let selected = 0;
  let drawn = 0;
  let buffer = "";
  let finished = false;

  const frame = (): string => {
    const from = Math.max(
      0,
      Math.min(
        selected - Math.floor(maxVisible / 2),
        labels.length - maxVisible,
      ),
    );
    const lines: string[] = [];
    if (drawn === 0 && options.title !== undefined) lines.push(options.title);
    if (from > 0) lines.push("  ↑ more");
    for (let index = from; index < from + maxVisible; index += 1) {
      const label = labels[index];
      if (label === undefined) continue;
      lines.push(`${index === selected ? "❯" : " "} ${label}`);
    }
    if (from + maxVisible < labels.length) lines.push("  ↓ more");
    lines.push(`  ${PICKER_HINT}`);
    return `${lines.join("\n")}\n`;
  };

  const repaint = (): void => {
    const text = frame();
    const painted = text.split("\n").length - 1;
    if (drawn === 0) stdout.write(`\u001b[?25l${text}`);
    else stdout.write(`\u001b[${drawn}A\u001b[J${text}`);
    drawn = painted;
  };

  const finish = (result: number | null): void => {
    if (finished) return;
    finished = true;
    stdin.off("data", onData);
    setRawMode?.(false);
    if (drawn > 0) stdout.write(`\u001b[${drawn}A\u001b[J`);
    stdout.write("\u001b[?25h");
    resolve(result);
  };

  function onData(chunk: Buffer | string): void {
    if (finished) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (buffer.length > 0 && !finished) {
      const { key, rest } = takeKey(buffer);
      if (key === "wait") return;
      buffer = rest;
      if (key === null) continue;
      if (key === "abort") {
        finish(null);
        return;
      }
      if (key === "select") {
        finish(selected);
        return;
      }
      selected =
        key === "up"
          ? (selected + labels.length - 1) % labels.length
          : (selected + 1) % labels.length;
      repaint();
    }
  }

  setRawMode?.(true);
  stdin.on("data", onData);
  repaint();
  return promise;
}
