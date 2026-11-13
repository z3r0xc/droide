/**
 * Secret scrubbing for `Edit` matching.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B22 — the uniqueness match runs
 * against a scrubbed view of the file, so an `old_str` that reproduces a
 * credential the model never saw cannot match. Each credential-shaped span is
 * replaced by {@link REDACTION_MARKER}; the original offsets are kept, so a
 * match that starts and ends outside a redacted span splices into the original
 * bytes unchanged. The marker never reaches the file.
 */
import type { Environment } from "../../config/paths.ts";

/** The fixed marker every credential-shaped span is replaced with. */
export const REDACTION_MARKER = "[redacted]";

/** Shorter environment values are not plausibly credentials. */
const MIN_ENV_SECRET_LENGTH = 8;

export interface RedactionSpan {
  readonly start: number;
  readonly end: number;
}

/** One run of the scrubbed view and the original bytes it came from. */
export interface ScrubbedSegment {
  readonly textStart: number;
  readonly textLength: number;
  readonly originalStart: number;
  readonly originalLength: number;
  readonly redacted: boolean;
}

export interface ScrubbedText {
  readonly text: string;
  readonly spans: readonly RedactionSpan[];
  readonly segments: readonly ScrubbedSegment[];
}

/** A whole private-key block, header through footer. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/dg;

/** An auth-scheme credential: `Bearer`/`Basic`/`Token` and an opaque value. */
const AUTH_SCHEME = /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/-]{16,}=*)/dg;

/** Provider-shaped API keys. */
const PROVIDER_KEY =
  /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/dg;

/** A JSON Web Token: three base64url segments after the `eyJ` header. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg;

/**
 * A credential assignment: the value after `password=`, `token:`, `api_key=`
 * and friends — quoted at 6+ characters, else an unquoted opaque value of 12+.
 */
const ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([A-Za-z0-9._~+/-]{12,}))/dgi;

function addSpan(
  text: string,
  pattern: RegExp,
  group: number,
  spans: RedactionSpan[],
): void {
  for (const match of text.matchAll(pattern)) {
    const range = match.indices?.[group];
    if (range === undefined) continue;
    spans.push({ start: range[0], end: range[1] });
  }
}

function addAssignmentSpans(text: string, spans: RedactionSpan[]): void {
  for (const match of text.matchAll(ASSIGNMENT)) {
    for (const group of [1, 2, 3]) {
      const range = match.indices?.[group];
      if (range !== undefined) spans.push({ start: range[0], end: range[1] });
    }
  }
}

function addValueSpans(
  text: string,
  value: string,
  spans: RedactionSpan[],
): void {
  for (
    let start = text.indexOf(value);
    start !== -1;
    start = text.indexOf(value, start + value.length)
  ) {
    spans.push({ start, end: start + value.length });
  }
}

/** Sorted, non-overlapping spans; a later span that overlaps is folded in. */
function mergeSpans(spans: RedactionSpan[]): RedactionSpan[] {
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RedactionSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end)
        merged[merged.length - 1] = { ...last, end: span.end };
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

function buildView(
  text: string,
  spans: readonly RedactionSpan[],
): ScrubbedText {
  if (spans.length === 0) {
    return {
      text,
      spans,
      segments: [
        {
          textStart: 0,
          textLength: text.length,
          originalStart: 0,
          originalLength: text.length,
          redacted: false,
        },
      ],
    };
  }
  const segments: ScrubbedSegment[] = [];
  let view = "";
  let cursor = 0;
  const addLiteral = (start: number, end: number): void => {
    if (end <= start) return;
    segments.push({
      textStart: view.length,
      textLength: end - start,
      originalStart: start,
      originalLength: end - start,
      redacted: false,
    });
    view += text.slice(start, end);
  };
  for (const span of spans) {
    addLiteral(cursor, span.start);
    segments.push({
      textStart: view.length,
      textLength: REDACTION_MARKER.length,
      originalStart: span.start,
      originalLength: span.end - span.start,
      redacted: true,
    });
    view += REDACTION_MARKER;
    cursor = span.end;
  }
  addLiteral(cursor, text.length);
  return { text: view, spans, segments };
}

/** The environment credentials `Edit` must never see: `DROIDE_API_KEY` (B22). */
export function secretValuesFromEnvironment(
  environment: Environment,
): string[] {
  const value = environment.env.DROIDE_API_KEY?.trim();
  return value !== undefined && value.length >= MIN_ENV_SECRET_LENGTH
    ? [value]
    : [];
}

/**
 * `text` with every credential-shaped span replaced by {@link REDACTION_MARKER}.
 * `secretValues` are extra literals to redact wherever they occur — the
 * environment credentials seen by this process.
 */
export function scrubSecrets(
  text: string,
  secretValues: readonly string[] = [],
): ScrubbedText {
  if (text === "") return buildView(text, []);
  const spans: RedactionSpan[] = [];
  addSpan(text, PRIVATE_KEY_BLOCK, 0, spans);
  addSpan(text, AUTH_SCHEME, 1, spans);
  addSpan(text, PROVIDER_KEY, 0, spans);
  addSpan(text, JWT, 0, spans);
  addAssignmentSpans(text, spans);
  for (const value of secretValues) {
    if (value.length >= MIN_ENV_SECRET_LENGTH)
      addValueSpans(text, value, spans);
  }
  return buildView(text, mergeSpans(spans));
}

function intersectsRedaction(
  scrubbed: ScrubbedText,
  start: number,
  end: number,
): boolean {
  return scrubbed.segments.some(
    (segment) =>
      segment.redacted &&
      segment.textStart < end &&
      start < segment.textStart + segment.textLength,
  );
}

/** The original offset `index` in the scrubbed view maps to, if any. */
function originalOffsetOf(
  scrubbed: ScrubbedText,
  index: number,
): number | null {
  for (const segment of scrubbed.segments) {
    if (index < segment.textStart) return null;
    if (index > segment.textStart + segment.textLength) continue;
    if (!segment.redacted) {
      return segment.originalStart + (index - segment.textStart);
    }
    if (index === segment.textStart) return segment.originalStart;
    if (index === segment.textStart + segment.textLength) {
      return segment.originalStart + segment.originalLength;
    }
    return null;
  }
  return null;
}

/**
 * Every non-overlapping occurrence of `needle` in the scrubbed view that lies
 * wholly outside a redacted span, as ranges of the original text. An
 * `old_str` that reproduces (or overlaps) a credential has no match.
 */
export function findScrubbedMatches(
  scrubbed: ScrubbedText,
  needle: string,
): RedactionSpan[] {
  const matches: RedactionSpan[] = [];
  if (needle === "") return matches;
  let from = scrubbed.text.indexOf(needle);
  while (from !== -1) {
    const end = from + needle.length;
    if (!intersectsRedaction(scrubbed, from, end)) {
      const start = originalOffsetOf(scrubbed, from);
      const mappedEnd = originalOffsetOf(scrubbed, end);
      if (start !== null && mappedEnd !== null) {
        matches.push({ start, end: mappedEnd });
      }
    }
    from = scrubbed.text.indexOf(needle, end);
  }
  return matches;
}
