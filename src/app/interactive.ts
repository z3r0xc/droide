/**
 * The interactive entry point (spec B1, B15, B16, B18).
 *
 * `runInteractiveShell` detects the terminal's capabilities from the injected
 * context, enters the terminal according to that plan, mounts the existing shell
 * (`src/ui/render.ts`) and owns every keypress while it is mounted. It resolves
 * with the process exit code: `0` for `/quit`, `130` for the `Ctrl+C` exit.
 *
 * A submitted line starts one agent turn through `interactive-turn.ts`: its
 * deltas stream into transcript rows, tool calls and results become rows, an
 * `ask` permission becomes an approval prompt, and Esc aborts the turn. Every
 * path out — quit, interrupt, a rejected mount, a thrown reducer — removes its
 * listeners, clears its timers, aborts the in-flight turn, unmounts the Ink
 * tree and runs the terminal teardown exactly once.
 */

import { StringDecoder } from "node:string_decoder";

import { createLlmProvider } from "../agent/adapters/llm-provider.ts";
import type { Provider } from "../agent/ports.ts";
import { DEFAULT_MODEL_ID } from "../cli/models.ts";
import { VERSION } from "../cli/brand.ts";
import {
  DEFAULT_COMPACTION_LIMIT,
  createExecToolRunner,
  createToolCatalogue,
  selectExecTools,
} from "../exec/runner.ts";
import { resolveModelTarget } from "../exec/command.ts";
import type { AppContext } from "./context.ts";
import {
  createTurnDriver,
  type TurnAgent,
  type TurnDriver,
} from "./interactive-turn.ts";
import { buildStartupPrompt } from "./prompt.ts";
import { createSessionTooling } from "./tooling.ts";
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
import {
  renderShell,
  type ShellHandle,
  type ShellTarget,
} from "../ui/render.ts";
import {
  planTerminal,
  setupTerminal,
  type SignalSource,
  type TerminalSession,
  type TerminationSignal,
} from "../ui/setup.ts";
import {
  HEADER_SHORTCUTS,
  HEADER_STATUS_LABELS,
  MODE_ROW_AUTONOMY_OFF,
  STARTUP_PLACEHOLDER,
  TURN_ALREADY_RUNNING,
} from "../ui/strings.ts";

/** The exit code for the `Ctrl+C` exit; `/quit` exits 0. */
export const INTERRUPT_EXIT_CODE = 130;

/** The exit code when the terminal raises `SIGTERM` (128 + 15). */
export const TERMINATE_EXIT_CODE = 143;

/** How the shell is mounted; tests inject a failing mount. */
export type ShellMounter = (
  props: ShellProps,
  target: ShellTarget,
) => Promise<ShellHandle>;

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
  /** Overrides `renderShell`; only tests use it (to prove the throw path). */
  readonly mount?: ShellMounter;
  /**
   * Model and tool wiring for submitted turns. Production builds it from the
   * context on first use; tests inject a scripted provider and fake tools, so
   * no test reaches a network or a real terminal.
   */
  readonly agent?: () => ShellAgent | Promise<ShellAgent>;
}

