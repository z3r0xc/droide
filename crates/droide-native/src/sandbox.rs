//! Sandbox profile generation.
//!
//! Contract: `specs/30-tools-and-sandbox.md` §B26–B30. The helper produces the
//! *description* of a sandbox; enforcement is the platform's:
//!
//! * Linux — `bubblewrap` argv with read-only binds, an unshared network unless
//!   the request allows it, and no capability escalation;
//! * macOS — a seatbelt profile in the documented `(version 1)` denylist form;
//! * Windows — no filesystem confinement is available to us, so the profile says
//!   so explicitly instead of pretending a jail exists.
//!
//! A profile that cannot express the request is refused, never silently weakened.

use std::fmt;

/// What the caller wants confined.
#[derive(Debug, Clone, Default)]
pub struct SandboxRequest {
    /// Whether outbound network access is allowed.
    pub network: bool,
    /// Extra paths that must be readable (already absolute).
    pub read_paths: Vec<String>,
    /// Paths that must be writable; the working directory is implied.
    pub write_paths: Vec<String>,
}

/// A generated profile: what to run, and how the platform enforces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxProfile {
    /// `bubblewrap` invocation prefix.
    Bubblewrap { argv: Vec<String> },
    /// A seatbelt profile document.
    Seatbelt { profile: String },
    /// The platform enforces nothing at this layer.
    Unconfined { reason: String },
}

impl SandboxProfile {
    pub fn mechanism(&self) -> &'static str {
        match self {
            Self::Bubblewrap { .. } => "bubblewrap",
            Self::Seatbelt { .. } => "seatbelt",
            Self::Unconfined { .. } => "unconfined",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SandboxError {
    /// A path is not absolute or contains a NUL byte.
    InvalidPath(String),
    /// Too many paths for one profile.
    TooManyPaths,
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(path) => write!(formatter, "invalid sandbox path: {path}"),
            Self::TooManyPaths => formatter.write_str("too many sandbox paths"),
        }
    }
}

impl std::error::Error for SandboxError {}

/// Upper bound on paths per profile; beyond this the caller is doing something
/// wrong and a silent truncation would weaken the sandbox.
pub const MAX_PATHS: usize = 256;

fn validate(paths: &[String]) -> Result<(), SandboxError> {
    if paths.len() > MAX_PATHS {
        return Err(SandboxError::TooManyPaths);
    }
    for path in paths {
        if path.contains('\0') || !(path.starts_with('/') || path.starts_with("\\\\")) {
            return Err(SandboxError::InvalidPath(path.clone()));
        }
    }
    Ok(())
}

/// Build the `bubblewrap` argv for a request.
///
/// The argv starts with `--` so the caller appends `-- <command> <args>`.
pub fn bubblewrap(request: &SandboxRequest) -> Result<SandboxProfile, SandboxError> {
    validate(&request.read_paths)?;
    validate(&request.write_paths)?;

    let mut argv: Vec<String> = vec![
        "--die-with-parent".into(),
        "--unshare-pid".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--tmpfs".into(),
        "/tmp".into(),
    ];
    if !request.network {
        argv.push("--unshare-net".into());
    }
    for path in ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"] {
        argv.push("--ro-bind-try".into());
        argv.push(path.into());
        argv.push(path.into());
    }
    for path in &request.read_paths {
        argv.push("--ro-bind-try".into());
        argv.push(path.clone());
        argv.push(path.clone());
    }
    for path in &request.write_paths {
        argv.push("--bind-try".into());
        argv.push(path.clone());
        argv.push(path.clone());
    }
    argv.push("--".into());
    Ok(SandboxProfile::Bubblewrap { argv })
}

/// Build a seatbelt profile document.
///
/// Deny by default, then allow the documented minimum: process execution and
/// reads under the listed paths, writes only under the requested paths, and
/// outbound network only when allowed.
pub fn seatbelt(request: &SandboxRequest) -> Result<SandboxProfile, SandboxError> {
    validate(&request.read_paths)?;
    validate(&request.write_paths)?;

    let mut profile = String::from("(version 1)\n(deny default)\n");
    profile.push_str("(allow process-exec process-fork signal)\n");
    profile.push_str("(allow sysctl-read mach-lookup)\n");
    profile.push_str("(allow file-read*)\n");

    if request.write_paths.is_empty() {
        profile.push_str("(allow file-write* (subpath \"/dev\"))\n");
    } else {
        for path in &request.write_paths {
            profile.push_str(&format!(
                "(allow file-write* (subpath \"{}\"))\n",
                escape_seatbelt(path)
            ));
        }
    }
    if request.network {
        profile.push_str("(allow network*)\n");
    }
    Ok(SandboxProfile::Seatbelt { profile })
}

