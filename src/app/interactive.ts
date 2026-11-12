/**
 * The interactive entry point (spec B1, B15, B16, B18).
 *
 * `runInteractiveShell` detects the terminal's capabilities from the injected
 * context, enters the terminal according to that plan, mounts the existing shell
 * (`src/ui/render.ts`) and owns every keypress while it is mounted. It resolves
 * with the process exit code: `0` for `/quit`, `130` for the `Ctrl+C` exit.
 *
 * There is no agent loop here yet: a submitted line becomes a transcript row and
 * the composer clears. Every path out — quit, interrupt, a rejected mount, a
 * thrown reducer — removes its listeners, clears its timers, unmounts the Ink
 * tree and runs the terminal teardown exactly once.
 */

import { StringDecoder } from "node:string_decoder";

import { DEFAULT_MODEL_ID } from "../cli/models.ts";
import { VERSION } from "../cli/brand.ts";
import type { AppContext } from "./context.ts";
import { detectCapabilities, type Capabilities } from "../ui/capabilities.ts";
import type { ShellProps } from "../ui/components/Shell.ts";
import type { HeaderStatus } from "../ui/components/Header.ts";
import {
  advanceComposer,
  applyComposerAction,
  initialComposerState,
  type ComposerState,
  type ComposerTransition,
} from "../ui/input.ts";
import {
  createKeyState,
  resolveInput,
  type KeyAction,
  type KeyState,
} from "../ui/keys.ts";
import { renderShell, type ShellHandle } from "../ui/render.ts";
import {
  planTerminal,
  setupTerminal,
  type SignalSource,
  type TerminalSession,
} from "../ui/setup.ts";
import {
  HEADER_SHORTCUTS,
  HEADER_STATUS_LABELS,
  MODE_ROW_AUTONOMY_OFF,
  STARTUP_PLACEHOLDER,
} from "../ui/strings.ts";
import type { TranscriptEntry } from "../ui/transcript.ts";

/** The exit code for the `Ctrl+C` exit; `/quit` exits 0. */
export const INTERRUPT_EXIT_CODE = 130;

/** Injectable timers, so a test never waits and never leaves one scheduled. */
export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

export interface InteractiveShellOptions {
  readonly context: AppContext;
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly columns?: number;
  readonly rows?: number;
  /** Ink debug mode: append frames instead of repainting (test capture). */
  readonly debug?: boolean;
  /** Defaults to `Date.now`; every window is measured against it. */
  readonly clock?: () => number;
  readonly timers?: TimerApi;
  readonly signals?: SignalSource;
  readonly installSafetyNet?: boolean;
  readonly version?: string;
  readonly model?: string;
}

