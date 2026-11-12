# Security policy

## Scope

Droide starts processes, reads and writes files and talks to model providers, so
the security-relevant surface is:

- **tool execution** (`src/tools/**`) — permission algebra, path containment,
  shell selection, output caps;
- **native helper** (`crates/droide-native/**`) — path resolution, sandbox
  profiles, DPAPI sealing;
- **transport** (`src/transport/**`) — URL validation, header construction,
  redirect policy, response bounds;
- **extensions** (`src/extensions/**`) — MCP servers are arbitrary programs;
  their frames and tool results are untrusted input;
- **the CLI itself** (`src/cli/**`) — the only place that prints to stdout, so a
  machine-readable mode must never leak prompts or secrets.

## Reporting

Open a private security advisory on the repository (Security → Advisories) or
email the maintainer listed in `package.json`. Do not open a public issue for a
vulnerability. Expect an acknowledgement within a few days.

## Guarantees this build tries to keep

1. Nothing from `raw/`, `evidence/` or `.work/` is tracked or shipped.
2. Every boundary value is parsed, not cast: tokens reaching a syscall or a
   provider are validated first.
3. `unsafe` Rust is confined to one audited module (`secrets.rs`), and each
   block states its invariant.
4. Secrets are never logged: header redaction is applied on every error path.
5. Shell execution takes an argument vector; model-provided strings are not
   interpolated into a shell command unless the spec says a shell is involved.

Reports that show otherwise are treated as bugs, not as design choices.
