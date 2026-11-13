/**
 * Child process for the stdout-purity integration test. It drives the real
 * `runOneShot` over `process.stdout` and prints nothing else.
 */
import {
  runOneShot,
  type TurnOutcome,
  type TurnRunner,
} from "../../../src/exec/turn.ts";
import { createJsonLineWriter } from "../../../src/exec/writer.ts";

const runner: TurnRunner = {
  async run(_request, sink): Promise<TurnOutcome> {
    await sink.assistant({
      id: "m1",
      blocks: [
        {
          kind: "tool_use",
          toolUseId: "t1",
          name: "Read",
          input: { file_path: "fixture.txt" },
        },
      ],
    });
    await sink.toolResult({
      toolUseId: "t1",
      messageId: "r1",
      isError: false,
      text: "hello fixture\n",
    });
    await sink.assistant({
      id: "m2",
      blocks: [{ kind: "text", text: "Done." }],
    });
    return {
      kind: "completed",
      finalText: "Done.",
      numTurns: 2,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        droide_credits: 0,
        thinking_tokens: 0,
      },
    };
  },
};

const code = await runOneShot(
  runner,
  {
    prompt: "read fixture.txt",
    cwd: "/work",
    sessionId: "sid",
    messageId: "u1",
    model: "custom:mock",
    reasoningEffort: "low",
    tools: ["Read"],
    clock: () => 0,
  },
  createJsonLineWriter(process.stdout),
);
process.exitCode = code;
