//! Real pseudo-terminal sessions for the native helper.
//!
//! Contract: `specs/90-native-layer.md` §"PTY (`rust_pty`)" and the session
//! registry in `crates/README.md`. The reference build hands its PTY helper a quoted command
//! line, reads raw byte chunks (never lines), reports the child's exit code and
//! closes the terminal on request. This module reproduces that surface as a
//! long-lived session object the JSON-lines dispatcher owns.
//!
//! Backends:
//!
//! * Windows — ConPTY (`CreatePseudoConsole` / `ResizePseudoConsole` /
//!   `ClosePseudoConsole`) fed by named pipes; the console writes into our
//!   overlapped read end so [`PtySession::read`] can honour a timeout without a
//!   polling loop or a reader thread.
//! * Unix — `openpty` + `fork`/`execve`, with `poll` for the read timeout and
//!   `waitpid` for exit status; the child is always reaped, so no zombies.
//! * Anything else — a typed [`PtyError::Unsupported`] naming the platform.
//!
//! All `unsafe` lives in the single platform module (one per target, guarded by
//! `#[allow(unsafe_code)]`); every block states the invariant it relies on.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Largest payload accepted by one [`PtySession::write`] call.
pub const MAX_WRITE_BYTES: usize = 512 * 1024;

/// Largest timeout a caller may request; keeps one request from blocking the
/// protocol loop for long.
pub const MAX_READ_TIMEOUT_MS: u32 = 60_000;

/// Live sessions one helper process may own at once (file-descriptor budget).
pub const MAX_SESSIONS: usize = 64;

/// How many closed identifiers are remembered for precise errors.
const CLOSED_ID_MEMORY: usize = 256;

/// How long a read lingers after the child has exited, so the console's last
/// bytes are delivered before the session reports `exited`.
pub const EXIT_FLUSH_MS: u32 = 200;

/// Why a PTY operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyError {
    /// This build has no PTY backend for the platform.
    Unsupported(&'static str),
    /// The request's parameters cannot describe a terminal.
    InvalidParam(String),
    /// Creating the terminal or its child failed.
    Spawn(String),
    /// The operating system rejected an I/O operation.
    Io(String),
    /// No session was ever created with this identifier.
    UnknownSession(String),
    /// The session existed but `pty.close` already released it.
    SessionClosed(String),
    /// The process-wide session budget is exhausted.
    Limit(String),
}

impl std::fmt::Display for PtyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(platform) => {
                write!(formatter, "pty sessions are not implemented for {platform}")
            }
            Self::InvalidParam(reason) => write!(formatter, "invalid pty parameter: {reason}"),
            Self::Spawn(reason) => write!(formatter, "pty spawn failed: {reason}"),
            Self::Io(reason) => write!(formatter, "pty operation failed: {reason}"),
            Self::UnknownSession(id) => write!(formatter, "unknown pty session: {id}"),
            Self::SessionClosed(id) => write!(formatter, "pty session is closed: {id}"),
            Self::Limit(reason) => write!(formatter, "pty session limit reached: {reason}"),
        }
    }
}

impl std::error::Error for PtyError {}

/// Everything needed to start one child under a terminal.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    /// Working directory; the caller's when `None`.
    pub cwd: Option<PathBuf>,
    /// Variables layered over the inherited environment (empty = inherit).
    pub env: Vec<(String, String)>,
    /// Terminal width in columns.
    pub cols: u16,
    /// Terminal height in rows.
    pub rows: u16,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            cwd: None,
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }
}

/// One observation of the child's output stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadOutcome {
    /// Bytes produced since the previous read (never more than a read chunk).
    pub data: Vec<u8>,
    /// `true` once the child is reaped and every buffered byte was delivered.
    pub exited: bool,
    /// Exit code, available when `exited` is set (and earlier once known).
    pub exit_code: Option<i32>,
}

impl ReadOutcome {
    fn terminal(exit_code: Option<i32>) -> Self {
        Self {
            data: Vec::new(),
            exited: true,
            exit_code,
        }
    }

    fn idle(exit_code: Option<i32>) -> Self {
        Self {
            data: Vec::new(),
            exited: false,
            exit_code,
        }
    }
}

/// A child process attached to a pseudo-terminal.
#[derive(Debug)]
pub struct PtySession {
    inner: platform::Session,
}

impl PtySession {
    /// Start `program` with `args` under a fresh terminal.
    pub fn spawn(program: &str, args: &[String], options: &SpawnOptions) -> Result<Self, PtyError> {
        if program.is_empty() {
            return Err(PtyError::InvalidParam("program must not be empty".into()));
        }
        if options.cols == 0 || options.rows == 0 {
            return Err(PtyError::InvalidParam(
                "cols and rows must be at least 1".into(),
            ));
        }
        Ok(Self {
            inner: platform::Session::spawn(program, args, options)?,
        })
    }

    /// Send bytes to the child's standard input.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), PtyError> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(PtyError::InvalidParam(format!(
                "write of {} bytes exceeds the {MAX_WRITE_BYTES}-byte limit",
                bytes.len()
            )));
        }
        self.inner.write(bytes)
    }

    /// Read up to one chunk, waiting at most `timeout_ms` for data.
    ///
    /// A timeout returns no data and leaves the child untouched; the caller may
    /// read again. Once `exited` is reported it stays reported.
    pub fn read(&mut self, timeout_ms: u32) -> Result<ReadOutcome, PtyError> {
        self.inner.read(timeout_ms.min(MAX_READ_TIMEOUT_MS))
    }

    /// Resize the terminal the child sees.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), PtyError> {
        if cols == 0 || rows == 0 {
            return Err(PtyError::InvalidParam(
                "cols and rows must be at least 1".into(),
            ));
        }
        self.inner.resize(cols, rows)
    }

    /// Terminate the child if needed, reap it, and report its exit code.
    pub fn kill(&mut self) -> Result<i32, PtyError> {
        self.inner.kill()
    }

    /// Wait for the child to exit and report its exit code.
    pub fn wait(&mut self) -> Result<i32, PtyError> {
        self.inner.wait()
    }

    /// Operating-system process id of the child.
    pub fn pid(&self) -> u32 {
        self.inner.pid()
    }

    /// Release the terminal; a still-running child is terminated first.
    pub fn close(&mut self) {
        self.inner.close();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.inner.close();
    }
}

/// The helper's live PTY sessions, keyed by an opaque identifier.
///
/// The registry is owned by the protocol dispatcher: it lives as long as the
/// stdin loop and releases every child when it is dropped (including EOF).
#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: HashMap<String, PtySession>,
    closed: HashSet<String>,
}

impl SessionRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a new session and return its opaque identifier.
    pub fn spawn(
        &mut self,
        program: &str,
        args: &[String],
        options: SpawnOptions,
    ) -> Result<String, PtyError> {
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(PtyError::Limit(format!(
                "at most {MAX_SESSIONS} sessions may be open"
            )));
        }
        let session = PtySession::spawn(program, args, &options)?;
        let mut id = String::new();
        for _ in 0..4 {
            let candidate = platform::random_hex_16()?;
            if !self.sessions.contains_key(&candidate) && !self.closed.contains(&candidate) {
                id = candidate;
                break;
            }
        }
        if id.is_empty() {
            return Err(PtyError::Io(
                "could not allocate a unique session identifier".into(),
            ));
        }
        self.sessions.insert(id.clone(), session);
        Ok(id)
    }

    /// Read from a session, waiting at most `timeout_ms`.
    pub fn read(&mut self, id: &str, timeout_ms: u32) -> Result<ReadOutcome, PtyError> {
        self.session(id)?.read(timeout_ms)
    }

    /// Write to a session; returns the number of bytes accepted.
    pub fn write(&mut self, id: &str, bytes: &[u8]) -> Result<usize, PtyError> {
        let session = self.session(id)?;
        session.write(bytes)?;
        Ok(bytes.len())
    }

    /// Resize a session's terminal.
    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.session(id)?.resize(cols, rows)
    }

    /// Terminate a session's child and report its exit code.
    pub fn kill(&mut self, id: &str) -> Result<i32, PtyError> {
        self.session(id)?.kill()
    }

    /// Release a session. Idempotent; later use of `id` is [`PtyError::SessionClosed`].
    pub fn close(&mut self, id: &str) -> Result<(), PtyError> {
        match self.sessions.remove(id) {
            Some(mut session) => {
                session.close();
                self.closed.insert(id.to_string());
                while self.closed.len() > CLOSED_ID_MEMORY {
                    let Some(oldest) = self.closed.iter().next().cloned() else {
                        break;
                    };
                    self.closed.remove(&oldest);
                }
                Ok(())
            }
            None if self.closed.contains(id) => Ok(()),
            None => Err(PtyError::UnknownSession(describe(id))),
        }
    }

    /// Number of live sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// `true` when no session is live.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Release every session (dropping a child that is still running).
    pub fn close_all(&mut self) {
        self.sessions.clear();
    }

    fn session(&mut self, id: &str) -> Result<&mut PtySession, PtyError> {
        if let Some(session) = self.sessions.get_mut(id) {
            return Ok(session);
        }
        if self.closed.contains(id) {
            return Err(PtyError::SessionClosed(describe(id)));
        }
        Err(PtyError::UnknownSession(describe(id)))
    }
}

