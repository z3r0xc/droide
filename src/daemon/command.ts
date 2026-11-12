/**
 * `droide daemon` wiring: parsed flags in, process exit code out. Contract:
 * `specs/70-daemon-and-remote-control.md` B1–B3, B5, B7, B8, B10, B11, B28
 * (refusal) and B31.
 *
 * The CLI layer owns option parsing and presentation; this module owns the
 * translation into {@link DaemonServerOptions} so the mapping is testable
 * without a process. Every path here comes from the injected `Environment`, so
 * a test never reads the real home directory.
 */

import {
  factoryDir,
  factoryHome,
  joinPath,
  type Environment,
} from "../config/paths.ts";
import type { DaemonAuthPolicy, DaemonIdentity } from "./auth.ts";
import type { LivenessPipeOpener } from "./liveness.ts";
import {
  DEFAULT_HOST,
  runDaemon,
  type DaemonLogger,
  type DaemonMethodHandler,
  type DaemonParentChannel,
  type DaemonServerOptions,
  type DaemonShutdownStep,
} from "./server.ts";
import { systemTimers, type DaemonTimers } from "./timers.ts";

/**
 * B28: `--remote-control` needs a registered computer. This build has no
 * backend client, so the flag is refused (fail-closed) instead of pretending
 * the relay is up.
 *
 * TODO(spec B28): registration, reconciliation and the relay dial are not
 * implemented; the flag is refused rather than ignored.
 */
export const REMOTE_CONTROL_UNAVAILABLE =
  "Remote Control requires a registered computer, which this build cannot create";

/**
 * The single-user identity this daemon reports.
 *
 * TODO(spec B15): the spec verifies a WorkOS token or `fk-` key against the
 * backend and answers with that account's `userId`/`orgId`; this build has no
 * backend client, so it accepts the ambient `DROIDE_API_KEY` and reports a
 * local identity.
 */
export const LOCAL_IDENTITY: DaemonIdentity = {
  userId: "local-user",
  orgId: "local-org",
};

/** The flags Commander has already parsed, normalised for this module. */
export interface DaemonArgv {
  readonly port?: number;
  readonly host?: string;
  readonly unixPath?: string;
  readonly debug?: boolean;
  readonly listen?: "websocket" | "ipc";
  readonly droidePath?: string;
  readonly livenessFd?: number;
  readonly parentPid?: number;
  readonly remoteControl?: boolean;
  readonly settings?: string;
}

export interface DaemonCommandDeps {
  readonly environment: Environment;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly pid?: number;
  /** Defaults to {@link environmentAuthPolicy}. */
  readonly auth?: DaemonAuthPolicy;
  /** Defaults to the real parent channel, when this process has one. */
  readonly parentChannel?: DaemonParentChannel;
  readonly notifyReady?: (state: string) => void;
  readonly signal?: AbortSignal;
  readonly timers?: DaemonTimers;
  readonly methods?: Readonly<Record<string, DaemonMethodHandler>>;
  readonly bindRetryDelaysMs?: readonly number[];
  readonly shutdownTimeoutMs?: number;
  readonly shutdownSteps?: readonly DaemonShutdownStep[];
  readonly onShutdownStep?: (name: string) => void;
  readonly logger?: DaemonLogger;
  readonly openLiveness?: LivenessPipeOpener;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly parentPollIntervalMs?: number;
}

/**
 * B15/B31: the credential the daemon accepts is the ambient `DROIDE_API_KEY`
 * (the only `fk-` credential this build can read). Without one every
 * `daemon.authenticate` is refused, which fails closed.
 */
export function environmentAuthPolicy(
  environment: Environment,
): DaemonAuthPolicy {
  const apiKey = environment.env["DROIDE_API_KEY"]?.trim();
  return {
    identity: LOCAL_IDENTITY,
    ...(apiKey !== undefined && apiKey.startsWith("fk-") ? { apiKey } : {}),
  };
}

/** Where the daemon's own log lives: `<state dir>/logs/the daemon.log`. */
export function daemonLogsPath(environment: Environment): string {
  return joinPath(
    environment.platform,
    factoryDir(environment),
    "logs",
    "the daemon.log",
  );
}

/**
 * B2: a non-empty `--settings` is exported so runtime settings resolve from
 * that file inside the daemon's own process. An empty value is left alone.
 */
