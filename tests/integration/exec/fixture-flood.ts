/**
 * Child process for the broken-pipe integration test: it keeps writing records
 * after the parent drops the read end, and must still exit `0`.
 */
import { runOneShot, type TurnOutcome, type TurnRunner } from "../../../src/exec/turn.ts";
import { createJsonLineWriter } from "../../../src/exec/writer.ts";

const runner: TurnRunner = {
  async run(_request, sink): Promise<TurnOutcome> {
    for (let index = 0; index < 512; index += 1) {
      await sink.assistant({
        id: `m${index}`,
        blocks: [{ kind: "text", text: "x".repeat(4096) }],
      });
    }
    return {
      kind: "completed",
      finalText: "Done.",
      numTurns: 512,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        factory_credits: 0,
        thinking_tokens: 0,
      },
    };
  },
};

const code = await runOneShot(
  runner,
  {
    prompt: "flood",
    cwd: "/work",
    sessionId: "sid",
    messageId: "u1",
    model: "custom:mock",
    reasoningEffort: "low",
    tools: [],
    clock: () => 0,
  },
  createJsonLineWriter(process.stdout),
);
process.exitCode = code;