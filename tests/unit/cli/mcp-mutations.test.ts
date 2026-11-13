import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runMcpAdd,
  runMcpAuth,
  runMcpPermissionsClear,
  runMcpPermissionsList,
  runMcpPermissionsRevoke,
  runMcpRemove,
} from "../../../src/cli/mcp-mutations.ts";
import type { McpMutationDeps } from "../../../src/cli/mcp-mutations.ts";
import { parseJsonc } from "../../../src/extensions/jsonc.ts";
import { readCredentials } from "../../../src/extensions/mcp/oauth/store.ts";
import type { CredentialSealer } from "../../../src/extensions/mcp/oauth/store.ts";
import { startAuthorizationServer } from "../extensions/oauth-fixtures.ts";

interface Sandbox {
  readonly root: string;
  readonly stateDir: string;
  readonly projectRoot: string;
  readonly userFile: string;
  readonly projectFile: string;
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "droide-mcp-cli-"));
  const stateDir = join(root, "home", ".droide");
  const projectRoot = join(root, "project");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(projectRoot, ".droide"), { recursive: true });
  return {
    root,
    stateDir,
    projectRoot,
    userFile: join(stateDir, "mcp.json"),
    projectFile: join(projectRoot, ".droide", "mcp.json"),
  };
}

interface Capture {
  readonly deps: McpMutationDeps;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exitCode: () => number | undefined;
}

