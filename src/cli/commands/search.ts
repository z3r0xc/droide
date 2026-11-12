/** `search|find` command. Contract: `specs/40-sessions-and-storage.md`. */
import { Command, Option } from "commander";

import { createAppContext } from "../../app/context.ts";
import { openSessionStore } from "../../session/store.ts";
import {
  type SearchCommandOptions,
  runSearchCommand,
} from "../search-command.ts";

export function makeSearchCommand(): Command {
  return new Command("search")
    .alias("find")
    .description(
      "Search across local sessions (messages, documents, tool results)",
    )
    .argument("<query>", "Query text (case-insensitive substring)")
    .addOption(
      new Option(
        "--kind <kind>",
        "Filter by kind: message_text|document|tool_use|tool_result|all",
      ).default("all"),
    )
    .addOption(
      new Option("--limit-sessions <n>", "Max sessions to return").default(20),
    )
    .addOption(
      new Option(
        "--limit-hits <n>",
        "Max matches per session (per kind per session without the session index)",
      ).default(3),
    )
    .addOption(
      new Option(
        "--context-chars <n>",
        "Characters of context around the match",
      ).default(80),
    )
    .option("--json", "Output JSON")
    .option("--reindex", "Bring the session index up to date first")
    .option("--include-archived", "Include archived sessions")
    .option("--exclude-children", "Leave out sessions another session started")
    .option("--include-hidden", "Include sessions with no visible message")
    .action((query: string, options: SearchCommandOptions) => {
      void runSearchCommand(query, options, {
        openStore: async () => {
          const app = await createAppContext();
          return openSessionStore({
            dbPath: app.paths.sessionIndexDatabase,
            sessionsDir: app.paths.sessionsDir,
            clock: { now: () => Date.now() },
          });
        },
        write: (text) => process.stdout.write(text),
        writeError: (text) => process.stderr.write(text),
        setExitCode: (code) => {
          process.exitCode = code;
        },
      });
    });
}