impl Drop for SessionRegistry {
    fn drop(&mut self) {
        self.close_all();
    }
}

/// Keep a caller-supplied identifier readable in an error without echoing an
/// unbounded blob back over the protocol.
fn describe(id: &str) -> String {
    id.chars().take(64).collect()
}

// FFI is unavoidable for both terminal APIs. The allow is scoped to the
// platform module; each `unsafe` block states its invariant.
#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    //! ConPTY backend. `unsafe` is limited to Win32 calls on handles this
    //! module created, plus POD structs passed by pointer to those calls.

    use std::collections::BTreeMap;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::pty::READ_CHUNK_BYTES;

    use super::{PtyError, ReadOutcome, SpawnOptions, EXIT_FLUSH_MS};

    type Handle = *mut c_void;

    const PIPE_ACCESS_INBOUND: u32 = 0x0000_0001;
    const PIPE_ACCESS_OUTBOUND: u32 = 0x0000_0002;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_OPERATION_ABORTED: u32 = 995;
    const ERROR_BROKEN_PIPE: u32 = 109;
    const ERROR_NO_DATA: u32 = 232;
    const ERROR_PIPE_NOT_CONNECTED: u32 = 233;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const INFINITE: u32 = 0xffff_ffff;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
    const WRITE_CHUNK_BYTES: usize = 64 * 1024;

    static PIPE_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    struct Coord {
        x: i16,
        y: i16,
    }

    #[repr(C)]
    #[derive(Debug)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[repr(C)]
    #[derive(Debug)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        reserved2: u16,
        reserved2_ptr: *mut u8,
        std_input: Handle,
        std_output: Handle,
        std_error: Handle,
    }

    #[repr(C)]
    #[derive(Debug)]
    struct StartupInfoEx {
        startup: StartupInfoW,
        attribute_list: *mut c_void,
    }

    #[repr(C)]
    #[derive(Debug)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        process_id: u32,
        thread_id: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePseudoConsole(
            size: Coord,
            input: Handle,
            output: Handle,
            flags: u32,
            console: *mut Handle,
        ) -> i32;
        fn ResizePseudoConsole(console: Handle, size: Coord) -> i32;
        fn ClosePseudoConsole(console: Handle);
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            output_size: u32,
            input_size: u32,
            timeout: u32,
            security: *mut c_void,
        ) -> Handle;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn CreateEventW(
            security: *mut c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> Handle;
        fn ResetEvent(event: Handle) -> i32;
        fn ReadFile(
            file: Handle,
            buffer: *mut u8,
            bytes: u32,
            read: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn WriteFile(
            file: Handle,
            buffer: *const u8,
            bytes: u32,
            written: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
        fn GetOverlappedResult(
            file: Handle,
            overlapped: *mut Overlapped,
            transferred: *mut u32,
            wait: i32,
        ) -> i32;
        /// Test-only: verify a pid is really gone.
        #[cfg(test)]
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
        fn TerminateProcess(process: Handle, code: u32) -> i32;
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: u32,
            attribute: usize,
            value: *const c_void,
            size: usize,
            previous: *mut c_void,
            return_size: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        #[allow(clippy::too_many_arguments)]
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *mut c_void,
            thread_attributes: *mut c_void,
            inherit_handles: i32,
            flags: u32,
            environment: *mut c_void,
            directory: *const u16,
            startup: *mut StartupInfoEx,
            information: *mut ProcessInformation,
        ) -> i32;
    }

    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32)
            -> i32;
    }

    /// One session's OS resources and cached exit state.
    #[derive(Debug)]
    pub struct Session {
        console: Handle,
        input: OwnedHandle,
        output: OwnedHandle,
        process: OwnedHandle,
        event: OwnedHandle,
        pid: u32,
        exit_code: Option<i32>,
        finished: bool,
        eof: bool,
        closed: bool,
    }

    /// Internal read result: data, a timed-out wait, or a closed pipe.
    enum Chunk {
        Data(Vec<u8>),
        Timeout,
        Eof,
    }

    pub fn random_hex_16() -> Result<String, PtyError> {
        let mut bytes = [0u8; 16];
        // SAFETY: the buffer is a live local of the length passed; the RNG
        // writes at most that many bytes.
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                bytes.as_mut_ptr(),
                16,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(PtyError::Io(format!(
                "BCryptGenRandom failed (status {status:#010x})"
            )));
        }
        Ok(crate::protocol::hex_lower(&bytes))
    }

    impl Session {
        pub fn spawn(
            program: &str,
            args: &[String],
            options: &SpawnOptions,
        ) -> Result<Self, PtyError> {
            let size = Coord {
                x: coord(options.cols)?,
                y: coord(options.rows)?,
            };
            let mut command = Vec::with_capacity(args.len() + 1);
            command.push(program.to_string());
            command.extend(args.iter().cloned());
            let mut command_line = wide(&crate::pty::quote_windows_command_line(&command))?;
            let directory = match options.cwd.as_ref() {
                Some(path) => Some(wide_path(path)?),
                None => None,
            };
            let mut environment = if options.env.is_empty() {
                None
            } else {
                Some(environment_block(&options.env)?)
            };

            let counter = PIPE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let base = format!("\\\\.\\pipe\\droide-pty-{}-{counter}", std::process::id());
            let input_name = format!("{base}-in");
            let output_name = format!("{base}-out");

            // Both pipes are duplex named pipes: the console gets the server
            // end (it duplicates it at CreatePseudoConsole) and we keep a
            // client end for reads/writes.
            let input_peer = owned(create_pipe(
                &input_name,
                PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND,
                "the terminal input pipe",
            )?);
            let input = owned(open_pipe(
                &input_name,
                GENERIC_READ | GENERIC_WRITE,
                0,
                "the terminal input pipe",
            )?);
            // Our output client is overlapped so a read can time out.
            let output_peer = owned(create_pipe(
                &output_name,
                PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND,
                "the terminal output pipe",
            )?);
            let output = owned(open_pipe(
                &output_name,
                GENERIC_READ | GENERIC_WRITE,
                FILE_FLAG_OVERLAPPED,
                "the terminal output pipe",
            )?);

            let mut console: Handle = ptr::null_mut();
            // SAFETY: both handles are live; the API only stores the console in
            // the out pointer.
            let created_console = unsafe {
                CreatePseudoConsole(
                    size,
                    input_peer.as_raw_handle(),
                    output_peer.as_raw_handle(),
                    0,
                    &mut console,
                )
            };
            if created_console < 0 {
                return Err(PtyError::Spawn(format!(
                    "CreatePseudoConsole failed (HRESULT {:#010x})",
                    created_console as u32
                )));
            }

            // The pseudoconsole duplicated both handles; closing ours is the
            // documented lifetime rule and makes pipe EOF observable.
            drop(input_peer);
            drop(output_peer);

            match create_child(
                &mut command_line,
                directory.as_ref(),
                environment.as_mut(),
                console,
            ) {
                Ok((process, pid)) => {
                    let event = match create_event() {
                        Ok(event) => event,
                        Err(error) => {
                            // SAFETY: `console` came from CreatePseudoConsole and
                            // has not been closed yet.
                            unsafe { ClosePseudoConsole(console) };
                            return Err(error);
                        }
                    };
                    Ok(Self {
                        console,
                        input,
                        output,
                        process,
                        event,
                        pid,
                        exit_code: None,
                        finished: false,
                        eof: false,
                        closed: false,
                    })
                }
                Err(error) => {
                    // SAFETY: `console` came from CreatePseudoConsole and has
                    // not been closed yet.
                    unsafe { ClosePseudoConsole(console) };
                    Err(error)
                }
            }
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }

        pub fn write(&mut self, bytes: &[u8]) -> Result<(), PtyError> {
            if self.closed || self.finished {
                return Err(PtyError::Io("the terminal is closed".into()));
            }
            let mut offset = 0usize;
            while offset < bytes.len() {
                let slice = bytes
                    .get(offset..)
                    .ok_or_else(|| PtyError::Io("write offset out of range".into()))?;
                let length = slice.len().min(WRITE_CHUNK_BYTES);
                let chunk = slice
                    .get(..length)
                    .ok_or_else(|| PtyError::Io("write chunk out of range".into()))?;
                let mut written: u32 = 0;
                // SAFETY: the buffer is a live slice of `chunk.len()` bytes and
                // the event-less (synchronous) write handle is ours.
                let ok = unsafe {
                    WriteFile(
                        self.input.as_raw_handle(),
                        chunk.as_ptr(),
                        length as u32,
                        &mut written,
                        ptr::null_mut(),
                    )
                };
                if ok == 0 {
                    return Err(PtyError::Io(format!("WriteFile failed ({})", last_error())));
                }
                if written == 0 {
                    return Err(PtyError::Io("the terminal accepted no bytes".into()));
                }
                offset = offset.saturating_add(written as usize);
            }
            Ok(())
        }

        pub fn read(&mut self, timeout_ms: u32) -> Result<ReadOutcome, PtyError> {
            if self.finished {
                return Ok(ReadOutcome::terminal(self.exit_code));
            }
            if let Some(code) = self.exit_code {
                // The child is gone: drain whatever the console buffered, then
                // report the exit once the stream is quiet.
                let wait = timeout_ms.min(EXIT_FLUSH_MS);
                return match self.read_chunk(wait)? {
                    Chunk::Data(data) => Ok(ReadOutcome {
                        data,
                        exited: false,
                        exit_code: Some(code),
                    }),
                    Chunk::Timeout | Chunk::Eof => {
                        self.finished = true;
                        Ok(ReadOutcome::terminal(Some(code)))
                    }
                };
            }

            let chunk = self.read_chunk(timeout_ms)?;
            if let Chunk::Data(data) = chunk {
                let code = self.poll_exit_code();
                return Ok(ReadOutcome {
                    data,
                    exited: false,
                    exit_code: code,
                });
            }
            let eof = matches!(chunk, Chunk::Eof);
            if let Some(code) = self.poll_exit_code() {
                self.finished = true;
                return Ok(ReadOutcome::terminal(Some(code)));
            }
            if eof {
                // No stream left to read; the only state that can change is the
                // process itself, so wait on it for the caller's budget.
                // SAFETY: the process handle is owned by this session.
                unsafe { WaitForSingleObject(self.process.as_raw_handle(), timeout_ms) };
                if let Some(code) = self.poll_exit_code() {
                    self.finished = true;
                    return Ok(ReadOutcome::terminal(Some(code)));
                }
            }
            Ok(ReadOutcome::idle(None))
        }

        pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), PtyError> {
            if self.closed {
                return Err(PtyError::Io("the terminal is closed".into()));
            }
            let size = Coord {
                x: coord(cols)?,
                y: coord(rows)?,
            };
            // SAFETY: `console` is live until `close`.
            let result = unsafe { ResizePseudoConsole(self.console, size) };
            if result < 0 {
                return Err(PtyError::Io(format!(
                    "ResizePseudoConsole failed (HRESULT {:#010x})",
                    result as u32
                )));
            }
            Ok(())
        }

        pub fn kill(&mut self) -> Result<i32, PtyError> {
            if let Some(code) = self.exit_code {
                return Ok(code);
            }
            // SAFETY: the process handle is owned by this session.
            let ok = unsafe { TerminateProcess(self.process.as_raw_handle(), 1) };
            if ok == 0 {
                if let Some(code) = self.poll_exit_code() {
                    return Ok(code);
                }
                return Err(PtyError::Io(format!(
                    "TerminateProcess failed ({})",
                    last_error()
                )));
            }
            self.wait()
        }

        pub fn wait(&mut self) -> Result<i32, PtyError> {
            if let Some(code) = self.exit_code {
                return Ok(code);
            }
            // SAFETY: the process handle is owned by this session.
            let signalled = unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) };
            if signalled != WAIT_OBJECT_0 {
                return Err(PtyError::Io(format!(
                    "waiting for the child failed ({signalled})"
                )));
            }
            self.poll_exit_code()
                .ok_or_else(|| PtyError::Io("the child's exit code is unavailable".into()))
        }

        pub fn close(&mut self) {
            if self.closed {
                return;
            }
            if self.exit_code.is_none() {
                let _ = self.kill();
            }
            // SAFETY: `console` came from CreatePseudoConsole and is closed once.
            unsafe { ClosePseudoConsole(self.console) };
            self.closed = true;
        }

        fn poll_exit_code(&mut self) -> Option<i32> {
            if let Some(code) = self.exit_code {
                return Some(code);
            }
            // SAFETY: the process handle is owned by this session.
            if unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
                return None;
            }
            let mut code: u32 = 0;
            // SAFETY: `code` is a live out parameter and the handle is ours.
            let ok = unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) };
            if ok == 0 {
                return None;
            }
            let code = code as i32;
            self.exit_code = Some(code);
            Some(code)
        }

        fn read_chunk(&mut self, timeout_ms: u32) -> Result<Chunk, PtyError> {
            if self.eof || self.closed {
                return Ok(Chunk::Eof);
            }
            let mut buffer = vec![0u8; READ_CHUNK_BYTES];
            let mut overlapped = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: self.event.as_raw_handle(),
            };
            // SAFETY: the event is owned by this session; the manual-reset
            // event is cleared so the wait below observes this operation only.
            unsafe { ResetEvent(self.event.as_raw_handle()) };

            let mut transferred: u32 = 0;
            // SAFETY: `buffer` is a live allocation of READ_CHUNK_BYTES and the
            // overlapped structure outlives the operation (we always wait for
            // completion or cancellation before returning).
            let immediate = unsafe {
                ReadFile(
                    self.output.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    READ_CHUNK_BYTES as u32,
                    &mut transferred,
                    &mut overlapped,
                )
            };
            if immediate != 0 {
                return self.finish_read(&mut buffer, transferred);
            }
            let error = last_error();
            if error != ERROR_IO_PENDING {
                return self.read_error(error);
            }

            // SAFETY: the event and the overlapped operation belong together.
            let wait = unsafe { WaitForSingleObject(self.event.as_raw_handle(), timeout_ms) };
            if wait == WAIT_TIMEOUT {
                // SAFETY: cancelling an operation we started, then waiting for
                // its completion, keeps `overlapped` valid until this point.
                unsafe {
                    CancelIoEx(self.output.as_raw_handle(), &mut overlapped);
                    WaitForSingleObject(self.event.as_raw_handle(), INFINITE);
                }
                let mut cancelled: u32 = 0;
                // SAFETY: the operation has completed (successfully or not).
                let finished = unsafe {
                    GetOverlappedResult(
                        self.output.as_raw_handle(),
                        &mut overlapped,
                        &mut cancelled,
                        0,
                    )
                };
                if finished != 0 && cancelled > 0 {
                    return self.finish_read(&mut buffer, cancelled);
                }
                return Ok(Chunk::Timeout);
            }
            if wait != WAIT_OBJECT_0 {
                return Err(PtyError::Io(format!("waiting for output failed ({wait})")));
            }
            let mut transferred: u32 = 0;
            // SAFETY: the operation completed; the result is now readable.
            let finished = unsafe {
                GetOverlappedResult(
                    self.output.as_raw_handle(),
                    &mut overlapped,
                    &mut transferred,
                    0,
                )
            };
            if finished == 0 {
                let error = last_error();
                if error == ERROR_OPERATION_ABORTED {
                    return Ok(Chunk::Timeout);
                }
                return self.read_error(error);
            }
            self.finish_read(&mut buffer, transferred)
        }

        fn finish_read(
            &mut self,
            buffer: &mut Vec<u8>,
            transferred: u32,
        ) -> Result<Chunk, PtyError> {
            let length = usize::try_from(transferred).unwrap_or(0).min(buffer.len());
            buffer.truncate(length);
            if buffer.is_empty() {
                self.eof = true;
                return Ok(Chunk::Eof);
            }
            Ok(Chunk::Data(std::mem::take(buffer)))
        }

        fn read_error(&mut self, error: u32) -> Result<Chunk, PtyError> {
            if matches!(
                error,
                ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED
            ) {
                self.eof = true;
                return Ok(Chunk::Eof);
            }
            Err(PtyError::Io(format!(
                "ReadFile failed (win32 error {error})"
            )))
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn create_child(
        command_line: &mut Vec<u16>,
        directory: Option<&Vec<u16>>,
        environment: Option<&mut Vec<u16>>,
        console: Handle,
    ) -> Result<(OwnedHandle, u32), PtyError> {
        let mut attribute_size: usize = 0;
        // SAFETY: a sizing query with a null list; the API writes the required
        // size into the out parameter.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_size) };
        if attribute_size == 0 {
            return Err(PtyError::Spawn(
                "InitializeProcThreadAttributeList reported no size".into(),
            ));
        }
        let words = attribute_size.div_ceil(std::mem::size_of::<usize>());
        let mut storage = vec![0usize; words];
        let list = storage.as_mut_ptr().cast::<c_void>();
        // SAFETY: `list` points at `words` usize words, which is at least the
        // requested byte size, and stays alive until DeleteProcThreadAttributeList.
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut attribute_size) } == 0 {
            return Err(PtyError::Spawn(format!(
                "InitializeProcThreadAttributeList failed ({})",
                last_error()
            )));
        }

        // SAFETY: the attribute list is initialized for one attribute; the
        // attribute value is the console handle itself (PROC_THREAD_ATTRIBUTE_
        // PSEUDOCONSOLE takes HPCON by value), which stays valid because the
        // session owns the console.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                console.cast_const().cast(),
                std::mem::size_of::<Handle>(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if updated == 0 {
            let error = last_error();
            // SAFETY: the list was initialized above.
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(PtyError::Spawn(format!(
                "UpdateProcThreadAttribute failed ({error})"
            )));
        }

        // SAFETY: both startup structures are POD and zero is a valid initial
        // state for every field; pointers are assigned immediately below.
        let mut startup: StartupInfoEx = unsafe { std::mem::zeroed() };
        startup.startup.cb = std::mem::size_of::<StartupInfoEx>() as u32;
        // The console owns the child's standard streams. Marking them invalid
        // stops the child inheriting (and writing to) ours.
        startup.startup.flags = STARTF_USESTDHANDLES;
        startup.startup.std_input = invalid_handle();
        startup.startup.std_output = invalid_handle();
        startup.startup.std_error = invalid_handle();
        startup.attribute_list = list;
        // SAFETY: as above; CreateProcessW fills the structure.
        let mut information: ProcessInformation = unsafe { std::mem::zeroed() };

        let mut flags = EXTENDED_STARTUPINFO_PRESENT;
        let environment_ptr = match environment {
            Some(block) => {
                flags |= CREATE_UNICODE_ENVIRONMENT;
                block.as_mut_ptr().cast::<c_void>()
            }
            None => ptr::null_mut(),
        };
        let directory_ptr = directory.map_or(ptr::null(), |value| value.as_ptr());

        // SAFETY: the command line is a mutable, NUL-terminated buffer; the
        // optional environment and directory are NUL-terminated too and live
        // for the call; the attribute list is valid and is deleted below.
        let created = unsafe {
            CreateProcessW(
                ptr::null(),
                command_line.as_mut_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                flags,
                environment_ptr,
                directory_ptr,
                &mut startup,
                &mut information,
            )
        };
        // SAFETY: initialized once above and used for the final time here.
        unsafe { DeleteProcThreadAttributeList(list) };
        drop(storage);

        if created == 0 {
            return Err(PtyError::Spawn(format!(
                "CreateProcessW failed ({})",
                last_error()
            )));
        }
        let process = owned(information.process);
        let _thread = owned(information.thread);
        Ok((process, information.process_id))
    }

    #[cfg(test)]
    pub fn process_has_exited(pid: u32) -> bool {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        // SAFETY: opens a synchronize-only handle to the process id; the handle
        // is closed by the owned wrapper before returning.
        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return true;
        }
        let process = owned(handle);
        // SAFETY: `process` is a live handle.
        let wait = unsafe { WaitForSingleObject(process.as_raw_handle(), 0) };
        wait == WAIT_OBJECT_0
    }

    fn create_event() -> Result<OwnedHandle, PtyError> {
        // SAFETY: a plain unnamed manual-reset event; the returned handle is
        // owned immediately.
        let event = unsafe { CreateEventW(ptr::null_mut(), 1, 0, ptr::null()) };
        if event == invalid_handle() {
            return Err(PtyError::Spawn(format!(
                "CreateEventW failed ({})",
                last_error()
            )));
        }
        Ok(owned(event))
    }

    fn create_pipe(name: &str, access: u32, what: &str) -> Result<Handle, PtyError> {
        let wide_name = wide(name)?;
        let mode = PIPE_TYPE_BYTE | PIPE_WAIT;
        // SAFETY: the name is a NUL-terminated wide string that lives for the
        // call; null security means the default descriptor.
        let handle = unsafe {
            CreateNamedPipeW(
                wide_name.as_ptr(),
                access,
                mode,
                1,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                ptr::null_mut(),
            )
        };
        if handle == invalid_handle() {
            return Err(PtyError::Spawn(format!(
                "creating {what} failed ({})",
                last_error()
            )));
        }
        Ok(handle)
    }

    fn open_pipe(name: &str, access: u32, flags: u32, what: &str) -> Result<Handle, PtyError> {
        let wide_name = wide(name)?;
        // SAFETY: the name is a live NUL-terminated wide string; the handle is
        // returned closed by its new owner on error paths.
        let handle = unsafe {
            CreateFileW(
                wide_name.as_ptr(),
                access,
                0,
                ptr::null_mut(),
                OPEN_EXISTING,
                flags,
                ptr::null_mut(),
            )
        };
        if handle == invalid_handle() {
            return Err(PtyError::Spawn(format!(
                "opening {what} failed ({})",
                last_error()
            )));
        }
        Ok(handle)
    }

    fn owned(handle: Handle) -> OwnedHandle {
        // SAFETY: every caller passes a handle returned by CreateNamedPipeW,
        // CreateFileW, CreateEventW or CreateProcessW that has no other owner.
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }

    fn invalid_handle() -> Handle {
        (-1isize) as Handle
    }

    fn last_error() -> u32 {
        std::io::Error::last_os_error()
            .raw_os_error()
            .map_or(0, |code| code as u32)
    }

    fn coord(value: u16) -> Result<i16, PtyError> {
        i16::try_from(value)
            .map_err(|_| PtyError::InvalidParam(format!("terminal dimension {value} is too large")))
    }

    fn wide(text: &str) -> Result<Vec<u16>, PtyError> {
        if text.contains('\0') {
            return Err(PtyError::InvalidParam(
                "strings must not contain NUL".into(),
            ));
        }
        Ok(text.encode_utf16().chain(std::iter::once(0)).collect())
    }

    fn wide_path(path: &Path) -> Result<Vec<u16>, PtyError> {
        let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        if encoded.contains(&0) {
            return Err(PtyError::InvalidParam("paths must not contain NUL".into()));
        }
        encoded.push(0);
        Ok(encoded)
    }

    fn environment_block(overrides: &[(String, String)]) -> Result<Vec<u16>, PtyError> {
        let mut merged: BTreeMap<String, String> = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        for (key, value) in overrides {
            if key.contains('=') || key.contains('\0') {
                return Err(PtyError::InvalidParam(format!(
                    "environment key {key:?} is not valid"
                )));
            }
            merged.insert(key.clone(), value.clone());
        }
        let mut block = Vec::new();
        for (key, value) in &merged {
            if value.contains('\0') {
                return Err(PtyError::InvalidParam(format!(
                    "environment value for {key:?} contains NUL"
                )));
            }
            block.extend(key.encode_utf16());
            block.push(u16::from(b'='));
            block.extend(value.encode_utf16());
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }
}

