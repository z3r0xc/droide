/**
 * Result budgets and the middle cut.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B11/B12 (two byte budgets, head +
 * notice + tail cut on UTF-8 code-point boundaries) and B13/B27 (an output past
 * 32 MiB is refused, not cut).
 */

/** Default model-facing budget for a tool result (B11). */
export const MODEL_RESULT_BUDGET_BYTES = 32 * 1024;

/** Budget for content the model asked for by name: Read, Task, text() (B11). */
export const MODEL_TEXT_BUDGET_BYTES = 64 * 1024;

/** The largest program output returned inline; past it the call is refused. */
export const MAX_INLINE_OUTPUT_BYTES = 32 * 1024 * 1024;

const NOTICE_SEPARATOR = "\n\n";

export interface BoundedText {
  readonly text: string;
  readonly cutBytes: number;
  readonly totalBytes: number;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The one notice every cut carries (B12). */
export function cutNotice(
  cutBytes: number,
  totalBytes: number,
  whole: string,
): string {
  return `[... ${cutBytes} bytes cut from the middle of ${totalBytes}; whole output: ${whole}]`;
}

/** The largest index `<= limit` that does not split a UTF-8 code point. */
function codePointStart(encoded: Buffer, index: number): number {
  let position = Math.max(0, Math.min(index, encoded.length));
  while (position > 0 && position < encoded.length) {
    const byte = encoded[position];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    position -= 1;
  }
  return position;
}

function codePointEnd(encoded: Buffer, index: number): number {
  let position = Math.max(0, Math.min(index, encoded.length));
  while (position < encoded.length) {
    const byte = encoded[position];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    position += 1;
  }
  return position;
}

function totalBytesAfterCut(
  totalBytes: number,
  budget: number,
  whole: string,
): number {
  // The notice is rendered with `totalBytes` in both slots, an upper bound on
  // its own length, so the kept region never overflows the budget.
  const noticeBytes =
    Buffer.byteLength(cutNotice(totalBytes, totalBytes, whole), "utf8") +
    2 * NOTICE_SEPARATOR.length;
  return Math.max(0, Math.min(budget - noticeBytes, totalBytes));
}

/**
 * `text` whole when it fits `budget`, else head + notice + tail within the
 * budget, cut on code-point boundaries. A budget too small for the notice keeps
 * only the notice (B12).
 */
export function boundText(
  text: string,
  budget: number,
  whole: string,
): BoundedText {
  const encoded = Buffer.from(text, "utf8");
  const totalBytes = encoded.length;
  if (totalBytes <= budget) {
    return { text, cutBytes: 0, totalBytes };
  }
  const kept = totalBytesAfterCut(totalBytes, budget, whole);
  const headBytes = Math.floor(kept / 2);
  const tailBytes = kept - headBytes;
  const headEnd = codePointEnd(encoded, headBytes);
  const tailStart = codePointStart(encoded, totalBytes - tailBytes);
  const head = encoded.subarray(0, headEnd).toString("utf8");
  const tail = encoded.subarray(tailStart).toString("utf8");
  const cutBytes = tailStart - headEnd;
  const parts = [head, cutNotice(cutBytes, totalBytes, whole), tail].filter(
    (part) => part !== "",
  );
  return {
    text: parts.join(NOTICE_SEPARATOR),
    cutBytes,
    totalBytes,
  };
}
