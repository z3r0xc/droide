//! `droide-native`: one helper process behind a JSON-lines protocol.
//!
//! Contract: `specs/90-native-layer.md`. The TypeScript product layer starts
//! this binary once and exchanges request/response records, one per line:
//!
//! ```text
//! -> {"id":1,"method":"native.version","params":{}}
//! <- {"id":1,"result":{"protocol":1,"version":"0.0.0"}}
//! ```
//!
//! Rules that keep the boundary safe:
//!  * a line longer than [`MAX_LINE_BYTES`] is refused, never buffered;
//!  * unknown methods and malformed JSON produce a structured error, not a panic;
//!  * no request field is trusted for length, index or path before validation.

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

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
struct Response {
    id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

impl Response {
    fn ok(id: u64, result: Value) -> Self {
        Self { id: Some(id), result: Some(result), error: None }
    }

    fn err(id: Option<u64>, code: i32, message: impl Into<String>) -> Self {
        Self { id, result: None, error: Some(ErrorBody { code, message: message.into() }) }
    }
}

/// Why a request line could not be turned into a response.
#[derive(Debug, PartialEq, Eq)]
enum LineError {
    TooLarge,
    Parse(String),
}

fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Handle one request line. Pure: no I/O, no globals, no panics.
fn handle_line(line: &str) -> Response {
    if line.len() > MAX_LINE_BYTES {
        return Response::err(None, error_code::TOO_LARGE, "request line too large");
    }
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return Response::err(None, error_code::PARSE, error.to_string()),
    };

    match request.method.as_str() {
        "native.version" => Response::ok(
            request.id,
            serde_json::json!({
                "protocol": PROTOCOL_VERSION,
                "version": env!("CARGO_PKG_VERSION"),
            }),
        ),
        "hash.sha256" => match request.params.get("text").and_then(Value::as_str) {
            Some(text) => {
                let digest = Sha256::digest(text.as_bytes());
                Response::ok(request.id, serde_json::json!({ "sha256": hex_lower(&digest) }))
            }
            None => Response::err(
                Some(request.id),
                error_code::INVALID_PARAMS,
                "hash.sha256 needs a string param \"text\"",
            ),
        },
        other => Response::err(
            Some(request.id),
            error_code::METHOD_NOT_FOUND,
            format!("unknown method: {other}"),
        ),
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in stdin.lock().lines() {
        let line = line?;
        let response = handle_line(&line);
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(response: &Response) -> Value {
        serde_json::to_value(response).expect("response is serialisable")
    }

    #[test]
    fn reports_version_and_protocol() {
        let response = json(&handle_line(r#"{"id":7,"method":"native.version"}"#));
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["protocol"], PROTOCOL_VERSION);
        assert!(response["error"].is_null());
    }

    #[test]
    fn hashes_text_with_sha256() {
        let response = json(&handle_line(
            r#"{"id":2,"method":"hash.sha256","params":{"text":"abc"}}"#,
        ));
        assert_eq!(
            response["result"]["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn rejects_unknown_method_without_panicking() {
        let response = json(&handle_line(r#"{"id":3,"method":"nope"}"#));
        assert_eq!(response["error"]["code"], error_code::METHOD_NOT_FOUND);
    }

    #[test]
    fn rejects_malformed_json() {
        let response = json(&handle_line("{not json"));
        assert_eq!(response["error"]["code"], error_code::PARSE);
        assert!(response["id"].is_null());
    }

    #[test]
    fn rejects_missing_hash_param() {
        let response = json(&handle_line(r#"{"id":4,"method":"hash.sha256"}"#));
        assert_eq!(response["error"]["code"], error_code::INVALID_PARAMS);
    }

    #[test]
    fn refuses_oversized_line_before_parsing() {
        let oversized = "x".repeat(MAX_LINE_BYTES + 1);
        let response = json(&handle_line(&oversized));
        assert_eq!(response["error"]["code"], error_code::TOO_LARGE);
    }

    #[test]
    fn ignores_unknown_request_fields() {
        let response = json(&handle_line(
            r#"{"id":5,"method":"native.version","extra":{"a":1},"params":{"b":2}}"#,
        ));
        assert_eq!(response["id"], 5);
        assert!(response["error"].is_null());
    }
}