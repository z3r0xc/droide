/**
 * A loopback authorization server for the OAuth flow tests.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B26–B29. It answers the
 * documents and endpoints the flow uses — protected-resource metadata, RFC 8414
 * metadata, RFC 7591 registration, an authorize redirect and a token exchange —
 * and records every request so a test can prove the PKCE pair, the state and the
 * client identity that actually went over the wire. It binds `127.0.0.1:0`, and
 * `close()` destroys every connection it opened.
 */
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface RegistrationRecord {
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: string | undefined;
  /** The published `client_name`, when the body carried one. */
  readonly clientName: string | undefined;
}

export interface AuthorizationRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly method: string;
  readonly state: string;
  readonly resource: string | null;
}

export interface TokenRecord {
  readonly clientId: string | null;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface FakeAuthorizationServer {
  /** e.g. `http://127.0.0.1:41234`. */
  readonly issuer: string;
  /** The MCP endpoint this issuer protects, e.g. `${issuer}/mcp`. */
  readonly resource: string;
  readonly registrations: RegistrationRecord[];
  readonly authorizations: AuthorizationRecord[];
  readonly tokenRequests: TokenRecord[];
  readonly close: () => Promise<void>;
}

export interface FakeServerOptions {
  /** `expires_in` of issued tokens; `0` makes the next run re-authenticate. */
  readonly expiresInSeconds?: number;
  /** Publish `registration_endpoint` and answer `POST /register`. */
  readonly dynamicRegistration?: boolean;
  /** Answer the protected-resource document (RFC 9728). */
  readonly protectedResource?: boolean;
  /** The `client_id` a registration hands out. */
  readonly clientId?: string;
  /** Refuse the token exchange with this status instead of issuing tokens. */
  readonly tokenStatus?: number;
}

const CHALLENGE_METHOD = "S256";

function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let text = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    text += chunk;
  });
  request.on("end", () => {
    resolve(text);
  });
  request.on("error", reject);
  return promise;
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(payload));
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Start the server. `options.clientId` is what registration returns, so a test
 * can assert the flow reused it rather than registering twice.
 */
export async function startAuthorizationServer(
  options: FakeServerOptions = {},
): Promise<FakeAuthorizationServer> {
  const registrations: RegistrationRecord[] = [];
  const authorizations: AuthorizationRecord[] = [];
  const tokenRequests: TokenRecord[] = [];
  const codes = new Map<string, { readonly challenge: string }>();
  const expiresIn = options.expiresInSeconds ?? 3600;
  const dynamicRegistration = options.dynamicRegistration ?? true;
  const withProtectedResource = options.protectedResource ?? true;
  const registrationClientId = options.clientId ?? "dynamic-client-1";

  let issuer = "";
  let resource = "";
  let nextCode = 1;

  const server = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      const url = new URL(request.url ?? "/", issuer);
      const path = url.pathname;

      if (
        withProtectedResource &&
        (path === "/.well-known/oauth-protected-resource" ||
          path === "/.well-known/oauth-protected-resource/mcp")
      ) {
        sendJson(response, 200, {
          resource,
          authorization_servers: [issuer],
        });
        return;
      }

      if (path === "/.well-known/oauth-authorization-server") {
        sendJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(dynamicRegistration
            ? { registration_endpoint: `${issuer}/register` }
            : {}),
        });
        return;
      }

      if (path === "/register" && request.method === "POST") {
        const payload: unknown = JSON.parse(await readBody(request));
        const record =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const redirectUris = Array.isArray(record["redirect_uris"])
          ? record["redirect_uris"].filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
        const method = record["token_endpoint_auth_method"];
        const clientName = record["client_name"];
        registrations.push({
          redirectUris,
          tokenEndpointAuthMethod:
            typeof method === "string" ? method : undefined,
          clientName: typeof clientName === "string" ? clientName : undefined,
        });
        sendJson(response, 201, { client_id: registrationClientId });
        return;
      }

      if (path === "/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        authorizations.push({
          clientId,
          redirectUri,
          challenge,
          method: url.searchParams.get("code_challenge_method") ?? "",
          state,
          resource: url.searchParams.get("resource"),
        });
        const code = `code-${nextCode}`;
        nextCode += 1;
        codes.set(code, { challenge });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        response.writeHead(302, { location: target.toString() }).end();
        return;
      }

      if (path === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await readBody(request));
        const code = form.get("code") ?? "";
        const verifier = form.get("code_verifier") ?? "";
        tokenRequests.push({
          clientId: form.get("client_id"),
          code,
          verifier,
          redirectUri: form.get("redirect_uri") ?? "",
        });
        const issued = codes.get(code);
        const method = authorizations.at(-1)?.method ?? CHALLENGE_METHOD;
        if (
          options.tokenStatus !== undefined ||
          issued === undefined ||
          method !== CHALLENGE_METHOD ||
          challengeFor(verifier) !== issued.challenge
        ) {
          sendJson(response, options.tokenStatus ?? 400, {
            error: "invalid_grant",
          });
          return;
        }
        codes.delete(code);
        sendJson(response, 200, {
          access_token: `access-${code}`,
          refresh_token: `refresh-${code}`,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: "read",
        });
        return;
      }

      response.writeHead(404).end();
    };

    void handle().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      listening.reject(
        new Error("the authorization server did not bind a port"),
      );
      return;
    }
    listening.resolve(address.port);
  });
  const port = await listening.promise;
  issuer = `http://127.0.0.1:${port}`;
  resource = `${issuer}/mcp`;

  return {
    issuer,
    resource,
    registrations,
    authorizations,
    tokenRequests,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => {
        closed.resolve();
      });
      await closed.promise;
    },
  };
}
