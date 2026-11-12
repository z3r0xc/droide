import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { runUpdateCommand } from "../../../src/cli/update-commands.ts";
import {
  archiveAssetName,
  installRelease,
  UpdateInstallError,
  UPDATE_LOCK_STALE_MS,
  type InstallReleaseOptions,
  type InstallReleaseResult,
  type InstallProbe,
  type InstallProbeResult,
  type ReleaseDocument,
  type UpdateInstallErrorCode,
} from "../../../src/update/install.ts";

// ---------------------------------------------------------------------------
// Fixtures: a tar.gz built with Node's own APIs, a loopback server, temp dirs
// ---------------------------------------------------------------------------

interface TarFile {
  readonly path: string;
  readonly content: string;
}

function writeString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  buffer.write(value, offset, length, "utf8");
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function buildTarFile(file: TarFile): Buffer {
  const data = Buffer.from(file.content, "utf8");
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, file.path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.byteLength);
  writeOctal(header, 136, 12, 0);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;

  const padding = Buffer.alloc((512 - (data.byteLength % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function buildTar(files: readonly TarFile[]): Buffer {
  const blocks = files.map(buildTarFile);
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Route {
  readonly status?: number;
  readonly body?: string | Buffer;
  readonly contentType?: string;
  /** Declare more bytes than are sent, then drop the connection. */
  readonly truncate?: boolean;
}

interface FakeServer {
  readonly baseUrl: string;
  readonly requests: readonly string[];
  readonly close: () => Promise<void>;
}

async function startServer(
  routes: Readonly<Record<string, Route>>,
): Promise<FakeServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    requests.push(path);
    const route = routes[path];
    if (route === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    const body = route.body ?? "";
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    if (route.truncate === true) {
      response.writeHead(200, {
        "content-length": String(buffer.byteLength + 100),
        "content-type": route.contentType ?? "application/octet-stream",
        connection: "close",
      });
      response.write(buffer.subarray(0, Math.max(1, buffer.byteLength - 10)));
      response.end();
      return;
    }
    response.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "application/octet-stream",
      "content-length": String(buffer.byteLength),
    });
    response.end(buffer);
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake release server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

async function makeTempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "droide-update-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function makeInstallDir(
  t: { after: (fn: () => Promise<void>) => void },
  files: Readonly<Record<string, string>>,
): Promise<{ readonly root: string; readonly installDir: string }> {
  const root = await makeTempDir(t);
  const installDir = join(root, "install");
  await mkdir(installDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(installDir, name), content);
  }
  return { root, installDir };
}

const ARCHIVE_NAME = archiveAssetName("1.2.0", "linux", "x64");
const ARCHIVE = gzipSync(
  buildTar([
    { path: "droide", content: "new binary\n" },
    { path: "version.txt", content: "1.2.0\n" },
    { path: "NOTES.md", content: "release notes\n" },
  ]),
);

function releaseDocument(baseUrl: string): ReleaseDocument {
  return {
    tag: "v1.2.0",
    pageUrl: null,
    assets: [
      { name: "sha256", url: `${baseUrl}/sha256` },
      { name: ARCHIVE_NAME, url: `${baseUrl}/${ARCHIVE_NAME}` },
    ],
  };
}

function installOptions(
  installDir: string,
  release: ReleaseDocument,
  probe: InstallProbe,
): InstallReleaseOptions {
  return {
    release,
    fetch,
    installDir,
    platform: "linux",
    arch: "x64",
    clock: () => Date.now(),
    probe,
  };
}

const passingProbe: InstallProbe = async () => ({ status: "passed" });

async function expectInstallError(
  promise: Promise<unknown>,
  code: UpdateInstallErrorCode,
  pattern?: RegExp,
): Promise<UpdateInstallError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof UpdateInstallError,
      `expected UpdateInstallError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected a ${code} refusal`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Install: the happy path
// ---------------------------------------------------------------------------

test("a verified release is staged, swapped in and probed", async (t) => {
  const { installDir } = await makeInstallDir(t, {
    droide: "old binary\n",
    "version.txt": "0.9.0\n",
  });
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  const probeInputs: Parameters<InstallProbe>[0][] = [];
  const result = await installRelease(
    installOptions(
      installDir,
      releaseDocument(server.baseUrl),
      async (input) => {
        probeInputs.push(input);
        return { status: "passed" };
      },
    ),
  );

  assert.equal(result.version, "1.2.0");
  assert.equal(result.probe, "passed");
  assert.equal(result.archive, ARCHIVE_NAME);
  assert.equal(
    await readFile(join(installDir, "droide"), "utf8"),
    "new binary\n",
  );
  assert.equal(
    await readFile(join(installDir, "version.txt"), "utf8"),
    "1.2.0\n",
  );
  assert.equal(
    await readFile(join(installDir, "NOTES.md"), "utf8"),
    "release notes\n",
  );
  // The swap moved the previous entries aside; the rollback copy stays.
  assert.equal(
    await readFile(join(installDir, ".old-1.2.0", "droide"), "utf8"),
    "old binary\n",
  );
  assert.deepEqual(await readdir(join(installDir, "update")), []);
  assert.equal(probeInputs.length, 1);
  assert.equal(probeInputs[0]?.version, "1.2.0");
  assert.equal(probeInputs[0]?.executable, join(installDir, "droide"));
});

test("the digest is read from the release, not inferred from the download", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${"0".repeat(64)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "checksum-mismatch",
    /does not match its published sha256/,
  );
  assert.equal(await pathExists(join(installDir, "droide")), false);
  assert.deepEqual(await readdir(join(installDir, "update")), []);
});

