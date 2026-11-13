/**
 * A stored transcript, read back as the two things the shell needs.
 *
 * Contract: `specs/10-cli-surface.md` B22 (a resumed shell starts with the
 * stored turns) and `specs/40-sessions-and-storage.md` (the transcript record
 * shapes). The mapping is deliberately read-only and side-effect free: the
 * transcript is the durable artefact, so resuming renders what is stored and
 * appends nothing. The model context is the same records read as loop
 * messages, which is what `exec -s` already does (`src/exec/session.ts`).
 */
import type { Message } from "../agent/messages.ts";
import { messageFromRecord } from "../exec/session.ts";
import { isJsonObject, type JsonObject } from "../session/transcript.ts";
import type { TranscriptEntry, ToolParam } from "../ui/transcript.ts";

/** What a resumed shell is seeded with; both sides are oldest first. */
export interface SessionSeed {
  /** Rows the shell paints before the user types anything. */
  readonly entries: readonly TranscriptEntry[];
  /** The conversation the next turn's request extends. */
  readonly messages: readonly Message[];
}

export const EMPTY_SEED: SessionSeed = { entries: [], messages: [] };

/**
 * Tool parameters as the row renders them: strings verbatim, everything else
 * through `JSON.stringify`, exactly as a live `tool_call` event is rendered.
 */
function paramsOf(input: unknown): readonly ToolParam[] {
  if (!isJsonObject(input)) return [];
  const params: ToolParam[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      params.push([key, value]);
      continue;
    }
    try {
      params.push([key, JSON.stringify(value) ?? String(value)]);
    } catch {
      params.push([key, String(value)]);
    }
  }
  return params;
}

/** A tool result's display text; images never carry their bytes into a row. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isJsonObject(part)) return "";
      if (part["type"] === "text") {
        return typeof part["text"] === "string" ? part["text"] : "";
      }
      return part["type"] === "image" ? "placeholder" : "[document]";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * One transcript, as rows and as context.
 *
 * Message records become rows by role: a user message is one `user` row (its
 * text blocks joined), an assistant message is one `assistant` row plus one
 * `tool` row per `tool_use`, and a tool message settles those rows with the
 * matching `tool_result`. Records that are not messages — `completion`,
 * `session_start` — add no row; an `error` record becomes a `notice` so a
 * stored failure is visible instead of silently skipped.
 *
 * Every readable message joins the context, including records whose prose was
 * empty and therefore produced no row: the model's history must stay complete
 * even where the renderer has nothing to show.
 */
export function seedFromRecords(records: readonly JsonObject[]): SessionSeed {
  const entries: TranscriptEntry[] = [];
  const messages: Message[] = [];
  const callRows = new Map<string, number>();

  for (const record of records) {
    const message = messageFromRecord(record);
    if (message === undefined) {
      const type = record["type"];
      const text = record["message"];
      if (type === "error" && typeof text === "string" && text.length > 0) {
        entries.push({ kind: "notice", text: `Error: ${text}` });
      }
      continue;
    }
    messages.push(message);

    switch (message.role) {
      case "user": {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text.length > 0)
          entries.push({ kind: "user", text, specMode: false });
        break;
      }
      case "assistant": {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text.length > 0) entries.push({ kind: "assistant", text });
        for (const block of message.content) {
          if (block.type !== "tool_use") continue;
          callRows.set(block.id, entries.length);
          entries.push({
            kind: "tool",
            name: block.name,
            params: paramsOf(block.input),
            suffix: undefined,
            state: "pending",
            result: undefined,
            interrupted: false,
          });
        }
        break;
      }
      case "tool": {
        for (const block of message.content) {
          if (block.type !== "tool_result") continue;
          const row = callRows.get(block.toolUseId);
          if (row === undefined) continue;
          const entry = entries[row];
          if (entry === undefined) continue;
          entries[row] = {
            ...entry,
            state: block.isError === true ? "error" : "success",
            result: resultText(block.content),
          };
        }
        break;
      }
      case "system":
        break;
    }
  }

  // A call with no stored result was cut off (an interrupt, a crash): it is
  // shown as an interrupted error rather than as a call still running.
  for (const row of callRows.values()) {
    const entry = entries[row];
    if (entry === undefined || entry["state"] !== "pending") continue;
    entries[row] = { ...entry, state: "error", interrupted: true };
  }

  return { entries, messages };
}
