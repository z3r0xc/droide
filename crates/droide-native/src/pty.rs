//! PTY framing helpers.
//!
//! Contract: `specs/90-native-layer.md` §"PTY (`rust_pty`)". The reference build passes
//! the command line as one quoted string and re-splits it with shell-word rules,
//! reads raw chunks of 4096 bytes, and reports `-2` for "child exited".
//!
//! Quoting is the part that can be tested without a terminal, so it lives here:
//! a wrong quote changes the argv a user's command receives, which is a real
//! security-relevant difference (argument injection).

/// Raw read size used by the helper (spec: 4096-byte chunks).
pub const READ_CHUNK_BYTES: usize = 4096;

/// Special value the reader returns once the child has exited.
pub const CHILD_EXITED: i32 = -2;

/// Quote one argument for a POSIX shell word list.
///
/// Single quotes preserve everything except `'` itself, which is closed, escaped
/// and reopened (`'\''`).
pub fn quote_posix_arg(argument: &str) -> String {
    if argument.is_empty() {
        return "''".to_string();
    }
    // Only quote when the argument actually needs it, so the common case stays
    // readable in logs and unchanged on the wire.
    let safe = argument.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(ch, '.' | '_' | '-' | '+' | '/' | ':' | '@' | '%' | '=')
    });
    if safe {
        return argument.to_string();
    }
    let escaped = argument.replace('\'', "'\\''");
    format!("'{escaped}'")
}

/// Join arguments into one POSIX shell-word string.
pub fn quote_posix_command_line(arguments: &[String]) -> String {
    arguments
        .iter()
        .map(|argument| quote_posix_arg(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Quote one argument for a Windows `CreateProcess` command line.
///
/// Follows the `CommandLineToArgvW` rules: quote when the argument contains
/// whitespace, a quote, or is empty; double every backslash that precedes a
/// quote; double the quote itself.
pub fn quote_windows_arg(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_string();
    }
    let mut quoted = String::with_capacity(argument.len() + 2);
    quoted.push('"');
    let mut backslashes = 0usize;
    for ch in argument.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                quoted.push(ch);
            }
        }
    }
    // Trailing backslashes are doubled so the closing quote is not escaped.
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Join arguments into one Windows command line.
pub fn quote_windows_command_line(arguments: &[String]) -> String {
    arguments
        .iter()
        .map(|argument| quote_windows_arg(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Split `data` into the helper's read chunks.
pub fn chunks(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    data.chunks(READ_CHUNK_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn posix_leaves_plain_words_alone() {
        assert_eq!(quote_posix_arg("ls"), "ls");
        assert_eq!(quote_posix_arg("src/main.rs"), "src/main.rs");
        assert_eq!(quote_posix_arg("--flag=1"), "--flag=1");
    }

    #[test]
    fn posix_quotes_spaces_and_metacharacters() {
        assert_eq!(quote_posix_arg("a b"), "'a b'");
        assert_eq!(quote_posix_arg("a;b"), "'a;b'");
        assert_eq!(quote_posix_arg("$HOME"), "'$HOME'");
        assert_eq!(quote_posix_arg(""), "''");
    }

    #[test]
    fn posix_escapes_embedded_single_quotes() {
        assert_eq!(quote_posix_arg("it's"), "'it'\\''s'");
    }

    #[test]
    fn posix_joins_with_single_spaces() {
        assert_eq!(
            quote_posix_command_line(&args(&["echo", "a b", "$x"])),
            "echo 'a b' '$x'"
        );
    }

    #[test]
    fn windows_leaves_plain_words_alone() {
        assert_eq!(quote_windows_arg("cmd.exe"), "cmd.exe");
        assert_eq!(quote_windows_arg("C:\\tools\\a.exe"), "C:\\tools\\a.exe");
    }

    #[test]
    fn windows_quotes_the_cases_that_need_it() {
        assert_eq!(quote_windows_arg("a b"), "\"a b\"");
        assert_eq!(quote_windows_arg(""), "\"\"");
    }

    #[test]
    fn windows_joins_with_single_spaces() {
        assert_eq!(
            quote_windows_command_line(&args(&["cmd", "/c", "a b"])),
            "cmd /c \"a b\""
        );
    }

    /// Reference `CommandLineToArgvW` splitter, used to prove the quoter
    /// round-trips instead of pinning escape sequences by hand.
    fn split_windows(command_line: &str) -> Vec<String> {
        let characters: Vec<char> = command_line.chars().collect();
        let mut args = Vec::new();
        let mut index = 0usize;

        while index < characters.len() {
            while index < characters.len() && characters[index] == ' ' {
                index += 1;
            }
            if index >= characters.len() {
                break;
            }
            let mut current = String::new();
            let mut in_quotes = false;
            while index < characters.len() {
                let ch = characters[index];
                if ch == ' ' && !in_quotes {
                    break;
                }
                if ch == '\\' {
                    let mut count = 0usize;
                    while index < characters.len() && characters[index] == '\\' {
                        count += 1;
                        index += 1;
                    }
                    if index < characters.len() && characters[index] == '"' {
                        current.push_str(&"\\".repeat(count / 2));
                        if count % 2 == 1 {
                            current.push('"');
                            index += 1;
                        }
                    } else {
                        current.push_str(&"\\".repeat(count));
                    }
                    continue;
                }
                if ch == '"' {
                    if in_quotes && index + 1 < characters.len() && characters[index + 1] == '"' {
                        current.push('"');
                        index += 2;
                        continue;
                    }
                    in_quotes = !in_quotes;
                    index += 1;
                    continue;
                }
                current.push(ch);
                index += 1;
            }
            args.push(current);
        }
        args
    }

    #[test]
    fn windows_quoting_round_trips_through_the_reference_splitter() {
        let cases = [
            vec!["simple"],
            vec!["a b"],
            vec!["say \"hi\""],
            vec!["trailing\\"],
            vec!["a b\\"],
            vec!["a b\\\""],
            vec!["cmd", "/c", "echo a b", "c:d"],
        ];
        for case in cases {
            let arguments: Vec<String> = case.iter().map(|value| (*value).to_string()).collect();
            let command_line = quote_windows_command_line(&arguments);
            assert_eq!(
                split_windows(&command_line),
                arguments,
                "input: {arguments:?} produced {command_line:?}"
            );
        }
    }

    #[test]
    fn chunking_uses_four_kilobyte_slices() {
        let data = vec![7u8; READ_CHUNK_BYTES * 2 + 5];
        let sizes: Vec<usize> = chunks(&data).map(<[u8]>::len).collect();
        assert_eq!(sizes, vec![READ_CHUNK_BYTES, READ_CHUNK_BYTES, 5]);
    }

    #[test]
    fn the_child_exited_sentinel_is_minus_two() {
        assert_eq!(CHILD_EXITED, -2);
    }
}
