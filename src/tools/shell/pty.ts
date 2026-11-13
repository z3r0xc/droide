/**
 * Pseudo-terminal sessions for `Execute`.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B26 (the decision: `pty` only),
 * B27 (the transport the result reports), B29 (the spec 90 B15 blocklist) and
 * B30 (timeout and kill), plus `specs/90-native-layer.md` B13-B22 for the
 * env/shutdown rules the daemon terminal and this surface share.
 *
 * A PTY is a seam, not a policy: {@link PtyBackend} is the narrow surface the
 * tool needs, the native implementation speaks the helper's `pty.*` methods,
 * and a test substitutes its own backend. Nothing here decides whether a call
 * gets a terminal — that is `usesPty` in `exec.ts`, so the decision stays
 * visible next to the input schema.
 */
import { createNativeClient, type NativeClient } from "../../native/client.ts";
import {
  ptyClose,
  ptyKill,
  ptyRead,
  ptySpawn,
  ptyWrite,
} from "../../native/methods.ts";

/** Biggest wait the helper accepts for one `pty.read`. */
const MAX_READ_TIMEOUT_MS = 60_000;
/** Room over the read wait for the JSON-lines round trip itself. */
const READ_REQUEST_MARGIN_MS = 2_000;

/**
 * B29: the spec 90 B15 blocklist. Removed from the helper's inherited
 * environment *and* from the session overrides, because the helper layers the
 * overrides over what it inherited: filtering one layer only would let a value
 * back in through the other.
 */
export const PTY_ENVIRONMENT_BLOCKLIST: readonly string[] = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "SUDO_USER",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
];

const BLOCKED = new Set(PTY_ENVIRONMENT_BLOCKLIST);

/** One read from the terminal: bytes, and whether the child is done. */
export interface PtyChunk {
  readonly data: Buffer;
  readonly exited: boolean;
  readonly exitCode: number | null;
}

/** A live session; `stop` releases it, `terminate` is the exit-hook stop. */
export interface PtySession {
  read(timeoutMs: number): Promise<PtyChunk>;
  write(data: Uint8Array): Promise<void>;
  /** Kill the child, then close the session. Returns the child's exit code. */
  stop(): Promise<number | null>;
  /**
   * Synchronous stop for a `process` exit hook, where no promise can run:
   * killing the helper closes the terminal and its child with it.
   */
  terminate(): void;
}

export interface PtySpawnRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

/** The seam `Execute` uses; the default implementation talks to the helper. */
export interface PtyBackend {
  spawn(request: PtySpawnRequest): Promise<PtySession>;
  /** Release the helper process (and with it any session not yet closed). */
  close(): Promise<void>;
}

/**
 * B29: the environment a PTY may see. Comparison is case-insensitive because
 * Windows treats variable names that way.
 */
export function withoutBlockedVariables(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (BLOCKED.has(key.toUpperCase())) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

class NativePtySession implements PtySession {
  private readonly client: NativeClient;
  private readonly sessionId: string;

  constructor(client: NativeClient, sessionId: string) {
    this.client = client;
    this.sessionId = sessionId;
  }

  async read(timeoutMs: number): Promise<PtyChunk> {
    const wait = Math.max(
      0,
      Math.min(Math.trunc(timeoutMs), MAX_READ_TIMEOUT_MS),
    );
    const result = await ptyRead(this.client, this.sessionId, {
      timeoutMs: wait,
      requestTimeoutMs: wait + READ_REQUEST_MARGIN_MS,
    });
    return {
      data: Buffer.from(result.data, "base64"),
      exited: result.exited,
      exitCode: result.exitCode,
    };
  }

  async write(data: Uint8Array): Promise<void> {
    // The helper takes base64 on the wire; the wrapper passes the payload as
    // given, so encoding belongs here.
    await ptyWrite(
      this.client,
      this.sessionId,
      Buffer.from(data).toString("base64"),
    );
  }

  async stop(): Promise<number | null> {
    let exitCode: number | null = null;
    try {
      exitCode = await ptyKill(this.client, this.sessionId);
    } catch {
      // The child may already be reaped; closing is still required.
    }
    await ptyClose(this.client, this.sessionId).catch(() => undefined);
    return exitCode;
  }

  terminate(): void {
    this.client.terminate();
  }
}

class NativePtyBackend implements PtyBackend {
  private readonly options: {
    readonly helperPath: string;
    readonly env: Readonly<Record<string, string>>;
  };
  private opening: Promise<NativeClient> | undefined;
  private opened: NativeClient | undefined;
  private closed = false;

  constructor(options: {
    readonly helperPath: string;
    readonly env: Readonly<Record<string, string>>;
  }) {
    this.options = options;
  }

  private open(): Promise<NativeClient> {
    this.opening ??= createNativeClient({
      helperPath: this.options.helperPath,
      env: { ...this.options.env },
    }).then(
      (client) => {
        this.opened = client;
        return client;
      },
      (error: unknown) => {
        // A failed handshake must not be cached as a permanently broken
        // backend: the caller reports this one fallback and closes.
        this.opening = undefined;
        throw error;
      },
    );
    return this.opening;
  }

  async spawn(request: PtySpawnRequest): Promise<PtySession> {
    const client = await this.open();
    const sessionId = await ptySpawn(client, {
      program: request.program,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      ...(request.cols === undefined ? {} : { cols: request.cols }),
      ...(request.rows === undefined ? {} : { rows: request.rows }),
    });
    return new NativePtySession(client, sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const client = this.opened;
    this.opened = undefined;
    if (client !== undefined) await client.close().catch(() => undefined);
  }
}

/** The production backend: one helper process per `Execute` PTY call. */
export function createNativePtyBackend(options: {
  readonly helperPath: string;
  readonly env: Readonly<Record<string, string>>;
}): PtyBackend {
  return new NativePtyBackend(options);
}
