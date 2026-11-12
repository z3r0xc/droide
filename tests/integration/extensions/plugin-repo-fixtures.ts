/**
 * Fixtures for the plugin marketplace/install tests: a real temporary git
 * repository holding one `marketplace.json` and one plugin directory. Nothing
 * here reaches the network — every repository operand the tests pass to the
 * injected runner is a path or a `file://` URL under the temporary root.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

import {
  defaultGitRunner,
  type GitRunner,
} from "../../../src/extensions/plugins/marketplace.ts";
import type { SourceFetch } from "../../../src/extensions/plugins/sources.ts";

export interface TempRoot {
  readonly path: string;
  cleanup(): void;
}

export function createTempRoot(prefix = "droide-plugins-"): TempRoot {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function writeAt(
  root: string,
  relative: string,
  content: string,
): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

/** One git command in `cwd`, with prompts and the user's config out of the way. */
export function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
}

export interface MarketplaceRepoOptions {
  /** Repository directory name under the temp root. */
  readonly directory: string;
  /** The manifest's display name. */
  readonly manifestName: string;
  /** Plugin directory names; each gets a `plugin.json` and a `SKILL.md`. */
  readonly plugins?: readonly string[];
  /** Create and check out this branch, with the manifest renamed to `<name>-branch`. */
  readonly branch?: string;
}

export interface MarketplaceRepo {
  readonly path: string;
  readonly url: string;
  readonly head: string;
  readonly manifestName: string;
}

export function createMarketplaceRepo(
  root: string,
  options: MarketplaceRepoOptions,
): MarketplaceRepo {
  const plugins = options.plugins ?? ["demo"];
  const repo = join(root, options.directory);
  const manifest = (name: string) =>
    JSON.stringify(
      {
        name,
        description: "fixture marketplace",
        plugins: plugins.map((plugin) => ({
          name: plugin,
          source: `plugins/${plugin}`,
        })),
      },
      null,
      2,
    );

  writeAt(
    repo,
    ".droide-plugin/marketplace.json",
    manifest(options.manifestName),
  );
  for (const plugin of plugins) {
    writeAt(repo, `plugins/${plugin}/.droide-plugin/plugin.json`, "{}\n");
    writeAt(repo, `plugins/${plugin}/SKILL.md`, `# ${plugin}\n`);
  }

  gitIn(repo, ["init", "-q", "-b", "main"]);
  gitIn(repo, ["config", "user.email", "fixture@example.test"]);
  gitIn(repo, ["config", "user.name", "Fixture"]);
  gitIn(repo, ["config", "core.autocrlf", "false"]);
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-qm", "initial marketplace"]);

  let manifestName = options.manifestName;
  if (options.branch !== undefined) {
    gitIn(repo, ["checkout", "-q", "-b", options.branch]);
    manifestName = `${options.manifestName}-branch`;
    writeAt(repo, ".droide-plugin/marketplace.json", manifest(manifestName));
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-qm", "branch variant"]);
  }

  return {
    path: repo,
    url: pathToFileURL(repo).href,
    head: gitIn(repo, ["rev-parse", "HEAD"]).trim(),
    manifestName,
  };
}

/** Commit one more file; returns the new full commit. */
export function commitFile(
  repo: string,
  relative: string,
  content: string,
  message = "update",
): string {
  writeAt(repo, relative, content);
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-qm", message]);
  return gitIn(repo, ["rev-parse", "HEAD"]).trim();
}

/**
 * The real runner plus a record of every repository operand. A test asserts
 * afterwards that each one is a `file://` URL or a path under the temp root,
 * which is the mechanical proof that nothing dialled out.
 */
export function localOnlyRunner(): {
  readonly runner: GitRunner;
  readonly operands: string[];
} {
  const operands: string[] = [];
  const runner: GitRunner = (args, options) => {
    for (const arg of args) {
      if (/^(?!file:)[a-z][a-z0-9+.-]*:\/\//iu.test(arg)) {
        throw new Error(`network URL reached the git runner: ${arg}`);
      }
      if (/^[^@\s/]+@[^:\s]+:/u.test(arg) && !arg.startsWith("file://")) {
        throw new Error(`scp-style remote reached the git runner: ${arg}`);
      }
    }
    operands.push(...args.filter((arg) => !arg.startsWith("-")));
    return defaultGitRunner(args, options);
  };
  return { runner, operands };
}

/** A bare clone of an existing fixture repository, so a `github` source can resolve locally. */
export function createBareRepo(
  root: string,
  repository: string,
  directory: string,
): { readonly path: string; readonly url: string } {
  const bare = join(root, directory);
  gitIn(root, ["clone", "--bare", repository, bare]);
  return { path: bare, url: pathToFileURL(bare).href };
}

/**
 * The real runner with one rewrite: a `github.com` clone URL is replaced by the
 * local bare repository it stands for. This is how a `github` source is
 * exercised end-to-end without any network hop.
 */
export function localGithubRunner(barePath: string): {
  readonly runner: GitRunner;
  readonly urls: string[];
} {
  const urls: string[] = [];
  const runner: GitRunner = (args, options) => {
    const rewritten = args.map((arg) => {
      if (!/^https:\/\/github\.com\//u.test(arg)) return arg;
      urls.push(arg);
      return barePath;
    });
    return defaultGitRunner(rewritten, options);
  };
  return { runner, urls };
}

export interface ZipEntryInput {
  readonly name: string;
  readonly data: string;
  /** `deflate` exercises the compressed path; `store` writes bytes verbatim. */
  readonly method?: "store" | "deflate";
}

/** A deterministic zip writer, enough for the extractor's contract. */
export function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data, "utf8");
    const method = entry.method === "deflate" ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.byteLength + data.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

function tarHeader(name: string, size: number, type: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

/** A deterministic `.tgz` with the npm tarball's `package/` wrapper. */
export function buildTarball(
  files: Readonly<Record<string, string>>,
): Uint8Array {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    parts.push(tarHeader(`package/${name}`, data.byteLength, "0"), data);
    parts.push(Buffer.alloc((512 - (data.byteLength % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

export interface FakeRoute {
  readonly status?: number;
  readonly body?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeFetch {
  readonly fetch: SourceFetch;
  readonly urls: string[];
  readonly headers: Readonly<Record<string, string>>[];
}

/** A fetch that answers only the routes it knows and records what was asked. */
export function fakeFetch(
  routes: Readonly<Record<string, FakeRoute>>,
): FakeFetch {
  const urls: string[] = [];
  const headers: Readonly<Record<string, string>>[] = [];
  const impl: SourceFetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
    const body = route.body ?? new Uint8Array();
    return {
      status: route.status ?? 200,
      headers: {
        get(name: string) {
          return route.headers?.[name.toLowerCase()] ?? null;
        },
      },
      arrayBuffer: async () =>
        body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
    };
  };
  return { fetch: impl, urls, headers };
}
