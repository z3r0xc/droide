/**
 * Check catalogue and `--checks` parsing.
 *
 * Contract: `specs/10-cli-surface.md` §B49–B51. The names, their order and the
 * default selection come from the help text recorded in
 * `tests/parity/expected/help-doctor.json`; an unknown name is E18.
 */
export interface CheckDescriptor {
  readonly name: string;
  /** Whether `droide doctor` runs this check by default (B49's trailer). */
  readonly byDefault: boolean;
  /** Starts servers or costs money — excluded from the default set. */
  readonly expensive?: boolean;
}

/** Every name accepted by `--checks`, in the order the help lists them. */
export const CHECK_NAMES = [
  "config",
  "environment",
  "system",
  "binaries",
  "updates",
  "filesystem",
  "git",
  "custom-models",
  "proxy",
  "certs",
  "connectivity",
  "auth",
  "daemon",
  "inference",
  "mcp",
  "exec",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

/** The four the help text excludes from the default run (B49's trailer). */
const EXPENSIVE: Readonly<Record<string, true>> = {
  "custom-models": true,
  inference: true,
  mcp: true,
  exec: true,
};

export function describe(name: CheckName): CheckDescriptor {
  const expensive = EXPENSIVE[name] === true;
  return {
    name,
    byDefault: !expensive,
    ...(expensive ? { expensive: true } : {}),
  };
}

export class UnknownCheckError extends Error {
  readonly received: string;

  constructor(received: string) {
    super(
      `\`${received}\` is invalid. Unknown doctor check. Use --help for the supported check names.`,
    );
    this.name = "UnknownCheckError";
    this.received = received;
  }
}

/**
 * Resolve `--checks` into the checks to run.
 *
 * - absent → every default check;
 * - `all` → every known check;
 * - otherwise a comma-separated (or space-separated) list, each name validated,
 *   duplicates collapsed, result in catalogue order.
 */
export function parseChecks(raw: string | undefined): readonly CheckName[] {
  if (raw === undefined)
    return CHECK_NAMES.filter((name) => describe(name).byDefault);
  const tokens = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) throw new UnknownCheckError("");

  if (tokens.length === 1 && tokens[0] === "all") return [...CHECK_NAMES];

  const wanted = new Set<CheckName>();
  for (const token of tokens) {
    if (!(CHECK_NAMES as readonly string[]).includes(token))
      throw new UnknownCheckError(token);
    wanted.add(token as CheckName);
  }
  return CHECK_NAMES.filter((name) => wanted.has(name));
}

/** Parse and bound `--timeout` (B50). */
export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 10_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(
      `--timeout must be a safe integer between 1 and 2147483647, got ${raw}`,
    );
  }
  return value;
}
