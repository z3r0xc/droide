/**
 * The loopback callback for the MCP OAuth flow.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B27–B28 and
 * `docs/adr/0008-oauth-credential-envelope.md`. The server binds `127.0.0.1`
 * only, tries a bounded run of ports, validates `state`, and gives the user four
 * minutes before it gives up.
 */
import { createServer, type Server } from "node:http";

import {
  AUTHORIZATION_WINDOW_MS,
  CALLBACK_PORT_ATTEMPTS,
  CALLBACK_PORT_START,
} from "./pkce.ts";

export interface AuthorizationCodeOptions {
  /** The `state` this flow generated; a mismatch is refused. */
  readonly expectedState: string;
  readonly host?: "127.0.0.1" | "localhost";
  /** First port to try; `0` asks the OS for an ephemeral one (tests). */
  readonly portStart?: number;
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called once the server is listening, with the redirect URI to use. */
  readonly onListening?: (redirectUri: string) => void;
}

export interface AuthorizationCode {
  readonly code: string;
}

export class OAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

const SUCCESS_PAGE =
  "<!doctype html><title>Droide</title><p>Authorization received. You can close this window.</p>";

function listen(server: Server, host: string, port: number): Promise<number> {
  const bound = Promise.withResolvers<number>();
  const onError = (error: Error): void => {
    server.removeListener("listening", onListeningEvent);
    bound.reject(error);
  };
  const onListeningEvent = (): void => {
    server.removeListener("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      bound.reject(
        new OAuthCallbackError("the callback server did not bind a TCP port"),
      );
      return;
    }
    bound.resolve(address.port);
  };
  server.once("error", onError);
  server.once("listening", onListeningEvent);
  server.listen(port, host);
  return bound.promise;
}

/** Bind the first free port in the documented run, or `0` for an ephemeral one. */
async function bindCallbackServer(
  server: Server,
  host: string,
  portStart: number,
  attempts: number,
): Promise<number> {
  if (portStart === 0) return listen(server, host, 0);

  let lastError: unknown;
  for (let offset = 0; offset < attempts; offset += 1) {
    try {
      return await listen(server, host, portStart + offset);
    } catch (error) {
      lastError = error;
    }
  }
  throw new OAuthCallbackError(
    `no free loopback port in ${portStart}..${portStart + attempts - 1}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Wait for the authorization redirect.
 *
 * Resolves with the code, rejects on an `error` parameter, a state mismatch that
 * exhausts the window, a timeout, or an aborted signal. The server is always
 * closed before the promise settles.
 */
export async function waitForAuthorizationCode(
  options: AuthorizationCodeOptions,
): Promise<AuthorizationCode> {
  const host = options.host ?? "127.0.0.1";
  const portStart = options.portStart ?? CALLBACK_PORT_START;
  const attempts = options.attempts ?? CALLBACK_PORT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? AUTHORIZATION_WINDOW_MS;

  const settled = Promise.withResolvers<AuthorizationCode>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      response
        .writeHead(400, { "content-type": "text/plain" })
        .end("authorization failed");
      settled.reject(new OAuthCallbackError(`authorization failed: ${error}`));
      return;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (state !== options.expectedState) {
      // Do not consume the flow: a stale tab or a probe must not end it.
      response
        .writeHead(400, { "content-type": "text/plain" })
        .end("state mismatch");
      return;
    }
    if (code === null || code.length === 0) {
      response
        .writeHead(400, { "content-type": "text/plain" })
        .end("missing code");
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(SUCCESS_PAGE);
    settled.resolve({ code });
  });

  const close = (): void => {
    server.closeAllConnections();
    server.close();
  };

  const timer = AbortSignal.timeout(timeoutMs);
  const onTimeout = (): void => {
    settled.reject(
      new OAuthCallbackError(
        `no authorization within ${Math.round(timeoutMs / 1000)} s`,
      ),
    );
    close();
  };
  const onAbort = (): void => {
    settled.reject(new OAuthCallbackError("authorization cancelled"));
    close();
  };
  timer.addEventListener("abort", onTimeout, { once: true });
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const port = await bindCallbackServer(server, host, portStart, attempts);
    options.onListening?.(`http://${host}:${port}/callback`);
    return await settled.promise;
  } finally {
    timer.removeEventListener("abort", onTimeout);
    options.signal?.removeEventListener("abort", onAbort);
    close();
  }
}
