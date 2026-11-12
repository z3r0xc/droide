# crates/ — Rust native layer

One helper process, spoken to over JSON lines (`specs/90-native-layer.md`). The
TypeScript layer never links native code directly; it starts this binary and
exchanges validated records, so a crash here cannot take the CLI down with it.

```
crates/
└── droide-native/
    ├── src/main.rs     protocol dispatch (version, hashing; pty/search/secrets/sandbox to come)
    └── Cargo.toml
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
parameters, `-32001` oversized line.

## Invariants

- `unsafe_code = "forbid"` at the workspace level; `unwrap_used` is denied.
- Untrusted input is validated before use: line length first, then shape.
- Every request gets exactly one response, including failures.
- The process exits when stdin closes; no background threads outlive it.

## Building

```sh
cargo test --workspace     # see docs/rust-setup.md if the local linker is broken
```

CI builds and tests the workspace on Linux; that is the authoritative gate while
this workstation's mingw toolchain cannot link (`docs/rust-setup.md`).