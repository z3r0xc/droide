//! JSON-lines protocol: one request in, exactly one response out.
//!
//! Contract: `crates/README.md` (protocol v1) and `specs/90-native-layer.md`.
//! Every field is treated as untrusted: the line length is bounded before
//! parsing, every parameter is type-checked, and a malformed request produces a
//! structured error instead of a panic.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::paths::resolve_within;
use crate::sandbox::{profile_for, SandboxRequest};
use crate::search::{search_text, walk, TextOptions, WalkOptions};

/// Hard ceiling for one request line. The product layer never sends more.
pub const MAX_LINE_BYTES: usize = 1 << 20;

/// Protocol version exchanged at startup.
pub const PROTOCOL_VERSION: u32 = 1;

/// JSON-RPC-style error codes used by this helper.
pub mod error_code {
    /// The line is not valid JSON or lacks required fields.
    pub const PARSE: i32 = -32700;
    /// The method is not known to this build.
    pub const METHOD_NOT_FOUND: i32 = -32601;
    /// The parameters are missing or do not match the method's schema.
    pub const INVALID_PARAMS: i32 = -32602;
    /// The request exceeded [`super::MAX_LINE_BYTES`].
    pub const TOO_LARGE: i32 = -32001;
    /// The operation failed inside the helper (I/O, refusal).
    pub const INTERNAL: i32 = -32603;
}

#[derive(Debug, Deserialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
    id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

impl Response {
    fn ok(id: u64, result: Value) -> Self {
        Self {
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }

    fn err(id: Option<u64>, code: i32, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(ErrorBody {
                code,
                message: message.into(),
            }),
        }
    }
}

/// Hex-encode bytes without pulling in a formatting dependency.
///
/// Indexing is safe: both nibbles are masked to `0..=0xf` and `DIGITS` has 16
/// entries, which clippy cannot express.
#[allow(clippy::indexing_slicing)]
pub fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

struct Params<'a> {
    value: &'a Value,
}

impl<'a> Params<'a> {
    fn new(value: &'a Value) -> Self {
        Self { value }
    }

    fn string(&self, name: &str) -> Result<&'a str, String> {
        match self.value.get(name) {
            Some(Value::String(text)) => Ok(text.as_str()),
            Some(_) => Err(format!("param \"{name}\" must be a string")),
            None => Err(format!("missing string param \"{name}\"")),
        }
    }

    fn optional_string(&self, name: &str) -> Result<Option<&'a str>, String> {
        match self.value.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.as_str())),
            Some(_) => Err(format!("param \"{name}\" must be a string")),
        }
    }

    fn usize(&self, name: &str, default: usize, max: usize) -> Result<usize, String> {
        match self.value.get(name) {
            None | Some(Value::Null) => Ok(default),
            Some(Value::Number(number)) => match number.as_u64() {
                Some(value) if value as usize <= max => Ok(value as usize),
                Some(_) => Err(format!("param \"{name}\" must be at most {max}")),
                None => Err(format!("param \"{name}\" must be a non-negative integer")),
            },
            Some(_) => Err(format!("param \"{name}\" must be a number")),
        }
    }

    fn bool(&self, name: &str, default: bool) -> Result<bool, String> {
        match self.value.get(name) {
            None | Some(Value::Null) => Ok(default),
            Some(Value::Bool(value)) => Ok(*value),
            Some(_) => Err(format!("param \"{name}\" must be a boolean")),
        }
    }

    fn string_list(&self, name: &str) -> Result<Vec<String>, String> {
        match self.value.get(name) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::String(text) => Ok(text.clone()),
                    _ => Err(format!("param \"{name}\" must contain only strings")),
                })
                .collect(),
            Some(_) => Err(format!("param \"{name}\" must be an array of strings")),
        }
    }
}

fn search_walk(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let root = params.string("root").map_err(invalid)?;
    let glob = params.optional_string("glob").map_err(invalid)?;
    let max_results = params.usize("maxResults", 1_000, 10_000).map_err(invalid)?;
    let include_hidden = params.bool("includeHidden", false).map_err(invalid)?;

    let result = walk(&WalkOptions {
        root: root.into(),
        glob: glob.map(str::to_owned),
        max_results,
        include_hidden,
    })
    .map_err(internal)?;

    let paths: Vec<String> = result
        .paths
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();
    Ok(serde_json::json!({ "paths": paths, "truncated": result.truncated }))
}

