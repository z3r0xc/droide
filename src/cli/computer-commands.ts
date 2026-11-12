/**
 * `computer` command bodies.
 *
 * Contract: `specs/70-daemon-and-remote-control.md` §B25–B27. Only the local
 * half exists: `list` reports what `host.json` says. Registration, removal, SSH
 * and port forwarding need the backend and the relay, so they stay refused with
 * clause-named markers rather than pretending.
 */
import type { AppContext } from "../app/context.ts";
import {
  readHostConfig,
  renderComputerList,
} from "../extensions/computer/host-config.ts";

export interface ComputerListDeps {
  readonly context: AppContext;
  readonly write: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

export async function runComputerList(deps: ComputerListDeps): Promise<void> {
  const file = readHostConfig(deps.context.paths.factoryDir);
  deps.write(renderComputerList([file]));
  deps.setExitCode(file?.diagnostic === undefined ? 0 : 1);
}
