/**
 * Mount the shell onto an injected terminal.
 *
 * The caller owns the stream, its size and (for tests) whether Ink renders in
 * debug mode. `renderShell` resolves after the first frame has been committed
 * and flushed; `unmount()` tears the Ink tree down, which restores the cursor
 * and any terminal state Ink itself turned on.
 */

import { render, type Instance } from "ink";
import { createElement } from "react";

import { Shell, type ShellProps } from "./components/Shell.ts";

/** The terminal render target. Sizes are given, never sniffed from process. */
export interface ShellTarget {
  readonly stdout: NodeJS.WriteStream;
  readonly columns?: number;
  readonly rows?: number;
  /** Ink debug mode: every frame is appended, never repainted (test capture). */
  readonly debug?: boolean;
  /** Override Ink's TTY/CI detection; production passes the shell's own answer. */
  readonly interactive?: boolean;
  readonly stdin?: NodeJS.ReadStream;
}

export interface ShellSize {
  readonly columns: number;
  readonly rows: number;
}

/** A mounted shell. `unmount` resolves once Ink has exited. */
export interface ShellHandle {
  readonly unmount: () => Promise<void>;
  readonly rerender: (props: ShellProps, size?: ShellSize) => Promise<void>;
}

const DEFAULT_SIZE: ShellSize = { columns: 80, rows: 24 };

export async function renderShell(
  props: ShellProps,
  target: ShellTarget,
): Promise<ShellHandle> {
  const size: ShellSize = {
    columns: target.columns ?? props.width ?? DEFAULT_SIZE.columns,
    rows: target.rows ?? props.height ?? DEFAULT_SIZE.rows,
  };
  target.stdout.columns = size.columns;
  target.stdout.rows = size.rows;

  let waiters: Array<() => void> = [];
  const onRender = (): void => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };
  const nextFrame = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push(resolve);
    return promise;
  };

  const firstFrame = nextFrame();
  const instance: Instance = render(createElement(Shell, props), {
    stdout: target.stdout,
    ...(target.stdin === undefined ? {} : { stdin: target.stdin }),
    debug: target.debug ?? false,
    ...(target.interactive === undefined
      ? {}
      : { interactive: target.interactive }),
    patchConsole: false,
    exitOnCtrlC: false,
    onRender,
  });
  await firstFrame;
  await instance.waitUntilRenderFlush();

  let unmounted = false;
  return {
    unmount: async (): Promise<void> => {
      if (unmounted) return;
      unmounted = true;
      // `waitUntilExit` installs a `beforeExit` listener; after unmount,
      // `waitUntilRenderFlush` waits on the same exit promise without one.
      instance.unmount();
      await instance.waitUntilRenderFlush();
    },
    rerender: async (next, nextSize): Promise<void> => {
      if (unmounted) return;
      if (nextSize !== undefined) {
        target.stdout.columns = nextSize.columns;
        target.stdout.rows = nextSize.rows;
      }
      const frame = nextFrame();
      instance.rerender(createElement(Shell, next));
      await frame;
      await instance.waitUntilRenderFlush();
    },
  };
}
