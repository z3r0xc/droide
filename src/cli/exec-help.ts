/**
 * Curated `exec --help` page. Contract: `specs/10-cli-surface.md` B26-B34.
 *
 * The page is data, not terminal rendering: no I/O, no terminal width and no
 * clock. Everything that varies between builds arrives as `ExecHelpModels`,
 * so the rendered text is a pure function of the catalogue.
 *
 * The subject prints its own name here; ADR 0005 routes every user-visible
 * occurrence through `brand.ts` and the parity harness substitutes it back.
 */
import { DISPLAY, PROGRAM } from "./brand.ts";

export interface ModelRow {
  readonly id: string;
  readonly name: string;
}

export interface ModelDetail {
  readonly name: string;
  readonly supportsReasoning: boolean;
  readonly supported: readonly string[];
  readonly defaultReasoningEffort: string;
}

export interface ExecHelpModels {
  /** Built-in models in availability order, ids unpadded. */
  readonly models: readonly ModelRow[];
  /** The single id the model list marks `(default)`. */
  readonly defaultModelId: string;
  /** Per-model reasoning table, in the same order as `models`. */
  readonly modelDetails: readonly ModelDetail[];
  /** Flags stream-jsonrpc validates but ignores, without leading spaces. */
  readonly ignoredFlags: readonly string[];
}