fn escape_seatbelt(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Windows: the subject confines the network only, and filesystem enforcement is
/// the application's job. Report that rather than implying a jail.
pub fn windows(_request: &SandboxRequest) -> Result<SandboxProfile, SandboxError> {
    Ok(SandboxProfile::Unconfined {
        reason:
            "this platform confines the network only; filesystem access is enforced by the caller"
                .into(),
    })
}

/// Choose the profile for `target_os` (`linux`, `macos`, `windows`).
pub fn profile_for(
    target_os: &str,
    request: &SandboxRequest,
) -> Result<SandboxProfile, SandboxError> {
    match target_os {
        "linux" => bubblewrap(request),
        "macos" => seatbelt(request),
        "windows" => windows(request),
        other => Ok(SandboxProfile::Unconfined {
            reason: format!("no sandbox mechanism for target {other}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SandboxRequest {
        SandboxRequest {
            network: false,
            read_paths: vec!["/workspace/project".into()],
            write_paths: vec!["/workspace/project/target".into()],
        }
    }

    #[test]
    fn bubblewrap_denies_network_by_default() {
        let profile = bubblewrap(&request()).unwrap();
        let SandboxProfile::Bubblewrap { argv } = profile else {
            panic!("expected bubblewrap");
        };
        assert!(argv.iter().any(|arg| arg == "--unshare-net"));
        assert!(argv.iter().any(|arg| arg == "--die-with-parent"));
        assert_eq!(argv.last().map(String::as_str), Some("--"));
    }

    #[test]
    fn bubblewrap_allows_network_when_asked() {
        let profile = bubblewrap(&SandboxRequest {
            network: true,
            ..request()
        })
        .unwrap();
        let SandboxProfile::Bubblewrap { argv } = profile else {
            panic!("expected bubblewrap");
        };
        assert!(!argv.iter().any(|arg| arg == "--unshare-net"));
    }

    #[test]
    fn bubblewrap_binds_reads_read_only_and_writes_writable() {
        let profile = bubblewrap(&request()).unwrap();
        let SandboxProfile::Bubblewrap { argv } = profile else {
            panic!("expected bubblewrap");
        };
        let joined = argv.join(" ");
        assert!(joined.contains("--ro-bind-try /workspace/project /workspace/project"));
        assert!(joined.contains("--bind-try /workspace/project/target /workspace/project/target"));
    }

    #[test]
    fn a_relative_path_is_refused() {
        let bad = SandboxRequest {
            network: false,
            read_paths: vec!["relative/path".into()],
            write_paths: vec![],
        };
        assert_eq!(
            bubblewrap(&bad),
            Err(SandboxError::InvalidPath("relative/path".into()))
        );
    }

    #[test]
    fn too_many_paths_is_refused_rather_than_truncated() {
        let bad = SandboxRequest {
            network: false,
            read_paths: (0..=MAX_PATHS).map(|index| format!("/p{index}")).collect(),
            write_paths: vec![],
        };
        assert_eq!(bubblewrap(&bad), Err(SandboxError::TooManyPaths));
    }

    #[test]
    fn seatbelt_denies_by_default_and_writes_only_requested_paths() {
        let profile = seatbelt(&request()).unwrap();
        let SandboxProfile::Seatbelt { profile } = profile else {
            panic!("expected seatbelt");
        };
        assert!(profile.starts_with("(version 1)\n(deny default)\n"));
        assert!(profile.contains("(allow file-write* (subpath \"/workspace/project/target\"))"));
        assert!(!profile.contains("(allow network*)"));
    }

    #[test]
    fn seatbelt_escapes_quotes_in_paths() {
        let profile = seatbelt(&SandboxRequest {
            network: false,
            read_paths: vec![],
            write_paths: vec!["/tmp/a\"b".into()],
        })
        .unwrap();
        let SandboxProfile::Seatbelt { profile } = profile else {
            panic!("expected seatbelt");
        };
        assert!(profile.contains("/tmp/a\\\"b"));
    }

    #[test]
    fn windows_reports_that_it_does_not_confine_the_filesystem() {
        let profile = profile_for("windows", &request()).unwrap();
        assert_eq!(profile.mechanism(), "unconfined");
        let SandboxProfile::Unconfined { reason } = profile else {
            panic!("expected unconfined");
        };
        assert!(reason.contains("network only"));
    }

    #[test]
    fn an_unknown_target_is_unconfined_with_a_reason() {
        let profile = profile_for("plan9", &request()).unwrap();
        assert_eq!(profile.mechanism(), "unconfined");
    }
}