test("a truncated download is refused and leaves nothing behind", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE, truncate: true },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "truncated-download",
    /stopped after \d+ bytes/,
  );
  assert.deepEqual(await readdir(join(installDir, "update")), []);
});

// ---------------------------------------------------------------------------
// Install: asset refusals
// ---------------------------------------------------------------------------

test("a release without a sha256 asset is not installable", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const release: ReleaseDocument = {
    tag: "v1.2.0",
    pageUrl: null,
    assets: [{ name: ARCHIVE_NAME, url: "http://127.0.0.1:1/never" }],
  };
  await expectInstallError(
    installRelease(installOptions(installDir, release, passingProbe)),
    "missing-sha256-asset",
    /no sha256 asset/,
  );
});

test("a release without an archive for this platform is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const release: ReleaseDocument = {
    tag: "v1.2.0",
    pageUrl: null,
    assets: [{ name: "sha256", url: "http://127.0.0.1:1/never" }],
  };
  await expectInstallError(
    installRelease(installOptions(installDir, release, passingProbe)),
    "missing-platform-asset",
    /no linux-x64 archive/,
  );
});

test("an archive published for another version is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const foreign = archiveAssetName("1.3.0", "linux", "x64");
  const release: ReleaseDocument = {
    tag: "v1.2.0",
    pageUrl: null,
    assets: [
      { name: "sha256", url: "http://127.0.0.1:1/never" },
      { name: foreign, url: "http://127.0.0.1:1/never" },
    ],
  };
  await expectInstallError(
    installRelease(installOptions(installDir, release, passingProbe)),
    "version-mismatch",
    /for version 1\.3\.0/,
  );
});

test("a release tag that is not a semantic version is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  await expectInstallError(
    installRelease(
      installOptions(
        installDir,
        { tag: "nightly", pageUrl: null, assets: [] },
        passingProbe,
      ),
    ),
    "invalid-release",
    /not a semantic version/,
  );
});

test("a digest asset the release claims but does not serve is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { status: 404, body: "missing" },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "download-failed",
    /sha256.*answered 404/,
  );
});

test("an archive whose download fails is refused with the status", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { status: 500, body: "boom" },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "download-failed",
    /answered 500/,
  );
});

test("an asset name with a path separator is refused before writing", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const release: ReleaseDocument = {
    tag: "v1.2.0",
    pageUrl: null,
    assets: [
      { name: "sha256", url: "http://127.0.0.1:1/never" },
      { name: `../${ARCHIVE_NAME}`, url: "http://127.0.0.1:1/never" },
    ],
  };
  await expectInstallError(
    installRelease(installOptions(installDir, release, passingProbe)),
    "unsafe-archive",
    /not a plain file name/,
  );
});

test("a digest document that omits the archive is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  something-else.tar.gz\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "missing-digest-entry",
    new RegExp(ARCHIVE_NAME.replace(/\./g, "\\.")),
  );
});

