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
| `secrets.protect` | `{plaintext: base64, entropy?: base64}` | `{sealed: base64}` |
| `secrets.unprotect` | `{sealed: base64, entropy?: base64}` | `{plaintext: base64}` |

## Invariants

- `unsafe_code = "deny"` at the workspace level; the only allow is the audited
  DPAPI module in `secrets.rs`, where each `unsafe` block states its invariant.
  `unwrap_used` is denied outside tests.
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

`src/native/methods.ts` wraps every method with a response validator: the helper
is another process, so its output is untrusted and a wrong shape throws
`NativeProtocolError` naming the method and field. Unit-level proof uses
`tests/fixtures/fake-native-helper.mjs` (including a `bad-shape` mode); the
end-to-end proof is `npm run test:native`, which builds this crate and runs
`tests/integration/native/real-helper.test.ts` against the compiled binary.
