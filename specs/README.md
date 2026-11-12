# Specifications

One file per subsystem of the reimplementation, numbered by layer. A spec is the
contract the code is written against and judged by: **nothing is implemented
before it is specified.**

## Rules

1. **One file per subsystem**, named `NN-<subsystem>.md`. Numbers group by layer
   (`10–19` CLI and configuration, `20–39` agent and tools, `40–59` storage and
   transport, `60–79` extensions and daemon, `80–99` modes, native layer and UI).
   `00-context.md` is shared context, not a spec.
2. **Observable only.** Every clause describes something a caller, a file or a
   log can see: inputs, outputs, ordering, persisted shapes, exit codes, error
   identities. Internal structure appears only where it is contract.
3. **Every clause is labelled and cited.** `[observed]` (read directly),
   `[derived]` (computed from several observations) or `[inferred]` (judgement),
   with a location (`evidence/original/windows-x64/<path>:<line>`) or a recorded
   golden (`tests/parity/expected/<case>.json`). A clause without a citation is
   an open question, not a clause.
4. **Every clause has a test.** Acceptance tests name at least one deterministic
   test per behavioural clause. Determinism: no network, no credentials, no wall
   clock, no dependence on the subject binary.
5. **Gaps are explicit.** Where evidence is incomplete — re-export barrels and
   type-only modules were elided from the bundle — write the narrowest supported
   clause and put the rest under Open questions. Never smooth a gap with a guess.
6. **Version-locked.** Specs describe `droid` v1.9.0. A different version needs a
   new recovery run and new specs, never a silent edit.
7. **Open questions name what would settle them** (a file to read, a probe to
   run, a decision to make).

## Status vocabulary

| Status | Meaning |
|---|---|
| `draft` | Being written; clauses may still be incomplete |
| `review` | Every clause cited and mapped to a test; awaiting check |
| `stable` | Implemented; its tests pass; changes need a new clause |
| `blocked` | Waiting on an open question or missing evidence |

## Index

| Spec | Status | Covers |
|---|---|---|
| `10-cli-surface.md` | review | Router, root options, visible and hidden commands, argument classification, precedence chain, exit codes, error strings |
| `40-sessions-and-storage.md` | review | SQLite schema and migrations, transcript records, ordering, on-disk layout, search |
| `80-exec-and-streaming.md` | review | Non-interactive mode, stream formats, exit codes |
| `90-native-layer.md` | review | Native helpers (pty, search, secrets, sqlite, browser), framing and contracts |
| `95-terminal-ui.md` | draft | Design tokens, layout, transcript renderers, keys, capability handling |
| `20-agent-loop.md` | pending | Provider message model, tool-call cycle, context assembly, model catalogue |
| `30-tools-and-sandbox.md` | pending | Tool registry, permission matrix, filesystem and shell models, sandbox |
| `50-transport-and-auth.md` | pending | Backend routes, auth flows, error taxonomy, LLM transport |
| `60-extensions-mcp-and-skills.md` | pending | MCP, plugins, skills, ACP |
| `70-daemon-and-remote-control.md` | pending | Daemon lifecycle, client protocol, remote control |

`pending` means the spec file does not exist yet; the subsystem must not be
implemented until it does.

## Template

Start from `template.md` and keep its section order.