#[cfg(unix)]
#[allow(unsafe_code)]
mod platform {
    //! `openpty` + `fork`/`execve` backend. `unsafe` is limited to libc calls on
    //! descriptors and C strings this module created.

    use std::collections::BTreeMap;
    use std::ffi::{c_char, c_int, c_short, c_ulong, c_ushort, c_void, CString};
    use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
    use std::path::Path;
    use std::ptr;

    use crate::pty::READ_CHUNK_BYTES;

    use super::{PtyError, ReadOutcome, SpawnOptions, EXIT_FLUSH_MS};

    const POLLIN: c_short = 0x0001;
    const POLLHUP: c_short = 0x0010;
    const POLLNVAL: c_short = 0x0020;
    const WNOHANG: c_int = 1;
    const SIGKILL: c_int = 9;
    const SIGPIPE: c_int = 13;
    const EIO: i32 = 5;
    const ECHILD: i32 = 10;
    const F_SETFD: c_int = 2;
    const FD_CLOEXEC: c_int = 1;
    const WRITE_CHUNK_BYTES: usize = 64 * 1024;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const TIOCSCTTY: c_ulong = 0x540e;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const TIOCSCTTY: c_ulong = 0x2000_7461;

    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    struct WinSize {
        rows: c_ushort,
        cols: c_ushort,
        xpixel: c_ushort,
        ypixel: c_ushort,
    }