function capture(box: Sandbox): Capture {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  return {
    deps: {
      stateDir: box.stateDir,
      projectRoot: box.projectRoot,
      write: (text) => {
        stdout += text;
      },
      writeError: (text) => {
        stderr += text;
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    exitCode: () => exitCode,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("add writes the user file and never the project file", async () => {
  const box = await sandbox();
  try {
    const run = capture(box);
    await runMcpAdd("Docs Server", ["node", "server.mjs"], {}, run.deps);
    assert.equal(run.exitCode(), 0);
    assert.match(run.stdout(), /Added MCP server "Docs-Server"/);
    assert.equal(await exists(box.projectFile), false);

    const parsed = parseJsonc(await readFile(box.userFile, "utf8")) as {
      readonly mcpServers: Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
    };
    assert.deepEqual(Object.keys(parsed.mcpServers), ["Docs-Server"]);
    assert.deepEqual(parsed.mcpServers["Docs-Server"], {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      disabled: false,
    });
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a duplicate add is refused and the file is unchanged", async () => {
  const box = await sandbox();
  try {
    const first = capture(box);
    await runMcpAdd("alpha", ["node", "a.mjs"], {}, first.deps);
    const before = await readFile(box.userFile, "utf8");

    const second = capture(box);
    await runMcpAdd("alpha", ["node", "b.mjs"], {}, second.deps);
    assert.equal(second.exitCode(), 1);
    assert.match(second.stderr(), /already configured/);
    assert.equal(await readFile(box.userFile, "utf8"), before);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a remote server is added with headers and --no-oauth", async () => {
  const box = await sandbox();
  try {
    const run = capture(box);
    await runMcpAdd(
      "remote",
      ["https://example.test/mcp"],
      {
        type: "http",
        header: ["Authorization: Bearer abc"],
        oauth: false,
      },
      run.deps,
    );
    assert.equal(run.exitCode(), 0);
    const parsed = parseJsonc(await readFile(box.userFile, "utf8")) as {
      readonly mcpServers: Readonly<Record<string, unknown>>;
    };
    assert.deepEqual(parsed.mcpServers["remote"], {
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer abc" },
      oauth: false,
      disabled: false,
    });
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

for (const [label, options] of [
  ["a bare URL without --type", {}],
  ["--env on a remote server", { type: "http", env: ["A=1"] }],
  ["--header on a stdio server", { header: ["A: B"] }],
  ["an unknown --type", { type: "websocket" }],
] as const) {
  test(`add refuses ${label}`, async () => {
    const box = await sandbox();
    try {
      const run = capture(box);
      await runMcpAdd("bad", ["https://example.test/mcp"], options, run.deps);
      assert.equal(run.exitCode(), 1);
      assert.equal(await exists(box.userFile), false);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });
}

test("remove round-trips a server and lists names when omitted", async () => {
  const box = await sandbox();
  try {
    const add = capture(box);
    await runMcpAdd("alpha", ["node", "a.mjs"], {}, add.deps);

    const listing = capture(box);
    await runMcpRemove(undefined, listing.deps);
    assert.equal(listing.exitCode(), 1);
    assert.match(listing.stdout(), /1\. alpha/);

    const removed = capture(box);
    await runMcpRemove("alpha", removed.deps);
    assert.equal(removed.exitCode(), 0);
    assert.match(removed.stdout(), /Removed MCP server "alpha"/);

    const unknown = capture(box);
    await runMcpRemove("alpha", unknown.deps);
    assert.equal(unknown.exitCode(), 1);
    assert.match(unknown.stderr(), /not configured/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("remove with no name and no servers succeeds quietly", async () => {
  const box = await sandbox();
  try {
    const run = capture(box);
    await runMcpRemove(undefined, run.deps);
    assert.equal(run.exitCode(), 0);
    assert.match(run.stdout(), /No removable MCP servers/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("auth reports nothing to do without remote OAuth servers", async () => {
  const box = await sandbox();
  try {
    const add = capture(box);
    await runMcpAdd(
      "keyed",
      ["https://example.test/mcp"],
      { type: "http", header: ["Authorization: x"], oauth: false },
      add.deps,
    );
    const run = capture(box);
    await runMcpAuth(run.deps);
    assert.equal(run.exitCode(), 0);
    assert.match(run.stdout(), /No MCP servers require authentication/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

/** The clock the auth tests pin, so an expiry is a constant. */
const AUTH_CLOCK_MS = 1_760_000_000_000;

/** An identity sealer: this file tests the CLI, not the envelope. */
const plainSealer: CredentialSealer = {
  seal: async (plaintext) => plaintext,
  open: async (sealed) => sealed,
};

/** The browser: follow the authorization redirect and hit the callback. */
async function followRedirect(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  const location = authorize.headers.get("location");
  if (location === null)
    throw new Error("the authorize request had no redirect");
  const callback = await fetch(location);
  if (callback.status !== 200) {
    throw new Error(`the callback answered ${callback.status}`);
  }
}

test("auth runs the flow for a server that needs authentication", async (t) => {
  const server = await startAuthorizationServer();
  const box = await sandbox();
  t.after(() => server.close());
  try {
    const add = capture(box);
    await runMcpAdd("remote", [server.resource], { type: "http" }, add.deps);
    const before = await readFile(box.userFile, "utf8");

    const run = capture(box);
    await runMcpAuth(run.deps, {
      sealer: plainSealer,
      openBrowser: followRedirect,
      fetch: globalThis.fetch,
      now: () => AUTH_CLOCK_MS,
      callbackPortStart: 0,
    });

    assert.equal(run.exitCode(), 0);
    assert.match(run.stdout(), /1 MCP server needs authentication/);
    assert.match(run.stdout(), /Authenticating "remote"/);
    assert.match(run.stdout(), /Authenticated "remote" \(revision 1\)/);
    assert.equal(run.stderr(), "");
    assert.equal(await readFile(box.userFile, "utf8"), before);

    const document = await readCredentials({
      stateDir: box.stateDir,
      sealer: plainSealer,
    });
    assert.equal(document.servers["remote"]?.issuer, server.issuer);
    assert.equal(document.servers["remote"]?.revision, 1);
    assert.equal(
      document.servers["remote"]?.client.clientId,
      "dynamic-client-1",
    );

    // A credential that has not expired is not re-authenticated, and the
    // registered client id is not registered again.
    const second = capture(box);
    await runMcpAuth(second.deps, {
      sealer: plainSealer,
      openBrowser: followRedirect,
      fetch: globalThis.fetch,
      now: () => AUTH_CLOCK_MS,
      callbackPortStart: 0,
    });
    assert.equal(second.exitCode(), 0);
    assert.match(second.stdout(), /No MCP servers require authentication/);
    assert.equal(server.registrations.length, 1);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a failed flow exits 1 and names the server", async (t) => {
  const server = await startAuthorizationServer({ dynamicRegistration: false });
  const box = await sandbox();
  t.after(() => server.close());
  try {
    const add = capture(box);
    await runMcpAdd("remote", [server.resource], { type: "http" }, add.deps);

    const run = capture(box);
    await runMcpAuth(run.deps, {
      sealer: plainSealer,
      openBrowser: followRedirect,
      fetch: globalThis.fetch,
      now: () => AUTH_CLOCK_MS,
      callbackPortStart: 0,
    });

    assert.equal(run.exitCode(), 1);
    assert.match(run.stdout(), /Authenticating "remote"/);
    assert.match(
      run.stderr(),
      /MCP server "remote" cannot be authenticated: .*registration/,
    );
    const document = await readCredentials({
      stateDir: box.stateDir,
      sealer: plainSealer,
    });
    assert.deepEqual(document.servers, {});
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("auth without the native helper refuses instead of writing plaintext", async () => {
  const box = await sandbox();
  try {
    const add = capture(box);
    await runMcpAdd(
      "remote",
      ["https://example.test/mcp"],
      { type: "http" },
      add.deps,
    );
    const run = capture(box);
    await runMcpAuth(run.deps, {
      nativeHelperPath: "",
      openBrowser: followRedirect,
      fetch: globalThis.fetch,
    });
    assert.equal(run.exitCode(), 1);
    assert.match(run.stderr(), /cannot seal MCP OAuth credentials on/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

const PERMISSIONS_DOCUMENT = `${JSON.stringify(
  {
    mcpServers: {},
    persistentPermissions: {
      servers: {
        linear: {
          approvedAt: "2026-01-01T00:00:00.000Z",
          impactLevel: "medium",
        },
      },
      tools: {
        linear: {
          list_issues: {
            approvedAt: "2026-01-02T00:00:00.000Z",
            impactLevel: "low",
          },
        },
      },
    },
  },
  null,
  2,
)}\n`;

async function writePermissions(box: Sandbox): Promise<void> {
  await writeFile(box.userFile, PERMISSIONS_DOCUMENT);
}

test("permissions list renders servers and tools", async () => {
  const box = await sandbox();
  try {
    await writePermissions(box);
    const run = capture(box);
    await runMcpPermissionsList(run.deps);
    assert.equal(run.exitCode(), 0);
    assert.match(run.stdout(), /MCP persistent permissions/);
    assert.match(run.stdout(), /server linear/);
    assert.match(run.stdout(), /tool\s+linear\/list_issues/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("permissions list is empty for a missing file", async () => {
  const box = await sandbox();
  try {
    const run = capture(box);
    await runMcpPermissionsList(run.deps);
    assert.equal(run.exitCode(), 0);
    assert.match(run.stdout(), /No persistent MCP permissions configured/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("permissions revoke removes a tool, then a server", async () => {
  const box = await sandbox();
  try {
    await writePermissions(box);
    const tool = capture(box);
    await runMcpPermissionsRevoke("linear", "list_issues", tool.deps);
    assert.equal(tool.exitCode(), 0);
    assert.match(tool.stdout(), /linear___list_issues/);

    const server = capture(box);
    await runMcpPermissionsRevoke("linear", undefined, server.deps);
    assert.equal(server.exitCode(), 0);
    assert.match(server.stdout(), /Revoked all permissions for server: linear/);

    const after = capture(box);
    await runMcpPermissionsList(after.deps);
    assert.match(after.stdout(), /No persistent MCP permissions configured/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("permissions revoke refuses unknown entries", async () => {
  const box = await sandbox();
  try {
    await writePermissions(box);
    const before = await readFile(box.userFile, "utf8");
    const run = capture(box);
    await runMcpPermissionsRevoke("nope", undefined, run.deps);
    assert.equal(run.exitCode(), 1);
    assert.match(run.stderr(), /no persistent permissions/);
    assert.equal(await readFile(box.userFile, "utf8"), before);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("permissions clear requires --confirm and then clears", async () => {
  const box = await sandbox();
  try {
    await writePermissions(box);
    const refused = capture(box);
    await runMcpPermissionsClear(false, refused.deps);
    assert.equal(refused.exitCode(), 1);
    assert.match(refused.stderr(), /clear 2 persistent permission\(s\)/);
    assert.match(refused.stderr(), /--confirm/);
    assert.match(await readFile(box.userFile, "utf8"), /persistentPermissions/);

    const cleared = capture(box);
    await runMcpPermissionsClear(true, cleared.deps);
    assert.equal(cleared.exitCode(), 0);
    assert.match(cleared.stdout(), /Cleared 2 persistent permission\(s\)/);
    assert.doesNotMatch(
      await readFile(box.userFile, "utf8"),
      /persistentPermissions/,
    );

    const again = capture(box);
    await runMcpPermissionsClear(true, again.deps);
    assert.equal(again.exitCode(), 0);
    assert.match(again.stdout(), /No persistent MCP permissions to clear/);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("an invalid settings shape makes every permissions command fail", async () => {
  const box = await sandbox();
  try {
    const source =
      '{\n  "mcpServers": {},\n  "persistentPermissions": "nope"\n}\n';
    await writeFile(box.userFile, source);
    const list = capture(box);
    await runMcpPermissionsList(list.deps);
    assert.equal(list.exitCode(), 1);
    assert.match(list.stderr(), /persistentPermissions/);
    assert.equal(await readFile(box.userFile, "utf8"), source);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});