fn search_text_method(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let root = params.string("root").map_err(invalid)?;
    let query = params.string("query").map_err(invalid)?;
    let max_hits = params.usize("maxHits", 100, 1_000).map_err(invalid)?;
    let case_sensitive = params.bool("caseSensitive", false).map_err(invalid)?;
    let include_hidden = params.bool("includeHidden", false).map_err(invalid)?;

    let result = search_text(&TextOptions {
        root: root.into(),
        query: query.to_owned(),
        max_hits,
        case_sensitive,
        max_file_bytes: crate::search::MAX_FILE_BYTES,
        include_hidden,
    })
    .map_err(internal)?;

    let hits: Vec<Value> = result
        .hits
        .iter()
        .map(|hit| {
            serde_json::json!({
                "path": hit.path,
                "line": hit.line,
                "text": hit.text,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "hits": hits,
        "truncated": result.truncated,
        "filesScanned": result.files_scanned,
    }))
}

fn sandbox_profile(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let target = params
        .optional_string("target")
        .map_err(invalid)?
        .unwrap_or(std::env::consts::OS);
    let network = params.bool("network", false).map_err(invalid)?;
    let read_paths = params.string_list("readPaths").map_err(invalid)?;
    let write_paths = params.string_list("writePaths").map_err(invalid)?;

    let profile = profile_for(
        target,
        &SandboxRequest {
            network,
            read_paths,
            write_paths,
        },
    )
    .map_err(|error| (error_code::INVALID_PARAMS, error.to_string()))?;

    Ok(match profile {
        crate::sandbox::SandboxProfile::Bubblewrap { argv } => {
            serde_json::json!({ "mechanism": "bubblewrap", "argv": argv })
        }
        crate::sandbox::SandboxProfile::Seatbelt { profile } => {
            serde_json::json!({ "mechanism": "seatbelt", "profile": profile })
        }
        crate::sandbox::SandboxProfile::Unconfined { reason } => {
            serde_json::json!({ "mechanism": "unconfined", "reason": reason })
        }
    })
}

fn path_resolve(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let root = params.string("root").map_err(invalid)?;
    let candidate = params.string("path").map_err(invalid)?;
    match resolve_within(root.as_ref(), candidate.as_ref()) {
        Ok(path) => Ok(serde_json::json!({ "path": path.to_string_lossy().replace('\\', "/") })),
        Err(error) => Err((error_code::INVALID_PARAMS, error.to_string())),
    }
}

/// Indices are safe: the decode table has 256 entries and is indexed by a byte,
/// and the encoder masks its slot to `0..=0x3f`.
#[allow(clippy::indexing_slicing)]
fn decode_base64(value: &str) -> Result<Vec<u8>, (i32, String)> {
    // Base64 is decoded here rather than pulled from a crate: the helper must
    // build without a registry mirror.
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (index, byte) in ALPHABET.iter().enumerate() {
        table[usize::from(*byte)] = index as u8;
    }
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(value.len() * 3 / 4);
    for byte in value.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' {
            continue;
        }
        let decoded = table[usize::from(byte)];
        if decoded == 255 {
            return Err(invalid("param is not valid base64".into()));
        }
        accumulator = (accumulator << 6) | u32::from(decoded);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[allow(clippy::indexing_slicing)]
fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk.first().copied().unwrap_or(0);
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        let triple = (u32::from(first) << 16) | (u32::from(second) << 8) | u32::from(third);
        for index in 0..4 {
            if chunk.len() + 1 > index {
                let slot = (triple >> (18 - 6 * index)) & 0x3f;
                out.push(char::from(ALPHABET[slot as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn secrets_protect(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let plaintext = decode_base64(params.string("plaintext").map_err(invalid)?)?;
    let entropy = params
        .optional_string("entropy")
        .map_err(invalid)?
        .map_or_else(|| Ok(Vec::new()), decode_base64)?;
    match crate::secrets::protect(&plaintext, &entropy) {
        Ok(sealed) => Ok(serde_json::json!({ "sealed": encode_base64(&sealed) })),
        Err(error) => Err((error_code::INTERNAL, error.to_string())),
    }
}

fn secrets_unprotect(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let sealed = decode_base64(params.string("sealed").map_err(invalid)?)?;
    let entropy = params
        .optional_string("entropy")
        .map_err(invalid)?
        .map_or_else(|| Ok(Vec::new()), decode_base64)?;
    match crate::secrets::unprotect(&sealed, &entropy) {
        Ok(plaintext) => Ok(serde_json::json!({ "plaintext": encode_base64(&plaintext) })),
        Err(error) => Err((error_code::INTERNAL, error.to_string())),
    }
}

fn pty_quote(request: &Request) -> Result<Value, (i32, String)> {
    let params = Params::new(&request.params);
    let arguments = params.string_list("args").map_err(invalid)?;
    let target = params
        .optional_string("target")
        .map_err(invalid)?
        .unwrap_or(std::env::consts::OS);
    let command_line = if target == "windows" {
        crate::pty::quote_windows_command_line(&arguments)
    } else {
        crate::pty::quote_posix_command_line(&arguments)
    };
    Ok(serde_json::json!({ "commandLine": command_line }))
}

fn invalid(message: String) -> (i32, String) {
    (error_code::INVALID_PARAMS, message)
}

fn internal(error: std::io::Error) -> (i32, String) {
    (error_code::INTERNAL, error.to_string())
}

/// Handle one request line. Pure: no I/O beyond what the method itself needs.
pub fn handle_line(line: &str) -> Response {
    if line.len() > MAX_LINE_BYTES {
        return Response::err(None, error_code::TOO_LARGE, "request line too large");
    }
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return Response::err(None, error_code::PARSE, error.to_string()),
    };

    let outcome = match request.method.as_str() {
        "native.version" => Ok(serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "version": env!("CARGO_PKG_VERSION"),
        })),
        "hash.sha256" => match request.params.get("text").and_then(Value::as_str) {
            Some(text) => {
                let digest = Sha256::digest(text.as_bytes());
                Ok(serde_json::json!({ "sha256": hex_lower(&digest) }))
            }
            None => Err(invalid("hash.sha256 needs a string param \"text\"".into())),
        },
        "search.walk" => search_walk(&request),
        "search.text" => search_text_method(&request),
        "sandbox.profile" => sandbox_profile(&request),
        "path.resolve" => path_resolve(&request),
        "secrets.protect" => secrets_protect(&request),
        "secrets.unprotect" => secrets_unprotect(&request),
        "pty.quote" => pty_quote(&request),
        other => Err((
            error_code::METHOD_NOT_FOUND,
            format!("unknown method: {other}"),
        )),
    };

    match outcome {
        Ok(result) => Response::ok(request.id, result),
        Err((code, message)) => Response::err(Some(request.id), code, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(response: &Response) -> Value {
        serde_json::to_value(response).expect("response is serialisable")
    }

    fn call(line: &str) -> Value {
        json(&handle_line(line))
    }

    #[test]
    fn reports_version_and_protocol() {
        let response = call(r#"{"id":7,"method":"native.version"}"#);
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["protocol"], PROTOCOL_VERSION);
        assert!(response["error"].is_null());
    }

    #[test]
    fn hashes_text_with_sha256() {
        let response = call(r#"{"id":2,"method":"hash.sha256","params":{"text":"abc"}}"#);
        assert_eq!(
            response["result"]["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn rejects_unknown_method_without_panicking() {
        assert_eq!(
            call(r#"{"id":3,"method":"nope"}"#)["error"]["code"],
            error_code::METHOD_NOT_FOUND
        );
    }

    #[test]
    fn rejects_malformed_json() {
        let response = call("{not json");
        assert_eq!(response["error"]["code"], error_code::PARSE);
        assert!(response["id"].is_null());
    }

    #[test]
    fn rejects_missing_hash_param() {
        assert_eq!(
            call(r#"{"id":4,"method":"hash.sha256"}"#)["error"]["code"],
            error_code::INVALID_PARAMS
        );
    }

    #[test]
    fn refuses_oversized_line_before_parsing() {
        let oversized = "x".repeat(MAX_LINE_BYTES + 1);
        assert_eq!(call(&oversized)["error"]["code"], error_code::TOO_LARGE);
    }

    #[test]
    fn ignores_unknown_request_fields() {
        let response =
            call(r#"{"id":5,"method":"native.version","extra":{"a":1},"params":{"b":2}}"#);
        assert_eq!(response["id"], 5);
        assert!(response["error"].is_null());
    }

    #[test]
    fn search_walk_returns_relative_paths() {
        let root = std::env::temp_dir().join(format!("droide-proto-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        std::fs::write(root.join("a.txt"), "alpha").unwrap();
        let line = format!(
            r#"{{"id":9,"method":"search.walk","params":{{"root":{:?}}}}}"#,
            root.to_string_lossy()
        );
        let response = call(&line);
        assert_eq!(response["result"]["paths"][0], "a.txt");
        assert_eq!(response["result"]["truncated"], false);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn search_text_reports_hits() {
        let root = std::env::temp_dir().join(format!("droide-proto-t-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        std::fs::write(root.join("a.txt"), "one\nalpha two\n").unwrap();
        let line = format!(
            r#"{{"id":10,"method":"search.text","params":{{"root":{:?},"query":"alpha"}}}}"#,
            root.to_string_lossy()
        );
        let response = call(&line);
        assert_eq!(response["result"]["hits"][0]["line"], 2);
        assert_eq!(response["result"]["hits"][0]["path"], "a.txt");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pty_quote_produces_a_platform_command_line() {
        let windows = call(
            r#"{"id":20,"method":"pty.quote","params":{"target":"windows","args":["cmd","a b"]}}"#,
        );
        assert_eq!(windows["result"]["commandLine"], "cmd \"a b\"");
        let posix = call(
            r#"{"id":21,"method":"pty.quote","params":{"target":"linux","args":["sh","-c","echo $x"]}}"#,
        );
        assert_eq!(posix["result"]["commandLine"], "sh -c 'echo $x'");
    }

    #[cfg(windows)]
    #[test]
    fn secrets_round_trip_over_the_protocol() {
        let sealed = call(
            r#"{"id":22,"method":"secrets.protect","params":{"plaintext":"aGVsbG8=","entropy":"ZQ=="}}"#,
        );
        let sealed_value = sealed["result"]["sealed"].as_str().unwrap().to_string();
        assert!(!sealed_value.is_empty());
        let line = format!(
            r#"{{"id":23,"method":"secrets.unprotect","params":{{"sealed":"{sealed_value}","entropy":"ZQ=="}}}}"#
        );
        assert_eq!(call(&line)["result"]["plaintext"], "aGVsbG8=");
    }

    #[test]
    fn invalid_base64_is_refused() {
        let response =
            call(r#"{"id":24,"method":"secrets.protect","params":{"plaintext":"not base64!"}}"#);
        assert_eq!(response["error"]["code"], error_code::INVALID_PARAMS);
    }

    #[test]
    fn sandbox_profile_returns_a_mechanism() {
        let response = call(
            r#"{"id":11,"method":"sandbox.profile","params":{"target":"linux","network":false,"readPaths":["/work"],"writePaths":[]}}"#,
        );
        assert_eq!(response["result"]["mechanism"], "bubblewrap");
        let argv = response["result"]["argv"].as_array().unwrap();
        assert!(argv.iter().any(|item| item == "--unshare-net"));
    }

    #[test]
    fn sandbox_profile_refuses_a_relative_path() {
        let response = call(
            r#"{"id":12,"method":"sandbox.profile","params":{"target":"linux","readPaths":["relative"]}}"#,
        );
        assert_eq!(response["error"]["code"], error_code::INVALID_PARAMS);
    }

    #[test]
    fn path_resolve_refuses_an_escape() {
        let response = call(
            r#"{"id":13,"method":"path.resolve","params":{"root":"/work/project","path":"../etc/passwd"}}"#,
        );
        assert_eq!(response["error"]["code"], error_code::INVALID_PARAMS);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("outside"));
    }

    #[test]
    fn path_resolve_accepts_an_inside_path() {
        let response = call(
            r#"{"id":14,"method":"path.resolve","params":{"root":"/work/project","path":"src/a.rs"}}"#,
        );
        assert!(response["error"].is_null());
        assert!(response["result"]["path"]
            .as_str()
            .unwrap()
            .ends_with("src/a.rs"));
    }
}