    #[repr(C)]
    #[derive(Debug)]
    struct PollFd {
        fd: c_int,
        events: c_short,
        revents: c_short,
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[link(name = "util")]
    extern "C" {
        fn openpty(
            master: *mut c_int,
            slave: *mut c_int,
            name: *mut c_char,
            termios: *const c_void,
            winsize: *const WinSize,
        ) -> c_int;
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    extern "C" {
        fn openpty(
            master: *mut c_int,
            slave: *mut c_int,
            name: *mut c_char,
            termios: *const c_void,
            winsize: *const WinSize,
        ) -> c_int;
    }

    extern "C" {
        fn fork() -> c_int;
        fn setsid() -> c_int;
        fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
        fn dup2(old: c_int, new: c_int) -> c_int;
        fn close(fd: c_int) -> c_int;
        fn execve(
            path: *const c_char,
            argv: *const *const c_char,
            envp: *const *const c_char,
        ) -> c_int;
        fn execv(path: *const c_char, argv: *const *const c_char) -> c_int;
        fn chdir(path: *const c_char) -> c_int;
        fn signal(number: c_int, handler: *mut c_void) -> *mut c_void;
        fn _exit(status: c_int) -> !;
        fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
        fn kill(pid: c_int, signal: c_int) -> c_int;
        fn read(fd: c_int, buffer: *mut c_void, count: usize) -> isize;
        fn write(fd: c_int, buffer: *const c_void, count: usize) -> isize;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        fn poll(fds: *mut PollFd, count: c_ulong, timeout: c_int) -> c_int;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        fn poll(fds: *mut PollFd, count: c_uint, timeout: c_int) -> c_int;
        fn fcntl(fd: c_int, command: c_int, argument: c_int) -> c_int;
    }

    /// One session's OS resources and cached exit state.
    #[derive(Debug)]
    pub struct Session {
        master: Option<OwnedFd>,
        pid: c_int,
        exit_code: Option<i32>,
        finished: bool,
        eof: bool,
        closed: bool,
    }

    /// Internal read result: data, a timed-out wait, or a closed terminal.
    enum Chunk {
        Data(Vec<u8>),
        Timeout,
        Eof,
    }

    pub fn random_hex_16() -> Result<String, PtyError> {
        use std::io::Read;
        let mut file = std::fs::File::open("/dev/urandom")
            .map_err(|error| PtyError::Io(format!("cannot open /dev/urandom: {error}")))?;
        let mut bytes = [0u8; 16];
        file.read_exact(&mut bytes)
            .map_err(|error| PtyError::Io(format!("cannot read /dev/urandom: {error}")))?;
        Ok(crate::protocol::hex_lower(&bytes))
    }

    impl Session {
        pub fn spawn(
            program: &str,
            args: &[String],
            options: &SpawnOptions,
        ) -> Result<Self, PtyError> {
            let mut argv_storage: Vec<CString> = Vec::with_capacity(args.len() + 1);
            argv_storage.push(c_string(program)?);
            for argument in args {
                argv_storage.push(c_string(argument)?);
            }
            let mut argv: Vec<*const c_char> =
                argv_storage.iter().map(|value| value.as_ptr()).collect();
            argv.push(ptr::null());

            let environment = build_environment(&options.env)?;
            let env_ptrs: Option<Vec<*const c_char>> = environment.as_ref().map(|entries| {
                let mut pointers: Vec<*const c_char> =
                    entries.iter().map(|value| value.as_ptr()).collect();
                pointers.push(ptr::null());
                pointers
            });
            let env_pointer = env_ptrs
                .as_ref()
                .map_or(ptr::null(), |pointers| pointers.as_ptr());
            let candidates = executable_candidates(program, &options.env);
            if candidates.is_empty() {
                return Err(PtyError::Spawn(format!(
                    "no executable candidate for {program:?}"
                )));
            }
            let directory = match options.cwd.as_ref() {
                Some(path) => Some(path_string(path)?),
                None => None,
            };

            let size = WinSize {
                rows: options.rows,
                cols: options.cols,
                xpixel: 0,
                ypixel: 0,
            };
            let mut master: c_int = -1;
            let mut slave: c_int = -1;
            // SAFETY: both out parameters are live; a null termios keeps the
            // default line discipline, and the window size is copied.
            let opened =
                unsafe { openpty(&mut master, &mut slave, ptr::null_mut(), ptr::null(), &size) };
            if opened != 0 || master < 0 || slave < 0 {
                if master >= 0 {
                    // SAFETY: `master` is a descriptor we just opened.
                    unsafe { close(master) };
                }
                if slave >= 0 {
                    // SAFETY: as above.
                    unsafe { close(slave) };
                }
                return Err(PtyError::Spawn(format!(
                    "openpty failed ({})",
                    last_error()
                )));
            }
            // Keep the master out of unrelated children started later.
            // SAFETY: `master` is a live descriptor.
            unsafe { fcntl(master, F_SETFD, FD_CLOEXEC) };

            // SAFETY: the only calls between fork and exec are async-signal-safe
            // libc calls on buffers prepared before the fork.
            let pid = unsafe { fork() };
            if pid < 0 {
                // SAFETY: both descriptors are ours and are not stored yet.
                unsafe {
                    close(master);
                    close(slave);
                }
                return Err(PtyError::Spawn(format!("fork failed ({})", last_error())));
            }
            if pid == 0 {
                // SAFETY: child path; no allocation or Rust runtime use occurs
                // here, only the prepared C strings and descriptors.
                unsafe {
                    close(master);
                    // Rust ignores SIGPIPE for its own writes; the child is a
                    // normal program and must start with the default action.
                    signal(SIGPIPE, ptr::null_mut());
                    setsid();
                    ioctl(slave, TIOCSCTTY, 0);
                    dup2(slave, 0);
                    dup2(slave, 1);
                    dup2(slave, 2);
                    if slave > 2 {
                        close(slave);
                    }
                    if let Some(directory) = directory.as_ref() {
                        // A child in the wrong directory is worse than a clear
                        // failure, so give up if the chdir is refused.
                        if chdir(directory.as_ptr()) != 0 {
                            _exit(127);
                        }
                    }
                    for candidate in &candidates {
                        if env_pointer.is_null() {
                            execv(candidate.as_ptr(), argv.as_ptr());
                        } else {
                            execve(candidate.as_ptr(), argv.as_ptr(), env_pointer);
                        }
                    }
                    _exit(127);
                }
            }

            // SAFETY: the parent no longer needs the slave side.
            unsafe { close(slave) };
            // SAFETY: `master` is open and ownership moves into `OwnedFd`.
            let master = unsafe { OwnedFd::from_raw_fd(master) };
            Ok(Self {
                master: Some(master),
                pid,
                exit_code: None,
                finished: false,
                eof: false,
                closed: false,
            })
        }

        pub fn pid(&self) -> u32 {
            u32::try_from(self.pid).unwrap_or(0)
        }

        pub fn write(&mut self, bytes: &[u8]) -> Result<(), PtyError> {
            if self.closed || self.finished {
                return Err(PtyError::Io("the terminal is closed".into()));
            }
            let fd = self
                .master
                .as_ref()
                .map(AsRawFd::as_raw_fd)
                .ok_or_else(|| PtyError::Io("the terminal is closed".into()))?;
            let mut offset = 0usize;
            while offset < bytes.len() {
                let slice = bytes
                    .get(offset..)
                    .ok_or_else(|| PtyError::Io("write offset out of range".into()))?;
                let length = slice.len().min(WRITE_CHUNK_BYTES);
                let chunk = slice
                    .get(..length)
                    .ok_or_else(|| PtyError::Io("write chunk out of range".into()))?;
                // SAFETY: `chunk` is a live slice and `fd` is our master.
                let written = unsafe { write(fd, chunk.as_ptr().cast(), chunk.len()) };
                if written < 0 {
                    let error = last_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(PtyError::Io(format!("write failed: {error}")));
                }
                if written == 0 {
                    return Err(PtyError::Io("the terminal accepted no bytes".into()));
                }
                offset = offset.saturating_add(written as usize);
            }
            Ok(())
        }

        pub fn read(&mut self, timeout_ms: u32) -> Result<ReadOutcome, PtyError> {
            if self.finished {
                return Ok(ReadOutcome::terminal(self.exit_code));
            }
            if let Some(code) = self.exit_code {
                let wait = timeout_ms.min(EXIT_FLUSH_MS);
                return match self.read_chunk(wait)? {
                    Chunk::Data(data) => Ok(ReadOutcome {
                        data,
                        exited: false,
                        exit_code: Some(code),
                    }),
                    Chunk::Timeout | Chunk::Eof => {
                        self.finished = true;
                        Ok(ReadOutcome::terminal(Some(code)))
                    }
                };
            }

            let chunk = self.read_chunk(timeout_ms)?;
            if let Chunk::Data(data) = chunk {
                let code = self.try_reap();
                return Ok(ReadOutcome {
                    data,
                    exited: false,
                    exit_code: code,
                });
            }
            let eof = matches!(chunk, Chunk::Eof);
            if let Some(code) = self.try_reap() {
                self.finished = true;
                return Ok(ReadOutcome::terminal(Some(code)));
            }
            if eof {
                // The slave side is gone but the child may still be running
                // (it can close its standard streams). Wait out the caller's
                // budget in one sleep, then report the state.
                sleep_ms(timeout_ms);
                if let Some(code) = self.try_reap() {
                    self.finished = true;
                    return Ok(ReadOutcome::terminal(Some(code)));
                }
            }
            Ok(ReadOutcome::idle(None))
        }

        pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), PtyError> {
            if self.closed {
                return Err(PtyError::Io("the terminal is closed".into()));
            }
            let fd = self
                .master
                .as_ref()
                .map(AsRawFd::as_raw_fd)
                .ok_or_else(|| PtyError::Io("the terminal is closed".into()))?;
            let size = WinSize {
                rows,
                cols,
                xpixel: 0,
                ypixel: 0,
            };
            // SAFETY: `fd` is our master descriptor and `size` is a live
            // winsize; TIOCSWINSZ copies it.
            let result = unsafe { ioctl(fd, TIOCSWINSZ, &size as *const WinSize) };
            if result != 0 {
                return Err(PtyError::Io(format!("resize failed ({})", last_error())));
            }
            Ok(())
        }

        pub fn kill(&mut self) -> Result<i32, PtyError> {
            if let Some(code) = self.exit_code {
                return Ok(code);
            }
            // SAFETY: signal delivery to a child pid; the result only tells us
            // whether the child was already gone.
            unsafe { kill(self.pid, SIGKILL) };
            self.wait()
        }

        pub fn wait(&mut self) -> Result<i32, PtyError> {
            if let Some(code) = self.exit_code {
                return Ok(code);
            }
            let mut status: c_int = 0;
            loop {
                // SAFETY: `status` is a live out parameter; `pid` is our child.
                let result = unsafe { waitpid(self.pid, &mut status, 0) };
                if result == self.pid {
                    break;
                }
                if result < 0 {
                    let error = last_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    if error.raw_os_error() == Some(ECHILD) {
                        return self.exit_code.ok_or_else(|| {
                            PtyError::Io("the child is gone without a recorded status".into())
                        });
                    }
                    return Err(PtyError::Io(format!("waitpid failed: {error}")));
                }
            }
            let code = decode_status(status);
            self.exit_code = Some(code);
            Ok(code)
        }

        pub fn close(&mut self) {
            if self.closed {
                return;
            }
            if self.exit_code.is_none() {
                let _ = self.kill();
            }
            self.master.take();
            self.closed = true;
        }

        fn try_reap(&mut self) -> Option<i32> {
            if let Some(code) = self.exit_code {
                return Some(code);
            }
            let mut status: c_int = 0;
            // SAFETY: `status` is a live out parameter; `pid` is our child.
            let result = unsafe { waitpid(self.pid, &mut status, WNOHANG) };
            if result == self.pid {
                let code = decode_status(status);
                self.exit_code = Some(code);
                return Some(code);
            }
            None
        }

        fn read_chunk(&mut self, timeout_ms: u32) -> Result<Chunk, PtyError> {
            if self.eof || self.closed {
                return Ok(Chunk::Eof);
            }
            let fd = match self.master.as_ref() {
                Some(master) => master.as_raw_fd(),
                None => return Ok(Chunk::Eof),
            };
            let mut descriptor = PollFd {
                fd,
                events: POLLIN,
                revents: 0,
            };
            let timeout = c_int::try_from(timeout_ms).unwrap_or(c_int::MAX);
            // SAFETY: one live pollfd; the timeout is bounded by the caller.
            let ready = unsafe { poll(&mut descriptor, 1, timeout) };
            if ready < 0 {
                let error = last_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Ok(Chunk::Timeout);
                }
                return Err(PtyError::Io(format!("poll failed: {error}")));
            }
            if ready == 0 {
                return Ok(Chunk::Timeout);
            }
            if descriptor.revents & POLLNVAL != 0 {
                self.eof = true;
                return Ok(Chunk::Eof);
            }
            if (descriptor.revents & (POLLIN | POLLHUP)) == 0 {
                return Ok(Chunk::Timeout);
            }
            let mut buffer = vec![0u8; READ_CHUNK_BYTES];
            // SAFETY: the buffer is a live allocation of its own length and the
            // descriptor is readable (POLLIN/POLLHUP), so this does not block.
            let count = unsafe { read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count > 0 {
                let length = usize::try_from(count).unwrap_or(0).min(buffer.len());
                buffer.truncate(length);
                return Ok(Chunk::Data(buffer));
            }
            if count == 0 {
                self.eof = true;
                return Ok(Chunk::Eof);
            }
            let error = last_error();
            if error.kind() == std::io::ErrorKind::Interrupted
                || error.kind() == std::io::ErrorKind::WouldBlock
            {
                return Ok(Chunk::Timeout);
            }
            if error.raw_os_error() == Some(EIO) {
                // The slave side is gone; that is this backend's EOF.
                self.eof = true;
                return Ok(Chunk::Eof);
            }
            Err(PtyError::Io(format!("read failed: {error}")))
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            self.close();
        }
    }

