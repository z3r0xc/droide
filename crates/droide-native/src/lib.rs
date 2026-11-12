//! `droide-native`: library half of the native helper.
//!
//! The binary in `main.rs` is a thin stdio loop over [`protocol::handle_line`];
//! everything testable lives here, so `cargo test` exercises behaviour without a
//! pipe.

pub mod paths;
pub mod protocol;
pub mod sandbox;
pub mod search;

pub use protocol::{handle_line, PROTOCOL_VERSION};
