import { renderShell } from "./src/ui/render.ts";
import { captureStream, frameLines, shellAt, scriptedTranscript } from "./tests/unit/ui/harness.ts";

async function dump(columns: number, rows: number, transcript: boolean, changelog: boolean, label: string) {
  const { stdout, chunks } = captureStream(columns, rows);
  const handle = await renderShell(
    shellAt(columns, rows, { transcript: transcript ? scriptedTranscript() : [], changelog }),
    { stdout, columns, rows, debug: true },
  );
  const frame = frameLines(chunks[0] ?? "");
  console.log(`=== ${label} (${frame.length} rows) ===`);
  frame.forEach((line, i) => console.log(String(i + 1).padStart(3), JSON.stringify(line)));
  await handle.unmount();
}
await dump(80, 24, false, false, "80x24");
await dump(120, 40, true, true, "120x40");
