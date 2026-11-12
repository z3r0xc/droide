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
 * late (answers 60 ms after the client's timeout), bad-shape (a wrong field
 * type the client's validators must reject), search (real `search.walk`,
 * `search.text` and `path.resolve` answers over the filesystem, mirroring the
 * Rust helper's bounds, so the tool backend can be tested without cargo).
 *
 * When `FAKE_NATIVE_HELPER_PID_FILE` is set, the pid is written there before
 * any I/O so a test can prove the process is gone afterwards.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
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
  "secrets",
  "search",
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

function flip(value) {
  const bytes = Buffer.from(value, "base64");
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = bytes[index] ^ 0x5a;
  }
  return bytes.toString("base64");
}

function sendVersion(id, protocol) {
  send({ id, result: { protocol, version: "0.0.0-fake" } });
}

if (mode === "exit") {
  process.exit(3);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".jj"]);
const MAX_WALK_LIMIT = 10_000;
const MAX_HITS_LIMIT = 1_000;
const MAX_FILE_BYTES = 1 << 20;
const MAX_DEPTH = 64;

function isHidden(name) {
  return name.startsWith(".") && name !== "." && name !== "..";
}

/** Port of `search.rs`'s `*` / `**` / `?` matcher; tests pass no glob anyway. */
function globMatches(pattern, path) {
  const matchFrom = (p, s) => {
    while (p < pattern.length) {
      const char = pattern[p];
      if (char === "*") {
        const double = pattern[p + 1] === "*";
        const next = p + (double ? 2 : 1);
        const skipSlash = double && pattern[next] === "/";
        if (skipSlash && matchFrom(next + 1, s)) return true;
        let cursor = s;
        for (;;) {
          if (matchFrom(next, cursor)) return true;
          if (cursor >= path.length) return false;
          const seen = path[cursor];
          cursor += 1;
          if (!double && seen === "/") return false;
        }
      }
      if (char === "?") {
        if (s >= path.length || path[s] === "/") return false;
        p += 1;
        s += 1;
        continue;
      }
      if (s >= path.length || path[s] !== char) return false;
      p += 1;
      s += 1;
    }
    return s === path.length;
  };
  return matchFrom(0, 0);
}

function fakeWalk(root, options) {
  const maxResults = Math.min(
    Math.max(options.maxResults ?? 1_000, 1),
    MAX_WALK_LIMIT,
  );
  const paths = [];
  let truncated = false;
  const stack = [[root, 0]];
  while (stack.length > 0) {
    const [directory, depth] = stack.pop();
    if (depth > MAX_DEPTH) {
      truncated = true;
      continue;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = nodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (isHidden(entry.name) && options.includeHidden !== true) continue;
        stack.push([absolute, depth + 1]);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isHidden(entry.name) && options.includeHidden !== true) continue;
      const relative = nodePath
        .relative(root, absolute)
        .split(nodePath.sep)
        .join("/");
      if (options.glob !== undefined && !globMatches(options.glob, relative)) {
        continue;
      }
      if (paths.length >= maxResults) {
        truncated = true;
        return { paths, truncated };
      }
      paths.push(relative);
    }
  }
  paths.sort();
  return { paths, truncated };
}

function fakeTextSearch(root, params) {
  const query = typeof params.query === "string" ? params.query : "";
  if (query === "") return { error: "query must not be empty" };
  const maxHits = Math.min(Math.max(params.maxHits ?? 100, 1), MAX_HITS_LIMIT);
  const caseSensitive = params.caseSensitive === true;
  const discovery = fakeWalk(root, {
    maxResults: MAX_WALK_LIMIT,
    includeHidden: params.includeHidden === true,
  });
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits = [];
  let filesScanned = 0;
  for (const relative of discovery.paths) {
    const absolute = nodePath.join(root, ...relative.split("/"));
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) continue;
    let bytes;
    try {
      bytes = readFileSync(absolute);
    } catch {
      continue;
    }
    if (bytes.subarray(0, 4096).includes(0)) continue;
    filesScanned += 1;
    const lines = bytes.toString("utf8").split("\n");
    for (const [index, raw] of lines.entries()) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (hits.length >= maxHits) {
        return { hits, truncated: true, filesScanned };
      }
      hits.push({ path: relative, line: index + 1, text: line.slice(0, 400) });
    }
  }
  return { hits, truncated: false, filesScanned };
}

