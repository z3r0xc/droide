/**
 * Built-in checks.
 *
 * Contract: `specs/10-cli-surface.md` §B49–B51. Each check answers one question
 * a user can act on, finishes inside the probe budget, and never throws: the
 * runner turns a thrown error into a `fail` with the message.
 *
 * Checks this build does not implement return `skip` with a reason, so an
 * incomplete report can never look like a clean bill of health.
 */
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { McpClient } from "../extensions/mcp/client.ts";
import {
  enabledMcpServers,
  loadMcpConfiguration,
  mcpConfigFileSources,
} from "../extensions/mcp/config.ts";

import type { CheckResult, DoctorCheck, DoctorContext } from "./types.ts";

const NOT_IMPLEMENTED = "not implemented in this build";

function skipped(what: string): CheckResult {
  return {
    status: "skip",
    summary: `${what}: ${NOT_IMPLEMENTED}`,
    details: [`TODO(spec B49): ${what} check`],
  };
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
      "FACTORY_API_KEY",
    ];
    const details = interesting.map((key) => {
      const value = context.environment.env[key];
      if (value === undefined) return `${key}: (unset)`;
      return key === "FACTORY_API_KEY"
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
    const factoryDir = context.paths["factoryDir"];
    if (factoryDir === undefined)
      return { status: "fail", summary: "factory directory is unknown" };
    const probe = join(factoryDir, `.doctor-${randomUUID()}`);
    try {
      // The app creates its home lazily, so a missing directory is not a
      // failure: make it, then prove it is writable.
      await mkdir(factoryDir, { recursive: true });
      await access(factoryDir, constants.W_OK);
      await writeFile(probe, "ok", "utf8");
      await rm(probe, { force: true });
      return {
        status: "ok",
        summary: "factory directory is writable",
        details: [
          `factoryDir: ${factoryDir}`,
          `cwd: ${context.environment.cwd}`,
        ],
      };
    } catch (error) {
      return {
        status: "fail",
        summary: "factory directory is not writable",
        details: [
          factoryDir,
          error instanceof Error ? error.message : String(error),
        ],
        fixes: [`ensure ${factoryDir} exists and is writable`],
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
    const apiKey = context.environment.env["FACTORY_API_KEY"];
    if (apiKey !== undefined && apiKey.trim().length > 0) {
      // Never print the key: length is enough to prove presence.
      return {
        status: "ok",
        summary: "API key from the environment",
        details: [`FACTORY_API_KEY: (set, ${apiKey.length} chars)`],
        metadata: { source: "env", length: apiKey.length },
      };
    }
    return {
      status: "warn",
      summary: "no credential found",
      details: [
        "FACTORY_API_KEY: (unset)",
        "the OS credential store is not consulted by this build yet",
      ],
      fixes: [
        "export FACTORY_API_KEY, or run `droide auth` once it is implemented",
      ],
    };
  },
};

const mcp: DoctorCheck = {
  name: "mcp",
  title: "MCP",
  async run(context) {
    const sources = mcpConfigFileSources(
      context.paths["factoryDir"] ?? "",
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

const notImplemented = (name: string): DoctorCheck => ({
  name,
  title: name,
  async run() {
    return skipped(name);
  },
});

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
  notImplemented("updates"),
  filesystem,
  git,
  notImplemented("custom-models"),
  proxy,
  certs,
  notImplemented("connectivity"),
  auth,
  notImplemented("daemon"),
  notImplemented("inference"),
  mcp,
  notImplemented("exec"),
];
