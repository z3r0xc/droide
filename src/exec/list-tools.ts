/**
 * `exec --list-tools`.
 *
 * Contract: `specs/80-exec-and-streaming.md` §B9 (the flag exists, the catalogue
 * order is registration order) with one clean-room addition recorded in that
 * spec: the *layout* below is ours, because the subject's rendering was not
 * recovered. It prints what a user needs to pass to `--only-tools` /
 * `--add-tools`: the model-facing name, the registry id and a one-line purpose.
 */
import type { ToolDefinition } from "../tools/registry.ts";
import type { LlmToolDefinition } from "../transport/llm.ts";

export interface ToolListHeader {
  readonly model: string;
  readonly autonomy: string;
  /** Tools the model will be offered, after filtering. */
  readonly offered: number;
  /** Tools known to the registry but not offered this run. */
  readonly withheld: number;
}

const MAX_DESCRIPTION = 96;

function truncate(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= MAX_DESCRIPTION
    ? single
    : `${single.slice(0, MAX_DESCRIPTION - 1)}…`;
}

/**
 * Render the listing from the registry (every tool, including the ones withheld
 * from this run) and the catalogue that will actually be sent to the provider.
 */
export function renderToolList(
  registry: readonly ToolDefinition[],
  catalogue: readonly LlmToolDefinition[],
  header: ToolListHeader,
): string {
  const offered = new Set(catalogue.map((tool) => tool.name));
  const rows = registry
    .map((definition) => ({
      llmId: definition.llmId,
      id: definition.id,
      description: truncate(definition.description),
      offered: offered.has(definition.llmId),
    }))
    .sort(
      (left, right) =>
        left.llmId.localeCompare(right.llmId) ||
        left.id.localeCompare(right.id),
    );

  const nameWidth = Math.max(4, ...rows.map((row) => row.llmId.length));
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length));

  const lines = [
    `Tools for model ${header.model} (autonomy: ${header.autonomy}) — ${header.offered} offered, ${header.withheld} withheld`,
  ];
  for (const row of rows) {
    const marker = row.offered ? " " : "-";
    lines.push(
      `  ${marker} ${row.llmId.padEnd(nameWidth)}  ${row.id.padEnd(idWidth)}  ${row.description}`,
    );
  }
  lines.push(
    "",
    "A leading '-' marks a tool that is configured but not offered to this model.",
  );
  return `${lines.join("\n")}\n`;
}
