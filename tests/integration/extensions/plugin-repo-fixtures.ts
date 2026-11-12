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

import {
  defaultGitRunner,
  type GitRunner,
} from "../../../src/extensions/plugins/marketplace.ts";

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
    ".factory-plugin/marketplace.json",
    manifest(options.manifestName),
  );
  for (const plugin of plugins) {
    writeAt(repo, `plugins/${plugin}/.factory-plugin/plugin.json`, "{}\n");
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
    writeAt(repo, ".factory-plugin/marketplace.json", manifest(manifestName));
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
