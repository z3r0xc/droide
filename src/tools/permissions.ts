/**
 * The permission decision algebra.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B41-B47 and the permission matrix.
 * The order is fixed: an administrative deny floor, then the confirmation
 * bypass, then command policy `block > ask > allow`, then the read-only-search
 * shortcut, then the model's risk against the session's autonomy.
 *
 * Pure functions only: no settings service, no session, no environment.
 */

export type AutonomyLevel = "off" | "low" | "medium" | "high";
export type RiskLevel = "none" | "low" | "medium" | "high";

/** How a call touches the filesystem, as the sandbox classifies it. */
export type PathClass =
  | "workspace"
  | "allow-write"
  | "outside"
  | "deny-write"
  | "deny-floor"
  | "protected";

export type ToolClass = "read" | "file-edit" | "execute" | "mcp" | "no-effect";

export interface CommandPolicyDecision {
  readonly decision: "allow" | "ask" | "block";
  /** The rule that matched; used in the block refusal (B43). */
  readonly pattern: string;
}

export interface PermissionRequest {
  readonly toolId: string;
  readonly llmId?: string;
  readonly toolClass: ToolClass;
  /** Present for a filesystem call; omitted for process/network tools. */
  readonly pathClass?: PathClass;
  readonly path?: string;
  /** `Execute`'s model-declared risk, raw: invalid or missing reads as high. */
  readonly riskLevel?: unknown;
  readonly commandPolicy?: CommandPolicyDecision;
  /** A provably read-only search, behind `RollSearchIntoExecute` (B43). */
  readonly readOnlySearch?: boolean;
}

export type InteractionMode = "interactive" | "auto" | "mission";

export interface PermissionContext {
  readonly autonomy: AutonomyLevel;
  readonly interactionMode: InteractionMode;
  /** The organization's ceiling; defaults to `high` when not supplied. */
  readonly maxAutonomy?: AutonomyLevel;
  /** `--skip-permissions-unsafe`, which sets the confirmation bypass (B45). */
  readonly skipConfirmations?: boolean;
  /** False in exec mode with no permission callback (B46). */
  readonly interactive?: boolean;
}

export type Decision = "allow" | "ask" | "deny";

const AUTONOMY_NUMBER: Readonly<Record<AutonomyLevel, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const RISK_NUMBER: Readonly<Record<RiskLevel, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const AUTONOMY_ORDER: readonly AutonomyLevel[] = [
  "off",
  "low",
  "medium",
  "high",
];

export function autonomyToNumber(level: AutonomyLevel): number {
  return AUTONOMY_NUMBER[level];
}

/** B43/B44: an unparsable or missing risk is `high`. */
export function parseRiskLevel(value: unknown): RiskLevel {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "high";
}

/**
 * B45: the bypass is on only while the organization's maximum admits `high`,
 * and the effective level is then `high`, clamped to that maximum.
 */
export function skipsConfirmations(context: PermissionContext): boolean {
  return context.skipConfirmations === true && context.maxAutonomy === "high";
}

export function effectiveAutonomy(context: PermissionContext): AutonomyLevel {
  const maximum = context.maxAutonomy ?? "high";
  if (context.skipConfirmations === true) {
    return AUTONOMY_NUMBER[maximum] <= AUTONOMY_NUMBER.high ? maximum : "high";
  }
  return AUTONOMY_NUMBER[context.autonomy] > AUTONOMY_NUMBER[maximum]
    ? maximum
    : context.autonomy;
}

/** B42: file edits auto-approve in Auto/Mission mode with autonomy != off. */
function autoApprovesFileEdits(context: PermissionContext): boolean {
  return (
    (context.interactionMode === "auto" ||
      context.interactionMode === "mission") &&
    effectiveAutonomy(context) !== "off"
  );
}

/**
 * The decision for one call. `deny` is final and carries no prompt; `ask` is a
 * prompt, which a non-interactive session turns into a denial (B46).
 */
