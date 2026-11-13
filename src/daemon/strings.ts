/**
 * The daemon's user-facing messages, keyed by the recovered `commands:daemon.*`
 * i18n keys. Contract: `specs/70-daemon-and-remote-control.md` B5.
 *
 * The recovered catalogues (`src/i18n/locales/<locale>/commands.json`) are not
 * in the tree, so the English text here is this build's copy: the spec pins it
 * next to each key. Rendering goes through a key and a template, never through
 * a sentence assembled beside the catalogue, so a locale is a drop-in
 * replacement of the whole record.
 */

/** Every line the readiness banner can print, in the order B5 pins them. */
export const DAEMON_MESSAGES = {
  "commands:daemon.running": "Daemon running",
  "commands:daemon.version": "Version: {{version}}",
  "commands:daemon.pid": "PID: {{pid}}",
  "commands:daemon.logs": "Logs: {{path}}",
  "commands:daemon.logsNotConfigured": "(not configured)",
  "commands:daemon.wsEndpoint": "WebSocket endpoint: ws://{{host}}:{{port}}",
  "commands:daemon.unixSocket": "Unix socket: {{path}}",
  "commands:daemon.ipcTransport": "IPC transport: parent process",
  "commands:daemon.noTransport":
    "No inbound transport: the daemon is reachable only through Remote Control",
  "commands:daemon.remoteControl": "Remote Control: enabled",
  "commands:daemon.pressCtrlCToStop": "Press Ctrl+C to stop",
} as const;

export type DaemonMessageKey = keyof typeof DAEMON_MESSAGES;

/** A complete catalogue; pass another locale's record to render in it. */
export type DaemonMessageCatalogue = Readonly<Record<DaemonMessageKey, string>>;

export type DaemonMessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Render one catalogue entry. Every `{{name}}` must be supplied: a missing
 * parameter is a programming error, not a blank line on startup.
 */
export function daemonMessage(
  catalogue: DaemonMessageCatalogue,
  key: DaemonMessageKey,
  params: DaemonMessageParams = {},
): string {
  return catalogue[key].replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`daemon message ${key} needs a ${name} parameter`);
    }
    return String(value);
  });
}
