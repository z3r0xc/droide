# Daemon, client protocol and Remote Control

- **Target:** Factory AI `droid` 1.9.0
- **Status:** draft
- **Owner:** daemon / transport
- **Related:** `specs/00-context.md`, `specs/template.md`; session persistence and the session index are the storage spec; `droid exec` streaming is the exec spec; registration storage lives in `host.json` (storage spec covers `host.json` only as a file); tool ids: none.

## Purpose

`droid daemon` runs the long-lived local server that the desktop app, the
web app, SDKs and other daemons talk to. This spec pins what a caller can see:
how the daemon picks its transport and announces readiness, the JSON-RPC
framing and handshake every client must perform, the lifecycle of the work a
client hands it, and what "Remote Control" actually registers on a machine and
with whom it is trusted. It also pins how the CLI behaves when no daemon is
reachable.

## Scope

In scope: `droid daemon` flags and startup; TCP/Unix/parent-IPC transports;
readiness signalling (stdout, `sd_notify`, parent IPC message); there is **no
daemon discovery file** (see B4); the request/response envelope, version
field, authentication gate, connection-status notification, compression and
frame shaping; the client request lifecycle (submit, streaming notifications,
cancel, timeout, disconnect and retention); background-process tracking as the
observable "background task" surface; Remote Control registration, relay
dial, X25519 computer identity and the trust boundary; bind-conflict retry,
stale sockets, single-instance behaviour, crash recovery and CLI behaviour
when the daemon is unreachable.

Out of scope, covered elsewhere:

- Session transcript format, project directories and the session index —
  storage spec. This spec only names the RPCs that carry them.
- Agent execution, tool semantics and turn streaming content — exec /
  session specs. This spec covers the transport of those notifications, not
  their payload semantics.
- The full list of ~200 `daemon.*` methods. Only methods that define the
  protocol lifecycle are enumerated; the method catalogue is generated from
  `packages/droid-sdk-core/src/protocol/daemon/schemas/enums.ts` and is a
  mechanical surface.
- Desktop/Electron-side daemon management (`apps/desktop/.../*` appears only
  in comments in the recovered source and is not shipped here).
- `droid computer ssh` and `port-forward` tunnel mechanics beyond their
  entry point and failure messages.

Deliberately deferred: human-facing i18n strings for `commands:daemon.*` and
`commands:computer.*` (catalogues are absent; Open question 1), and the exact
Bun behaviour for a pre-existing Unix socket path (Open question 3).

## Terms

- **Daemon** — the process started by `droid daemon`; one per Factory home
  and transport endpoint.
- **Transport** — one of `websocket` (TCP or Unix socket; the `--listen`
  default), `ipc` (the parent/child Node IPC channel, `--listen ipc`), or the
  in-process transport used by the TUI and `droid exec` (never a separate
  process).
- **Parent IPC** — the Node `process.send`/`'message'` channel between a
  parent CLI/desktop process and a daemon it spawned.
- **Child IPC** — the same channel attached to worker sessions the daemon
  spawns; always active, which is why `--enable-child-ipc` is a hidden no-op.
- **Envelope** — one JSON object on the wire: `type` = `request` |
  `response` | `notification`, plus `jsonrpc`, `factoryApiVersion`,
  `factoryProtocolVersion` and, for requests, `id` and `method`.
- **Protocol version** — `factoryProtocolVersion`, a `major.minor.patch`
  string; v1.9.0 emits `1.321.0`. `factoryApiVersion` is a frozen legacy
  field (`1.0.0`) and is never used for compatibility decisions.
- **Auth gate** — the state of a JSON-RPC connection before
  `daemon.authenticate` succeeds.
- **Remote Control** — the feature that lets a client reach a daemon through
  the Factory relay instead of a local socket; enabled with
  `--remote-control` (alias `--remote-access`).
- **Computer** — a backend record identifying a machine that can be reached
  for Remote Control; identifiers are the backend `computerId` and the local
  `hostId`.
- **Computer identity** — the machine's X25519 key pair used to authenticate
  the end-to-end encrypted channel.
