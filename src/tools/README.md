# src/tools — registry, permissions, executors

Contract: `specs/30-tools-and-sandbox.md`. Everything here takes an injected
`{ root, environment }`; nothing reads `process.cwd()`/`process.env`.

## Registry model

`ToolDefinition` carries the key `id` (`read-cli`), the model-facing `llmId`
(`Read`), a display name and description, `inputSchema`, declared `sideEffects`,
and `requiresConfirmation` — metadata only (B41). `defineTool` builds one; the
executor runs only through `ToolRegistry.dispatch`, which validates first (B7).
A rejected input produces B8's text: the issue list, `Tool "<id>" accepts the
following parameters:` with one `- field (required): description` line per
property, then `Please retry with valid parameters.` Registration rejects a
definition with no `sideEffects`, a non-array, or an unknown value (B1).
`all()` is registration order; several ids may share an llmId, in that order.

`validate.ts` is the dependency-free schema algebra (object, string, number,
boolean, enum, array, union, optional, default). Unknown keys are dropped and
defaults filled; error paths read `input.path: expected string`.

## Permission algebra

`decide(request, context)` is pure and ordered: a blocked command, deny floor or
protected path denies and is never overridable; a user `denyWrite` file edit
asks (promptable, B50); the bypass (`--skip-permissions-unsafe` while the org
maximum admits `high`) allows; reads and no-effect tools allow, MCP asks; file
edits allow in Auto/Mission with autonomy ≠ `off`, else ask; `Execute` follows
policy `allow`/`ask`, then a read-only search, then risk ≤ autonomy.

Risk numbers are `none=0, low=1, medium=2, high=3`, autonomy `off=0 … high=3`;
a missing or unparsable risk is `high`. `decideWithRefusal` turns an `ask` into
B46's early-exit denial in a non-interactive session.

## Tools and side-effect classes

| Tool      | id                | effects                               |
| --------- | ----------------- | ------------------------------------- |
| Read      | `read-cli`        | `filesystem-read`                     |
| LS        | `ls-cli`          | `filesystem-read`                     |
| Glob      | `glob-search-cli` | `filesystem-read`                     |
| Grep      | `grep_tool_cli`   | `filesystem-read`                     |
| Create    | `create-cli`      | `filesystem-write`                    |
| Edit      | `edit-cli`        | `filesystem-read`, `filesystem-write` |
| Execute   | `execute-cli`     | `process`                             |
| TodoWrite | `todo_write`      | —                                     |

Writes are temp-file + rename; `Read` is bounded at 64 KiB and every other
result at 32 KiB, cut in the middle with a notice.

## Search backend

`Glob` and `Grep` get discovery from `ToolContext.nativeBackend`
(`native-backend.ts`). `local` is the TypeScript walk and the default; `helper`
uses `crates/droide-native` (`search.walk`, `search.text`, `path.resolve`) only
when a session asks for it and the binary exists. The tools keep their own
matching, ordering, filters and bounds, so both backends return the same items;
a helper failure at call time degrades to `local` and leaves a diagnostic.
