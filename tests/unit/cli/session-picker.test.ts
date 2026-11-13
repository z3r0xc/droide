/**
 * The terminal session picker (`specs/10-cli-surface.md` B22 / ADR 0012).
 *
 * Keystrokes arrive as the bytes a terminal sends; the drawn frames are the
 * captured writes. Every case proves the keyboard was handed back: no data
 * listener left on stdin and raw mode restored.
 */
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import {
  PICKER_HINT,
  runSessionPicker,
} from "../../../src/cli/session-picker.ts";

interface FakeTerminal {
  readonly stdin: NodeJS.ReadStream & { readonly rawModes: boolean[] };
  readonly stdout: NodeJS.WriteStream;
  write(text: string): void;
  text(): string;
}

function fakeTerminal(): FakeTerminal {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const stdout = Object.assign(sink, {
    columns: 80,
    rows: 24,
    isTTY: true,
  }) as unknown as NodeJS.WriteStream;

  const input = new PassThrough();
  const rawModes: boolean[] = [];
  const stdin = Object.assign(input, {
    isTTY: true,
    rawModes,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
  }) as unknown as FakeTerminal["stdin"];

  return {
    stdin,
    stdout,
    write(text) {
      input.write(text);
    },
    text() {
      return chunks.join("");
    },
  };
}

const LABELS = ["id-a  Alpha", "id-b  Beta", "id-c  Gamma"];

test("Enter takes the first row", async () => {
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(LABELS, terminal, { title: "Resume:" });
  assert.equal(terminal.stdin.listenerCount("data"), 1);
  assert.deepEqual(terminal.stdin.rawModes, [true]);

  terminal.write("\r");
  assert.equal(await chosen, 0);
  assert.equal(terminal.stdin.listenerCount("data"), 0);
  assert.deepEqual(terminal.stdin.rawModes, [true, false]);
  assert.ok(terminal.text().includes("Resume:"));
  assert.ok(terminal.text().includes(PICKER_HINT));
});

test("the down arrow moves the pointer and Enter takes that row", async () => {
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(LABELS, terminal);

  terminal.write("\u001b[B");
  terminal.write("\u001b[B");
  terminal.write("\r");
  assert.equal(await chosen, 2);
  assert.ok(terminal.text().includes("❯ id-c  Gamma"));
});

test("k and j move without an arrow sequence", async () => {
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(LABELS, terminal);

  terminal.write("j");
  terminal.write("k");
  terminal.write("j");
  terminal.write("\n");
  assert.equal(await chosen, 1);
});

test("moving up from the first row wraps to the last", async () => {
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(LABELS, terminal);

  terminal.write("\u001b[A");
  terminal.write("\r");
  assert.equal(await chosen, 2);
});

test("q aborts, and Ctrl+C with it", async () => {
  for (const abort of ["q", "\u0003"]) {
    const terminal = fakeTerminal();
    const chosen = runSessionPicker(LABELS, terminal);
    terminal.write(abort);
    assert.equal(await chosen, null);
    assert.equal(terminal.stdin.listenerCount("data"), 0);
    assert.deepEqual(terminal.stdin.rawModes, [true, false]);
  }
});

test("a lone Escape is ignored; the next key still works", async () => {
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(LABELS, terminal);

  terminal.write("\u001b");
  terminal.write("\r");
  assert.equal(await chosen, 0);
});

test("keys split across chunks are read in order", async () => {
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(LABELS, terminal);

  terminal.write("\u001b");
  terminal.write("[B");
  terminal.write("\r");
  assert.equal(await chosen, 1);
});

test("an empty list resolves without touching the streams", async () => {
  const terminal = fakeTerminal();
  assert.equal(await runSessionPicker([], terminal), null);
  assert.deepEqual(terminal.stdin.rawModes, []);
  assert.equal(terminal.stdin.listenerCount("data"), 0);
  assert.equal(terminal.text(), "");
});

test("a long list scrolls around the selection", async () => {
  const labels = Array.from({ length: 20 }, (_, index) => `row-${index}`);
  const terminal = fakeTerminal();
  const chosen = runSessionPicker(labels, terminal, { maxVisible: 5 });

  for (let step = 0; step < 8; step += 1) terminal.write("\u001b[B");
  terminal.write("\r");
  assert.equal(await chosen, 8);
  const text = terminal.text();
  assert.ok(text.includes("↑ more"), "the hidden rows above are marked");
  assert.ok(text.includes("↓ more"), "the hidden rows below are marked");
  assert.ok(text.includes("❯ row-8"));
});
