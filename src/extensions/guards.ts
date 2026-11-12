/**
 * Shared runtime shape guard for untrusted documents (JSON settings, MCP
 * configs, manifests). Fields stay `unknown`; callers narrow each one.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
