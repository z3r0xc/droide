#!/usr/bin/env node
/**
 * Fake native helper for the TypeScript client tests.
 *
 * Speaks the same v1 protocol as `crates/droide-native`: one JSON request per
 * stdin line, one JSON response per stdout line, same error codes. The mode is
 * the first argument; every mode answers `native.version` first so a client can
 * complete its handshake and then observe the mode's fault.
 *
 * Modes: normal (default), error, malformed, oversized, silent, exit,
 * exit-after-version, wrong-version, stray (answers an id that was never sent),
 * late (answers 60 ms after the client's timeout).
 *
 * When `FAKE_NATIVE_HELPER_PID_FILE` is set, the pid is written there before
 * any I/O so a test can prove the process is gone afterwards.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const MODES = new Set([
  "normal",
  "error",
  "malformed",
  "oversized",
  "silent",
  "exit",
  "exit-after-version",
  "wrong-version",
  "stray",
  "late",
  "bad-shape",
]);
const PROTOCOL = 1;
const MAX_LINE_BYTES = 1 << 20;

const requested = process.argv[2] ?? "normal";
const mode = MODES.has(requested) ? requested : "normal";

const pidFile = process.env.FAKE_NATIVE_HELPER_PID_FILE;
if (pidFile !== undefined && pidFile !== "") {
  writeFileSync(pidFile, String(process.pid));
}

// The client may kill this process mid-write; a pipe error is not a failure.
process.stdout.on("error", () => {});
process.stdin.on("error", () => {});

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendVersion(id, protocol) {
  send({ id, result: { protocol, version: "0.0.0-fake" } });
}

if (mode === "exit") {
  process.exit(3);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "request is not JSON" } });
    return;
  }

  const id = request?.id;
  const method = request?.method;
  if (typeof id !== "number" || typeof method !== "string") {
    send({
      id: null,
      error: { code: -32700, message: "request needs id and method" },
    });
    return;
  }

  if (mode === "wrong-version") {
    sendVersion(id, PROTOCOL + 1);
    return;
  }

  if (mode === "exit-after-version") {
    if (method === "native.version") {
      sendVersion(id, PROTOCOL);
    } else {
      process.exit(4);
    }
    return;
  }

  if (method === "native.version") {
    sendVersion(id, PROTOCOL);
    return;
  }

  if (mode === "silent") {
    return;
  }

  if (mode === "stray") {
    send({ id: id + 9000, result: {} });
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not a response\n");
    return;
  }

  if (mode === "oversized") {
    // No newline: the client must refuse the partial line at its byte cap.
    process.stdout.write("x".repeat(MAX_LINE_BYTES + 1));
    return;
  }

  if (mode === "error") {
    send({
      id,
      error: { code: -32602, message: "params rejected by fake helper" },
    });
    return;
  }

  if (mode === "late" && method === "hash.sha256") {
    const text = request?.params?.text;
    setTimeout(() => {
      send({
        id,
        result: {
          sha256: createHash("sha256").update(String(text)).digest("hex"),
        },
      });
    }, 60);
    return;
  }

  if (mode === "normal" && method === "hash.sha256") {
    const text = request?.params?.text;
    if (typeof text !== "string") {
      send({
        id,
        error: {
          code: -32602,
          message: 'hash.sha256 needs a string param "text"',
        },
      });
      return;
    }
    send({
      id,
      result: { sha256: createHash("sha256").update(text).digest("hex") },
    });
    return;
  }

  // Deterministic answers for the typed-method wrappers. Shapes mirror the Rust
  // helper; `bad-shape` deliberately answers the wrong type so the client's
  // validators can be proven.
  const params = request?.params ?? {};
  if (mode === "bad-shape" && method === "search.walk") {
    send({ id, result: { paths: "not-an-array", truncated: false } });
    return;
  }
  switch (method) {
    case "search.walk":
      send({
        id,
        result: { paths: ["src/a.ts", "README.md"], truncated: params.maxResults === 1 },
      });
      return;
    case "search.text":
      send({
        id,
        result: {
          hits: [{ path: "src/a.ts", line: 2, text: `hit for ${String(params.query ?? "")}` }],
          truncated: false,
          filesScanned: 2,
        },
      });
      return;
    case "sandbox.profile":
      send({
        id,
        result: { mechanism: "bubblewrap", argv: ["--unshare-net", "--"] },
      });
      return;
    case "pty.quote":
      send({ id, result: { commandLine: "echo 'a b'" } });
      return;
    case "path.resolve":
      send({ id, result: { path: `${String(params.root ?? "")}/src/a.ts` } });
      return;
    case "secrets.protect":
      send({ id, result: { sealed: "c2VhbGVk" } });
      return;
    case "secrets.unprotect":
      send({ id, result: { plaintext: "b3Blbg==" } });
      return;
    default:
      send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
});
