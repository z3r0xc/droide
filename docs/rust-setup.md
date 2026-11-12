# Rust toolchain on this workstation

## Status: fixed

The local toolchain builds and tests the workspace:

```sh
cargo test --workspace      # 39 tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

## What was wrong

Two independent failures, both in the mingw toolchain the machine defaults to
(`stable-x86_64-pc-windows-gnu`, linker `w64devkit 16.2.0`):

1. **`-lgcc_eh` missing.** w64devkit's sysroot shipped `libgcc.a` but not
   `libgcc_eh.a`, which Rust's gnu target always requests, so even
   `rustc hello.rs` failed to link.
2. **CRT mismatch.** Adding `-L` to Rust's own `self-contained` directory to
   supply that file made the linker mix two CRTs and fail with
   `undefined reference to __p___initenv` / `_crt_atexit`.

## The fix

The repository pins the **rust-lld** linker with Rust's self-contained libraries
for this target only, in `.cargo/config.toml`:

```toml
[target.x86_64-pc-windows-gnu]
linker = "rust-lld"
rustflags = ["-C", "link-self-contained=yes"]
```

`rust-lld` ships with the Rust toolchain, so the setting works on a clean
machine and on CI; it avoids the mingw sysroot entirely. Nothing machine-local is
hard-coded.

## If you prefer the MSVC toolchain

Install the "Desktop development with C++" workload and pin the host in
`rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
host = "x86_64-pc-windows-msvc"
```

That path needs no linker override. Do not commit machine-local paths.
