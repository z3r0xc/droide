/**
 * Built-in checks.
 *
 * Contract: `specs/10-cli-surface.md` §B49–B51. Each check answers one question
 * a user can act on, finishes inside the probe budget, and never throws: the
 * runner turns a thrown error into a `fail` with the message.
 *
 * A check that cannot run for lack of configuration returns `skip` with the
 * reason, so an incomplete report can never look like a clean bill of health.
 * Every probe takes its HTTP client, resolver and daemon from the injected
 * context, so the tests never open a socket.
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, mkdir, rm, writeFile } from "node:fs/promises";

import { checkForUpdate } from "../update/check.ts";
import { constants } from "node:fs";
import { arch, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { PRODUCT_VERSION } from "../cli/brand.ts";
import type {
  CustomModelProvider,
  CustomModelSettings,
} from "../config/schema.ts";
import { resolveModelTarget, type ExecModelTarget } from "../exec/command.ts";
import { createToolCatalogue, selectExecTools } from "../exec/runner.ts";
import { McpClient } from "../extensions/mcp/client.ts";
import {
  enabledMcpServers,
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../extensions/mcp/config.ts";
import { createCoreRegistry } from "../tools/index.ts";
import { redactUrl } from "../transport/headers.ts";
import {
  API_BASE_URL_ENV,
  createApiUrlConfig,
  resolveCliApiBaseUrl,
} from "../transport/urls.ts";

import type { CheckResult, DoctorCheck, DoctorContext } from "./types.ts";

/** Where update checks read from (ADR 0007). */
const UPDATE_REPOSITORY = "z3r0xc/droide";

/**
 * This build bakes no endpoint (50 B3): the product has no hosted backend, so
 * `DROIDE_API_BASE_URL` is the only source and its absence is a skip, never a
 * failure.
 */
const DEFAULT_API_BASE_URL = "";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The syscall error code, looked up through Node's `cause` chain. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) return undefined;
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

const config: DoctorCheck = {
  name: "config",
  title: "Configuration",
  async run(context) {
    const keys = Object.keys(context.settings);
    const problems: string[] = [];
    for (const [label, value] of Object.entries(context.paths)) {
      if (typeof value !== "string" || value.length === 0)
        problems.push(`${label} is empty`);
    }
    if (problems.length > 0)
      return {
        status: "fail",
        summary: problems.join("; "),
        details: problems,
      };
    return {
      status: "ok",
      summary: `settings loaded (${keys.length} key${keys.length === 1 ? "" : "s"})`,
      details:
        keys.length > 0
          ? [`keys: ${keys.join(", ")}`]
          : ["no settings files contributed"],
      metadata: { settingsKeys: keys.length },
    };
  },
};

const environment: DoctorCheck = {
  name: "environment",
  title: "Environment",
  async run(context) {
    const interesting = [
      "TERM",
      "NO_COLOR",
      "CI",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "DROIDE_API_KEY",
    ];
    const details = interesting.map((key) => {
      const value = context.environment.env[key];
      if (value === undefined) return `${key}: (unset)`;
      return key === "DROIDE_API_KEY"
        ? `${key}: (set, ${String(value).length} chars)`
        : `${key}: ${value}`;
    });
    return {
      status: "ok",
      summary: `${context.environment.platform} · node ${context.environment.nodeVersion}`,
      details,
      metadata: {
        platform: context.environment.platform,
        node: context.environment.nodeVersion,
      },
    };
  },
};

const system: DoctorCheck = {
  name: "system",
  title: "System",
  async run() {
    const major = Number.parseInt(
      process.versions.node.split(".")[0] ?? "0",
      10,
    );
    const gib = Math.round(totalmem() / 1024 ** 3);
    const result: CheckResult = {
      status: major >= 24 ? "ok" : "warn",
      summary: `${platform()} ${release()} · ${arch()} · ${gib} GiB · node ${process.versions.node}`,
      details:
        major >= 24 ? [] : ["node 24 or newer is required by the build target"],
      ...(major >= 24 ? {} : { fixes: ["install node 24 or newer"] }),
      metadata: {
        arch: arch(),
        platform: platform(),
        memoryGiB: gib,
        nodeMajor: major,
      },
    };
    return result;
  },
};