- **Background process** (our term for the target's "background task") — a
  fire-and-forget process a session started and the daemon still tracks.
- **Long-running operation** (our term) — any request whose result is not
  immediate; carried by one request id, notifications, and one terminal
  response.

## Observable behaviour

### Daemon command surface

**B1 — `droid daemon --help` is fixed.** It prints exactly:
`Usage: droid daemon [options]`, the description `Run the Factory daemon
server`, and these options in order: `-p, --port <number>`, `--host <address>`
(default `"127.0.0.1"`), `--unix <path>`, `-d, --debug` (default `false`),
`--listen <transport>` (choices `"websocket"`, `"ipc"`, default
`"websocket"`), `--droid-path <path>`, `--liveness-fd <fd>`,
`--parent-pid <pid>`, `--remote-control`, `--remote-access` (described as the
alias, default `false`), `--settings <path>`, `-h, --help`.
`--enable-child-ipc` exists but is hidden, so it does not appear.
(`src/entrypoints/daemon/command.ts:20-83`; confirmed against a captured
`droid daemon --help` golden during this investigation.)

**B2 — `--settings` is inherited and exported.** If `--settings` is absent on
`daemon` and the root command supplied `--settings`, the daemon uses the root
value. A non-empty value sets the environment variable
`FACTORY_RUNTIME_SETTINGS_PATH` for the daemon's own process before the run
module loads, so runtime settings resolve from that file.
(`src/entrypoints/daemon/command.ts:85-104`.)

**B3 — Transport selection.** `--listen ipc` makes the daemon IPC-only and it
opens no socket. Otherwise an explicit `--unix` wins over `--port`; with
neither, the daemon starts with **no inbound transport** (relay-only or
useless) and logs that fact. `--port 0` asks the OS for a port and the daemon
advertises the bound port, not `0`.
(`src/entrypoints/daemon/handler.ts:533-535`;
`packages/daemon-core/src/DaemonCore.ts:263-278`;
`packages/daemon-core/src/server/daemon-server.ts:312-315`;
`packages/daemon-core/src/server/web-socket-server.ts:862-870`;
`src/entrypoints/daemon/handler.ts:925`.)

**B4 — There is no discovery file.** The daemon writes neither a port file
nor a pid file; the endpoint is whatever the supervisor passed and readiness
is signalled out-of-band (B5). Consequently two daemons on the same endpoint
are distinguished only by who holds the bind (B6/B7). No file under the
Factory home is written by daemon startup itself.
(`packages/daemon-core/src/server/web-socket-server.ts:487-512`;
absence across `src/entrypoints/daemon/**` and
`packages/daemon-core/src/server/**`.)

**B5 — Readiness is announced, in this order.** After `DaemonServer.start()`
resolves, the daemon (a) emits `sd_notify` `READY=1` when `NOTIFY_SOCKET` is
set, and (b) if a parent IPC channel is connected, sends the message
`{ type: "factory.daemon.ready", pid, version }`. It then prints a fixed
banner to stdout: `commands:daemon.running`, `commands:daemon.version`,
`commands:daemon.pid`, `commands:daemon.logs`, then the endpoint line
(`commands:daemon.unixSocket` with the path, `commands:daemon.wsEndpoint`
with host/port, or the literal `IPC transport: parent process`), the relay
line when Remote Control is on, and `commands:daemon.pressCtrlCToStop`. It
then blocks until shutdown. A failed `READY=1` marks startup failed but does
not abort the daemon.
(`src/entrypoints/daemon/handler.ts:839-960`;
`src/services/daemon/notifyReady.ts:38-80`.)

**B6 — Startup order inside the daemon.** The request core and connection
handler are built; any persisted user prompts are restored **before** any
transport accepts a client; the parent/child IPC server starts; then the
WebSocket server binds; interrupted automation runs are recovered; the relay
is dialled if configured; then heartbeat, disk monitor, scheduled-run poller
and SCM services start; only then is the server marked running. Any later
step that is not marked optional fails startup, and the daemon rolls back
every resource already acquired.
(`packages/daemon-core/src/server/daemon-server.ts:256-315,446-529`;
rollback at `:570-610`.)

**B7 — Bind conflict retry and single-instance behaviour.** The TCP bind is
retried when the port is in use: up to 5 retries with delays 500, 1000, 2000,
4000, 8000 ms (15.5 s total), each attempt logged as
`[Daemon] Port in use, retrying Bun.serve()`. A successful retry logs
`[Daemon] Bun.serve() succeeded after retry`. A non-`EADDRINUSE` error, or a
sixth failure, is thrown: the daemon prints `Startup failed: <message>` to
stderr, logs `CLI daemon startup failed`, and exits **1**. There is no lock
file and no "already running" probe: exclusivity is the bind itself, so the
second of two concurrent starts loses after the retry budget.
(`packages/daemon-core/src/server/web-socket-server.ts:501-556`;
`packages/droid-sdk-core/src/protocol/daemon/constants.ts:104-115`;
`src/entrypoints/daemon/run.ts:655-665`.)

**B8 — Shutdown is graceful, bounded and closes at 0.** Signals
(`SIGINT`, `SIGTERM`, `SIGHUP`, `SIGBREAK`) go through the shutdown
coordinator, which asks the daemon to stop; the daemon then stops services in
this order: background refresh tasks, relay (with close code
`DaemonShuttingDown` 4012, or `DaemonUpdating` 4013 for an idle update),
scheduled-run poller, heartbeat, disk monitor, disk-pressure response, SCM
credential service, IPC server, WebSocket server, persist pending user
prompts, request core. Under systemd it sends `STOPPING=1` first. Teardown is
capped at 10 s; the process exits **0** for a signal-driven or requested stop.
The WebSocket server closes open clients rather than waiting for them.
(`src/entrypoints/daemon/handler.ts:700-770`;
`packages/daemon-core/src/server/daemon-server.ts:611-660`;
`packages/daemon-core/src/server/web-socket-server.ts:833-852`;
`src/utils/shutdownCoordinator.ts:611-636`.)

**B9 — Crash policy.** An uncaught error or rejection attributed to an
in-process agent fails only that agent and keeps the daemon alive. A
disk-full/quota error is logged and the daemon stays up. Every other
uncaught error is fatal: stderr gets `Critical error: <message>`, the startup
root is marked failed, the daemon is stopped, and the process exits **1**.
(`src/entrypoints/daemon/run.ts:196-253`.)

**B10 — Parent-death detection.** With `--liveness-fd`, the daemon reads the
inherited fd as a pipe and shuts down when it closes. With `--parent-pid`, it
polls `process.kill(pid, 0)` every 2000 ms and shuts down when the parent is
gone. `--listen ipc` additionally requires an inherited channel at startup and
shuts down (exit 0) when the channel disconnects.
(`packages/daemon-core/src/DaemonCore.ts:326-420`;
`src/entrypoints/daemon/handler.ts:380-410`.)

**B11 — `--listen ipc` preconditions.** Without `process.send` the daemon
fails with `droid.daemon.ipc-unavailable` and message "`--listen ipc
requires the daemon to be spawned with an inherited IPC channel`". If the
channel is already disconnected it fails with `droid.daemon.ipc-disconnected`.
Combining it with `--remote-control` fails with
`droid.daemon.ipc-remote-access`: "`--listen ipc cannot be combined with
--remote-control`". All three exit 1 via `Startup failed: <message>`.
(`src/entrypoints/daemon/handler.ts:380-400,290-296`.)

### Client protocol

**B12 — Framing.** One envelope per frame. On WebSocket, frames are text
(JSON) or binary (a `0x01` byte followed by raw-deflate JSON, only after the
client offers `deflate-raw`); a JSON payload never begins with `0x01`. On
parent/child IPC, each frame is one JSON string passed through
`process.send`. Relay transport wraps each JSON text frame in a relay
envelope `{type:"client_frame", clientId, frameType:"text"|"binary", data}`;
binary data is base64. The daemon's IPC/WS send path serialises the same
envelope object it dispatches, so a response and its request share the
envelope shape.
(`packages/droid-sdk-core/src/protocol/daemon/constants.ts:87-88,95`;
`packages/droid-sdk-core/src/transport-protocol/payload-codec.ts:11-30`;
`packages/daemon-core/src/server/ipc/ipc-server-transport.ts:16-38`;
`packages/common/src/relay/schemas.ts:50-59`.)

**B13 — Envelope fields.** Every envelope carries
`jsonrpc:"2.0"`, `factoryApiVersion:"1.0.0"` and `factoryProtocolVersion`
(the current version string; optional when reading). A request has
`type:"request"`, `id` (client-generated UUID v4 string), `method` and
optional `params` (omitted entirely when absent). A success response has
`type:"response"`, `id` and `result`; a failure response has `error`
`{code, message, data?}` and no `result`. A notification has `type:
"notification"`, `method`, optional `params`. `_meta` may carry W3C
`traceparent`/`tracestate` and `requestAttribution`.
(`packages/droid-sdk-core/src/protocol/shared/schemas.ts:290-410`;
`packages/daemon-sdk/src/RequestEngine.ts:229-258`.)

**B14 — Version handling is advisory, not a gate.** The daemon compares the
inbound `factoryProtocolVersion` by exact string equality with its own. A
missing field is not a mismatch. A mismatch never rejects an otherwise valid
`daemon.authenticate`; it is attached as
`error.data.protocolVersionMismatch = {localFactoryProtocolVersion,
peerFactoryProtocolVersion, messageType?, method?, requestId?}` to failures
only: a parse error, an unsupported authentication method (answered
`METHOD_NOT_FOUND`), and an unknown method after authentication. Clients use
the same comparison to ignore a notification they cannot parse instead of
reporting a routing error.
(`packages/daemon-sdk/src/default-helpers.ts:413-434`;
`packages/daemon-core/src/server/daemon-connection-handler.ts:679-712`;
`packages/daemon-core/src/server/envelope-helpers.ts:160-210,229-245`;
`packages/daemon-sdk/src/session/core/MessageRouter.ts:106,297-320`.)

**B15 — The auth gate.** The first request on a WebSocket/IPC connection must
be `daemon.authenticate`; any other request is answered
`AUTHENTICATION_ERROR` (-32001) with the exact message "`Connection not
authenticated. Must call daemon.authenticate first.`". A malformed frame
before authentication gets `PARSE_ERROR` (-32700) with `id:null`. A
notification before authentication is not answered. Authentication requires
either `token` (WorkOS JWT) or `apiKey` (`fk-*`); grants
(`actAsGrant`, `sharedSessionGrant`) and `activeOrganizationId` have their own
preconditions, enforced by schema refinements that fail as `PARSE_ERROR`.
(`packages/daemon-core/src/server/daemon-connection-handler.ts:560-725`;
`packages/droid-sdk-core/src/protocol/daemon/schemas/connection.ts:45-135`.)

**B16 — Authenticate result and post-auth sequence.** Success returns
`{result:{userId, orgId, encoding?, pipelined?}}`; `encoding:"deflate-raw"`
is returned only when the client listed it in `acceptEncodings` and the
connection supports compression. Immediately after the reply the daemon sends
the `daemon.connection_status` notification (`supportsRequestCwd`,
`supportsPullRequestRecords`, `supportsRemoteDesktop`,
`supportsReadOnlySideChats`, `supportsSharedSessionSideChats`,
`supportsSessionPresence`, `isDroidCLIInPath`, `droidCLIVersion`,
`homedir`, `platform`, optional `hostId`). Requests folded into the
authenticate `pipeline` (max 8; only `list_opened_sessions`,
`list_available_sessions`, `get_session_messages`, `get_message_blocks`,
`load_session`) are dispatched after the status notification, each answered
as an ordinary response with its own id; any other pipelined method is
answered `INVALID_REQUEST` with "`Method is not allowed in the authentication
pipeline`", and `pipelined:true` is set in the result.
(`packages/daemon-core/src/server/daemon-connection-handler.ts:640-680,960-1040,1208-1265`;
`packages/droid-sdk-core/src/protocol/daemon/constants.ts:84-102`.)

**B17 — Re-authenticate and logout.** On an authenticated connection,
`daemon.authenticate` does not re-verify the credential: the daemon replies
with the connection's `{userId, orgId}`. `daemon.logout` replies
`{accepted:true}` and then closes the connection.
(`packages/daemon-core/src/server/daemon-connection-handler.ts:522-560,750-800`.)

**B18 — Dispatch and error codes.** Unknown methods answer
`METHOD_NOT_FOUND` (-32601) with `Method not found: <method>`; relay methods
on a daemon without relay capability answer `INVALID_REQUEST` (-32600) with
"`Relay is not available on this daemon instance. Start the daemon with
--remote-access to enable relay capability.`"; an unhandled handler exception
answers `INTERNAL_ERROR` (-32603); malformed params answer
`INVALID_PARAMS` (-32602) with `error.data.issues`; a response whose id
matches no pending server→client request is logged and dropped. Notifications
from clients that the daemon does not know are dropped silently.
(`packages/daemon-core/src/server/request-dispatcher.ts:140-185,215-235,345-395`;
`packages/daemon-sdk/src/RequestEngine.ts:863-980`.)

**B19 — Client request lifecycle.** The client generates a UUID v4 id, stores
the pending request with its timeout, and resolves it on the response with the
same id (RTT recorded). Default timeout 30 s, overridden per method (e.g.
session init/resume 120 s, session send 240 s, worktree cleanup 900 s).
On transport close every pending request rejects with
`ConnectionClosedError(code, reason)`; on reconnect every still-pending
request rejects with `ConnectionClosedError(1000, "Connection reopened")`. A
response that fails the method's result schema rejects with an invalid-response
error. An `AbortSignal` that aborts before send drops the request unsent; one
that aborts after send drops it so a late response is discarded.
(`packages/daemon-sdk/src/RequestEngine.ts:182-215,466-560,863-980`;
`packages/daemon-sdk/src/DaemonClient.ts:365-395,543-612`.)

**B20 — Streaming.** Work in progress is streamed as
`daemon.session_notification` notifications with `params.sessionId` and a
discriminated `params.notification.type`; permission prompts, ask-user and
pick-options are instead JSON-RPC **requests from the daemon to the client**
(`daemon.request_permission`, `daemon.ask_user`, `daemon.pick_options`) that
the client answers by id. Pending server→client requests are keyed by that id;
a duplicate id throws `CONFLICT`; the three elicitation methods have **no
TTL**, every other pending request expires after 5 minutes and may be
re-sent up to 5 times. A member connection may only answer requests routed to
its own session.
(`packages/daemon-core/src/server/handlers/pending-daemon-request-store.ts:263-330`;
`packages/daemon-core/src/server/constants/constants.ts:3-5`;
`packages/daemon-core/src/server/core/createDaemonRequestCore.ts:59-70`;
`packages/daemon-core/src/server/request-dispatcher.ts:194-250`.)

**B21 — Cancel.** `daemon.interrupt_session` stops the current turn;
`daemon.kill_worker_session` kills a worker; `daemon.cancel_search_sessions`
cancels a session search; `daemon.cancel_mcp_auth` cancels an MCP login. A
client-side abort of a request is local only — it removes the pending entry
and does not cancel daemon work unless the method has its own cancel RPC.
`daemon.interrupt_session` responses report drained request ids on protocol
≥ 1.292.0 (`STOP_DRAIN_PROTOCOL_VERSION`).
(`packages/droid-sdk-core/src/protocol/daemon/schemas/enums.ts:69-82`;
`packages/daemon-sdk/src/constants.ts:38-46`.)

**B22 — Background-process lifecycle.** A session may start
fire-and-forget processes. The daemon tracks them as
`{id, pid, command, startedAtMs, toolUseId?, outputFile?}` and publishes the
whole set as `background_processes_changed` under
`daemon.session_notification`, with `capturedAtMs` on the session host's
clock. A load/initialize result carries the same snapshot as
`backgroundProcesses` (older runners omit it). `daemon.kill_background_process`
`{sessionId, processId}` returns `{killed: boolean}`; it is `false` when the
session has no worker or nothing matched, and the daemon forwards the kill to
the worker otherwise. `outputFile` and `pid` refer to the session host, not
the client.
(`packages/droid-sdk-core/src/protocol/droid/schemas/cli.ts:536-566`;
`packages/droid-sdk-core/src/protocol/droid/schemas/client.ts:1354-1360,688-692`;
`packages/daemon-core/src/server/handlers/droid-request-handler.ts:18688-18704`.)

**B23 — Session retention.** A Local or Computer daemon reaps an idle session
after 30 minutes (`OVERRIDE_DROID_SESSION_TIMEOUT_MS` overrides; an Ephemeral
daemon uses 5 minutes). Before teardown it broadcasts a
`daemon.session_notification` whose notification is
`{type:"session_inactivity", message:"Session cleaned up after inactivity",
timestamp, timeoutSeconds}`. The host may answer a retention query (Task
subagents still working, a completion still owed) and the timer re-arms one
bounded window at a time. After teardown an empty draft session is deleted.
A session with `disableInactivityTimeout` is never reaped, and a session that
is loading or being initialized is not reaped before it settles.
(`packages/daemon-core/src/droid/droid-registry.ts:116,252-267,1975-2100`.)

**B24 — Prompt retention across restart.** Pending `ask_user`,
`pick_options` and `request_permission` requests are snapshotted to
`pending-askuser-requests.json` in the user settings directory on shutdown
and on a failed start, and restored before transports accept clients. Entries
older than 24 hours are discarded. A client that reconnects therefore answers
the original request id.
(`packages/daemon-core/src/server/core/pendingElicitationPersistence.ts:22-40`;
`packages/runtime/settings/src/constants/index.ts:25-27`.)

### Remote Control and computers

**B25 — What `droid computer` exposes.** `droid computer register [name]`
(`-y/--yes`), `remove` (`-y`), `list`, `ssh <name> [command...]` (with
`--debug`, `--proxy`, `--port`, default `22`), `port-forward <name>
<mappings...>` (with `--address`, default `127.0.0.1`, `--debug`), and the
hidden `trust-repos <dirs...>` used by provisioning. `ssh` and `port-forward`
load auth and block on feature flags before acting.
(`src/entrypoints/computer/command.ts:12-105`.)

**B26 — What registration writes.** `register` creates a BYOM computer in the
backend (`CreateComputer` with `{name, provider:"byom", hostId, remoteUser}`),
then saves `computerRegistration` into `host.json` under the Factory dir as
`{computerId, firestoreOrgId, userId, registeredAt}` alongside the stable
`hostId`, `schemaVersion:1`, optional `provisioningId`, and `createdAt`. The
legacy `computer.json` is written too. A registration is only honoured for
the same `userId` + `firestoreOrgId`; another login sees "not registered".
Writes are serialised by a `host.json.lock` directory lock (5 s timeout, 25 ms
poll, stale after 5 s).
(`src/api/computer.ts:88-115`;
`packages/runtime/host/src/HostConfigStore.ts:13-95`;
`packages/runtime/host/src/HostIdentityService.ts:85-170,180-250`;
`packages/droid-sdk-core/src/protocol/host/schemas.ts:5-26`.)

**B27 — Reconciliation before use.** A stored registration is checked against
the backend `computerId`: missing on backend → local registration cleared
(`BackendMissing`); backend `hostId` absent → repaired from the local
`hostId`; backend `hostId` different → stale (`HostConflict`) and cleared,
unless the caller asked for no clearing (then `Stale`). A backend lookup
failure is `Error` and preserves local state. `computer register` refuses with
exit 1 if already registered, and with `-y` clears a stale registration
without prompting.
(`packages/runtime/computer/src/registration.ts:27-125`;
`src/entrypoints/computer/run.ts:145-200`.)

**B28 — `--remote-control` startup.** With the flag, the daemon requires a
usable registration: it reconciles (B27), and if none exists falls through to
interactive registration — refused when stdin/stdout is not a TTY with
`commands:daemon.remoteAccessRegistrationRequired`; otherwise it prompts for
confirmation and a name (default: normalised hostname), calls `CreateComputer`,
saves the registration, and prints `commands:daemon.registeredComputer`.
BYOM registration is additionally refused when the organization's managed
setting `byomComputersEnabled` is `false` (fail-closed). The relay URL comes
from the computer record's `relayAgentUrl`; absent it fails with
`commands:daemon.remoteAccessRelayUrlRequired`.
(`src/entrypoints/daemon/remoteAccess.ts:78-120,150-300,320-371`;
`src/entrypoints/daemon/handler.ts:424-490`.)

**B29 — Relay dial and identity publication.** Before dialling, the daemon
publishes its computer identity to the backend (`UpdateComputer` with
`{computerIdentity:{publicKey(base64), keyId, algorithm:"X25519"}}`),
retrying transient failures until the startup signal aborts; a failed
publish leaves any existing relay connection intact. It then opens a WebSocket
to `relayAgentUrl`, offering subprotocols `factory-relay.<N>` descending from
the current version and retrying without a subprotocol only on a
subprotocol-mismatch close, and sends `{method:"relay.authenticate", token? |
apiKey?, activeOrganizationId?, connectionEpoch?}` as the **first** message.
It expects `{type:"relay.auth_ok", clientId?}` within 10 s; an
`{type:"relay.auth_error", message, code?, retryable?, retryAfterMs?}` or a
close before it fails startup. The daemon reports
`daemon.relay.status_changed` to authenticated clients and exposes
`daemon.relay.start|stop|get_status`.
(`packages/daemon-core/src/server/daemon-server.ts:662-780`;
`packages/daemon-core/src/relay/WebSocketRelayTransport.ts:300-400`;
`packages/common/src/relay/constants.ts:63-100`;
`packages/droid-sdk-core/src/protocol/daemon/schemas/relay-auth.ts:14-72`.)

**B30 — Computer identity at rest.** The X25519 identity is
`<Factory dir>/computer-identity/identity.json`:
`{schemaVersion:1, publicKey, privateKey, keyId, algorithm:"X25519"}`, both
keys canonical base64 of 32 bytes, `keyId` 32 lowercase hex characters. The
private key is never logged or returned by an API; the whole directory is the
sandbox deny target because atomic writes stage a sibling temp file.
(`packages/runtime/host/src/constants/index.ts:1-8`;
`packages/runtime/host/src/schemas.ts:11-30`.)

**B31 — Trust boundary.** A local daemon is reachable only where it is bound:
`127.0.0.1` by default, or an explicit `--host`, or a Unix socket. There is no
"localhost means trusted" bypass: every JSON-RPC client authenticates (B15)
and the daemon is single-user — a valid credential for another user or
organization is rejected with `AUTHENTICATION_ERROR` and
`error.data.reason` one of `user_mismatch`, `organization_selection_mismatch`,
`organization_access_denied`, or `verification_unavailable` (backend
unreachable, retryable). Relay traffic is authenticated by the relay with the
same WorkOS/API-key credential; the end-to-end channel is a pinned Noise
`NK_25519_ChaChaPoly_SHA256` handshake (secure-channel version 2) between the
client and the daemon, keyed by the published computer identity, so the relay
forwards ciphertext when the client pins that identity. The local WebSocket
transport is plaintext JSON (the optional encrypted `directChannel` path is
defined but never configured by the CLI daemon).
(`packages/daemon-core/src/server/web-socket-server.ts:666-698,487-497`;
`packages/daemon-core/src/server/auth/utils.ts:390-480`;
`packages/daemon-core/src/server/auth/constants.ts:1-14`;
`packages/crypto/src/secure-channel/constants.ts:1-5`;
`packages/daemon-sdk/src/transports/WebSocketDaemonTransport.ts:325-380`.)

**B32 — Customer (Prem) deployments.** A customer-prem origin restricts the
daemon: relay with air-gap enabled is refused
("`Remote Control is unavailable in air-gapped mode.`"); `relayCapable`, a
relay config, a non-local `machineType`, or a non-loopback `host` are refused
with "`Customer deployments support local daemons only.`"; a relay URL must
match the customer origin; `droid daemon --remote-control` on a customer
deployment is refused unless the machine is a provisioned Computer (provider
must be OpenCompute). A provisioned registration is never cleared locally and
a missing host binding says "Reprovision it.".
(`packages/daemon-core/src/DaemonCore.ts:127-160`;
`src/entrypoints/daemon/handler.ts:355-372,424-438`;
`src/entrypoints/daemon/remoteAccess.ts:150-240`.)

**B33 — Port proxy.** The WebSocket server answers `GET /health` with
`200/factory-daemon ok` (unauthenticated, used by the desktop's pre-kill
probe) and proxies `/port-proxy/<port><path>` to `localhost:<port>` on the
daemon machine for ports 1024-65535. A proxy request needs the per-process
32-byte base64url token (`daemon.get_proxy_token`), supplied as the
`factorydToken` query parameter or the `factoryd_proxy` cookie; otherwise
`401 Unauthorized`. A query token is exchanged for an `HttpOnly;
SameSite=Strict` cookie scoped to `/port-proxy/<port>` by a 302 that strips
it from the URL. Paths are normalised and rejected when they escape the
prefix. Anything else answers `404 Not Found`.
(`packages/daemon-core/src/server/web-socket-server.ts:327-437`;
`packages/daemon-core/src/server/auth/proxy-token.ts:1-24`.)

**B34 — CLI behaviour when the daemon is unavailable.** The interactive TUI
and `droid exec` do not need the background daemon: they construct the same
request core in-process and talk to it through the in-process transport, so an
absent daemon changes nothing there. Remote commands surface classified
failures: `DaemonUnreachable`/`DaemonTimeout` render the app message
`daemonUnavailable` ("Could not reach the daemon. It may still be starting;
try again in a moment."), a computer without `relayClientUrl` renders
`commands:ssh.computerNotReady`, and other connection failures map to their
reason's fixed text (e.g. `Protocol version mismatch. Please update your
client.`, `Another daemon is already connected to this computer...`,
`Computer is offline or hibernating.`). `droid doctor` only checks that a
localhost TCP listen+connect+echo works (`daemon.loopback`), not that a daemon
runs.
(`src/services/daemon/createSameProcessDaemonClient.ts:1-20`;
`src/services/daemon/daemonErrorMessages.ts:62-75`;
`src/entrypoints/computer/connection.ts:55-75`;
`packages/daemon-sdk/src/session/connection-failure.ts:42-200`;
`src/entrypoints/doctor/checks/daemon.ts:18-50`.)

## Data & config

### CLI flags (B1)

| Flag | Type / domain | Default | Effect |
|---|---|---|---|
| `-p, --port <number>` | integer | none | TCP port; `0` = OS-assigned. Ignored when `--unix` is set. |
| `--host <address>` | string | `127.0.0.1` | Bind address. |
| `--unix <path>` | path | none | Unix socket; wins over `--port`. |
| `-d, --debug` | boolean | `false` | Verbose daemon debug log. |
| `--listen <transport>` | `websocket` \| `ipc` | `websocket` | `ipc` = IPC-only, no socket. |
| `--droid-path <path>` | path | none | Droid executable for spawned sessions; resolved from PATH otherwise. |
| `--liveness-fd <fd>` | integer | none | Inherited pipe; parent-death shutdown. |
| `--parent-pid <pid>` | integer | none | Polled parent; parent-death shutdown. |
| `--remote-control` | boolean | `false` | Enables Remote Control (implies `remoteAccess`). |
| `--remote-access` | boolean | `false` | Alias for `--remote-control`. |
| `--settings <path>` | path | root `--settings` | Exported as `FACTORY_RUNTIME_SETTINGS_PATH`. |
| `--enable-child-ipc` | (hidden) | — | No-op; child IPC is always on. |

### Environment

| Variable | Where | Meaning |
|---|---|---|
| `FACTORY_RUNTIME_SETTINGS_PATH` | set by `--settings` | Runtime settings overlay for the daemon process only. |
| `NOTIFY_SOCKET`, `WATCHDOG_*`, `LISTEN_*`, `INVOCATION_ID` | read at boot, then stripped from `process.env` | systemd notification; stripped so children cannot signal systemd. |
| `OVERRIDE_DROID_SESSION_TIMEOUT_MS` | daemon config | Positive integer; replaces the 30-minute inactivity timeout. |
| `FACTORY_DAEMON_HEARTBEAT_INTERVAL_MS` | daemon config | Positive integer; heartbeat interval override. |
| `FACTORY_DAEMON_CGROUP_ISOLATION`, `FACTORY_DAEMON_CGROUP_RESERVE_BYTES`, `FACTORY_DAEMON_CGROUP_STATUS`, `FACTORY_DAEMON_CGROUP_REASON` | Computer only | Managed cgroup admission and report. |
| `SHELL_ENV_FROM_PARENT_ENV_VAR` marker | daemon | `1` means the parent already loaded the login shell environment. |

(`src/entrypoints/daemon/run.ts:30-42`;
`src/entrypoints/daemon/handler.ts:239-280,620-640`;
`src/environment.ts:360-370,710-716`.)

### Wire constants

| Constant | Value | Source |
|---|---|---|
| `JSONRPC_VERSION` | `2.0` | `protocol/shared/constants.ts:7` |
| `LEGACY_FACTORY_API_VERSION` | `1.0.0` (frozen) | `protocol/shared/constants.ts:5` |
| `FACTORY_PROTOCOL_VERSION` | `1.321.0` | `protocol/droid/schemas/constants.ts:6` |
| `COMPRESSED_PAYLOAD_TAG` | `0x01` | `protocol/daemon/constants.ts:95` |
| `DEFLATE_RAW_ENCODING` | `deflate-raw` | `protocol/daemon/constants.ts:88` |
| `CLIENT_FRAME_TARGET_BYTES` | 8 MiB | `daemon-core/.../constants/constants.ts:13` |
| `DAEMON_SERVE_BIND_MAX_RETRIES` | 5 | `protocol/daemon/constants.ts:113` |
| `DAEMON_SERVE_BIND_INITIAL_DELAY_MS` | 500 | `protocol/daemon/constants.ts:114` |
| WebSocket idle timeout | 300 s | `web-socket-server.ts:54` (`DEFAULT_E2B_KILL_TIMEOUT_MS` 300000/1000) |
| WebSocket ping interval | 30 s | `web-socket-server.ts:81` |
| Pending daemon request TTL | 300 s | `server/constants/constants.ts:3` |
| Pending resend attempts | 5 | `server/constants/constants.ts:5` |
| Session inactivity (Local/Computer) | 1 800 000 ms | `droid-registry.ts:116` |
| Relay ping interval / pong timeout | 1000 / 5000 ms | `common/relay/constants.ts:100-118` |
| Relay reconnect grace | 15 000 ms | `common/relay/constants.ts:25` |
| Secure channel | v2, `Noise_NK_25519_ChaChaPoly_SHA256` | `crypto/secure-channel/constants.ts:1-5` |

### JSON-RPC error codes

`-32700` PARSE_ERROR, `-32600` INVALID_REQUEST, `-32601` METHOD_NOT_FOUND,
`-32602` INVALID_PARAMS, `-32603` INTERNAL_ERROR, `-32001`
AUTHENTICATION_ERROR, `-32004` ENTITY_NOT_FOUND, `-32005`
SESSION_DISCONNECTED, `-32006` CONFLICT, `-32800` REQUEST_CANCELLED.
(`packages/droid-sdk-core/src/protocol/shared/enums.ts:63-83`.)

### Persisted files

| Path | Shape | Written by |
|---|---|---|
| `<Factory home>/<Factory dir>/host.json` | `HostConfig` (`schemaVersion:1`, `hostId`, `createdAt`, optional `provisioningId`, optional `computerRegistration`) | host identity service |
| `<...>/computer.json` | `LegacyComputerConfig` (`computerId`, optional `hostId`/`provisioningId`, `registeredAt`) | host identity service |
| `<...>/computer-identity/identity.json` | `PersistedComputerIdentity` | host identity service |
| `<...>/pending-askuser-requests.json` | `{version:1, requests:[...]}` | daemon shutdown / failed start |
| `<...>/logs/factoryd.log` | daemon log | logging |

## Errors

### Startup

| Condition | Observable | State |
|---|---|---|
| Port in use, retries exhausted | `Startup failed: <bind message>` on stderr; exit 1; log `CLI daemon startup failed` | Nothing left listening; rollback closed IPC/relay/services. Retry after the other daemon stops is safe. |
| `--unix` path exists and cannot be bound | Same as above with the bind message | Socket file left as found. Recovery is removing the file (Open question 3). |
| `--listen ipc` without an inherited channel | `Startup failed: --listen ipc requires the daemon to be spawned with an inherited IPC channel`; exit 1 | No transport opened. |
| `--listen ipc` + `--remote-control` | `Startup failed: --listen ipc cannot be combined with --remote-control`; exit 1 | Nothing opened. |
| Parent channel already gone (`ipc`) | code `droid.daemon.ipc-disconnected`; exit 1 | Nothing opened. |
| Customer-prem + relay/air-gap/non-local | `MetaError` message (B32); exit 1 | Nothing opened. |
| Remote control without registration, non-TTY | `commands:daemon.remoteAccessRegistrationRequired`; exit 1 | No registration written. |
| Relay URL missing | `commands:daemon.remoteAccessRelayUrlRequired`; exit 1 | Registration already saved (B28). |
| Relay publish/handshake failure | startup fails after retries; exit 1 | Existing relay connection (if any) left intact / closed cleanly. |
| Any other bootstrap failure | `Startup failed: <message>`; exit 1 | Rollback. |

### Connection and request

| Condition | Observable | Notes |
|---|---|---|
| Non-auth first request | `AUTHENTICATION_ERROR` "Connection not authenticated. Must call daemon.authenticate first." | Connection stays open. |
| Malformed frame pre-auth | `PARSE_ERROR`, `id:null` | Connection stays open. |
| Bad/missing credential | `AUTHENTICATION_ERROR`; `reason` only when the daemon can classify it | Client maps to `AuthRejected` / `IdentityMismatch` / `RelayGatewayError`. |
| Version mismatch | Only on failures, as `data.protocolVersionMismatch` | Never blocks a successful authenticate. |
| Unknown method | `METHOD_NOT_FOUND` `Method not found: <m>` | Carries the mismatch data when present. |
| Relay method without capability | `INVALID_REQUEST`, fixed relay message | Older SDKs match this text as a liveness sentinel. |
| Duplicate pending server→client id | `CONFLICT` thrown to the producer | The existing request keeps its slot. |
| Pending server→client request expiry | Produced request rejects `Pending daemon request timed out` | Except `ask_user`/`pick_options`/`request_permission`. |
| Client request timeout | `RequestTimeoutError(method, id, timeoutMs)` | Request already sent; daemon may still complete it. |
| Transport close | Every pending request rejects `ConnectionClosedError(code, reason)` | Reconnect rejects with code 1000 / `Connection reopened`. |
| Kill unknown background process | `{killed:false}` | No error, no session created. |
| Idle session expiry | `session_inactivity` notification, then teardown | Draft deletion only when empty. |

### Remote / relay

| Condition | Observable |
|---|---|
| Relay rejects credential `unauthorized` | `auth_error`, terminal; client `RelayUnauthorized` |
| `computer_already_connected` | `auth_error`; bounded retry; client `DaemonConflict` |
| `wrong_region` | terminal; client `RelayWrongRegion` |
| `service_unavailable` / `rate_limited` | retryable; client `RelayGatewayError` / `RelayRateLimited` |
| Secure handshake rejected (pin mismatch) | `SecureIdentityRejected`; transport refreshes the pin once, then fails |
| Tampered secure record | close 4017 locally / `Unauthorized` to older relays; `SecureProtocolViolation` |

(`packages/droid-sdk-core/src/protocol/daemon/schemas/relay-auth.ts:29-80`;
`packages/daemon-sdk/src/session/connection-failure.ts:330-380`.)

## Acceptance tests

| Clause | Test id | Fixture |
|---|---|---|
| B1, B11 (surface) | `tests/daemon/test_help_daemon` | recorded stdout golden; `$COLUMNS` fixed at 80 |
| B2 | `tests/daemon/test_settings_flag_forwarding` | temp `HOME`; root `--settings <tmp>`; assert `FACTORY_RUNTIME_SETTINGS_PATH` in the child env |
| B3 | `tests/daemon/test_transport_selection` | config table: `{listen,unix,port}` → expected constructor config (ipc-only / unix / tcp / none) |
| B4 | `tests/daemon/test_no_discovery_file` | temp `HOME`; start daemon with `--port 0`; assert the Factory dir gains no port/pid file |
| B5 | `tests/daemon/test_readiness_signals` | fake parent IPC sink + `NOTIFY_SOCKET` temp socket; assert ready message keys and `READY=1` before the banner |
| B6, B7 | `tests/daemon/test_single_instance_two_starts` | two daemons, same fixed loopback port, in-process harness; second exits 1 with `Startup failed:`; first still answers `/health` |
| B7 | `tests/daemon/test_stale_port_retry` | injected `serve` that throws `EADDRINUSE` 5× then succeeds with fake timers; assert delays `[500,1000,2000,4000,8000]`, success logged on attempt 5; 6 failures rethrow |
| B7 (unix) | `tests/daemon/test_stale_unix_socket_cleanup` | (a) socket file with no listener → bind succeeds; (b) socket held by a live listener → exit 1 with bind message. Marked inferred until Open question 3 settles |
| B8 | `tests/daemon/test_graceful_shutdown_order` | fake services recording stop calls + `SIGTERM`; assert order and exit 0 |
| B9 | `tests/daemon/test_crash_policy` | injected uncaught errors: agent error → daemon alive; `ENOSPC` → alive; other → `Critical error:` then exit 1 |
| B10 | `tests/daemon/test_parent_death_monitors` | liveness pipe closed / `--parent-pid` of an exited process → shutdown invoked; interval asserted at 2000 ms with fake timers |
| B12 | `tests/protocol/test_frame_codec` | text frame, binary `0x01`+deflate frame, IPC string frame, relay `client_frame` envelope; byte-for-byte expected |
| B13 | `tests/protocol/test_request_response_fixture` | `fixtures/protocol/authenticate.request.json`, `authenticate.response.json`, `error.method_not_found.json`; parse → normalise → compare |
| B14 | `tests/protocol/test_handshake_version_negotiation` | 4 envelopes: equal, older, newer, absent version; expected `protocolVersionMismatch` presence and contents |
| B15 | `tests/protocol/test_auth_gate` | unauthenticated `list_opened_sessions` and malformed frame; expected exact error envelopes |
| B16, B17 | `tests/protocol/test_authenticate_pipeline` | authenticate with 2 pipelined reads + 1 disallowed method; expected status notification, two results, one `INVALID_REQUEST`, then a second authenticate returns identity, logout closes |
| B18 | `tests/protocol/test_dispatch_errors` | unknown method, relay method without capability, handler throw, bad params |
| B19 | `tests/protocol/test_request_lifecycle` | fake transport; close during pending → `ConnectionClosedError`; abort before/after send |
| B20 | `tests/protocol/test_pending_server_requests` | duplicate id → `CONFLICT`; non-elicitation TTL expiry with fake timers |
| B21 | `tests/protocol/test_cancel_methods` | interrupt response with `drainedRequestIds` at protocol 1.292.0 |
| B22 | `tests/protocol/test_background_processes` | two-process snapshot notification + `kill_background_process` `{killed:true}`/`{killed:false}` |
| B23 | `tests/daemon/test_session_inactivity` | fake timers at 30 min; assert `session_inactivity` payload fields, then teardown; retention callback re-arms |
| B24 | `tests/daemon/test_pending_prompt_restore` | snapshot file with one fresh and one 25 h old request; restore keeps only the fresh one, before transport start |
| B25, B26 | `tests/computer/test_register_list_remove` | fake backend; temp `HOME`; assert `host.json`/`computer.json` contents and exit codes |
| B27 | `tests/computer/test_reconcile_registration` | table: missing / hostId absent / hostId conflict / backend error → status and local state |
| B28, B32 | `tests/daemon/test_remote_control_gating` | non-TTY without registration → exact message; BYOM disabled → refusal; customer-prem cases → refusals |
| B29 | `tests/relay/test_relay_auth_frames` | recorded `relay.authenticate` frame and `auth_ok`/`auth_error` fixtures; disposition table per code |
| B30 | `tests/computer/test_computer_identity_file` | generated identity parses; base64 canonical; `keyId` 32 hex; private key absent from logs |
| B31 | `tests/protocol/test_identity_mismatch` | credential of another user/org → `AUTHENTICATION_ERROR` with each `reason` |
| B33 | `tests/daemon/test_port_proxy_auth` | no token → 401; query token → 302 + cookie; bad port → 400; traversal path → 400; unknown path → 404 |
| B34 | `tests/cli/test_daemon_unavailable_messages` | classified errors → exact fallback strings |

Fixtures are synthesised JSON envelopes and in-memory fakes; no fixture is
copied from the original binary. Tests that bind use loopback only and a
fixed free port; timer tests use fake timers.

## Evidence

| Evidence | Supports | Method |
|---|---|---|
| `ev_daemon_cli_1` | B1 | read of `src/entrypoints/daemon/command.ts:20-83`; captured golden `tests/parity/expected/help-daemon.json` (now absent from the tree) |
| `ev_daemon_cli_2` | B2, B3 | `command.ts:85-104`; `handler.ts:533-535,925`; `daemon-server.ts:312-315` |
| `ev_daemon_lifecycle_1` | B5, B6, B8, B9, B10 | `handler.ts:700-960`; `daemon-server.ts:256-660`; `run.ts:196-253`; `DaemonCore.ts:326-420` |
| `ev_daemon_discovery_1` | B4 | negative search across `src/entrypoints/daemon/**`, `packages/daemon-core/src/server/**` for port/pid/state files; only `/health` exists |
| `ev_daemon_bind_1` | B7 | `web-socket-server.ts:501-556`; `protocol/daemon/constants.ts:104-115` |
| `ev_protocol_framing_1` | B12 | `payload-codec.ts:11-30`; `ipc-server-transport.ts:16-38`; `common/relay/schemas.ts:50-59` |
| `ev_protocol_envelope_1` | B13, B14 | `protocol/shared/schemas.ts:290-410`; `default-helpers.ts:413-434`; `envelope-helpers.ts:160-245` |
| `ev_protocol_auth_1` | B15, B16, B17, B18 | `daemon-connection-handler.ts:522-1040,1208-1265`; `request-dispatcher.ts:140-395` |
| `ev_protocol_client_1` | B19, B20, B21 | `RequestEngine.ts:182-215,466-560,863-980`; `DaemonClient.ts:365-395,543-612`; `pending-daemon-request-store.ts:263-330` |
| `ev_protocol_background_1` | B22 | `protocol/droid/schemas/cli.ts:536-566`; `schemas/client.ts:688-692,1354-1360`; `droid-request-handler.ts:18688-18704` |
| `ev_daemon_retention_1` | B23, B24 | `droid-registry.ts:116,252-267,1975-2100`; `pendingElicitationPersistence.ts:22-40` |
| `ev_remote_cli_1` | B25, B26, B27 | `computer/command.ts:12-105`; `computer/run.ts:145-300`; `registration.ts:27-125`; `HostConfigStore.ts:13-95` |
| `ev_remote_daemon_1` | B28, B29 | `remoteAccess.ts:78-371`; `daemon-server.ts:662-780`; `WebSocketRelayTransport.ts:300-400` |
| `ev_remote_identity_1` | B30, B31 | `runtime/host/src/constants/index.ts:1-8`; `runtime/host/src/schemas.ts:11-30`; `auth/utils.ts:390-480`; `crypto/secure-channel/constants.ts:1-5` |
| `ev_remote_prem_1` | B32 | `DaemonCore.ts:127-160`; `handler.ts:355-372,424-438` |
| `ev_daemon_portproxy_1` | B33 | `web-socket-server.ts:327-437`; `auth/proxy-token.ts:1-24` |
| `ev_cli_unavailable_1` | B34 | `daemonErrorMessages.ts:62-75`; `connection-failure.ts:42-200`; `doctor/checks/daemon.ts:18-50`; `createSameProcessDaemonClient.ts:1-20` |

## Open questions

1. **Exact user-facing strings.** The message catalogues
   (`src/i18n/locales/*/commands.json`) are not in the recovered source; only
   the keys are (`commands:daemon.*`, `commands:computer.*`,
   `common:droidsView.*`). Settled by capturing those outputs from the binary
   with a temp `HOME` (allowed `--help` runs cover only `help-daemon`).
   Blocks exact-text assertions in B5, B28, B34; the keys and structure are
   pinned.
2. **`--unix` on Windows.** The daemon has no platform gate before
   `Bun.serve({unix})`; whether a Windows build binds a named pipe or fails is
   unobserved. Settled by running `droid daemon --unix <tmp>` on Windows with
   a temp `HOME` (not permitted under the current rules). Blocks the Windows
   half of B3/B7.
3. **Stale Unix socket path.** The daemon never unlinks the path before bind
   (`web-socket-server.ts:487-499`); Bun's behaviour for a leftover socket
   file is unobserved. Settled by the same run as (2), or by a unit test
   against the bundled Bun version. Blocks `test_stale_unix_socket_cleanup`
   (currently marked inferred).
4. **Discovery file outside the CLI.** The desktop app's manager is referenced
   only in comments (`apps/desktop/src/main/daemon/manager.ts`). Whether the
   desktop keeps its own port file is not in this repository. Settled by the
   desktop source. Does not block B4 as written (the CLI writes none).
5. **`ConnectionFailureReason.ProtocolMismatch` has no producer** in the
   recovered source; the string exists in the behaviour table
   (`connection-failure.ts:67-70`) but no code path raises it. Settled by
   finding the producer in an unelided module or by confirming it is dead.
   B34 quotes the string as reachable only through that table.
6. **`directChannel` (encrypted direct WebSocket).** `DaemonConfig` supports
   it (`web-socket-server.ts:666-698`) but the CLI never sets it. Whether a
   non-CLI host (desktop-managed `factoryd`) uses it is unknown. If it does,
   B31's "local WebSocket is plaintext" must be narrowed. Does not block the
   current contract.
7. **`--host` beyond loopback.** The CLI accepts any `--host`, but nothing
   documents or tests non-loopback exposure and no TLS is offered. Whether
   that is a supported configuration or only a debugging affordance is
   unstated. Settled by maintainer intent. Blocks any claim that non-loopback
   binding is safe or supported.

## Clean-room notes

A reimplementation must reproduce:

- The exact `droid daemon` flag set, defaults and help text (B1), including
  the hidden `--enable-child-ipc` no-op and the `--remote-access` alias.
- Transport precedence and the absence of a discovery file: endpoint comes
  from the supervisor; readiness is stdout + optional `sd_notify` + optional
  parent IPC `factory.daemon.ready`.
- The bind-as-mutex model with the 500 ms doubling retry (5 retries) and the
  `Startup failed: …`/exit-1 outcome; a graceful, ordered, 10 s-bounded
  shutdown that exits 0.
- The JSON-RPC envelope byte shape: `type`/`jsonrpc`/`factoryApiVersion`/
  `factoryProtocolVersion`, UUID request ids, `result`-or-`error` responses,
  optional `params`, optional `_meta`.
- Advisory (non-blocking) protocol-version comparison with the mismatch
  record attached only to failures; `-32001` auth gate with the exact message;
  authenticate result + `daemon.connection_status` ordering + optional
  pipeline; re-authenticate returning identity; logout closing the connection.
- Client request lifecycle: per-method timeouts, rejection of all pending on
  close, `Connection reopened` on reconnect, abort semantics.
- Pending server→client request ids with `CONFLICT` on duplicates, no TTL for
  the three elicitation methods, 5-minute TTL otherwise, and persistence of
  pending prompts to `pending-askuser-requests.json` across restart.
- Background-process snapshot notifications and `kill_background_process`
  returning `{killed:boolean}`.
- Session inactivity semantics (30 min Local/Computer, 5 min Ephemeral,
  `session_inactivity` notification before teardown, host retention query).
- Remote Control registration in `host.json` (+ legacy `computer.json`),
  reconciliation statuses, the BYOM registration flow and its refusals, the
  relay `relay.authenticate` first-message handshake with the
  `factory-relay.N` subprotocol, the X25519 identity file and its publication,
  and the identity-mismatch `reason` values.
- `/health` and the token-gated `/port-proxy/<port>` surface.
- CLI failure text for unreachable daemons and the in-process fallback.

Not part of the contract:

- The ~200 `daemon.*` methods beyond the lifecycle ones named here; the
  generated catalogue is mechanical.
- Internal service wiring (heartbeat cadence implementation, disk monitor,
  SCM credential sync, cron/automation internals) except where a client can
  observe it.
- The desktop app, relay server and backend implementations; only their wire
  contracts are pinned.
- Exact log line wording beyond the strings quoted above; log content is
  diagnostic, not contract, except where a test above names it.
- The Node/Bun runtime choice; any runtime that produces the same frames,
  bind/retry timing and process exit behaviour satisfies the spec.