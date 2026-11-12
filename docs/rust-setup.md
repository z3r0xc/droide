# Rust toolchain on this workstation

## Symptom

Any Rust build fails at link time, before our code is involved:

```
$ rustc hello.rs -o hello.exe
ld.exe: cannot find -lgcc_eh
collect2.exe: error: ld returned 1 exit status
```

`cargo check` fails too, because dependency build scripts are compiled **and**
linked before the check runs.

## Diagnosis

- Active toolchain: `stable-x86_64-pc-windows-gnu`; its linker is
  `C:\Users\handona\Apps\tools\w64devkit\w64devkit\bin\gcc.exe` (w64devkit 16.2).
- w64devkit's sysroot has `libgcc.a` but **not** `libgcc_eh.a`, which Rust's
  mingw target always requests.
- The alternative `stable-x86_64-pc-windows-msvc` toolchain is installed but has
  no Visual C++ tools (`link.exe`); the only `link.exe` on `PATH` is Git's GNU
  `link`, which is not a linker for PE objects.
- Copying `libgcc_eh.a` from Rust's `self-contained` directory next to the
  build does not help: it drags in a second mingw CRT (`crt2.o`), and the two
  runtimes disagree (`undefined reference to __p___initenv`, `_crt_atexit`).

## What works

**CI is the verification path for `crates/`.** The GitHub workflow builds and
tests the workspace on Linux, where the toolchain is healthy. Locally, Rust
changes are validated by review and by CI on push.

## Fixing it locally (either one is enough)

1. **MSVC (recommended).** Install the "Desktop development with C++" workload
   from the Visual Studio Installer, then pin the host:

   ```toml
   # rust-toolchain.toml
   [toolchain]
   channel = "stable"
   host = "x86_64-pc-windows-msvc"
   ```

2. **Complete mingw-w64.** Replace w64devkit's sysroot with one that ships
   `libgcc_eh.a` (MSYS2 `mingw-w64-x86_64-gcc`), or point Rust at it:

   ```sh
   # .cargo/config.toml (machine-local; do not commit)
   [target.x86_64-pc-windows-gnu]
   linker = "C:/msys64/mingw64/bin/gcc.exe"
   ```

Do not commit machine-local paths; keep this file as the record of the problem.