/** The agent wiring a shell turn runs against; `close` releases MCP clients. */
export interface ShellAgent extends TurnAgent {
  close?(): Promise<void>;
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
  onSignal: (signal: TerminationSignal) => void,
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
    onSignal,
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    ...(options.installSafetyNet === undefined
      ? {}
      : { installSafetyNet: options.installSafetyNet }),
  });
  try {
    const handle = await (options.mount ?? renderShell)(props, {
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
 * The production wiring: the managed or custom model resolved exactly as exec
 * resolves it, the session registry (core tools plus reachable MCP servers),
 * and exec's own tool runner so the shell applies the same permission algebra
 * and dispatch as the non-interactive path. The autonomy is `off` — every
 * mutating or process call prompts — and MCP is always a prompt.
 */
async function buildShellAgent(
  options: InteractiveShellOptions,
): Promise<ShellAgent> {
  const context = options.context;
  // B55: a missing credential fails here, before any tool server is contacted.
  const target = resolveModelTarget({
    model: options.model,
    reasoningEffort: undefined,
    settings: context.settings,
    env: context.environment.env,
  });
  const tooling = await createSessionTooling({ context });
  try {
    // The interactive session offers the full set; the permission algebra in
    // the runner decides every call (reads run, writes prompt).
    const allowed = selectExecTools(tooling.registry, { autonomy: "low" });
    const catalogue = createToolCatalogue(tooling.registry, allowed);
    const system = await buildStartupPrompt({ context });
    const provider: Provider = createLlmProvider({
      url: target.url,
      headers: target.headers,
      dialect: target.dialect,
      model: target.wireModel,
      system,
      tools: catalogue,
      maxTokens: target.maxTokens,
      operation: target.url.pathname,
    });
    return {
      provider,
      tools: (confirm) =>
        createExecToolRunner({
          registry: tooling.registry,
          root: context.environment.cwd,
          environment: context.environment,
          permission: {
            autonomy: "off",
            interactionMode: "interactive",
            interactive: true,
          },
          allowed,
          confirm,
        }),
      compactionTokenLimit: DEFAULT_COMPACTION_LIMIT,
      close: () => tooling.close(),
    };
  } catch (error) {
    await tooling.close();
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

  let driver: TurnDriver | undefined;
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
    transcript: driver?.entries ?? [],
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
    ...(driver?.statusText === undefined
      ? {}
      : { statusLine: { text: driver.statusText, padding: 1 } }),
  });

  // Signals restore the terminal inside `setupTerminal`; deciding the exit code
  // is this module's job. The hook is installed after `close` exists, and a
  // signal that lands before then is remembered rather than dropped.
  let pendingSignal: TerminationSignal | undefined;
  let handleSignal: ((signal: TerminationSignal) => void) | undefined;
  const mounted = await mountSession(
    capabilities,
    options,
    { columns, rows },
    buildProps(),
    (signal) => {
      if (handleSignal === undefined) pendingSignal = signal;
      else handleSignal(signal);
    },
  );

  // One wiring attempt per session. The promise is created now (so a fast
  // failure is ready by the first submit) but only awaited by a turn, and its
  // rejection is observed here so an idle shell never logs an unhandled one.
  let assembledAgent: ShellAgent | undefined;
  const agentWiring: Promise<ShellAgent> = Promise.resolve()
    .then(() =>
      options.agent === undefined ? buildShellAgent(options) : options.agent(),
    )
    .then((agent) => {
      assembledAgent = agent;
      return agent;
    });
  agentWiring.catch(() => undefined);

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
    if (settled) return paintChain;
    paintChain = paintChain.then(() =>
      mounted.handle.rerender(buildProps(), { columns: width, rows: height }),
    );
    // A failed render must end the session cleanly, not freeze it behind a
    // rejected chain that every later paint silently skips.
    paintChain = paintChain.catch((error: unknown) => {
      fail(error);
    });
    return paintChain;
  };

  // The turn driver owns the transcript rows beyond the composer's own state.
  // Its paint callback is the same chain, so a streamed delta, a tool result
  // and an approval prompt all land in one ordered frame sequence.
  driver = createTurnDriver({
    connect: () => agentWiring,
    clock,
    timers,
    onChange: () => {
      if (!settled) void paint();
    },
  });

  const close = async (code: number, failure?: unknown): Promise<void> => {
    if (settled) return;
    settled = true;
    options.stdin.off("data", onData);
    options.stdout.off("resize", onResize);
    clearTimer(pendingKeyTimer);
    clearTimer(deferredTimer);
    pendingKeyTimer = undefined;
    deferredTimer = undefined;
    try {
      // An in-flight turn is aborted and awaited before the tree goes away, so
      // no provider request (and no AbortController) outlives the session.
      await driver?.dispose();
      await paintChain;
      await mounted.handle.unmount();
    } catch (error) {
      result.reject(error);
      return;
    } finally {
      mounted.terminal.teardown();
      // A wiring that never finished is not waited for: the process is leaving
      // and a half-open MCP connection must not hold the exit hostage.
      await assembledAgent?.close?.().catch(() => undefined);
    }
    if (failure === undefined) result.resolve(code);
    else result.reject(failure);
  };

  /** End the session after an internal failure, restoring the terminal first. */
  const fail = (error: unknown): void => {
    close(0, error).catch((closeError: unknown) => result.reject(closeError));
  };

  const schedulePendingKey = (): void => {
    clearTimer(pendingKeyTimer);
    if (settled) {
      pendingKeyTimer = undefined;
      return;
    }
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
    if (atMs === undefined || settled) return;
    deferredTimer = timers.setTimeout(
      () => {
        deferredTimer = undefined;
        try {
          const transition = advanceComposer(composer, clock());
          applyTransition(transition);
        } catch (error) {
          fail(error);
        }
      },
      Math.max(0, atMs - clock()),
    );
  };

  const requestExit = (code: number): void => {
    close(code).catch((error: unknown) => result.reject(error));
  };

  // `setupTerminal` has already restored the terminal by the time this runs;
  // the shell only decides the exit code.
  handleSignal = (signal: TerminationSignal): void => {
    requestExit(
      signal === "SIGINT" ? INTERRUPT_EXIT_CODE : TERMINATE_EXIT_CODE,
    );
  };
  if (pendingSignal !== undefined) handleSignal(pendingSignal);

  const applyTransition = (transition: ComposerTransition): void => {
    composer = transition.state;
    keyState = {
      ...keyState,
      draftLength: composer.draft.length,
      suggestionsOpen: composer.completion.open,
    };
    if (transition.submitted !== undefined) {
      // The driver appends the user row itself and owns the turn from here.
      driver?.submit(transition.submitted);
    }
    if (transition.notice !== undefined) {
      // The ephemeral system-message renderer is a later slice; until then the
      // notice is a `●` row so it is visible, never silent.
      driver?.appendNotice(transition.notice);
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

      // R11: an open approval owns every key it can answer. Keys it declines
      // (the quit chord) fall through to the composer.
      if (driver?.approvalOpen === true) {
        if (driver.handleApprovalAction(action)) {
          dirty = true;
          continue;
        }
      }

      // B12: Esc stops the running turn instead of editing the draft. The
      // composer keeps the draft, so it is usable the moment the turn settles.
      if (action.kind === "escape" && driver?.running === true) {
        driver.cancel();
        dirty = true;
        continue;
      }

      // B10: steering and the queued-message list are not implemented, so a
      // plain submit during a turn is refused in the transcript, never lost.
      // `/quit` still leaves the session and takes the turn down with it.
      if (action.kind === "submit" && driver?.running === true) {
        if (composer.draft.trim() === "/quit") {
          applyTransition(
            applyComposerAction(composer, action, now, composerWidth(width)),
          );
          dirty = true;
          continue;
        }
        driver.appendNotice(TURN_ALREADY_RUNNING);
        dirty = true;
        continue;
      }

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
    try {
      const now = clock();
      const resolved = resolveInput(flush ? "" : chunk, keyState, now);
      keyState = resolved.state;
      handleActions(resolved.actions, now);
    } catch (error) {
      fail(error);
    }
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

  // A signal can land during mount and close the session before this point;
  // attaching listeners afterwards would leak them past teardown.
  if (!settled) {
    options.stdin.on("data", onData);
    options.stdout.on("resize", onResize);
  }

  return result.promise;
}
