/**
 * The daemon message catalogue and the readiness banner it renders.
 * Contract: `specs/70-daemon-and-remote-control.md` B5.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatReadinessBanner } from "../../../src/daemon/server.ts";
import {
  DAEMON_MESSAGES,
  daemonMessage,
  type DaemonMessageCatalogue,
} from "../../../src/daemon/strings.ts";

const BASE = {
  version: "1.2.3",
  pid: 42,
  logsPath: "/var/log/droide/daemon.log",
  remoteControl: false,
} as const;

/** `BASE` without a log path, since an optional string cannot be `undefined`. */
const { logsPath: _logsPath, ...BASE_WITHOUT_LOGS } = BASE;

/** A catalogue whose values are their own keys: rendering it prints keys only. */
function keyCatalogue(): DaemonMessageCatalogue {
  const entries = Object.keys(DAEMON_MESSAGES).map(
    (key) => [key, key] as const,
  );
  return Object.fromEntries(entries) as DaemonMessageCatalogue;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

test("every catalogue value is non-empty printable ASCII", () => {
  for (const [key, value] of Object.entries(DAEMON_MESSAGES)) {
    assert.ok(key.startsWith("commands:daemon."), `${key} is namespaced`);
    assert.equal(typeof value, "string", `${key} is a string`);
    assert.notEqual(value.length, 0, `${key} is non-empty`);
    assert.match(value, PRINTABLE_ASCII, `${key} is printable ASCII`);
    assert.equal(value, value.trim(), `${key} carries no outer whitespace`);
  }
});

test("the readiness banner prints the documented keys, in order", () => {
  const catalogue = keyCatalogue();
  const cases = [
    {
      endpoint: { kind: "tcp", host: "127.0.0.1", port: 1234 } as const,
      endpointKey: "commands:daemon.wsEndpoint",
    },
    {
      endpoint: { kind: "unix", unixPath: "/tmp/daemon.sock" } as const,
      endpointKey: "commands:daemon.unixSocket",
    },
    {
      endpoint: { kind: "ipc" } as const,
      endpointKey: "commands:daemon.ipcTransport",
    },
    {
      endpoint: { kind: "none" } as const,
      endpointKey: "commands:daemon.noTransport",
    },
  ];
  for (const { endpoint, endpointKey } of cases) {
    assert.deepEqual(
      formatReadinessBanner(endpoint, { ...BASE, catalogue }),
      [
        "commands:daemon.running",
        "commands:daemon.version",
        "commands:daemon.pid",
        "commands:daemon.logs",
        endpointKey,
        "commands:daemon.pressCtrlCToStop",
      ],
      `key order for ${endpoint.kind}`,
    );
  }
  assert.deepEqual(
    formatReadinessBanner(
      { kind: "none" },
      { ...BASE, catalogue, remoteControl: true },
    ).slice(5, 7),
    ["commands:daemon.remoteControl", "commands:daemon.pressCtrlCToStop"],
    "the relay line sits between the endpoint and the Ctrl+C hint",
  );
});

test("the readiness banner renders the pinned English text", () => {
  assert.deepEqual(
    formatReadinessBanner(
      { kind: "tcp", host: "127.0.0.1", port: 1234 },
      { ...BASE, remoteControl: true },
    ),
    [
      "Daemon running",
      "Version: 1.2.3",
      "PID: 42",
      "Logs: /var/log/droide/daemon.log",
      "WebSocket endpoint: ws://127.0.0.1:1234",
      "Remote Control: enabled",
      "Press Ctrl+C to stop",
    ],
  );
  assert.deepEqual(
    formatReadinessBanner(
      { kind: "unix", unixPath: "/tmp/daemon.sock" },
      BASE,
    ).slice(4),
    ["Unix socket: /tmp/daemon.sock", "Press Ctrl+C to stop"],
  );
  assert.deepEqual(
    formatReadinessBanner({ kind: "ipc" }, BASE_WITHOUT_LOGS).slice(3),
    [
      "Logs: (not configured)",
      "IPC transport: parent process",
      "Press Ctrl+C to stop",
    ],
  );
  assert.deepEqual(formatReadinessBanner({ kind: "none" }, BASE).slice(4), [
    "No inbound transport: the daemon is reachable only through Remote Control",
    "Press Ctrl+C to stop",
  ]);
});

test("replacing a catalogue value changes exactly that banner line", () => {
  const endpoint = { kind: "tcp", host: "127.0.0.1", port: 1234 } as const;
  const baseline = formatReadinessBanner(endpoint, BASE);

  const renamed = formatReadinessBanner(endpoint, {
    ...BASE,
    catalogue: {
      ...DAEMON_MESSAGES,
      "commands:daemon.running": "Relay listening",
    },
  });
  assert.deepEqual(renamed, ["Relay listening", ...baseline.slice(1)]);

  const templated = formatReadinessBanner(endpoint, {
    ...BASE,
    catalogue: {
      ...DAEMON_MESSAGES,
      "commands:daemon.version": "Build {{version}}",
    },
  });
  assert.deepEqual(templated, [
    baseline[0],
    "Build 1.2.3",
    ...baseline.slice(2),
  ]);

  const fallback = formatReadinessBanner(endpoint, {
    ...BASE_WITHOUT_LOGS,
    catalogue: {
      ...DAEMON_MESSAGES,
      "commands:daemon.logsNotConfigured": "(stdout only)",
    },
  });
  assert.deepEqual(fallback, [
    ...baseline.slice(0, 3),
    "Logs: (stdout only)",
    ...baseline.slice(4),
  ]);
});

test("a template with an unsupplied parameter is refused", () => {
  assert.throws(
    () => daemonMessage(DAEMON_MESSAGES, "commands:daemon.version"),
    /needs a version parameter/,
  );
});