test("an archive that escapes the installation directory is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const hostile = gzipSync(
    buildTar([{ path: "../evil", content: "escaped\n" }]),
  );
  const server = await startServer({
    "/sha256": { body: `${sha256(hostile)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: hostile },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "unsafe-archive",
    /escapes the installation directory/,
  );
  assert.equal(await pathExists(join(installDir, "..", "evil")), false);
});

// ---------------------------------------------------------------------------
// Install: swap, rollback, lock and permissions
// ---------------------------------------------------------------------------

test("a failing probe restores the previous installation", async (t) => {
  const { installDir } = await makeInstallDir(t, {
    droide: "old binary\n",
    "version.txt": "0.9.0\n",
  });
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  const failingProbe: InstallProbe = async (): Promise<InstallProbeResult> => ({
    status: "failed",
    detail: "--version exited with 1",
  });
  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), failingProbe),
    ),
    "probe-failed",
    /previous installation was restored/,
  );

  assert.equal(
    await readFile(join(installDir, "droide"), "utf8"),
    "old binary\n",
  );
  assert.equal(
    await readFile(join(installDir, "version.txt"), "utf8"),
    "0.9.0\n",
  );
  assert.equal(await pathExists(join(installDir, "NOTES.md")), false);
  assert.equal(await pathExists(join(installDir, ".old-1.2.0")), false);
  assert.deepEqual(await readdir(join(installDir, "update")), []);
});

test("a probe that throws rolls the installation back", async (t) => {
  const { installDir } = await makeInstallDir(t, { droide: "old binary\n" });
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  const throwingProbe: InstallProbe = async () => {
    throw new Error("spawn EACCES");
  };
  await expectInstallError(
    installRelease(
      installOptions(
        installDir,
        releaseDocument(server.baseUrl),
        throwingProbe,
      ),
    ),
    "probe-failed",
    /the probe threw: spawn EACCES.*restored/,
  );
  assert.equal(
    await readFile(join(installDir, "droide"), "utf8"),
    "old binary\n",
  );
});

test("a fresh lock refuses a concurrent install without touching anything", async (t) => {
  const { installDir } = await makeInstallDir(t, { droide: "old binary\n" });
  const updateDir = join(installDir, "update");
  await mkdir(updateDir, { recursive: true });
  await writeFile(join(updateDir, ".lock"), "held\n");

  let fetched = 0;
  const options: InstallReleaseOptions = {
    release: releaseDocument("http://127.0.0.1:1"),
    fetch: (async () => {
      fetched += 1;
      return new Response("", { status: 500 });
    }) as typeof fetch,
    installDir,
    platform: "linux",
    arch: "x64",
    clock: () => Date.now(),
    probe: passingProbe,
  };
  await expectInstallError(
    installRelease(options),
    "locked",
    /another update is already running/,
  );
  assert.equal(fetched, 0);
  assert.equal(await readFile(join(updateDir, ".lock"), "utf8"), "held\n");
  assert.equal(
    await readFile(join(installDir, "droide"), "utf8"),
    "old binary\n",
  );
});

test("a stale lock is reclaimed", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const updateDir = join(installDir, "update");
  await mkdir(updateDir, { recursive: true });
  const lockPath = join(updateDir, ".lock");
  await writeFile(lockPath, "abandoned\n");
  const old = new Date(Date.now() - UPDATE_LOCK_STALE_MS - 60_000);
  await utimes(lockPath, old, old);

  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);

  const result: InstallReleaseResult = await installRelease(
    installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
  );
  assert.equal(result.version, "1.2.0");
  assert.deepEqual(await readdir(updateDir), []);
});

test("a non-writable installation directory is refused with the exact path", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  // A regular file where the staging directory must go: no elevation, no
  // silence, a refusal naming the installation directory.
  await writeFile(join(installDir, "update"), "not a directory\n");

  await expectInstallError(
    installRelease(
      installOptions(
        installDir,
        releaseDocument("http://127.0.0.1:1"),
        passingProbe,
      ),
    ),
    "not-writable",
    new RegExp(
      `cannot write to the installation directory ${installDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`,
    ),
  );
});

test("a missing installation directory is refused before any download", async (t) => {
  const root = await makeTempDir(t);
  let fetched = 0;
  await expectInstallError(
    installRelease({
      release: releaseDocument("http://127.0.0.1:1"),
      fetch: (async () => {
        fetched += 1;
        return new Response("", { status: 500 });
      }) as typeof fetch,
      installDir: join(root, "missing"),
      platform: "linux",
      arch: "x64",
      probe: passingProbe,
    }),
    "not-installed",
    /no installation directory/,
  );
  assert.equal(fetched, 0);
});

test("an empty archive is refused as corrupt", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const empty = gzipSync(Buffer.alloc(1024));
  const server = await startServer({
    "/sha256": { body: `${sha256(empty)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: empty },
  });
  t.after(server.close);

  await expectInstallError(
    installRelease(
      installOptions(installDir, releaseDocument(server.baseUrl), passingProbe),
    ),
    "corrupt-archive",
    /contains no files/,
  );
});

// ---------------------------------------------------------------------------
// CLI: install path and exit codes
// ---------------------------------------------------------------------------

interface CommandCapture {
  readonly deps: Parameters<typeof runUpdateCommand>[1];
  read(): { readonly out: string; readonly err: string; readonly code: number };
}