function fakeResolve(root, candidate) {
  if (candidate === "") return { error: "path is empty" };
  const joined = nodePath.isAbsolute(candidate)
    ? candidate
    : nodePath.join(root, candidate);
  const normalised = nodePath.normalize(joined);
  const relation = nodePath.relative(root, normalised);
  if (relation.startsWith("..") || nodePath.isAbsolute(relation)) {
    return { error: "path is outside the workspace root" };
  }
  return { path: normalised.split(nodePath.sep).join("/") };
}

/** Search mode: the three calls the tool backend makes, answered for real. */
function answerSearch(id, method, params) {
  const root = typeof params.root === "string" ? params.root : ".";
  if (method === "search.walk") {
    send({ id, result: fakeWalk(root, params) });
    return;
  }
  if (method === "search.text") {
    const result = fakeTextSearch(root, params);
    if (result.error !== undefined) {
      send({ id, error: { code: -32602, message: result.error } });
      return;
    }
    send({ id, result });
    return;
  }
  if (method === "path.resolve") {
    const candidate = typeof params.path === "string" ? params.path : "";
    const result = fakeResolve(root, candidate);
    if (result.error !== undefined) {
      send({ id, error: { code: -32602, message: result.error } });
      return;
    }
    send({ id, result });
    return;
  }
  send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
}

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

  if (mode === "search") {
    answerSearch(id, method, request?.params ?? {});
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

  // A real round-trip, so the sealer adapter can be proven end to end: the
  // transform is reversible but not the identity (0x5a is flipped on every
  // byte), which is all the adapter needs to show base64 in and out.
  if (mode === "secrets" && method === "secrets.protect") {
    const plaintext = params.plaintext;
    if (typeof plaintext !== "string") {
      send({
        id,
        error: { code: -32602, message: "secrets.protect needs plaintext" },
      });
      return;
    }
    send({ id, result: { sealed: flip(plaintext) } });
    return;
  }
  if (mode === "secrets" && method === "secrets.unprotect") {
    const sealed = params.sealed;
    if (typeof sealed !== "string") {
      send({
        id,
        error: { code: -32602, message: "secrets.unprotect needs sealed" },
      });
      return;
    }
    send({ id, result: { plaintext: flip(sealed) } });
    return;
  }

  if (mode === "bad-shape" && method === "search.walk") {
    send({ id, result: { paths: "not-an-array", truncated: false } });
    return;
  }
  switch (method) {
    case "search.walk":
      send({
        id,
        result: {
          paths: ["src/a.ts", "README.md"],
          truncated: params.maxResults === 1,
        },
      });
      return;
    case "search.text":
      send({
        id,
        result: {
          hits: [
            {
              path: "src/a.ts",
              line: 2,
              text: `hit for ${String(params.query ?? "")}`,
            },
          ],
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
    case "pty.spawn":
      send({ id, result: { sessionId: "fixture-session" } });
      return;
    case "pty.read":
      send({ id, result: { data: "aGk=", exited: false, exitCode: null } });
      return;
    case "pty.write":
      send({ id, result: { written: String(params.data ?? "").length } });
      return;
    case "pty.resize":
      send({ id, result: { cols: params.cols, rows: params.rows } });
      return;
    case "pty.kill":
      send({ id, result: { exitCode: -1 } });
      return;
    case "pty.close":
      send({ id, result: { closed: true } });
      return;
    default:
      send({
        id,
        error: { code: -32601, message: `unknown method: ${method}` },
      });
  }
});
