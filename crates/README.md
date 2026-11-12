# crates/ — Rust native layer

One helper process, spoken to over JSON lines (`specs/90-native-layer.md`). The
TypeScript layer never links native code directly; it starts this binary and
exchanges validated records, so a crash here cannot take the CLI down with it.

```
crates/
└── droide-native/
    ├── src/main.rs       stdio loop (one request line in, one response line out)
    ├── src/lib.rs        module root
    ├── src/protocol.rs   request parsing, dispatch, base64, error codes
    ├── src/paths.rs      resolve-within-root, symlink containment
    ├── src/search.rs     bounded file walk, glob matching, literal text search
    ├── src/sandbox.rs    bubblewrap argv / seatbelt profile / Windows "unconfined"
    ├── src/pty.rs        command-line quoting (POSIX + Windows), 4 KiB chunking
    ├── src/pty_session.rs  ConPTY (Windows) / openpty+fork (Unix) sessions and the registry
    └── src/secrets.rs    DPAPI sealing (Windows); other targets fail loudly
```

## Why a process boundary

- The subject does the same for its own helpers (PTY, search, secrets), which is
  the behaviour we must reproduce.
- A protocol boundary is testable without the platform: the TypeScript side is
  covered against a fake helper, the Rust side against captured request/response
  pairs.

## Protocol (v1)

Request, one per line, UTF-8, at most 1 MiB:

```json
{"id":1,"method":"native.version","params":{}}
```

Response, one per line:

```json
{"id":1,"result":{"protocol":1,"version":"0.0.0"}}
{"id":2,"error":{"code":-32601,"message":"unknown method: nope"}}
```

Error codes: `-32700` malformed request, `-32601` unknown method, `-32602` bad
parameters, `-32001` oversized line, `-32603` operation failed.

## Methods

| method | params | result |
|---|---|---|
| `native.version` | — | `{protocol, version}` |
| `hash.sha256` | `{text}` | `{sha256}` |
| `path.resolve` | `{root, path}` | `{path}` or an error when the path escapes |
| `search.walk` | `{root, glob?, maxResults?, includeHidden?}` | `{paths[], truncated}` |
| `search.text` | `{root, query, maxHits?, caseSensitive?, includeHidden?}` | `{hits[{path,line,text}], truncated, filesScanned}` |
| `sandbox.profile` | `{target?, network?, readPaths?, writePaths?}` | `{mechanism, argv\|profile\|reason}` |
| `pty.quote` | `{target?, args[]}` | `{commandLine}` |
| `pty.spawn` | `{program, args?, cwd?, env?, cols?, rows?}` | `{sessionId}` |
| `pty.read` | `{sessionId, timeoutMs?}` | `{data: base64, exited, exitCode}` |
| `pty.write` | `{sessionId, data: base64}` | `{written}` |
| `pty.resize` | `{sessionId, cols, rows}` | `{cols, rows}` |
| `pty.kill` | `{sessionId}` | `{exitCode}` |
| `pty.close` | `{sessionId}` | `{closed}` |
| `secrets.protect` | `{plaintext: base64, entropy?: base64}` | `{sealed: base64}` |
| `secrets.unprotect` | `{sealed: base64, entropy?: base64}` | `{plaintext: base64}` |

## PTY sessions

`pty.*` sessions are stateful: the binary's stdin loop owns a session map
(`protocol::Dispatcher`), so a `sessionId` returned by `pty.spawn` is valid for
later lines on the same process. A stateless `handle_line` call cannot own a
child and answers the session methods with `-32603`.

* **Ids** are 128 bits from the OS RNG (`BCryptGenRandom`, `/dev/urandom`),
  hex-encoded. They are opaque; nothing else in the protocol refers to a
  process.
* **Framing.** Terminal output is bytes, not text, so `pty.read` and `pty.write`
  carry base64 (`{data}`). One read returns at most one 4096-byte chunk, matching
  the subject's raw-chunk reads; callers loop until `exited`. A timeout returns
  `{data: "", exited: false}` and leaves the child untouched; once `exited` is
  `true` it stays `true` and carries the child's `exitCode`.
* **Exit codes.** `pty.kill` terminates the child (TerminateProcess on Windows,
  `SIGKILL` on Unix), reaps it, and returns the code. A Unix child killed by a
  signal is reported as `128 + signal` (so `SIGKILL` is 137). After the child
  exits, up to 200 ms of buffered console output is delivered before `exited`
  is reported.
* **Lifetime.** `pty.close` releases the session and its child; `pty.close` is
  idempotent, and any later `pty.read`/`pty.write`/`pty.resize`/`pty.kill` for
  that id fails with `-32602` (`pty session is closed`). An id that was never
  issued is also `-32602` (`unknown pty session`). Every session — and every
  child — is released when `pty.close` arrives and when stdin reaches EOF.
* **Limits.** At most 64 sessions per helper; one write at most 512 KiB; a read
  timeout at most 60 s. `cols`/`rows` default to 80×24 and must be ≥ 1.

## Invariants

- `unsafe_code = "deny"` at the workspace level. Two audited modules opt in and
  each `unsafe` block states its invariant: the DPAPI bindings in `secrets.rs`
  and the PTY platform module in `pty_session.rs` (ConPTY on Windows,
  `openpty`/`fork`/`execve` on Unix; other targets return a typed error naming
  the platform). `unwrap_used` is denied outside tests.
- Untrusted input is validated before use: line length first, then shape.
- Every request gets exactly one response, including failures.
- The process exits when stdin closes; no background threads outlive it.

## Building

```sh
cargo test --workspace     # see docs/rust-setup.md if the local linker is broken
```

CI builds and tests the workspace on Linux; that is the authoritative gate while
this workstation's mingw toolchain cannot link (`docs/rust-setup.md`).

## Typed TypeScript side

`src/native/methods.ts` wraps each native method it exposes with a response validator: the helper
is another process, so its output is untrusted and a wrong shape throws
`NativeProtocolError` naming the method and field. Unit-level proof uses
`tests/fixtures/fake-native-helper.mjs` (including a `bad-shape` mode); the
end-to-end proof is `npm run test:native`, which builds this crate and runs
`tests/integration/native/real-helper.test.ts` against the compiled binary.
