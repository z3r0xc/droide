# `src/native/` — the helper boundary

The Rust helper (`crates/droide-native`) is one process behind JSON lines:
`{"id","method","params"}` in; `{"id","result"}` or `{"id","error":{"code","message"}}`
out.

`Glob` and `Grep` reach it through `src/tools/native-backend.ts`: the binary is
used only when the session asks for `nativeBackend: "helper"` **and** the file
exists (the factory `bin/`, or `DROIDE_NATIVE_BIN`). Every helper failure
degrades that session to the TypeScript walk and is recorded as a diagnostic,
so a missing or broken helper never fails a tool call.

```ts
const native = await createNativeClient({ helperPath: "/abs/droide-native" });
const result = await native.request("hash.sha256", { text: "abc" });
await native.close();
```

## Guarantees

- Ids are allocated monotonically from 1 and responses are matched by id, so
  concurrent requests never cross; each request gets exactly one frame.
- `createNativeClient` performs `native.version` and requires protocol 1.
- `result` is unvalidated JSON: run a parser from `protocol.ts` before use.
- A late frame for a timed-out id is discarded, never fatal.
- `close()` is idempotent, rejects in-flight requests, ends stdin, waits
  `closeGraceMs` (500 ms), then kills: no child survives it.
- Bounds: a response line over `MAX_LINE_BYTES` (1 MiB) is refused before it is
  buffered; params over `MAX_PARAMS_BYTES` (512 KiB) before a byte is written.
- Timers are injectable; `helperArgs` and `env` serve the fake helper.

## Failure modes

| Trigger                               | Error                                  | Client         |
| ------------------------------------- | -------------------------------------- | -------------- |
| helper missing or not executable      | `NativeUnavailableError`               | creation fails |
| helper exits (code or signal)         | `NativeUnavailableError`, method named | closed         |
| no frame within the request timeout   | `NativeTimeoutError`                   | request only   |
| `error` frame                         | `NativeError` (`code`, `method`)       | usable         |
| malformed line, not JSON, wrong shape | `NativeProtocolError`                  | fatal, killed  |
| line over 1 MiB                       | `NativeProtocolError`                  | fatal, killed  |
| answer to an id that is not pending   | `NativeProtocolError`                  | fatal, killed  |
| `error` frame with a null id          | `NativeProtocolError`                  | fatal, killed  |
| protocol version mismatch             | `NativeProtocolError`                  | creation fails |
| params over the cap                   | `NativeProtocolError`                  | request only   |
| request after `close()`               | `NativeUnavailableError`               | rejected       |