const filesystem: DoctorCheck = {
  name: "filesystem",
  title: "Filesystem",
  async run(context) {
    const stateDir = context.paths["stateDir"];
    if (stateDir === undefined)
      return { status: "fail", summary: "state directory is unknown" };
    const probe = join(stateDir, `.doctor-${randomUUID()}`);
    try {
      // The app creates its home lazily, so a missing directory is not a
      // failure: make it, then prove it is writable.
      await mkdir(stateDir, { recursive: true });
      await access(stateDir, constants.W_OK);
      await writeFile(probe, "ok", "utf8");
      await rm(probe, { force: true });
      return {
        status: "ok",
        summary: "state directory is writable",
        details: [`stateDir: ${stateDir}`, `cwd: ${context.environment.cwd}`],
      };
    } catch (error) {
      return {
        status: "fail",
        summary: "state directory is not writable",
        details: [
          stateDir,
          error instanceof Error ? error.message : String(error),
        ],
        fixes: [`ensure ${stateDir} exists and is writable`],
      };
    }
  },
};

function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    "git",
    [...args],
    { cwd, timeout: timeoutMs, windowsHide: true },
    (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout.trim());
    },
  );
  return promise;
}

const git: DoctorCheck = {
  name: "git",
  title: "Git",
  async run(context) {
    try {
      const inside = await runGit(
        context.environment.cwd,
        ["rev-parse", "--is-inside-work-tree"],
        context.timeoutMs,
      );
      if (inside !== "true")
        return {
          status: "ok",
          summary: "not inside a git work tree",
          details: [`cwd: ${context.environment.cwd}`],
        };
      const branch = await runGit(
        context.environment.cwd,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        context.timeoutMs,
      );
      const status = await runGit(
        context.environment.cwd,
        ["status", "--porcelain"],
        context.timeoutMs,
      );
      const changed = status.length === 0 ? 0 : status.split("\n").length;
      return {
        status: "ok",
        summary: `git work tree on ${branch} (${changed} change${changed === 1 ? "" : "s"})`,
        metadata: { branch, changedFiles: changed },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "ok",
        summary: "git unavailable or not a repository",
        details: [message],
        metadata: { git: false },
      };
    }
  },
};

const proxy: DoctorCheck = {
  name: "proxy",
  title: "Proxy",
  async run(context) {
    const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
    const details: string[] = [];
    const problems: string[] = [];
    let configured = 0;

    for (const name of names) {
      const value =
        context.environment.env[name] ??
        context.environment.env[name.toLowerCase()];
      if (value === undefined || value.length === 0) {
        details.push(`${name}: (unset)`);
        continue;
      }
      configured += 1;
      if (name === "NO_PROXY") {
        details.push(`${name}: ${value}`);
        continue;
      }
      // A proxy value is a URL with a scheme; a bare host:port is a typo that
      // fails much later, inside a request, so catch it here.
      try {
        const url = new URL(value);
        details.push(`${name}: ${url.protocol}//${url.host}`);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          problems.push(`${name} must be an http(s) URL`);
        }
      } catch {
        problems.push(`${name} is not a valid URL`);
        details.push(`${name}: (invalid)`);
      }
    }

    if (problems.length > 0) {
      return {
        status: "fail",
        summary: problems.join("; "),
        details,
        fixes: ["fix or unset the proxy variables"],
      };
    }
    return {
      status: "ok",
      summary:
        configured === 0
          ? "no proxy configured"
          : `${configured} proxy variable${configured === 1 ? "" : "s"} configured`,
      details,
      metadata: { configured },
    };
  },
};

const certs: DoctorCheck = {
  name: "certs",
  title: "Certificates",
  async run(context) {
    const extra = context.environment.env["NODE_EXTRA_CA_CERTS"];
    if (extra === undefined || extra.length === 0) {
      return {
        status: "ok",
        summary: "system trust store (NODE_EXTRA_CA_CERTS is unset)",
        details:
          context.environment.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0"
            ? [
                "NODE_TLS_REJECT_UNAUTHORIZED=0 disables verification — do not use this outside tests",
              ]
            : [],
      };
    }
    try {
      await access(extra, constants.R_OK);
      return {
        status: "ok",
        summary: "extra CA bundle is readable",
        details: [extra],
      };
    } catch {
      return {
        status: "fail",
        summary: "NODE_EXTRA_CA_CERTS points at an unreadable file",
        details: [extra],
        fixes: [
          "point NODE_EXTRA_CA_CERTS at a readable PEM bundle, or unset it",
        ],
      };
    }
  },
};

