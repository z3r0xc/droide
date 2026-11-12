//! `droide-native` binary: a stdio loop over the protocol.
//!
//! One request line in, one response line out, flushed per response so the
//! TypeScript side never waits on a buffer. The process exits when stdin closes.

use std::io::{self, BufRead, Write};

use droide_native::protocol::handle_line;

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
