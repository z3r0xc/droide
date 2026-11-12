import { renderShell } from "./src/ui/render.ts";
import { captureStream, frameLines, shellAt } from "./tests/unit/ui/harness.ts";
const LONG_TEXT = "This paragraph is deliberately long so that it wraps at one width and re-wraps at another, proving the transcript is laid out from the size props rather than cached in a module constant.";
const entries = [
  { kind: "user", text: "hello" },
  { kind: "assistant", text: LONG_TEXT },
  { kind: "tool", name: "Read", params: [["path", "src/a.ts"]], state: "success", result: "line one\nline two" },
] as const;
const { stdout, chunks } = captureStream(120, 40);
const h = await renderShell(shellAt(120, 40, { transcript: [...entries], changelog: true }), { stdout, columns: 120, rows: 40, debug: true });
let b = chunks.length;
await h.rerender(shellAt(80, 30, { transcript: [...entries] }), { columns: 80, rows: 30 });
console.log("chunks after 80x30:", chunks.slice(b).length);
let frame = frameLines(chunks.slice(b).join("\n"));
frame.forEach((l,i)=>console.log(String(i+1).padStart(3), JSON.stringify(l)));
b = chunks.length;
await h.rerender(shellAt(80, 24, { transcript: [...entries] }), { columns: 80, rows: 24 });
console.log("chunks after 80x24:", chunks.slice(b).length, chunks.slice(b).map(c=>c.slice(0,20)));
frame = frameLines(chunks.slice(b).join("\n"));
frame.forEach((l,i)=>console.log(String(i+1).padStart(3), JSON.stringify(l)));
await h.unmount();
