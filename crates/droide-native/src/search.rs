//! File discovery and literal text search.
//!
//! Contract: `specs/90-native-layer.md` §"ripgrep / fff" and
//! `specs/30-tools-and-sandbox.md` §B18–B21: discovery never follows a symlinked
//! directory out of the root, never enters a VCS metadata directory, and every
//! result set is bounded.
//!
//! Deliberately dependency-free: a literal matcher plus a small glob matcher,
//! because the helper must build without a registry mirror.

use std::fs;
use std::io;
use std::path::PathBuf;

/// Directory names never descended into.
const SKIPPED_DIRECTORIES: &[&str] = &[".git", ".hg", ".svn", ".jj"];

/// Hard ceilings that a caller cannot raise.
pub const MAX_RESULTS_LIMIT: usize = 10_000;
pub const MAX_HITS_LIMIT: usize = 1_000;
pub const MAX_FILE_BYTES: u64 = 1 << 20;
pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone)]
pub struct WalkOptions {
    pub root: PathBuf,
    pub glob: Option<String>,
    pub max_results: usize,
    pub include_hidden: bool,
}

#[derive(Debug, Default)]
pub struct WalkResult {
    pub paths: Vec<PathBuf>,
    pub truncated: bool,
}

/// Glob match supporting `*` (within one segment), `**` (across segments) and
/// `?`. Matching is anchored at the whole path.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let path: Vec<char> = path.chars().collect();
    matches_from(&pattern, 0, &path, 0)
}

/// Bounds-checked matcher: every index below is guarded by the loop conditions
/// (`p < pattern.len()`, `s < path.len()`), which clippy cannot see through.
#[allow(clippy::indexing_slicing)]
fn matches_from(pattern: &[char], mut p: usize, path: &[char], mut s: usize) -> bool {
    while p < pattern.len() {
        match pattern[p] {
            '*' => {
                let double = p + 1 < pattern.len() && pattern[p + 1] == '*';
                let next = p + if double { 2 } else { 1 };
                // `**/` also matches zero directories.
                let skip_slash = double && next < pattern.len() && pattern[next] == '/';
                if skip_slash && matches_from(pattern, next + 1, path, s) {
                    return true;
                }
                let mut cursor = s;
                loop {
                    if matches_from(pattern, next, path, cursor) {
                        return true;
                    }
                    if cursor >= path.len() {
                        return false;
                    }
                    let ch = path[cursor];
                    cursor += 1;
                    if !double && ch == '/' {
                        return false;
                    }
                }
            }
            '?' => {
                if s >= path.len() || path[s] == '/' {
                    return false;
                }
                p += 1;
                s += 1;
            }
            '\\' if p + 1 < pattern.len() => {
                if s >= path.len() || path[s] != pattern[p + 1] {
                    return false;
                }
                p += 2;
                s += 1;
            }
            literal => {
                if s >= path.len() || path[s] != literal {
                    return false;
                }
                p += 1;
                s += 1;
            }
        }
    }
    s == path.len()
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// Walk `root` collecting files that match `glob` (or every file).
pub fn walk(options: &WalkOptions) -> io::Result<WalkResult> {
    let max_results = options.max_results.clamp(1, MAX_RESULTS_LIMIT);
    let mut result = WalkResult::default();
    let mut stack: Vec<(PathBuf, usize)> = vec![(options.root.clone(), 0)];

    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            result.truncated = true;
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            // An unreadable subdirectory is skipped, not fatal: the walk is a
            // discovery aid, and one bad folder must not hide the rest.
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                if SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                    continue;
                }
                if is_hidden(&name) && !options.include_hidden {
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if is_hidden(&name) && !options.include_hidden {
                continue;
            }
            let relative = path
                .strip_prefix(&options.root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if let Some(pattern) = options.glob.as_deref() {
                if !glob_matches(pattern, &relative) {
                    continue;
                }
            }
            if result.paths.len() >= max_results {
                result.truncated = true;
                return Ok(result);
            }
            result.paths.push(relative.into());
        }
    }
    result.paths.sort();
    Ok(result)
}

#[derive(Debug, Clone)]
pub struct TextOptions {
    pub root: PathBuf,
    pub query: String,
    pub max_hits: usize,
    pub case_sensitive: bool,
    pub max_file_bytes: u64,
    pub include_hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextHit {
    pub path: String,
    /// 1-based line number.
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct TextResult {
    pub hits: Vec<TextHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

/// Literal substring search across the files under `root`.
pub fn search_text(options: &TextOptions) -> io::Result<TextResult> {
    if options.query.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "query must not be empty",
        ));
    }
    let max_hits = options.max_hits.clamp(1, MAX_HITS_LIMIT);
    let budget = options.max_file_bytes.min(MAX_FILE_BYTES);
    let discovery = walk(&WalkOptions {
        root: options.root.clone(),
        glob: None,
        max_results: MAX_RESULTS_LIMIT,
        include_hidden: options.include_hidden,
    })?;