function commandDeps(
  installDir: string,
  feed: Record<string, unknown>,
  probe: InstallProbe,
): CommandCapture {
  let out = "";
  let err = "";
  let code = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.hostname === "api.github.com") {
      return new Response(JSON.stringify(feed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(url.hostname, "127.0.0.1");
    return fetch(input, init);
  };
  return {
    deps: {
      currentVersion: "0.3.0",
      repository: "owner/repo",
      fetch: fetchImpl,
      installDir,
      platform: "linux",
      arch: "x64",
      clock: () => Date.now(),
      probe,
      write: (text) => {
        out += text;
      },
      writeError: (text) => {
        err += text;
      },
      setExitCode: (value) => {
        code = value;
      },
    },
    read: () => ({ out, err, code }),
  };
}

function feedDocument(baseUrl: string): Record<string, unknown> {
  return {
    tag_name: "v1.2.0",
    html_url: "https://example.test/r/1.2.0",
    assets: [
      {
        name: "sha256",
        browser_download_url: `${baseUrl}/sha256`,
      },
      {
        name: ARCHIVE_NAME,
        browser_download_url: `${baseUrl}/${ARCHIVE_NAME}`,
      },
    ],
  };
}

test("update without --check installs the release the feed offers", async (t) => {
  const { installDir } = await makeInstallDir(t, { droide: "old binary\n" });
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);
  const { deps, read } = commandDeps(
    installDir,
    feedDocument(server.baseUrl),
    passingProbe,
  );

  await runUpdateCommand({}, deps);

  assert.equal(read().code, 0);
  assert.match(read().out, /installed droide 1\.2\.0/);
  assert.equal(
    await readFile(join(installDir, "droide"), "utf8"),
    "new binary\n",
  );
});

test("update --version installs that version", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);
  const { deps, read } = commandDeps(
    installDir,
    feedDocument(server.baseUrl),
    passingProbe,
  );

  await runUpdateCommand({ version: "1.2.0" }, deps);

  assert.equal(read().code, 0);
  assert.match(read().out, /installed droide 1\.2\.0/);
});

test("an invalid --version exits 1 before any request", async () => {
  const { deps, read } = commandDeps(
    join(tmpdir(), "droide-never-installed"),
    {},
    passingProbe,
  );
  await runUpdateCommand({ version: "latest" }, deps);
  assert.equal(read().code, 1);
  assert.match(read().err, /invalid --version "latest"/);
  assert.equal(read().out, "");
});

test("an install failure exits 1 with the installer's message", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${"1".repeat(64)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);
  const { deps, read } = commandDeps(
    installDir,
    feedDocument(server.baseUrl),
    passingProbe,
  );

  await runUpdateCommand({}, deps);

  assert.equal(read().code, 1);
  assert.match(read().err, /does not match its published sha256/);
  assert.equal(await pathExists(join(installDir, "droide")), false);
});

test("a feed without a release exits 1", async () => {
  let err = "";
  let code = 0;
  await runUpdateCommand(
    {},
    {
      currentVersion: "0.3.0",
      repository: "owner/repo",
      fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
      installDir: join(tmpdir(), "droide-never-installed"),
      write: () => undefined,
      writeError: (text) => {
        err += text;
      },
      setExitCode: (value) => {
        code = value;
      },
    },
  );
  assert.equal(code, 1);
  assert.match(err, /no release/);
});

test("install without a known installation directory refuses", async () => {
  let err = "";
  let code = 0;
  await runUpdateCommand(
    {},
    {
      currentVersion: "0.3.0",
      repository: "owner/repo",
      fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
      write: () => undefined,
      writeError: (text) => {
        err += text;
      },
      setExitCode: (value) => {
        code = value;
      },
    },
  );
  assert.equal(code, 1);
  assert.match(err, /installation directory/);
});

test("an already-current release reports up to date and installs nothing", async () => {
  const captured = commandDeps("/nonexistent/install", {}, passingProbe);
  const deps = captured.deps;
  const feed = {
    tag_name: "v0.3.0",
    html_url: "https://example.test/r/0.3.0",
    assets: [],
  };
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(feed), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  await runUpdateCommand({}, { ...deps, fetch: fetchImpl });
  assert.equal(captured.read().code, 0);
  assert.match(captured.read().out, /is up to date/);
});

test("the feed answering with another version than --version is refused", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const { deps, read } = commandDeps(
    installDir,
    { tag_name: "v1.3.0", html_url: null, assets: [] },
    passingProbe,
  );
  await runUpdateCommand({ version: "1.2.0" }, deps);
  assert.equal(read().code, 1);
  assert.match(read().err, /answered with release v1\.3\.0, not 1\.2\.0/);
});

test("a probe that is skipped is reported", async (t) => {
  const { installDir } = await makeInstallDir(t, {});
  const server = await startServer({
    "/sha256": { body: `${sha256(ARCHIVE)}  ${ARCHIVE_NAME}\n` },
    [`/${ARCHIVE_NAME}`]: { body: ARCHIVE },
  });
  t.after(server.close);
  const { deps, read } = commandDeps(
    installDir,
    feedDocument(server.baseUrl),
    async () => ({ status: "skipped", reason: "no executable to probe" }),
  );

  await runUpdateCommand({}, deps);

  assert.equal(read().code, 0);
  assert.match(read().out, /could not be probed \(no executable to probe\)/);
});