export function exportSettingsEnvironment(
  settings: string | undefined,
  environment: Record<string, string | undefined>,
): void {
  if (settings === undefined || settings.length === 0) return;
  environment["FACTORY_RUNTIME_SETTINGS_PATH"] = settings;
}

/**
 * Debug logging goes to stderr; without `--debug` only failures do, so a
 * normal run's stdout stays the readiness banner and nothing else.
 */
export function stderrLogger(
  stderr: (line: string) => void,
  debug: boolean,
): DaemonLogger {
  return debug
    ? { debug: stderr, info: stderr, error: stderr }
    : { debug() {}, info() {}, error: stderr };
}

/** The Node parent/child IPC channel, when this process was spawned with one. */
export function processParentChannel(): DaemonParentChannel | undefined {
  const send = process.send;
  if (typeof send !== "function") return undefined;
  return {
    connected: process.connected,
    send: (message) => {
      send(message);
    },
    onMessage: (listener) => {
      process.on("message", listener);
    },
    onDisconnect: (listener) => {
      process.on("disconnect", listener);
    },
    offMessage: (listener) => {
      process.off("message", listener);
    },
    offDisconnect: (listener) => {
      process.off("disconnect", listener);
    },
  };
}

/**
 * Translate the parsed flags into the server configuration. Pure: the only
 * side effects are the injected sinks.
 *
 * TODO(spec B1): `--droide-path` is parsed but no session spawner in this build
 * consumes it; spawned sessions are outside the implemented slice.
 */
export function daemonServerOptions(
  argv: DaemonArgv,
  deps: DaemonCommandDeps,
): DaemonServerOptions {
  const environment = deps.environment;
  const listen = argv.listen ?? "websocket";
  return {
    listen,
    host: argv.host ?? DEFAULT_HOST,
    ...(argv.port === undefined ? {} : { port: argv.port }),
    ...(argv.unixPath === undefined ? {} : { unixPath: argv.unixPath }),
    auth: deps.auth ?? environmentAuthPolicy(environment),
    homedir: factoryHome(environment),
    platform: environment.platform,
    pid: deps.pid ?? process.pid,
    logsPath: daemonLogsPath(environment),
    ...(deps.methods === undefined ? {} : { methods: deps.methods }),
    ...(deps.parentChannel === undefined
      ? {}
      : { parentChannel: deps.parentChannel }),
    ...(deps.notifyReady === undefined
      ? {}
      : { notifyReady: deps.notifyReady }),
    remoteControl: argv.remoteControl === true,
    ...(argv.livenessFd === undefined ? {} : { livenessFd: argv.livenessFd }),
    ...(argv.parentPid === undefined ? {} : { parentPid: argv.parentPid }),
    ...(deps.parentPollIntervalMs === undefined
      ? {}
      : { parentPollIntervalMs: deps.parentPollIntervalMs }),
    ...(deps.openLiveness === undefined
      ? {}
      : { openLiveness: deps.openLiveness }),
    ...(deps.isProcessAlive === undefined
      ? {}
      : { isProcessAlive: deps.isProcessAlive }),
    stdout: deps.stdout,
    stderr: deps.stderr,
    logger: deps.logger ?? stderrLogger(deps.stderr, argv.debug === true),
    timers: deps.timers ?? systemTimers,
    ...(deps.bindRetryDelaysMs === undefined
      ? {}
      : { bindRetryDelaysMs: deps.bindRetryDelaysMs }),
    ...(deps.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: deps.shutdownTimeoutMs }),
    ...(deps.shutdownSteps === undefined
      ? {}
      : { shutdownSteps: deps.shutdownSteps }),
    ...(deps.onShutdownStep === undefined
      ? {}
      : { onShutdownStep: deps.onShutdownStep }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
}

/**
 * Run the daemon to completion and return the documented process exit code:
 * `1` for a refused startup (with `Startup failed: <message>` on stderr), `0`
 * for a signal-driven or requested stop (B7, B8).
 */
export async function runDaemonCommand(
  argv: DaemonArgv,
  deps: DaemonCommandDeps,
): Promise<number> {
  // The server answers `--listen ipc` + `--remote-control` with its own,
  // documented code, so only the socket transports reach the refusal here.
  const listen = argv.listen ?? "websocket";
  if (argv.remoteControl === true && listen !== "ipc") {
    deps.stderr(`Startup failed: ${REMOTE_CONTROL_UNAVAILABLE}`);
    return 1;
  }
  return await runDaemon(daemonServerOptions(argv, deps));
}
