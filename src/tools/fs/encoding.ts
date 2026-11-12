/**
 * File encoding and line-ending handling.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B16 (BOM first, then a BOM-less
 * UTF-16 NUL-pattern heuristic, then UTF-8; legacy charsets only when the bytes
 * are not valid UTF-8; content is returned LF-normalised with the BOM stripped)
 * and B21/B25 (a write restores the encoding and line ending it saw).
 */

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "latin1";
export type LineEnding = "lf" | "crlf";

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
  readonly hadBom: boolean;
  readonly lineEnding: LineEnding;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

const SAMPLE_BYTES = 1024;
const NUL_RATIO_THRESHOLD = 0.3;
const OPPOSITE_NUL_RATIO_MAX = 0.1;
const REPLACEMENT_RATIO_MAX = 0.05;
const PRINTABLE_RATIO_MIN = 0.7;

function isUtf8(buffers: Buffer): boolean {
  return Buffer.from(buffers.toString("utf8"), "utf8").equals(buffers);
}

function decodeUtf16(buffer: Buffer, bigEndian: boolean): string {
  const evenLength = buffer.length - (buffer.length % 2);
  const slice = buffer.subarray(0, evenLength);
  if (!bigEndian) return slice.toString("utf16le");
  const swapped = Buffer.from(slice);
  swapped.swap16();
  return swapped.toString("utf16le");
}

function looksLikeText(sample: string): boolean {
  if (sample.length === 0) return false;
  let replacement = 0;
  let printable = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0xfffd) {
      replacement += 1;
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      printable += 1;
      continue;
    }
    if (code >= 0x20 && code !== 0x7f) printable += 1;
  }
  return (
    replacement / sample.length <= REPLACEMENT_RATIO_MAX &&
    printable / sample.length >= PRINTABLE_RATIO_MIN
  );
}

/** The BOM-less UTF-16 guess, or null when the NUL pattern is not decisive. */
function detectUtf16WithoutBom(buffer: Buffer): TextEncoding | null {
  const sampleLength = Math.min(buffer.length, SAMPLE_BYTES);
  if (sampleLength < 2) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) evenNul += 1;
    else oddNul += 1;
  }
  const evenTotal = Math.ceil(sampleLength / 2);
  const oddTotal = Math.floor(sampleLength / 2);
  const evenRatio = evenNul / evenTotal;
  const oddRatio = oddNul / oddTotal;
  if (oddRatio >= NUL_RATIO_THRESHOLD && evenRatio <= OPPOSITE_NUL_RATIO_MAX) {
    const sample = decodeUtf16(
      buffer.subarray(0, sampleLength),
      false,
    ).slice(0, 256);
    return looksLikeText(sample) ? "utf-16le" : null;
  }
  if (evenRatio >= NUL_RATIO_THRESHOLD && oddRatio <= OPPOSITE_NUL_RATIO_MAX) {
    const sample = decodeUtf16(buffer.subarray(0, sampleLength), true).slice(
      0,
      256,
    );
    return looksLikeText(sample) ? "utf-16be" : null;
  }
  return null;
}

/** BOM first, then the UTF-16 NUL-pattern heuristic, then UTF-8/latin1. */
export function detectEncoding(buffer: Buffer): TextEncoding {
  if (buffer.length >= 2) {
    if (buffer[0] === UTF16LE_BOM[0] && buffer[1] === UTF16LE_BOM[1]) {
      return "utf-16le";
    }
    if (buffer[0] === UTF16BE_BOM[0] && buffer[1] === UTF16BE_BOM[1]) {
      return "utf-16be";
    }
  }
  const withoutBom =
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
      ? buffer.subarray(3)
      : buffer;
  const utf16 = detectUtf16WithoutBom(withoutBom);
  if (utf16 !== null) return utf16;
  return isUtf8(withoutBom) ? "utf-8" : "latin1";
}

/** CRLF and a lone CR both normalise to LF. */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function detectLineEnding(text: string): LineEnding {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "crlf" : "lf";
}

/** Decodes a buffer to LF-normalised text with the BOM removed. */
export function decodeText(buffer: Buffer): DecodedText {
  const encoding = detectEncoding(buffer);
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const hadBom =
      buffer.length >= 2 &&
      ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
        (buffer[0] === 0xfe && buffer[1] === 0xff));
    const decoded = decodeUtf16(buffer, encoding === "utf-16be").replace(
      /^\uFEFF/,
      "",
    );
    return {
      text: normalizeToLF(decoded),
      encoding,
      hadBom,
      lineEnding: detectLineEnding(decoded),
    };
  }
  const hadBom =
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2];
  const body = hadBom ? buffer.subarray(3) : buffer;
  const decoded = body.toString(encoding === "latin1" ? "latin1" : "utf8");
  return {
    text: normalizeToLF(decoded),
    encoding,
    hadBom,
    lineEnding: detectLineEnding(decoded),
  };
}

/** Encodes LF-normalised text back to the bytes a write should produce. */
export function encodeText(
  text: string,
  encoding: TextEncoding,
  hadBom: boolean,
  lineEnding: LineEnding,
): Buffer {
  const withEndings = lineEnding === "crlf" ? text.replace(/\n/g, "\r\n") : text;
  if (encoding === "utf-16le") {
    const body = Buffer.from(withEndings, "utf16le");
    return hadBom
      ? Buffer.concat([Buffer.from(UTF16LE_BOM), body])
      : body;
  }
  if (encoding === "utf-16be") {
    const body = Buffer.from(withEndings, "utf16le");
    body.swap16();
    return hadBom ? Buffer.concat([Buffer.from(UTF16BE_BOM), body]) : body;
  }
  if (encoding === "latin1") {
    return Buffer.from(withEndings, "latin1");
  }
  const body = Buffer.from(withEndings, "utf8");
  return hadBom ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body;
}