    let needle = if options.case_sensitive {
        options.query.clone()
    } else {
        options.query.to_lowercase()
    };

    let mut result = TextResult::default();
    for relative in discovery.paths {
        let absolute = options.root.join(&relative);
        let metadata = match fs::metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > budget {
            continue;
        }
        let bytes = match fs::read(&absolute) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        // Binary files are skipped rather than searched as text.
        if bytes.iter().take(4096).any(|byte| *byte == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        result.files_scanned += 1;
        for (index, line) in text.lines().enumerate() {
            let haystack = if options.case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if !haystack.contains(&needle) {
                continue;
            }
            if result.hits.len() >= max_hits {
                result.truncated = true;
                return Ok(result);
            }
            result.hits.push(TextHit {
                path: relative.to_string_lossy().replace('\\', "/"),
                line: index + 1,
                text: line.chars().take(400).collect(),
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "droide-search-{}-{name}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn alpha() {}\n// beta\n").unwrap();
        fs::write(root.join("src/nested/deep.rs"), "alpha again\n").unwrap();
        fs::write(root.join(".git/config"), "alpha in metadata\n").unwrap();
        fs::write(root.join(".hidden.rs"), "alpha hidden\n").unwrap();
        root
    }

    #[test]
    fn walks_files_and_skips_vcs_metadata() {
        let root = fixture("walk");
        let result = walk(&WalkOptions {
            root: root.clone(),
            glob: None,
            max_results: 100,
            include_hidden: false,
        })
        .unwrap();
        let paths: Vec<String> = result
            .paths
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(paths, vec!["src/lib.rs", "src/nested/deep.rs"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_glob_filters_by_relative_path() {
        let root = fixture("glob");
        let result = walk(&WalkOptions {
            root: root.clone(),
            glob: Some("**/*.rs".into()),
            max_results: 100,
            include_hidden: false,
        })
        .unwrap();
        assert_eq!(result.paths.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hidden_entries_are_opt_in() {
        let root = fixture("hidden");
        let result = walk(&WalkOptions {
            root: root.clone(),
            glob: Some("*.rs".into()),
            max_results: 100,
            include_hidden: true,
        })
        .unwrap();
        assert!(result
            .paths
            .iter()
            .any(|path| path.to_string_lossy().contains(".hidden.rs")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_walk_is_bounded_and_reports_truncation() {
        let root = fixture("bounded");
        let result = walk(&WalkOptions {
            root: root.clone(),
            glob: None,
            max_results: 1,
            include_hidden: false,
        })
        .unwrap();
        assert_eq!(result.paths.len(), 1);
        assert!(result.truncated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_search_reports_path_line_and_text() {
        let root = fixture("text");
        let result = search_text(&TextOptions {
            root: root.clone(),
            query: "alpha".into(),
            max_hits: 10,
            case_sensitive: false,
            max_file_bytes: MAX_FILE_BYTES,
            include_hidden: false,
        })
        .unwrap();
        assert_eq!(result.hits.len(), 2);
        assert!(result.hits.iter().all(|hit| hit.line == 1));
        assert!(result.hits.iter().all(|hit| hit.text.contains("alpha")));
        assert!(result.hits.iter().all(|hit| !hit.path.contains(".git")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_search_is_case_insensitive_by_default_and_stoppable() {
        let root = fixture("case");
        let result = search_text(&TextOptions {
            root: root.clone(),
            query: "ALPHA".into(),
            max_hits: 1,
            case_sensitive: false,
            max_file_bytes: MAX_FILE_BYTES,
            include_hidden: false,
        })
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert!(result.truncated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_empty_query_is_refused() {
        let root = fixture("empty");
        let error = search_text(&TextOptions {
            root: root.clone(),
            query: String::new(),
            max_hits: 10,
            case_sensitive: false,
            max_file_bytes: MAX_FILE_BYTES,
            include_hidden: false,
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn binary_files_are_not_searched() {
        let root = fixture("binary");
        fs::write(root.join("blob.bin"), b"alpha\0\0\0").unwrap();
        let result = search_text(&TextOptions {
            root: root.clone(),
            query: "alpha".into(),
            max_hits: 10,
            case_sensitive: false,
            max_file_bytes: MAX_FILE_BYTES,
            include_hidden: false,
        })
        .unwrap();
        assert!(result.hits.iter().all(|hit| hit.path != "blob.bin"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn glob_matching_handles_star_and_question_mark() {
        assert!(glob_matches("*.rs", "main.rs"));
        assert!(!glob_matches("*.rs", "src/main.rs"));
        assert!(glob_matches("**/*.rs", "src/deep/main.rs"));
        assert!(glob_matches("src/?.rs", "src/a.rs"));
        assert!(!glob_matches("src/?.rs", "src/ab.rs"));
        assert!(glob_matches("src/**/x.rs", "src/a/b/x.rs"));
        assert!(glob_matches("src/**/x.rs", "src/x.rs"));
    }
}
