//! Path resolution that cannot leave its root.
//!
//! Contract: `specs/90-native-layer.md` (filesystem boundary) and
//! `specs/30-tools-and-sandbox.md` §B23–B24. The helper receives paths from the
//! TypeScript layer, which already resolved them — but a helper must never trust
//! its caller more than the process it spawned, so every path is re-validated
//! here before a syscall touches it.

use std::fmt;
use std::path::{Component, Path, PathBuf};

/// Why a candidate path was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    /// The candidate contains a `..` component after normalisation.
    EscapesRoot,
    /// The candidate is absolute and outside the root.
    OutsideRoot,
    /// The candidate is empty or made only of separators.
    Empty,
    /// The candidate contains a NUL byte.
    NulByte,
}

impl fmt::Display for PathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::EscapesRoot => "path escapes the workspace root",
            Self::OutsideRoot => "path is outside the workspace root",
            Self::Empty => "path is empty",
            Self::NulByte => "path contains a NUL byte",
        };
        formatter.write_str(text)
    }
}

impl std::error::Error for PathError {}

/// Normalise `candidate` against `root`, refusing anything that would land
/// outside it.
///
/// Lexical only: symlinks are resolved by the caller with
/// [`canonicalize_within`], because a lexical check cannot see them.
pub fn resolve_within(root: &Path, candidate: &Path) -> Result<PathBuf, PathError> {
    if candidate.as_os_str().is_empty() {
        return Err(PathError::Empty);
    }
    if candidate.to_string_lossy().contains('\0') {
        return Err(PathError::NulByte);
    }

    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };

    let mut normalised = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                if !normalised.pop() {
                    return Err(PathError::EscapesRoot);
                }
            }
            Component::CurDir => {}
            other => normalised.push(other.as_os_str()),
        }
    }

    if !normalised.starts_with(root) {
        return Err(PathError::OutsideRoot);
    }
    Ok(normalised)
}

/// Resolve symlinks and re-check containment.
///
/// Returns the canonical path when it is inside `root`, otherwise
/// [`PathError::OutsideRoot`].
pub fn canonicalize_within(root: &Path, candidate: &Path) -> Result<PathBuf, PathError> {
    let lexical = resolve_within(root, candidate)?;
    let canonical_root = root.canonicalize().map_err(|_| PathError::OutsideRoot)?;
    let canonical = lexical.canonicalize().map_err(|_| PathError::OutsideRoot)?;
    if canonical.starts_with(&canonical_root) {
        Ok(canonical)
    } else {
        Err(PathError::OutsideRoot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root() -> PathBuf {
        PathBuf::from("/workspace/project")
    }

    #[test]
    fn accepts_a_relative_path_inside_the_root() {
        let resolved = resolve_within(&root(), Path::new("src/main.rs")).unwrap();
        assert_eq!(resolved, PathBuf::from("/workspace/project/src/main.rs"));
    }

    #[test]
    fn accepts_a_dot_segment() {
        let resolved = resolve_within(&root(), Path::new("./src/./lib.rs")).unwrap();
        assert_eq!(resolved, PathBuf::from("/workspace/project/src/lib.rs"));
    }

    #[test]
    fn refuses_a_parent_escape() {
        // `..` is normalised first, so the result is a path outside the root
        // rather than a parent-segment error.
        assert_eq!(
            resolve_within(&root(), Path::new("../secrets.txt")),
            Err(PathError::OutsideRoot)
        );
        assert_eq!(
            resolve_within(&root(), Path::new("src/../../outside.txt")),
            Err(PathError::OutsideRoot)
        );
    }

    #[test]
    fn refuses_to_pop_past_the_filesystem_root() {
        assert_eq!(
            resolve_within(Path::new("/"), Path::new("../../x")),
            Err(PathError::EscapesRoot)
        );
    }

    #[test]
    fn refuses_an_absolute_path_outside_the_root() {
        assert_eq!(
            resolve_within(&root(), Path::new("/etc/passwd")),
            Err(PathError::OutsideRoot)
        );
    }

    #[test]
    fn accepts_an_absolute_path_inside_the_root() {
        let resolved =
            resolve_within(&root(), Path::new("/workspace/project/src/main.rs")).unwrap();
        assert_eq!(resolved, PathBuf::from("/workspace/project/src/main.rs"));
    }

    #[test]
    fn refuses_empty_and_nul_paths() {
        assert_eq!(
            resolve_within(&root(), Path::new("")),
            Err(PathError::Empty)
        );
        assert_eq!(
            resolve_within(&root(), Path::new("a\0b")),
            Err(PathError::NulByte)
        );
    }

    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let base = std::env::temp_dir().join(format!("droide-paths-{}", std::process::id()));
        let inside = base.join("inside");
        let outside = base.join("outside");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "s").unwrap();

        let link = inside.join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.txt"), &link).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(outside.join("secret.txt"), &link).is_err() {
                // Symlink creation needs a privilege on Windows; skip, not fail.
                let _ = fs::remove_dir_all(&base);
                return;
            }
        }

        let result = canonicalize_within(&inside, Path::new("escape"));
        assert_eq!(result, Err(PathError::OutsideRoot));
        let _ = fs::remove_dir_all(&base);
    }
}
