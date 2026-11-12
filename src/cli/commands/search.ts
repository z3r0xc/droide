/** `search|find` command. Contract: `specs/40-sessions-and-storage.md`. */
import { Command, Option } from "commander";

import { notImplemented } from "../not-implemented.ts";

export function makeSearchCommand(): Command {
  return new Command("search")
    .alias("find")
    .description("Search across local sessions (messages, documents, tool results)")
    .argument("<query>", "Query text (case-insensitive substring)")
    .addOption(
      new Option("--kind <kind>", "Filter by kind: message_text|document|tool_use|tool_result|all")
        .default("all"),
    )
    .addOption(new Option("--limit-sessions <n>", "Max sessions to return").default(20))
    .addOption(
      new Option(
        "--limit-hits <n>",
        "Max matches per session (per kind per session without the session index)",
      ).default(3),
    )
    .addOption(new Option("--context-chars <n>", "Characters of context around the match").default(80))
    .option("--json", "Output JSON")
    .option("--reindex", "Bring the session index up to date first")
    .option("--include-archived", "Include archived sessions")
    .option("--exclude-children", "Leave out sessions another session started")
    .option("--include-hidden", "Include sessions with no visible message")
    .action(() => notImplemented("search"));
}