const auth: DoctorCheck = {
  name: "auth",
  title: "Authentication",
  async run(context) {
    const apiKey = context.environment.env["DROIDE_API_KEY"];
    if (apiKey !== undefined && apiKey.trim().length > 0) {
      // Never print the key: length is enough to prove presence.
      return {
        status: "ok",
        summary: "API key from the environment",
        details: [`DROIDE_API_KEY: (set, ${apiKey.length} chars)`],
        metadata: { source: "env", length: apiKey.length },
      };
    }
    return {
      status: "warn",
      summary: "no credential found",
      details: [
        "DROIDE_API_KEY: (unset)",
        "the OS credential store is not consulted by this build yet",
      ],
      fixes: [
        "export DROIDE_API_KEY, or run `droide auth` once it is implemented",
      ],
    };
  },
};

const mcp: DoctorCheck = {
  name: "mcp",
  title: "MCP",
  async run(context) {
    const sources = mcpConfigFileSources(
      context.paths["stateDir"] ?? "",
      context.environment.cwd,
    );
    const configuration = loadMcpConfiguration(sources);
    const enabled = enabledMcpServers(configuration);
    const broken = configuration.diagnostics.filter(
      (diagnostic) => diagnostic.code !== "server-unavailable",
    );

    if (enabled.length === 0) {
      const details = broken.map(
        (diagnostic) => `${diagnostic.path}: ${diagnostic.message}`,
      );
      return {
        status: broken.length > 0 ? "fail" : "skip",
        summary:
          broken.length > 0
            ? "the MCP configuration could not be read"
            : "no enabled MCP servers",
        details,
        ...(broken.length > 0
          ? { fixes: ["fix the MCP configuration file named above"] }
          : {}),
      };
    }

    const details: string[] = [];
    const failures: string[] = [];
    for (const entry of enabled) {
      const client = new McpClient({
        server: entry.name,
        config: entry.config,
      });
      try {
        await context.withTimeout(`mcp ${entry.name}`, async (signal) => {
          await client.connect();
          const listing = await client.listTools({ signal });
          details.push(
            `${entry.name}: ${listing.tools.length} tool${listing.tools.length === 1 ? "" : "s"}`,
          );
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${entry.name}: ${message}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    }

    if (failures.length > 0) {
      return {
        status: "fail",
        summary: `${failures.length} of ${enabled.length} MCP server${enabled.length === 1 ? "" : "s"} did not answer`,
        details: [...details, ...failures],
        fixes: ["check the server's command or URL, then re-run --checks mcp"],
      };
    }
    return {
      status: "ok",
      summary: `${enabled.length} MCP server${enabled.length === 1 ? "" : "s"} answered`,
      details,
      metadata: { servers: enabled.length },
    };
  },
};

const updates: DoctorCheck = {
  name: "updates",
  title: "Updates",
  async run(context) {
    const result = await checkForUpdate({
      repository: UPDATE_REPOSITORY,
      currentVersion: PRODUCT_VERSION,
      fetch: context.fetch ?? fetch,
      timeoutMs: Math.min(context.timeoutMs, 5_000),
    });
    switch (result.kind) {
      case "current":
        return {
          status: "ok",
          summary: `${result.version} is the newest published release`,
          metadata: { current: result.version },
        };
      case "available":
        return {
          status: "warn",
          summary: `${result.version} is available (running ${result.current})`,
          details: [result.url],
          fixes: ["run `droide update` to install it"],
        };
      case "unavailable":
        return {
          status: "skip",
          summary: `could not check for updates: ${result.reason}`,
          details: [
            "the check reads this repository's GitHub releases anonymously",
          ],
        };
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Connectivity                                                               */
/* -------------------------------------------------------------------------- */

/** DNS codes that mean the name did not resolve, not that the wire failed. */
const DNS_ERROR_CODES: Readonly<Record<string, true>> = {
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EAI_FAIL: true,
  EAI_NODATA: true,
  EAI_NONAME: true,
};

/** TLS failures Node reports with a stable code. */
const TLS_ERROR_CODES: Readonly<Record<string, true>> = {
  CERT_HAS_EXPIRED: true,
  CERT_NOT_YET_VALID: true,
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_GET_ISSUER_CERT: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
  EPROTO: true,
};

/** Which of the three stages an unreachable probe failed at. */
function stageOf(error: unknown): "dns" | "tls" | "http" {
  const code = errorCode(error);
  if (code !== undefined) {
    if (DNS_ERROR_CODES[code] === true) return "dns";
    if (TLS_ERROR_CODES[code] === true || code.startsWith("ERR_TLS"))
      return "tls";
  }
  return "http";
}

/** The backend base URL this process routes to, or `null` when none is configured (50 B1/B3). */
function backendBase(context: DoctorContext): URL | null {
  const configured = context.environment.env[API_BASE_URL_ENV]?.trim();
  if (configured === undefined || configured === "") return null;
  const config = createApiUrlConfig({
    deployment: { kind: "managed" },
    environment: { env: context.environment.env },
    baked: { apiBaseUrl: DEFAULT_API_BASE_URL, apiBaseUrlEu: null },
    // The probe is global-only, so an EU override cannot make it fail.
    overrides: { apiBaseUrlEu: null },
  });
  return resolveCliApiBaseUrl(config, "global");
}

const connectivity: DoctorCheck = {
  name: "connectivity",
  title: "Connectivity",
  async run(context) {
    let resolved: URL | null;
    try {
      resolved = backendBase(context);
    } catch (error) {
      return {
        status: "fail",
        summary: messageOf(error),
        details: [
          `${API_BASE_URL_ENV}: ${context.environment.env[API_BASE_URL_ENV] ?? "(unset)"}`,
        ],
        fixes: [`fix ${API_BASE_URL_ENV} or unset it`],
      };
    }

    if (resolved === null) {
      return {
        status: "skip",
        summary: "no API endpoint configured",
        details: [
          `${API_BASE_URL_ENV}: (unset)`,
          "this build ships no hosted endpoint",
        ],
        fixes: [`set ${API_BASE_URL_ENV} to the endpoint to use`],
      };
    }

    const base: URL = resolved;

    const baseUrl = redactUrl(base) ?? base.href;
    const host = base.hostname;
    const usesTls = base.protocol === "https:";
    const tlsLine = usesTls ? "TLS: not reached" : "TLS: not used (http)";
    const details: string[] = [`base: ${baseUrl}`];

    let addresses: readonly string[];
    try {
      addresses = await context.withTimeout("DNS lookup", async () => {
        if (context.resolveHost !== undefined) {
          return await context.resolveHost(host);
        }
        const records = await lookup(host, { all: true, verbatim: true });
        return records.map((record) => record.address);
      });
    } catch (error) {
      details.push(
        `DNS: failed (${messageOf(error)})`,
        tlsLine,
        "HTTP: not reached",
      );
      return {
        status: "warn",
        summary: `backend unreachable: ${host} did not resolve`,
        details,
        fixes: [
          "check DNS and VPN state, or point DROIDE_API_BASE_URL at a reachable backend",
        ],
        metadata: {
          baseUrl,
          dns: "failed",
          tls: "unreached",
          http: "unreached",
        },
      };
    }
    if (addresses.length === 0) {
      details.push(
        `DNS: ${host} resolved to no addresses`,
        tlsLine,
        "HTTP: not reached",
      );
      return {
        status: "warn",
        summary: `backend unreachable: ${host} resolved to no addresses`,
        details,
        metadata: {
          baseUrl,
          dns: "empty",
          tls: "unreached",
          http: "unreached",
        },
      };
    }
    details.push(`DNS: ${addresses.join(", ")}`);

    let response: Response;
    try {
      response = await context.withTimeout("HTTP probe", async (signal) => {
        const request = context.fetch ?? fetch;
        // HEAD proves the path without moving a body; a redirect is recorded
        // rather than followed, because the answer is the evidence.
        return await request(base, {
          method: "HEAD",
          redirect: "manual",
          signal,
        });
      });
    } catch (error) {
      const stage = stageOf(error);
      const code = errorCode(error);
      const reason =
        code === undefined ? messageOf(error) : `${messageOf(error)} (${code})`;
      let tls: string;
      if (stage === "dns") {
        details.push(`DNS: failed (${reason})`, tlsLine, "HTTP: not reached");
        tls = "unreached";
      } else if (stage === "tls") {
        details.push(`TLS: failed (${reason})`, "HTTP: not reached");
        tls = "failed";
      } else {
        details.push(tlsLine, `HTTP: failed (${reason})`);
        tls = "unknown";
      }
      return {
        status: "warn",
        summary:
          stage === "dns"
            ? `backend unreachable: ${host} did not resolve`
            : stage === "tls"
              ? `backend unreachable: the TLS handshake with ${host} failed`
              : `backend unreachable: ${host} did not answer`,
        details,
        fixes: [
          "the network path is the problem, not the credential — check the proxy, the VPN and the certificate store",
        ],
        metadata: {
          baseUrl,
          dns: stage === "dns" ? "failed" : "ok",
          tls,
          http: "failed",
        },
      };
    }

    const statusLine =
      response.statusText === ""
        ? `${response.status}`
        : `${response.status} ${response.statusText}`;
    details.push(
      usesTls ? "TLS: handshake ok" : "TLS: not used (http)",
      `HTTP: ${statusLine}`,
    );
    const unhealthy = response.status >= 500;
    return {
      status: unhealthy ? "warn" : "ok",
      summary: unhealthy
        ? `the network path works; the backend answered ${response.status}`
        : `backend reachable (HTTP ${statusLine})`,
      details,
      ...(unhealthy
        ? { fixes: ["the backend is unhealthy; retry later or report it"] }
        : {}),
      metadata: {
        baseUrl,
        dns: "ok",
        tls: usesTls ? "ok" : "unused",
        http: response.status,
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Custom models                                                              */
/* -------------------------------------------------------------------------- */

const KNOWN_PROVIDERS: Readonly<Record<CustomModelProvider, true>> = {
  anthropic: true,
  openai: true,
  "generic-chat-completion-api": true,
  "bedrock-converse": true,
};

/** `localhost`, a `*.localhost` name, `127.0.0.0/8` or `::1`. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./u.test(host)
  );
}

/** Every reason one `customModels[]` entry cannot be called, with its index. */
function customModelProblems(
  entry: CustomModelSettings,
  index: number,
): readonly string[] {
  const label =
    entry.id === undefined
      ? `customModels[${index}]`
      : `customModels[${index}] (${entry.id})`;
  const problems: string[] = [];

  if (KNOWN_PROVIDERS[entry.provider] !== true) {
    problems.push(`${label}: unknown provider "${String(entry.provider)}"`);
  }

  const baseUrl = entry.baseUrl?.trim() ?? "";
  if (baseUrl === "") {
    problems.push(`${label}: no baseUrl`);
  } else {
    let url: URL | undefined;
    try {
      url = new URL(baseUrl);
    } catch {
      problems.push(`${label}: baseUrl is not an absolute URL: ${baseUrl}`);
    }
    if (url !== undefined) {
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        problems.push(
          `${label}: baseUrl must use https:// (or http:// on loopback)`,
        );
      } else if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        problems.push(
          `${label}: baseUrl uses plain http on ${url.hostname}; use https or a loopback host`,
        );
      }
    }
  }

  const hasApiKey = (entry.apiKey?.trim() ?? "") !== "";
  const hasHelper = (entry.apiKeyHelper?.trim() ?? "") !== "";
  if (!hasApiKey && !hasHelper) {
    problems.push(`${label}: no credential (set apiKey or apiKeyHelper)`);
  }
  return problems;
}

const customModels: DoctorCheck = {
  name: "custom-models",
  title: "Custom models",
  async run(context) {
    const models = context.settings.customModels ?? [];
    if (models.length === 0) {
      return {
        status: "skip",
        summary: "no custom models configured",
        details: [
          "add an entry to customModels[] in settings.json to use -m custom:<id>",
        ],
      };
    }
    const problems = models.flatMap((entry, index) =>
      customModelProblems(entry, index),
    );
    if (problems.length > 0) {
      return {
        status: "fail",
        summary: `${models.length} custom model${models.length === 1 ? "" : "s"} configured, ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
        details: problems,
        fixes: [
          "fix the customModels[] entry named above; `droide exec -m custom:<id>` refuses an entry it cannot call",
        ],
        metadata: { models: models.length, problems: problems.length },
      };
    }
    return {
      status: "ok",
      summary: `${models.length} custom model${models.length === 1 ? "" : "s"} valid`,
      details: models.map(
        (entry, index) =>
          `${entry.id ?? `customModels[${index}]`}: ${entry.provider} → ${redactUrl(entry.baseUrl ?? "") ?? "(unparseable base URL)"}`,
      ),
      metadata: { models: models.length, problems: 0 },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Daemon                                                                     */
/* -------------------------------------------------------------------------- */

const daemon: DoctorCheck = {
  name: "daemon",
  title: "Daemon",
  async run(context) {
    const probe = context.daemon;
    if (probe === undefined) {
      return {
        status: "skip",
        summary: "no daemon endpoint configured",
        details: [
          "doctor probes only a daemon this process was told about; the daemon writes no discovery file (70 B4)",
        ],
      };
    }
    try {
      const answer = await context.withTimeout(
        "daemon handshake",
        async (signal) => {
          return await probe.connect(signal);
        },
      );
      return {
        status: "ok",
        summary: `daemon answered at ${probe.endpoint}`,
        details: [
          `endpoint: ${probe.endpoint}`,
          `protocol: ${answer.protocolVersion}`,
        ],
        metadata: {
          endpoint: probe.endpoint,
          protocolVersion: answer.protocolVersion,
        },
      };
    } catch (error) {
      return {
        status: "fail",
        summary: `daemon did not answer at ${probe.endpoint}`,
        details: [messageOf(error)],
        fixes: [
          `start \`droide daemon --port <port>\` on ${probe.endpoint}, or clear the configured endpoint`,
        ],
        metadata: { endpoint: probe.endpoint },
      };
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Inference                                                                  */
/* -------------------------------------------------------------------------- */

/** One token in, one token out: the cheapest proof the pipe works. */
const INFERENCE_PROMPT = "reply with ok";
const INFERENCE_MAX_TOKENS = 1;

/** How much of a provider body a report may quote. */
const MAX_PROVIDER_MESSAGE_CHARS = 300;

/** The credential values a provider body must never leak into a report. */
function credentialValues(
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key !== "authorization" && key !== "x-api-key") continue;
    const token = value.replace(/^Bearer\s+/iu, "").trim();
    if (token.length >= 4) secrets.push(token);
  }
  return secrets;
}

function redactProviderMessage(
  message: string,
  secrets: readonly string[],
): string {
  let text = message;
  for (const secret of secrets) text = text.split(secret).join("<redacted>");
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}…`
    : collapsed;
}

const inference: DoctorCheck = {
  name: "inference",
  title: "Inference",
  async run(context) {
    let target: ExecModelTarget;
    try {
      target = resolveModelTarget({
        model: undefined,
        reasoningEffort: undefined,
        settings: context.settings,
        env: context.environment.env,
      });
    } catch (error) {
      return {
        status: "fail",
        summary: `no model target: ${messageOf(error)}`,
        details: [
          "`droide exec` resolves the same target before it opens a connection",
        ],
        fixes: [
          "set DROIDE_API_KEY, or point droidCoreModel at a custom model",
        ],
      };
    }

    const secrets = credentialValues(target.headers);
    const endpoint = redactUrl(target.url) ?? target.url.href;
    const budget = `budget: ${context.timeoutMs} ms`;
    const body = JSON.stringify({
      model: target.wireModel,
      max_tokens: INFERENCE_MAX_TOKENS,
      messages: [{ role: "user", content: INFERENCE_PROMPT }],
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      ...target.headers,
    };

    let exchange: { readonly response: Response; readonly text: string };
    try {
      exchange = await context.withTimeout("inference", async (signal) => {
        const request = context.fetch ?? fetch;
        const response = await request(target.url, {
          method: "POST",
          headers,
          body,
          signal,
        });
        return { response, text: await response.text() };
      });
    } catch (error) {
      return {
        status: "fail",
        summary: `model ${target.wireModel} did not answer`,
        details: [
          redactProviderMessage(messageOf(error), secrets),
          `url: ${endpoint}`,
          budget,
        ],
        fixes: ["check connectivity and the model credentials"],
      };
    }

    if (!exchange.response.ok) {
      return {
        status: "fail",
        summary: `model ${target.wireModel} refused the request (HTTP ${exchange.response.status})`,
        details: [
          redactProviderMessage(
            exchange.text === "" ? exchange.response.statusText : exchange.text,
            secrets,
          ),
          `url: ${endpoint}`,
          budget,
        ],
        fixes: ["check the credential and the model id"],
        metadata: { status: exchange.response.status },
      };
    }

    return {
      status: "ok",
      summary: `model ${target.wireModel} answered (HTTP ${exchange.response.status})`,
      details: [`url: ${endpoint}`, `dialect: ${target.dialect}`, budget],
      metadata: {
        model: target.wireModel,
        dialect: target.dialect,
        status: exchange.response.status,
        budgetMs: context.timeoutMs,
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Exec                                                                       */
/* -------------------------------------------------------------------------- */

const exec: DoctorCheck = {
  name: "exec",
  title: "Exec",
  async run(context) {
    if ((context.paths["stateDir"] ?? "") === "") {
      return {
        status: "fail",
        summary: "exec cannot start: the state directory is not resolved",
        fixes: ["check HOME/USERPROFILE, then re-run --checks exec"],
        metadata: { stage: "settings" },
      };
    }
    if (context.environment.cwd === "") {
      return {
        status: "fail",
        summary: "exec cannot start: the working directory is not resolved",
        metadata: { stage: "settings" },
      };
    }

    let target: ExecModelTarget;
    try {
      target = resolveModelTarget({
        model: undefined,
        reasoningEffort: undefined,
        settings: context.settings,
        env: context.environment.env,
      });
    } catch (error) {
      return {
        status: "fail",
        summary: `exec cannot start: ${messageOf(error)}`,
        details: [
          "the model target is resolved before a provider or a tool runner exists",
        ],
        fixes: [
          "set DROIDE_API_KEY, or point droidCoreModel at a custom model",
        ],
        metadata: { stage: "model" },
      };
    }

    let tools: number;
    try {
      const registry = createCoreRegistry();
      tools = createToolCatalogue(
        registry,
        selectExecTools(registry, {}),
      ).length;
    } catch (error) {
      return {
        status: "fail",
        summary: "exec cannot start: the tool registry could not be built",
        details: [messageOf(error)],
        metadata: { stage: "tools" },
      };
    }

    return {
      status: "ok",
      summary: `exec can start: ${target.model} with ${tools} tool${tools === 1 ? "" : "s"}`,
      details: [
        `model: ${target.model}`,
        `endpoint: ${redactUrl(target.url) ?? target.url.href}`,
        `dialect: ${target.dialect}`,
        `tools: ${tools}`,
      ],
      metadata: { model: target.model, tools },
    };
  },
};

export const BUILTIN_CHECKS: readonly DoctorCheck[] = [
  config,
  environment,
  system,
  {
    name: "binaries",
    title: "Binaries",
    async run() {
      try {
        const version = await runGit(process.cwd(), ["--version"], 5_000);
        return {
          status: "ok",
          summary: `git ${version.replace(/^git version /, "")}`,
        };
      } catch (error) {
        return {
          status: "warn",
          summary: "git is not on PATH",
          details: [error instanceof Error ? error.message : String(error)],
          fixes: ["install git"],
        };
      }
    },
  },
  updates,
  filesystem,
  git,
  customModels,
  proxy,
  certs,
  connectivity,
  auth,
  daemon,
  inference,
  mcp,
  exec,
];