    #[cfg(test)]
    pub fn child_is_reaped(pid: u32) -> bool {
        let Ok(pid) = c_int::try_from(pid) else {
            return false;
        };
        let mut status: c_int = 0;
        // SAFETY: `status` is a live out parameter; a non-child pid simply
        // returns ECHILD.
        let result = unsafe { waitpid(pid, &mut status, WNOHANG) };
        result == -1 && last_error().raw_os_error() == Some(ECHILD)
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const TIOCSWINSZ: c_ulong = 0x5414;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const TIOCSWINSZ: c_ulong = 0x8008_7467;

    fn c_string(text: &str) -> Result<CString, PtyError> {
        CString::new(text)
            .map_err(|_| PtyError::InvalidParam("arguments must not contain NUL".into()))
    }

    fn path_string(path: &Path) -> Result<CString, PtyError> {
        use std::os::unix::ffi::OsStrExt;
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| PtyError::InvalidParam("paths must not contain NUL".into()))
    }

    fn build_environment(overrides: &[(String, String)]) -> Result<Option<Vec<CString>>, PtyError> {
        if overrides.is_empty() {
            return Ok(None);
        }
        let mut merged: BTreeMap<String, String> = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        for (key, value) in overrides {
            if key.contains('=') || key.contains('\0') {
                return Err(PtyError::InvalidParam(format!(
                    "environment key {key:?} is not valid"
                )));
            }
            merged.insert(key.clone(), value.clone());
        }
        let entries = merged
            .iter()
            .map(|(key, value)| c_string(&format!("{key}={value}")))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(entries))
    }

