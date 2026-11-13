/**
 * `exec --list-tools`.
 *
 * Contract: `specs/80-exec-and-streaming.md` §B53. Two renderings:
 *
 *  - `-o json` → one line, a JSON array of
 *    `{id, llmId, displayName, description, category, defaultAllowed, currentlyAllowed}`;
 *  - any other format → `Available tools for <model>`, `Autonomy: <autonomy>`,
 *    then category sections with
 *    `  • <llmId> (<displayName>) - status: allowed|blocked[ override]`.
 *
 * `defaultAllowed` is our derivation: membership of the catalogue at the
 * strictest autonomy (`off`). The field's presence and type are contractual,
 * which is what the clause pins.
 */
import type { ToolDefinition } from "../tools/registry.ts";

export interface ToolListRow {
  readonly id: string;
  readonly llmId: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly defaultAllowed: boolean;
  readonly currentlyAllowed: boolean;
}

export interface ToolListHeader {
  readonly model: string;
  readonly autonomy: string;
}

/** Build the rows once, so both renderings describe the same state. */
export function buildToolListRows(
  registry: readonly ToolDefinition[],
  currentlyAllowed: ReadonlySet<string>,
  defaultAllowed: ReadonlySet<string>,
): readonly ToolListRow[] {
  return registry
    .map((definition) => ({
      id: definition.id,
      llmId: definition.llmId,
      displayName: definition.displayName,
      description: definition.description,
      category: definition.category ?? "Other",
      defaultAllowed: defaultAllowed.has(definition.llmId),
      currentlyAllowed: currentlyAllowed.has(definition.llmId),
    }))
    .sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.llmId.localeCompare(right.llmId),
    );
}

/** `-o json`: one line, no trailing spaces. */
export function renderToolListJson(rows: readonly ToolListRow[]): string {
  return `${JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      llmId: row.llmId,
      displayName: row.displayName,
      description: row.description,
      category: row.category,
      defaultAllowed: row.defaultAllowed,
      currentlyAllowed: row.currentlyAllowed,
    })),
  )}\n`;
}

/** The text listing used by every non-JSON format (§B53). */
export function renderToolListText(
  rows: readonly ToolListRow[],
  header: ToolListHeader,
): string {
  const lines = [
    `Available tools for ${header.model}`,
    `Autonomy: ${header.autonomy}`,
  ];
  const categories = [...new Set(rows.map((row) => row.category))];

  for (const category of categories) {
    lines.push("", category);
    for (const row of rows.filter((entry) => entry.category === category)) {
      const status = row.currentlyAllowed ? "allowed" : "blocked";
      const override =
        row.defaultAllowed === row.currentlyAllowed ? "" : " override";
      lines.push(
        `  • ${row.llmId} (${row.displayName}) - status: ${status}${override}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
