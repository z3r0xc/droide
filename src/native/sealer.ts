/**
 * `CredentialSealer` over the native helper.
 *
 * Contract: `docs/adr/0008-oauth-credential-envelope.md` decisions 2–3 — the
 * credential document is sealed with `secrets.protect` (DPAPI on Windows, a
 * platform store on macOS/Linux when that lands) and a helper that cannot seal
 * is a refusal, never a plaintext fallback — and `crates/README.md`, where both
 * methods take and return base64.
 *
 * The helper is started lazily on the first seal or open and reused for the
 * rest of the process, so a `mcp auth` run pays one handshake. `close()` kills
 * the child; a test that forgets it leaves nothing behind but a process.
 */
import type { CredentialSealer } from "../extensions/mcp/oauth/store.ts";
import {
  createNativeClient,
  type NativeClient,
  type NativeClientOptions,
} from "./client.ts";
import {
  NativeError,
  NativeProtocolError,
  NativeTimeoutError,
  NativeUnavailableError,
} from "./errors.ts";
import { secretsProtect, secretsUnprotect } from "./methods.ts";

/** Why sealing is not possible here. */
export type SealerFailure =
  "helper-unavailable" | "platform-unsupported" | "helper-failed";

/**
 * Sealing is not available: the helper is missing, the platform store refused,
 * or the helper broke. The platform is named because that is the actionable
 * fact ("no DPAPI"), and there is deliberately no plaintext fallback.
 */
export class SealerUnavailableError extends Error {
  readonly failure: SealerFailure;
  readonly platform: string;

  constructor(
    failure: SealerFailure,
    platform: string,
    detail: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      `cannot seal MCP OAuth credentials on ${platform}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SealerUnavailableError";
    this.failure = failure;
    this.platform = platform;
  }
}

export interface NativeSealerOptions {
  /** Absolute path of the helper executable. */
  readonly helperPath: string;
  /** Extra argv, used by the fake helper in tests; the real helper takes none. */
  readonly helperArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Entropy bound into every blob, so a copied blob is not portable. */
  readonly entropy?: Uint8Array;
  readonly requestTimeoutMs?: number;
  /** Overrides `process.platform` in the error text (tests). */
  readonly platform?: string;
}

/** A sealer whose child can be shut down; the CLI owns this one. */
export interface ClosableCredentialSealer extends CredentialSealer {
  close(): Promise<void>;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export class NativeCredentialSealer implements ClosableCredentialSealer {
  private readonly options: NativeSealerOptions;
  private readonly platform: string;
  private client: NativeClient | undefined;
  private connecting: Promise<NativeClient> | undefined;

  constructor(options: NativeSealerOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    if (options.helperPath.trim() === "") {
      throw new SealerUnavailableError(
        "helper-unavailable",
        this.platform,
        "no native helper path is configured",
      );
    }
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    const client = await this.requireClient();
    const entropy = this.entropyParam();
    let sealed: string;
    try {
      sealed = await secretsProtect(client, {
        plaintext: Buffer.from(plaintext).toString("base64"),
        ...(entropy === undefined ? {} : { entropy }),
      });
    } catch (error) {
      throw this.translate(error, "the helper failed to seal");
    }
    return this.decode(sealed, "the sealed blob");
  }

  async open(sealed: Uint8Array): Promise<Uint8Array> {
    const client = await this.requireClient();
    const entropy = this.entropyParam();
    let plaintext: string;
    try {
      plaintext = await secretsUnprotect(client, {
        sealed: Buffer.from(sealed).toString("base64"),
        ...(entropy === undefined ? {} : { entropy }),
      });
    } catch (error) {
      throw this.translate(error, "the helper failed to open");
    }
    return this.decode(plaintext, "the opened plaintext");
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client !== undefined) await client.close();
  }

  private entropyParam(): string | undefined {
    const entropy = this.options.entropy;
    return entropy === undefined
      ? undefined
      : Buffer.from(entropy).toString("base64");
  }

  private decode(value: string, detail: string): Uint8Array {
    if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
      throw new SealerUnavailableError(
        "helper-failed",
        this.platform,
        `${detail} is not base64`,
      );
    }
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  private async requireClient(): Promise<NativeClient> {
    if (this.client !== undefined) return this.client;
    this.connecting ??= this.connect();
    try {
      const client = await this.connecting;
      this.client = client;
      return client;
    } catch (error) {
      this.connecting = undefined;
      throw error;
    }
  }

  private async connect(): Promise<NativeClient> {
    const options: NativeClientOptions = {
      helperPath: this.options.helperPath,
      ...(this.options.helperArgs === undefined
        ? {}
        : { helperArgs: this.options.helperArgs }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.options.requestTimeoutMs }),
    };
    try {
      return await createNativeClient(options);
    } catch (error) {
      throw this.translate(error, "the native helper could not be started");
    }
  }

  /** Map the native boundary's failures onto the sealer's one typed refusal. */
  private translate(error: unknown, detail: string): Error {
    if (error instanceof SealerUnavailableError) return error;
    if (error instanceof NativeUnavailableError) {
      return new SealerUnavailableError(
        "helper-unavailable",
        this.platform,
        `${detail} (${error.message})`,
        { cause: error },
      );
    }
    if (error instanceof NativeError) {
      return new SealerUnavailableError(
        "platform-unsupported",
        this.platform,
        `the helper refused: ${error.message}`,
        { cause: error },
      );
    }
    if (
      error instanceof NativeTimeoutError ||
      error instanceof NativeProtocolError
    ) {
      return new SealerUnavailableError(
        "helper-failed",
        this.platform,
        error.message,
        { cause: error },
      );
    }
    return error instanceof Error
      ? error
      : new SealerUnavailableError("helper-failed", this.platform, detail);
  }
}

/** Build a sealer; it starts the helper on first use, not here. */
export function createNativeSealer(
  options: NativeSealerOptions,
): NativeCredentialSealer {
  return new NativeCredentialSealer(options);
}
