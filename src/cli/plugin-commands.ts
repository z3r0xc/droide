/**
 * `plugin` command bodies.
 *
 * Contract: `specs/60-extensions-mcp-and-skills.md` §B57–B60. `list` is
 * read-only: it reads the two registries and the enablement map, and never
 * touches the network or a plugin's files beyond the registry itself.
 */
import type { AppContext } from "../app/context.ts";
import {
  type InstalledPluginsResult,
  type PluginScope,
  loadInstalledPlugins,
  renderPluginList,
} from "../extensions/plugins/installed.ts";

export interface PluginListOptions {
  readonly scope?: string;
}

export interface PluginListDeps {
  readonly context: AppContext;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

const SCOPES: Readonly<Record<string, PluginScope>> = {
  user: "user",
  project: "project",
};

export async function runPluginList(
  options: PluginListOptions,
  deps: PluginListDeps,
): Promise<void> {
  let scope: PluginScope | undefined;
  if (options.scope !== undefined) {
    const resolved = SCOPES[options.scope];
    if (resolved === undefined) {
      deps.writeError(
        `Invalid --scope value: ${options.scope}. Expected user or project.\n`,
      );
      deps.setExitCode(1);
      return;
    }
    scope = resolved;
  }

  const result: InstalledPluginsResult = loadInstalledPlugins({
    factoryDir: deps.context.paths.factoryDir,
    projectDir: deps.context.paths.projectDir,
    ...(deps.context.settings.enabledPlugins === undefined
      ? {}
      : { enabledPlugins: deps.context.settings.enabledPlugins }),
  });

  deps.write(renderPluginList(result, scope === undefined ? {} : { scope }));
  deps.setExitCode(result.diagnostics.length > 0 ? 1 : 0);
}
