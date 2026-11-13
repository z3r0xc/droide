# ADR 0012 — Resuming seeds the shell; the picker is not the shell

- Status: accepted
- Date: 2026-11-13
- Deciders: project owner (resume gap), orchestrator

## Context

`droide resume <id>` resolved the session, printed its name and then opened an
empty interactive shell: the transcript was never read, so the user could not
see the conversation they had resumed and the model's next request started from
nothing. Two related surfaces were missing:

- a terminal without an id printed the same bounded list a pipe gets instead of
  offering a choice (the picker was a `TODO(spec 10 B22)`);
- the shell's turn driver already accepted `initialEntries`/`initialMessages`,
  but nothing produced them from a stored transcript.

The obvious implementation of the picker is an Ink component, because the shell
is Ink. That would make `resume` pay for React, Ink and the whole component tree
to print ten lines and read three keys, and it would pull the UI bundle into the
`resume` path even on machines that only list sessions.

## Decision

1. **The transcript is projected, not replayed.** `src/app/session-seed.ts` maps
   transcript records to `{ entries, messages }`: rows for the screen, loop
   messages for the next request. `messageFromRecord` (already used by
   `exec -s`) supplies the message; tool calls become rows and their stored
   results settle them. The interactive shell accepts this as `seed`, so a
   resume runs no model call and appends nothing.
2. **A broken transcript is a refusal.** Missing and corrupt transcripts fail
   with a named message and exit 1 before the shell mounts. An empty shell hides
   a real problem and looks like data loss.
3. **The picker is a raw-mode CLI surface.** `src/cli/session-picker.ts` takes
   caller-formatted labels and returns an index; it owns the keyboard, the
   cursor and the repaint only. `resume-commands.ts` keeps the wording and the
   ordering, so the picker and the pipe's list can never disagree about which
   session is which.
4. **Non-TTY output is unchanged.** A pipe has nothing to choose with, so it
   still gets the bounded newest-first list; the picker is reached only when
   both streams are terminals.

## Consequences

- `resume` stays cheap: the picker costs no React/Ink, and the shell is loaded
  (as before) only at a terminal.
- The seed mapping is one module with one test surface; a future transcript
  record kind adds a row case there instead of touching the shell.
- Forking is seeded from the source transcript _before_ the fork, because
  forking closes the store it was handed; a fork copies every record, so the
  rows are identical either way.
- The shell repaints once after the driver is created when rows are seeded — the
  mount frame is built before the driver exists.
- The picker draws with ANSI escapes rather than a component, so a future
  theming change to the shell does not automatically reach it.

## Alternatives considered

- **An Ink picker**: reuses the shell's look, but loads React and Ink for a
  list, and cannot be exercised without mounting a terminal tree.
- **Replaying the transcript through the loop to rebuild context**: exact, but
  it costs a model round-trip (and money) for every resume.
- **Resuming into `exec -s` semantics only**: no first screen; the task asked
  for the shell to open on the conversation.
