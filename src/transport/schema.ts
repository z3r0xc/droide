/**
 * Reading untrusted JSON at the transport boundary. One canonical
 * `isRecord` guard and the field readers built on it live here, so no caller
 * grows its own copy (see the repo's type-guard rule).
 *
 * Every reader answers `null` for a missing or mistyped field: a payload from
 * a provider may add fields, but it may not change the type of one this build
 * relies on. Callers decide whether a missing field is an error.
 */

/** A plain JSON object: not `null`, not an array, not a primitive. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

export function readNumber(
  source: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBoolean(
  source: Readonly<Record<string, unknown>>,
  key: string,
): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

export function readRecord(
  source: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

export function readArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}