/** Raised when the surface is asked for on streams that are not a TTY (B18). */
export class InteractiveUnavailableError extends Error {
  constructor() {
    super("interactive mode requires a TTY on both stdin and stdout");
    this.name = "InteractiveUnavailableError";
  }
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/** The composer's inner width: the frame's borders and padding. */
function composerWidth(width: number): number {
  return Math.max(1, width - 4);
}

function statuses(): readonly HeaderStatus[] {
  return [
    { label: HEADER_STATUS_LABELS.skills, count: 0, ok: false },
    { label: HEADER_STATUS_LABELS.mcps, count: 0, ok: false },
    { label: HEADER_STATUS_LABELS.connectors, count: 0, ok: false },
    { label: HEADER_STATUS_LABELS.agentsMd, count: undefined, ok: false },
  ];
}

function cursorLineOf(state: ComposerState): number {
  let line = 0;
  for (
    let index = 0;
    index < state.cursor && index < state.draft.length;
    index += 1
  ) {
    if (state.draft.charAt(index) === "\n") line += 1;
  }
  return line;
}

interface MountedSession {
  readonly handle: ShellHandle;
  readonly terminal: TerminalSession;
  readonly capabilities: Capabilities;
}

async function mountSession(
  capabilities: Capabilities,
  options: InteractiveShellOptions,
  size: { readonly columns: number; readonly rows: number },
  props: ShellProps,
): Promise<MountedSession> {
  const terminal = setupTerminal({
    stdin: options.stdin,
    stdout: options.stdout,
    plan: planTerminal(capabilities, {
      stdinIsTTY: options.stdin.isTTY === true,
      stdoutIsTTY: options.stdout.isTTY === true,
      tmux:
        options.context.environment.env.TMUX !== undefined ||
        options.context.environment.env.STY !== undefined,
    }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    ...(options.installSafetyNet === undefined
      ? {}
      : { installSafetyNet: options.installSafetyNet }),
  });
  try {
    const handle = await renderShell(props, {
      stdout: options.stdout,
      stdin: options.stdin,
      columns: size.columns,
      rows: size.rows,
      debug: options.debug ?? false,
      interactive: capabilities.interactive,
    });
    return { handle, terminal, capabilities };
  } catch (error) {
    terminal.teardown();
    throw error;
  }
}

/**
 * Run the interactive shell until it quits.
 *
 * @returns the exit code — `0` for `/quit`, `130` for `Ctrl+C`.
 */
export async function runInteractiveShell(
  options: InteractiveShellOptions,
): Promise<number> {
  const env = options.context.environment;
  const columns = options.columns ?? options.stdout.columns ?? DEFAULT_COLUMNS;
  const rows = options.rows ?? options.stdout.rows ?? DEFAULT_ROWS;
  const capabilities = detectCapabilities({
    env: env.env,
    platform: env.platform,
    stdinIsTTY: options.stdin.isTTY === true,
    stdoutIsTTY: options.stdout.isTTY === true,
  });
  if (!capabilities.interactive) throw new InteractiveUnavailableError();

  const clock = options.clock ?? (() => Date.now());
  const timers = options.timers ?? systemTimers;

  let transcript: TranscriptEntry[] = [];
  let composer = initialComposerState({
    tmux: env.env.TMUX !== undefined || env.env.STY !== undefined,
  });
  let keyState: KeyState = createKeyState({
    tmux: composer.tmux,
    draftLength: 0,
  });
  let width = columns;
  let height = rows;

  const buildProps = (): ShellProps => ({
    capabilities,
    width,
    height,
    header: {
      version: options.version ?? VERSION,
      tip: STARTUP_PLACEHOLDER,
      statuses: statuses(),
      shortcuts: HEADER_SHORTCUTS,
    },
    transcript,
    composer: {
      draft: composer.draft,
      placeholder: STARTUP_PLACEHOLDER,
      focused: true,
      cursorLine: cursorLineOf(composer),
      ...(composer.completion.open
        ? { hint: composer.completion.items[composer.completion.selected] }
        : {}),
    },
    modeRow: {
      autonomy: MODE_ROW_AUTONOMY_OFF,
      model:
        options.model ??
        options.context.settings.droidCoreModel ??
        DEFAULT_MODEL_ID,
    },
    footer: {},
  });

  const mounted = await mountSession(
    capabilities,
    options,
    { columns, rows },
    buildProps(),
  );

  const result = Promise.withResolvers<number>();
  let settled = false;
  let paintChain: Promise<void> = Promise.resolve();
  let pendingKeyTimer: unknown;
  let deferredTimer: unknown;
  let keyStatePending: Extract<KeyAction, { kind: "pending" }> | undefined;
  const decoder = new StringDecoder("utf8");

  const clearTimer = (handle: unknown): void => {
    if (handle !== undefined) timers.clearTimeout(handle);
  };

  const paint = (): Promise<void> => {
    paintChain = paintChain.then(() =>
      mounted.handle.rerender(buildProps(), { columns: width, rows: height }),
    );
    return paintChain;
  };

  const close = async (code: number): Promise<void> => {
    if (settled) return;
    settled = true;
    options.stdin.off("data", onData);
    options.stdout.off("resize", onResize);
    clearTimer(pendingKeyTimer);
    clearTimer(deferredTimer);
    pendingKeyTimer = undefined;
    deferredTimer = undefined;
    try {
      await paintChain;
      await mounted.handle.unmount();
    } catch (error) {
      result.reject(error);
      return;
    } finally {
      mounted.terminal.teardown();
    }
    result.resolve(code);
  };

  const schedulePendingKey = (): void => {
    clearTimer(pendingKeyTimer);
    const action = keyStatePending;
    if (action === undefined || action.deadlineMs === 0) {
      pendingKeyTimer = undefined;
      return;
    }
    pendingKeyTimer = timers.setTimeout(
      () => {
        pendingKeyTimer = undefined;
        handleInput("", true);
      },
      Math.max(0, action.deadlineMs - clock()),
    );
  };

  const scheduleDeferred = (atMs: number | undefined): void => {
    clearTimer(deferredTimer);
    deferredTimer = undefined;
    if (atMs === undefined) return;
    deferredTimer = timers.setTimeout(
      () => {
        deferredTimer = undefined;
        const transition = advanceComposer(composer, clock());
        applyTransition(transition);
      },
      Math.max(0, atMs - clock()),
    );
  };

  const requestExit = (code: number): void => {
    close(code).catch((error: unknown) => result.reject(error));
  };

  const applyTransition = (transition: ComposerTransition): void => {
    composer = transition.state;
    keyState = {
      ...keyState,
      draftLength: composer.draft.length,
      suggestionsOpen: composer.completion.open,
    };
    if (transition.submitted !== undefined) {
      transcript = [
        ...transcript,
        { kind: "user", text: transition.submitted },
      ];
    }
    if (transition.notice !== undefined) {
      // The ephemeral system-message renderer is a later slice; until then the
      // notice is a transcript row so it is visible, never silent.
      transcript = [
        ...transcript,
        { kind: "assistant", text: transition.notice },
      ];
    }
    if (transition.exit === "quit") {
      requestExit(0);
      return;
    }
    if (transition.exit === "interrupt") {
      requestExit(INTERRUPT_EXIT_CODE);
      return;
    }
    scheduleDeferred(
      transition.deferredSubmitAtMs ?? composer.deferredSubmitAtMs,
    );
  };

  const handleActions = (actions: readonly KeyAction[], now: number): void => {
    keyStatePending = actions.find(
      (action): action is Extract<KeyAction, { kind: "pending" }> =>
        action.kind === "pending",
    );
    let dirty = false;
    for (const action of actions) {
      if (action.kind === "pending") continue;
      if (action.kind === "ignore" || action.kind === "app") continue;
      const transition = applyComposerAction(
        composer,
        action,
        now,
        composerWidth(width),
      );
      const changed =
        transition.state !== composer || transition.submitted !== undefined;
      applyTransition(transition);
      dirty = dirty || changed;
    }
    schedulePendingKey();
    if (dirty) void paint();
  };

  function handleInput(chunk: string, flush: boolean): void {
    if (settled) return;
    const now = clock();
    const resolved = resolveInput(flush ? "" : chunk, keyState, now);
    keyState = resolved.state;
    handleActions(resolved.actions, now);
  }

  function onData(chunk: Buffer | string): void {
    handleInput(
      typeof chunk === "string" ? chunk : decoder.write(chunk),
      false,
    );
  }

  function onResize(): void {
    if (settled) return;
    const nextColumns = options.stdout.columns;
    const nextRows = options.stdout.rows;
    width =
      typeof nextColumns === "number" && nextColumns > 0 ? nextColumns : width;
    height = typeof nextRows === "number" && nextRows > 0 ? nextRows : height;
    if (options.debug === true) return;
    void paint();
  }

  options.stdin.on("data", onData);
  options.stdout.on("resize", onResize);

  return result.promise;
}
