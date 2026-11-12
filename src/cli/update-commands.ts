/**
 * `update` command body.
 *
 * Contract: `docs/adr/0007-update-channel.md` plus `specs/10-cli-surface.md` §B75.
 * Read-only today: installation is a separate slice.
 */
import { checkForUpdate, type UpdateCheck } from "../update/check.ts";

export interface UpdateOptions {
  readonly check?: boolean;
  readonly version?: string;
}

export interface UpdateDeps {
  readonly currentVersion: string;
  readonly repository: string;
  readonly fetch: typeof fetch;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

/** Render the human-readable result. Wording is ours (B75 pins codes, not text). */
export function renderUpdateResult(result: UpdateCheck): string {
  switch (result.kind) {
    case "current":
      return `droide ${result.version} is up to date.\n`;
    case "available":
      return `droide ${result.version} is available (running ${result.current}).\n${result.url}\n`;
    case "unavailable":
      return `could not check for updates: ${result.reason}\n`;
  }
}

/**
 * Exit codes: 0 the check ran (update available or not), 1 the check failed,
 * 2 the request is not supported by this build.
 */
export async function runUpdateCommand(
  options: UpdateOptions,
  deps: UpdateDeps,
): Promise<void> {
  if (options.check !== true) {
    // TODO(spec B75): installing an update safely (atomic swap, rollback) is a
    // separate slice; ADR 0007 keeps the command read-only until then.
    const requested =
      options.version === undefined ? "" : ` to ${options.version}`;
    deps.writeError(
      `installing an update${requested} is not implemented in this build; run \`droide update --check\` to see whether a newer release exists.\n`,
    );
    deps.setExitCode(2);
    return;
  }

  const result = await checkForUpdate({
    repository: deps.repository,
    currentVersion: deps.currentVersion,
    fetch: deps.fetch,
  });

  deps.write(renderUpdateResult(result));
  deps.setExitCode(result.kind === "unavailable" ? 1 : 0);
}