export function renderExecHelp(models: ExecHelpModels): string {
  let widestId = 0;
  for (const model of models.models)
    widestId = Math.max(widestId, model.id.length);

  const modelRows = models.models
    .map((model) => {
      const padded = model.id.padEnd(widestId + 1, " ");
      const suffix = model.id === models.defaultModelId ? " (default)" : "";
      return `  ${padded}  ${model.name}${suffix}`;
    })
    .join("\n");

  const modelDetailRows = models.modelDetails
    .map(
      (detail) =>
        `  - ${detail.name}: supports reasoning: ${detail.supportsReasoning ? "Yes" : "No"}; supported: [${detail.supported.join(", ")}]; default: ${detail.defaultReasoningEffort}`,
    )
    .join("\n");

  const ignoredFlags = models.ignoredFlags
    .map((flag) => `    ${flag}`)
    .join("\n");

  return `Usage: ${PROGRAM} exec [options] [prompt]

Execute a single command (non-interactive mode)

Arguments:
  prompt                      The prompt to execute

Options:
  -o, --output-format <format>  Output format: text|json|stream-json|stream-jsonrpc|acp (default: "text")
  --input-format <format>     Input format: stream-json for multi-turn sessions; stream-jsonrpc is controlled via JSON-RPC requests
  -f, --file <path>           Read prompt from file
  --auto <level>              Autonomy level: low|medium|high
  --skip-permissions-unsafe   Skip ALL permission checks - allows all permissions (unsafe)
  --disable-builtin-skills    Disable Factory-provided builtin skills (not supported in ACP modes)
  -s, --session-id <id>       Existing session to continue (requires a prompt)
  --fork <id>                 Fork an existing session into a new session (requires a prompt)
  -m, --model <id>            Model ID to use (default: ${models.defaultModelId})
  -r, --reasoning-effort <level>  Reasoning effort (defaults per model)
  --spec-model <id>           Model ID to use for spec mode (defaults to main model)
  --spec-reasoning-effort <level>  Reasoning effort for spec mode (defaults per spec model)
  --use-spec                  Start in spec mode
  --only-tools <ids>          Use only tool IDs or MCP:<server>[/<tool>] selectors
  --add-tools <ids>           Add tool IDs or MCP:<server>[/<tool>] selectors
  --remove-tools <ids>        Remove tool IDs or MCP:<server>[/<tool>] selectors
  --cwd <path>                Working directory path
  --settings <path>           Path to runtime settings file merged for this process only
  -w, --worktree [name]       Run in a git worktree (name selects the branch to use or create; default: <current-branch>-<id>)
  --worktree-dir <path>       Deprecated: set worktreeDirectory in ~/.factory/settings.json instead
  --tag <spec>                Session tag (name or JSON, repeatable)
  --log-group-id <id>         Log group ID for filtering logs
  --mission                   Run in mission mode (orchestrate a multi-agent mission)
  --worker-model <id>         Model ID used by mission workers (only valid with --mission)
  --worker-reasoning-effort <level>  Reasoning effort for mission workers (only valid with --mission)
  --validator-model <id>      Model ID used by mission validation workers (only valid with --mission)
  --validator-reasoning-effort <level>  Reasoning effort for mission validation workers (only valid with --mission)
  --append-system-prompt <text>  Append custom text to the end of the system prompt
  --append-system-prompt-file <path>  Append file contents to the end of the system prompt
  --list-tools                List available tools for the selected model and exit
  -h, --help                  display help for command

Stream JSON-RPC Mode:
  With --input-format stream-jsonrpc, session settings come from JSON-RPC requests. These
  flags are still validated but have no effect, and a warning on stderr names any that are set:
${ignoredFlags}

Autonomy Levels:
  ${DISPLAY} exec uses a tiered autonomy system to control what operations the agent can perform.
  By default, it runs in read-only mode, requiring explicit flags to enable modifications.

  DEFAULT (no flags)         Read-only mode - The safest mode for reviewing planned changes without execution
                             • Reading files or logs: cat, less, head, tail, systemctl status
                             • Display commands: echo, pwd
                             • Information gathering: whoami, date, uname, ps, top
                             • Git read operations: git status, git log, git diff
                             • Directory listing: ls, find (without -delete or -exec)
                             ✗ No modifications to files or system
                             Use case: Safe for reviewing what changes would be made

  --auto low                 Low-risk operations - Basic file operations while blocking system changes
                             • File creation/modification in non-system directories: touch, mkdir, mv, cp
                             ✗ No system modifications or package installations
                             Use case: Documentation updates, code formatting, adding comments

  --auto medium              Development operations - Significant but recoverable side effects
                             • Installing packages from trusted sources: npm install, pip install (without sudo)
                             • Network requests to trusted endpoints: curl, wget to known APIs
                             • Git operations (local only): git commit, git checkout, git pull
                             • Building code: make, npm run build, mvn compile
                             ✗ No git push, sudo commands, or production changes
                             Use case: Local development, testing, dependency management

  --auto high                Production operations - Security implications or major side effects
                             • Running arbitrary/untrusted code: curl | bash, eval, downloaded scripts
                             • Exposing ports or modifying firewall rules
                             • Git push operations: git push, git push --force
                             • Production deployments, database migrations, sensitive operations
                             • Commands accessing/modifying passwords or keys
                             ✗ Still blocks: sudo rm -rf /, system-wide changes
                             Use case: CI/CD pipelines, automated deployments

  --skip-permissions-unsafe  Bypass all checks - DANGEROUS!
                             • Allows ALL operations without confirmation
                             • Can execute irreversible operations
                             • Only use in isolated environments (Docker, throwaway VMs)
                             ✗ Cannot be combined with --auto flags
                             Use case: Isolated environments only

Mission Mode:
  --mission                  Run in mission mode (multi-agent orchestration)
                             • Automatically upgrades session to orchestrator mode
                             • Spawns worker sessions via factoryd to implement features
                             • Uses GPT-5.2 High reasoning by default (override with --model)
                             • Missions auto-approve proposals (no interactive confirmation)
                             • Requires --auto high or --skip-permissions-unsafe
                             Use case: Complex multi-step projects that benefit from parallel workers

Session Flags:
  --session-id <id>          Continue an existing session (requires a prompt)
                             Loads conversation history for context but does NOT replay old messages in output
  --fork <id>                Fork an existing session into a new local session (requires a prompt)
                             Copies conversation history first, then continues on the forked branch
  --tag <spec>               Session tag for categorization (repeatable)
                             Plain name: --tag code-review
                             JSON object: --tag '{"name":"code-review","metadata":{"prUrl":"..."}}'

Tool Controls:
  --list-tools               Print the tools available for the selected model and exit
  --only-tools <list>        Use only tool IDs or MCP:<server>[/<tool>] selectors
  --add-tools <list>         Add tool IDs or MCP:<server>[/<tool>] selectors
  --remove-tools <list>      Remove tool IDs or MCP:<server>[/<tool>] selectors
  MCP:<server>               Select every tool from an MCP server
  MCP:<server>/<tool>        Select one tool from an MCP server
                             Percent-encode each server or tool segment when needed

Available Models:
${modelRows}

Model details:
${modelDetailRows}

Pinning the Latest Model:
  Any model flag (-m/--model, --spec-model, --worker-model, --validator-model) also accepts a
  tier alias that runs the newest released model in that tier your organization allows:
    anthropic-latest-{premium,balanced,medium,fast}
    openai-latest-{premium,balanced,medium,fast}
    oss-latest-{premium,balanced,fast}
  A version wildcard pins one model line instead: claude-opus-*, gpt-*-sol, gpt-*-luna, glm-*
  * matches only the version, so claude-opus-* never selects a Fast variant (use claude-opus-*-fast).
  The alias is resolved when the session starts; the session keeps that model afterwards.

Authentication:
  Create an API key: https://app.factory.ai/settings/api-keys

  Setting API key examples:
    macOS/Linux:
      export FACTORY_API_KEY=fk-... && ${PROGRAM} exec "fix the bug"
    Windows (PowerShell):
      $env:FACTORY_API_KEY="fk-..." ; ${PROGRAM} exec "fix the bug"
    Windows (CMD):
      set FACTORY_API_KEY=fk-... && ${PROGRAM} exec "fix the bug"

  Note: Keep your API key secret. Do not commit it to source control.

Examples:
  # DEFAULT (no flags) - Read-only mode for planning and analysis
  ${PROGRAM} exec "Analyze the authentication system and create a detailed plan for migrating from session-based auth to OAuth2"
  ${PROGRAM} exec "Review the codebase for security vulnerabilities and generate a prioritized list of improvements"
  ${PROGRAM} exec "Analyze the project architecture and create a dependency graph"

  # --auto low - Safe file operations
  ${PROGRAM} exec --auto low "add JSDoc comments to all functions"
  ${PROGRAM} exec --auto low "fix typos in README.md"
  ${PROGRAM} exec --auto low "format all Python files with black"

  # --auto medium - Development tasks
  ${PROGRAM} exec --auto medium "install deps, run tests, fix issues"
  ${PROGRAM} exec --auto medium "update packages and resolve conflicts"
  ${PROGRAM} exec --auto medium "set up the development environment and run the test suite"

  # Tool discovery and selection
  ${PROGRAM} exec --list-tools
  ${PROGRAM} exec --model gpt-5 --list-tools --output-format json
  ${PROGRAM} exec --only-tools Read,Grep "inspect this repository"
  ${PROGRAM} exec --add-tools 'MCP:slack/search_messages' "find relevant messages"
  ${PROGRAM} exec --remove-tools Execute "refactor without running commands"
  ${PROGRAM} exec --only-tools 'Read,MCP:github' --add-tools Grep "review this repository"

  # Using custom models
  ${PROGRAM} exec --model custom:deepseek-v3 "analyze this code"
  ${PROGRAM} exec --auto medium --model custom:qwen-turbo "implement this feature"

  # --auto high - Production operations
  ${PROGRAM} exec --auto high "fix bug, test, commit, and push to main"
  ${PROGRAM} exec --auto high "deploy to staging after running tests"
  ${PROGRAM} exec --auto high "run database migration and update production config"

  # --mission - Multi-agent mission orchestration
  ${PROGRAM} exec --mission --skip-permissions-unsafe "Build a full authentication system with OAuth2"
  ${PROGRAM} exec --mission --auto high "Refactor the database layer to use connection pooling"
  ${PROGRAM} exec --mission --auto high --model gpt-5 "Add comprehensive test coverage for the API layer"

  # --mission with per-run worker / validator model overrides
  ${PROGRAM} exec --mission --auto high \\
    --model claude-opus-4-6 \\
    --worker-model claude-opus-4-6 --worker-reasoning-effort medium \\
    --validator-model gpt-5 --validator-reasoning-effort high \\
    "Refactor the auth system"

  # File input with different autonomy levels
  ${PROGRAM} exec -f requirements.md
  ${PROGRAM} exec -f task.md --auto low
  cat prompt.txt | ${PROGRAM} exec --auto medium
  echo "analyze code" | ${PROGRAM} exec

  # Session continuation (preserves context, no message replay)
  ${PROGRAM} exec -s <session-id> "continue previous task"
  ${PROGRAM} exec -s <session-id> "what did we discuss?"
  ${PROGRAM} exec --fork <session-id> "take a different approach from here"

  # --skip-permissions-unsafe - Only in isolated environments!
  # In a Docker container:
  docker run --rm -v $(pwd):/workspace alpine:latest sh -c "
    ${PROGRAM} exec --skip-permissions-unsafe 'Install system deps, modify configs, run tests'"

  # In ephemeral CI/CD runner:
  ${PROGRAM} exec --skip-permissions-unsafe "Modify /etc/hosts, install kernel modules, reset network"
`;
}
