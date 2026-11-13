# ADR 0013 — Settings writes are textual and atomic

- Status: accepted
- Date: 2026-11-13
- Deciders: plugin/enablement slice, orchestrator

## Context

B37 and B38 in `specs/60-extensions-mcp-and-skills.md` require a plugin install
to record its enablement in `settings.json` and an uninstall to remove it. Until
now `src/config` could only _read_ settings: every write surface in the product
stopped at its own file (the plugin registry, the marketplace registry), and the
enablement map was left alone, so an installed plugin was "enabled by absence".

`settings.json` is the user's document. It is JSONC, hand-edited, and carries
comments that explain why a value is what it is, keys in the order the user put
them, and the indentation of whatever editor wrote it. The obvious
implementation — parse, mutate, `JSON.stringify` — is a destructive one: it
deletes every comment, reorders nothing but reformats everything, and turns a
one-key change into a whole-file diff. Reviewing such a diff is impossible, and a
merge conflict becomes a formatting fight.

The write also has to be crash-safe. A settings file truncated halfway through a
write takes the next CLI launch's configuration with it.

## Decision

1. **The unit of change is a span, not a document.** `src/config/write.ts`
   parses JSONC only far enough to know where each value starts and ends, then
   edits the smallest possible span:
   - an existing value is replaced in place (multi-line values are re-indented
     at the value's own column);
   - a new member is inserted before the closing brace, in key order when the
     caller asks for it (`sorted`), reusing the object's existing indentation;
   - a missing intermediate object is created inline only when the caller's key
     path needs it;
   - a removal deletes the member and exactly one separator, so the survivors
     keep their commas, comments and blank lines.

   Everything outside the edited span is emitted unchanged: comments, key order,
   indentation, trailing commas, CRLF, and a leading byte-order mark.

2. **The edit is verified before it is published.** The edited text is parsed
   back with `JSON.parse` (after the same JSONC reduction the readers use) and
   the value at the key path is compared with what the caller asked for. A
   mismatch is a refusal, not a write — so a bug in the span scanner can only
   cost a failed operation, never a corrupted file.

3. **The replacement is atomic.** The new text goes to a hidden temporary file in
   the same directory, is `fsync`ed, is given the original file's mode, and is
   renamed over the target; the directory is `fsync`ed afterwards on POSIX. A
   brand-new file is created with mode `0600`, because settings may carry MCP
   environment tokens.

4. **Refusals are typed and happen before any write.** The writer throws one
   `SettingsWriteError` whose `code` is exactly one of:
   `not-found` (no file), `not-writable` (read-only file, a non-file, a symbolic
   link, a path that resolves outside the caller's scope root, or a failed
   replacement), `ambiguous-key` (the target key appears twice, so no single
   value can be meant), `invalid-document` (the file does not parse, a key path
   runs through a non-object, or the edit would not reproduce the requested
   value). The caller's document is untouched in every one of those cases.

5. **Never through a link, never outside the scope.** A scope passes its root
   (`.droide` directory); the writer compares the resolved parent directory
   against it and `lstat`s the target. A symlinked settings file is refused
   rather than followed, so a hostile or accidental link cannot redirect the
   write into another user's file.

6. **Order makes the operation whole.** An install writes the enablement entry
   first, then copies the plugin, then writes the registry; a failure after the
   settings write restores the previous enablement (old value, member removal, or
   removing a file the install created) before rethrowing. An uninstall plans
   every settings removal before performing any of them and only then touches the
   registry and the plugin's files.

7. **The API is deliberately narrow.** `setSettingsValue(path, keyPath, value)`,
   `removeSettingsValue(path, keyPath)` and `lookupSettingsValue(path, keyPath)`
   over object key paths. There is no array-index edit, no document-level
   replacement and no create-if-missing by default: a writer that can do anything
   tends to be used for everything, and a full-document write is exactly what
   this ADR exists to prevent.

The writer is synchronous. A settings edit is a few kilobytes on a local disk, the
callers (install/uninstall) are already synchronous around their filesystem
surface, and the atomic sequence is easier to keep correct when it cannot be
interleaved at an `await`.

## Consequences

- A plugin install into a commented, hand-formatted settings file produces a
  one-member diff. The round-trip is proven by tests that compare the whole file
  byte for byte.
- Documents the writer cannot edit safely are refused with a message naming the
  file and the key: duplicate keys, unparsable JSONC, read-only files, symlinks.
  The user is asked to fix the file by hand rather than being handed a
  reformatted one.
- A newly created settings file starts as `{}` and grows one member, so its
  formatting is ours until the user edits it.
- Inserting a _composite_ value normalises only the bytes we insert: an existing
  value replaced by a long array is re-indented at its column, which may differ
  from the style of a hand-written neighbour. Scalars — the enablement case —
  are untouched.
- Multi-file edits are not transactional. An uninstall that removes the entry at
  user scope and then fails at project scope leaves the first file edited; the
  registry and the plugin's files are still intact, so the plugin remains
  installed and can be uninstalled again. Closing that gap needs a journal, which
  no other write surface in the product has.
- `strictEnabledPlugins` can only be honoured if the loader sees the unmerged
  level maps. The plugin command passes them; a caller that supplies only the
  merged map gets the non-strict answer, which is why the option documents that
  limitation instead of pretending the merge carries level information.

## Alternatives considered

- **Parse, mutate, re-serialise with `JSON.stringify(value, null, 2)`.** Simple
  and total; destroys comments and every formatting choice the user made. It also
  cannot preserve key order for an existing file, because the parse loses it.
  Rejected: the file belongs to the user.
- **A JSONC AST library (comment-preserving).** A dependency for one surface,
  and it still re-renders the whole document on `stringify`, including spans the
  caller did not ask to touch. Rejected: more code than the span scanner, less
  control over untouched bytes.
- **Write through a dedicated `settings` CLI command only.** Clients and scripts
  need the same operation programmatically; exposing it only through argv would
  mean shelling out to ourselves.
- **Rewrite the file in place (open, truncate, write).** One power loss leaves an
  empty or half-written configuration. Rejected for the temp-file rename.
- **Follow symbolic links so a symlinked dotfile keeps working.** The link's
  target is outside the directory the caller validated; refusing is the only
  rule that can be stated and checked.