export function decide(
  request: PermissionRequest,
  context: PermissionContext,
): Decision {
  // A deny floor is non-overridable by any autonomy or bypass (B50, matrix).
  if (request.pathClass === "deny-floor" || request.pathClass === "protected") {
    return "deny";
  }

  // A blocked command can never run, bypass or not (B43, matrix, Errors).
  if (request.commandPolicy?.decision === "block") {
    return "deny";
  }

  // A user `denyWrite` entry stays promptable even when confirmations are
  // otherwise bypassed (B50, matrix's last column), so it is checked here.
  if (request.toolClass === "file-edit" && request.pathClass === "deny-write") {
    return context.interactive === false ? "deny" : "ask";
  }

  if (skipsConfirmations(context)) {
    return "allow";
  }

  switch (request.toolClass) {
    case "read":
    case "no-effect":
      return "allow";

    case "file-edit":
      if (autoApprovesFileEdits(context)) return "allow";
      return "ask";

    case "mcp":
      return "ask";

    case "execute": {
      const policy = request.commandPolicy;
      if (policy !== undefined) {
        return policy.decision === "allow" ? "allow" : "ask";
      }
      if (request.readOnlySearch === true) return "allow";
      const risk = parseRiskLevel(request.riskLevel);
      return RISK_NUMBER[risk] <= autonomyToNumber(effectiveAutonomy(context))
        ? "allow"
        : "ask";
    }
  }
}

/** B46's level-specific guidance. `TODO(spec B46)` for the exact sentences. */
function guidance(context: PermissionContext): string {
  const maximum = context.maxAutonomy ?? "high";
  const level = effectiveAutonomy(context);
  const organizationMaximum =
    `This session cannot exceed the organization's maximum autonomy level ` +
    `(${maximum}). Ask an administrator to raise it.`;
  if (level === "off") {
    return maximum === "off"
      ? organizationMaximum
      : "Re-run with --auto low, --auto medium or --auto high to allow this tool.";
  }
  if (level === "low") {
    if (maximum === "low") return organizationMaximum;
    // Spec 80 §B14 `guidanceLow`.
    return "Re-run with --auto medium or --auto high. For destructive commands, use --skip-permissions-unsafe.";
  }
  if (level === "medium") {
    if (maximum !== "high") return organizationMaximum;
    // Spec 80 §B14 `guidanceMedium`.
    return "Re-run with --auto high. For destructive commands, use --skip-permissions-unsafe.";
  }
  if (maximum !== "high") return organizationMaximum;
  // Spec 80 §B14 `guidanceHigh`.
  return "Re-run with --skip-permissions-unsafe.";
}

/**
 * The model-visible refusal for a denied call. Every string here is quoted by
 * the spec's Errors table or its clauses; nothing is invented.
 */
export function refusal(
  request: PermissionRequest,
  context: PermissionContext,
): string {
  const path = request.path ?? "<path>";
  if (request.pathClass === "deny-floor" || request.pathClass === "protected") {
    return `Sandbox: write denied to ${path}`;
  }
  const policy = request.commandPolicy;
  if (request.toolClass === "execute" && policy?.decision === "block") {
    // B43: the block text is quoted up to "Do not run this command again".
    return (
      `This command is blocked by your organization's security policy and can ` +
      `never be run (matched blocked-command rule "${policy.pattern}"). ` +
      `Do not run this command again.`
    );
  }
  return `Exec ended early: insufficient permission to proceed. ${guidance(context)}`;
}

/**
 * The MCP-specific early exit (B46), for a tool whose class is `mcp`.
 */
export function mcpRefusal(
  request: PermissionRequest,
  context: PermissionContext,
): string {
  const name = request.llmId ?? request.toolId;
  return (
    `Exec ended early: MCP tool ${name} requires higher autonomy to proceed. ` +
    guidance(context)
  );
}

/** Convenience: the decision, then the refusal text when it is a denial. */
export function decideWithRefusal(
  request: PermissionRequest,
  context: PermissionContext,
): { readonly decision: Decision; readonly message?: string } {
  const decision = decide(request, context);
  if (decision === "deny")
    return { decision, message: refusal(request, context) };
  if (decision === "ask" && context.interactive === false) {
    return {
      decision: "deny",
      message:
        request.toolClass === "mcp"
          ? mcpRefusal(request, context)
          : refusal(request, context),
    };
  }
  return { decision };
}