    fn executable_candidates(program: &str, overrides: &[(String, String)]) -> Vec<CString> {
        if program.contains('/') {
            return match c_string(program) {
                Ok(value) => vec![value],
                Err(_) => Vec::new(),
            };
        }
        let search_path = overrides
            .iter()
            .rev()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var("PATH").ok());
        let Some(search_path) = search_path else {
            return match c_string(program) {
                Ok(value) => vec![value],
                Err(_) => Vec::new(),
            };
        };
        search_path
            .split(':')
            .filter(|directory| !directory.is_empty())
            .filter_map(|directory| c_string(&format!("{directory}/{program}")).ok())
            .collect()
    }

    fn sleep_ms(timeout_ms: u32) {
        let timeout = c_int::try_from(timeout_ms).unwrap_or(c_int::MAX);
        if timeout == 0 {
            return;
        }
        // SAFETY: a zero-descriptor poll is the portable millisecond sleep.
        unsafe { poll(ptr::null_mut(), 0, timeout) };
    }

    /// Shell's view of a wait status: exit code, or `128 + signal`.
    fn decode_status(status: c_int) -> i32 {
        let signal = status & 0x7f;
        if signal == 0 {
            (status >> 8) & 0xff
        } else {
            128 + signal
        }
    }

    fn last_error() -> std::io::Error {
        std::io::Error::last_os_error()
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    //! No backend on this target; every operation fails with a typed error that
    //! names the platform instead of pretending to work.

    use super::{PtyError, ReadOutcome, SpawnOptions};

    #[derive(Debug)]
    pub struct Session;

    pub fn random_hex_16() -> Result<String, PtyError> {
        Err(PtyError::Unsupported(std::env::consts::OS))
    }

    impl Session {
        pub fn spawn(
            _program: &str,
            _args: &[String],
            _options: &SpawnOptions,
        ) -> Result<Self, PtyError> {
            Err(PtyError::Unsupported(std::env::consts::OS))
        }

        pub fn pid(&self) -> u32 {
            0
        }

        pub fn write(&mut self, _bytes: &[u8]) -> Result<(), PtyError> {
            Err(PtyError::Unsupported(std::env::consts::OS))
        }

        pub fn read(&mut self, _timeout_ms: u32) -> Result<ReadOutcome, PtyError> {
            Err(PtyError::Unsupported(std::env::consts::OS))
        }

        pub fn resize(&mut self, _cols: u16, _rows: u16) -> Result<(), PtyError> {
            Err(PtyError::Unsupported(std::env::consts::OS))
        }

        pub fn kill(&mut self) -> Result<i32, PtyError> {
            Err(PtyError::Unsupported(std::env::consts::OS))
        }

        pub fn wait(&mut self) -> Result<i32, PtyError> {
            Err(PtyError::Unsupported(std::env::consts::OS))
        }

        pub fn close(&mut self) {}
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn options() -> SpawnOptions {
        SpawnOptions::default()
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    /// Read until `needle` shows up (or the budget runs out), returning
    /// everything seen so the caller can assert on it.
    fn read_until(session: &mut PtySession, needle: &str, budget_ms: u64) -> (String, Option<i32>) {
        let start = Instant::now();
        let mut collected: Vec<u8> = Vec::new();
        let mut exit_code = None;
        while start.elapsed() < Duration::from_millis(budget_ms) {
            let outcome = session.read(250).expect("read");
            collected.extend_from_slice(&outcome.data);
            exit_code = outcome.exit_code;
            if String::from_utf8_lossy(&collected).contains(needle) || outcome.exited {
                break;
            }
        }
        (String::from_utf8_lossy(&collected).into_owned(), exit_code)
    }

    /// Read until one call returns no data (the terminal went quiet), or the
    /// budget runs out; never blocks longer than the budget.
    fn read_quiet(session: &mut PtySession, budget_ms: u64) -> ReadOutcome {
        let start = Instant::now();
        let mut last = ReadOutcome {
            data: Vec::new(),
            exited: false,
            exit_code: None,
        };
        while start.elapsed() < Duration::from_millis(budget_ms) {
            last = session.read(100).expect("read");
            if last.exited || last.data.is_empty() {
                return last;
            }
        }
        last
    }

    fn drain_registry(registry: &mut SessionRegistry, id: &str) -> Option<i32> {
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(5_000) {
            let outcome = registry.read(id, 250).expect("read");
            if outcome.exited {
                return outcome.exit_code;
            }
        }
        None
    }

    fn drain_until_exit(session: &mut PtySession, budget_ms: u64) -> (String, Option<i32>) {
        let start = Instant::now();
        let mut collected: Vec<u8> = Vec::new();
        let mut exit_code = None;
        while start.elapsed() < Duration::from_millis(budget_ms) {
            let outcome = session.read(250).expect("read");
            collected.extend_from_slice(&outcome.data);
            exit_code = outcome.exit_code;
            if outcome.exited {
                break;
            }
        }
        (String::from_utf8_lossy(&collected).into_owned(), exit_code)
    }

    #[test]
    fn session_identifiers_are_opaque_and_unique() {
        let first = platform::random_hex_16().expect("identifier");
        let second = platform::random_hex_16().expect("identifier");
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn an_empty_program_is_refused() {
        assert_eq!(
            PtySession::spawn("", &[], &options()).unwrap_err(),
            PtyError::InvalidParam("program must not be empty".into())
        );
    }

    #[test]
    fn zero_dimensions_are_refused() {
        let bad = SpawnOptions {
            cols: 0,
            ..SpawnOptions::default()
        };
        assert!(matches!(
            PtySession::spawn("nope", &[], &bad),
            Err(PtyError::InvalidParam(_))
        ));
    }

    #[test]
    fn an_unknown_session_is_a_typed_error() {
        let mut registry = SessionRegistry::new();
        assert_eq!(
            registry.read("nope", 10).unwrap_err(),
            PtyError::UnknownSession("nope".into())
        );
        assert_eq!(
            registry.kill("nope").unwrap_err(),
            PtyError::UnknownSession("nope".into())
        );
        assert_eq!(
            registry.close("nope").unwrap_err(),
            PtyError::UnknownSession("nope".into())
        );
        assert!(registry.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_child_reports_its_marker_and_exit_code() {
        let mut session = PtySession::spawn(
            "cmd.exe",
            &strings(&["/d", "/c", "echo droide-pty-marker"]),
            &options(),
        )
        .expect("spawn");
        let (text, code) = drain_until_exit(&mut session, 5_000);
        assert!(text.contains("droide-pty-marker"), "output: {text:?}");
        assert_eq!(code, Some(0));
        assert!(session.read(10).expect("read").exited);
    }

    #[cfg(unix)]
    #[test]
    fn a_child_reports_its_marker_and_exit_code() {
        let mut session = PtySession::spawn(
            "/bin/sh",
            &strings(&["-c", "printf droide-pty-marker"]),
            &options(),
        )
        .expect("spawn");
        let (text, code) = drain_until_exit(&mut session, 5_000);
        assert!(text.contains("droide-pty-marker"), "output: {text:?}");
        assert_eq!(code, Some(0));
        assert!(session.read(10).expect("read").exited);
    }

    #[cfg(windows)]
    #[test]
    fn a_write_reaches_a_child_that_echoes() {
        let mut session =
            PtySession::spawn("cmd.exe", &strings(&["/d", "/q", "/k"]), &options()).expect("spawn");
        read_until(&mut session, ">", 3_000);
        session.write(b"echo droide-echo-probe\r\n").expect("write");
        let (text, _) = read_until(&mut session, "droide-echo-probe", 3_000);
        assert!(text.contains("droide-echo-probe"), "output: {text:?}");
        session.kill().expect("kill");
    }

    #[cfg(unix)]
    #[test]
    fn a_write_reaches_a_child_that_echoes() {
        let mut session = PtySession::spawn("/bin/cat", &[], &options()).expect("spawn");
        session.write(b"droide-echo-probe\n").expect("write");
        let (text, _) = read_until(&mut session, "droide-echo-probe", 3_000);
        assert!(text.contains("droide-echo-probe"), "output: {text:?}");
        session.kill().expect("kill");
    }

    #[cfg(windows)]
    #[test]
    fn resize_then_kill_reports_the_exit_without_leaving_the_child() {
        let mut session =
            PtySession::spawn("cmd.exe", &strings(&["/d", "/q", "/k"]), &options()).expect("spawn");
        let pid = session.pid();
        assert!(pid > 0);
        // Consume the banner/prompt so the timeout below sees a quiet child.
        read_until(&mut session, ">", 3_000);
        let outcome = read_quiet(&mut session, 3_000);
        assert!(outcome.data.is_empty(), "timeout must not return data");
        assert!(!outcome.exited, "the shell is still running");
        session.resize(120, 40).expect("resize");
        let outcome = read_quiet(&mut session, 1_000);
        assert!(outcome.data.is_empty(), "a resize is not output");
        assert!(!outcome.exited, "the child survives the read timeout");
        let code = session.kill().expect("kill");
        assert_ne!(code, 0, "an interrupted child does not exit cleanly");
        assert!(
            platform::process_has_exited(pid),
            "the killed child must be gone"
        );
        let after = session.read(10).expect("read");
        assert!(after.exited);
        assert_eq!(after.exit_code, Some(code));
        assert_eq!(session.kill().expect("kill is idempotent"), code);
    }

    #[cfg(unix)]
    #[test]
    fn resize_then_kill_reports_the_exit_without_leaving_the_child() {
        let mut session =
            PtySession::spawn("/bin/sh", &strings(&["-c", "sleep 30"]), &options()).expect("spawn");
        let pid = session.pid();
        assert!(pid > 0);
        session.resize(120, 40).expect("resize");
        let outcome = read_quiet(&mut session, 1_000);
        assert!(outcome.data.is_empty(), "timeout must not return data");
        assert!(!outcome.exited, "the child is still running");
        assert_eq!(session.resize(80, 24), Ok(()));
        let code = session.kill().expect("kill");
        assert_eq!(code, 137, "SIGKILL is reported as 128 + signal");
        let after = session.read(10).expect("read");
        assert!(after.exited);
        assert_eq!(after.exit_code, Some(code));
        assert!(platform::child_is_reaped(pid), "the child must be reaped");
        assert_eq!(session.kill().expect("kill is idempotent"), code);
    }

    #[cfg(windows)]
    #[test]
    fn a_closed_session_is_a_typed_error_and_releases_the_child() {
        let mut registry = SessionRegistry::new();
        let id = registry
            .spawn(
                "cmd.exe",
                &strings(&["/d", "/q", "/k"]),
                SpawnOptions::default(),
            )
            .expect("spawn");
        assert_eq!(registry.len(), 1);
        registry.close(&id).expect("close");
        assert!(registry.is_empty());
        assert_eq!(
            registry.read(&id, 10).unwrap_err(),
            PtyError::SessionClosed(id.clone())
        );
        assert_eq!(
            registry.write(&id, b"x").unwrap_err(),
            PtyError::SessionClosed(id.clone())
        );
        registry.close(&id).expect("close is idempotent");
    }

    #[cfg(unix)]
    #[test]
    fn a_closed_session_is_a_typed_error_and_releases_the_child() {
        let mut registry = SessionRegistry::new();
        let id = registry
            .spawn(
                "/bin/sh",
                &strings(&["-c", "sleep 30"]),
                SpawnOptions::default(),
            )
            .expect("spawn");
        assert_eq!(registry.len(), 1);
        registry.close(&id).expect("close");
        assert!(registry.is_empty());
        assert_eq!(
            registry.read(&id, 10).unwrap_err(),
            PtyError::SessionClosed(id.clone())
        );
        registry.close(&id).expect("close is idempotent");
    }

    #[cfg(windows)]
    #[test]
    fn two_sessions_get_different_identifiers_and_both_close() {
        let mut registry = SessionRegistry::new();
        let first = registry
            .spawn(
                "cmd.exe",
                &strings(&["/d", "/c", "echo one"]),
                SpawnOptions::default(),
            )
            .expect("spawn");
        let second = registry
            .spawn(
                "cmd.exe",
                &strings(&["/d", "/c", "echo two"]),
                SpawnOptions::default(),
            )
            .expect("spawn");
        assert_ne!(first, second);
        assert_eq!(drain_registry(&mut registry, &first), Some(0));
        assert_eq!(drain_registry(&mut registry, &second), Some(0));
        registry.close_all();
        assert!(registry.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn two_sessions_get_different_identifiers_and_both_close() {
        let mut registry = SessionRegistry::new();
        let first = registry
            .spawn(
                "/bin/sh",
                &strings(&["-c", "printf one"]),
                SpawnOptions::default(),
            )
            .expect("spawn");
        let second = registry
            .spawn(
                "/bin/sh",
                &strings(&["-c", "printf two"]),
                SpawnOptions::default(),
            )
            .expect("spawn");
        assert_ne!(first, second);
        assert_eq!(drain_registry(&mut registry, &first), Some(0));
        assert_eq!(drain_registry(&mut registry, &second), Some(0));
        registry.close_all();
        assert!(registry.is_empty());
    }
}
