import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decide,
  decideWithRefusal,
  effectiveAutonomy,
  mcpRefusal,
  parseRiskLevel,
  refusal,
  skipsConfirmations,
  type AutonomyLevel,
  type Decision,
  type PermissionContext,
  type PermissionRequest,
} from "../../../src/tools/permissions.ts";

type Column = "off" | "low" | "medium" | "high" | "skip";

const COLUMNS: readonly Column[] = ["off", "low", "medium", "high", "skip"];

const AUTONOMY: Readonly<Record<Column, AutonomyLevel>> = {
  off: "off",
  low: "low",
  medium: "medium",
  high: "high",
  skip: "low",
};

function contextFor(column: Column): PermissionContext {
  return {
    autonomy: AUTONOMY[column],
    interactionMode: "auto",
    maxAutonomy: "high",
    skipConfirmations: column === "skip",
    interactive: true,
  };
}

interface Row {
  readonly name: string;
  readonly request: PermissionRequest;
  /** One decision per column, in COLUMNS order. */
  readonly expected: readonly Decision[];
}

const ROWS: readonly Row[] = [
  {
    name: "Read / LS / Glob / Grep",
    request: { toolId: "read-cli", toolClass: "read", pathClass: "workspace" },
    expected: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "TodoWrite / ToolSearch / TaskOutput / Skill",
    request: { toolId: "todo_write", toolClass: "no-effect" },
    expected: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "Create / Edit / ApplyPatch inside the workspace",
    request: {
      toolId: "edit-cli",
      toolClass: "file-edit",
      pathClass: "workspace",
    },
    expected: ["ask", "allow", "allow", "allow", "allow"],
  },
  {
    name: "Create / Edit / ApplyPatch outside the workspace",
    request: {
      toolId: "create-cli",
      toolClass: "file-edit",
      pathClass: "outside",
    },
    expected: ["ask", "allow", "allow", "allow", "allow"],
  },
  {
    // B50: a deny floor is never overridable; a user denyWrite stays promptable.
    name: "file edit on a deny-floor path",
    request: {
      toolId: "edit-cli",
      toolClass: "file-edit",
      pathClass: "deny-floor",
    },
    expected: ["deny", "deny", "deny", "deny", "deny"],
  },
  {
    name: "file edit on a user denyWrite path",
    request: {
      toolId: "edit-cli",
      toolClass: "file-edit",
      pathClass: "deny-write",
    },
    expected: ["ask", "ask", "ask", "ask", "ask"],
  },
  {
    name: "Execute, risk low",
    request: { toolId: "execute-cli", toolClass: "execute", riskLevel: "low" },
    expected: ["ask", "allow", "allow", "allow", "allow"],
  },
  {
    name: "Execute, risk medium",
    request: {
      toolId: "execute-cli",
      toolClass: "execute",
      riskLevel: "medium",
    },
    expected: ["ask", "ask", "allow", "allow", "allow"],
  },
  {
    name: "Execute, risk high",
    request: { toolId: "execute-cli", toolClass: "execute", riskLevel: "high" },
    expected: ["ask", "ask", "ask", "allow", "allow"],
  },
  {
    name: "Execute, policy allow",
    request: {
      toolId: "execute-cli",
      toolClass: "execute",
      riskLevel: "high",
      commandPolicy: { decision: "allow", pattern: "git status" },
    },
    expected: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "Execute, policy ask",
    request: {
      toolId: "execute-cli",
      toolClass: "execute",
      riskLevel: "low",
      commandPolicy: { decision: "ask", pattern: "git push" },
    },
    expected: ["ask", "ask", "ask", "ask", "allow"],
  },
  {
    name: "Execute, policy block",
    request: {
      toolId: "execute-cli",
      toolClass: "execute",
      riskLevel: "low",
      commandPolicy: { decision: "block", pattern: "rm -rf /" },
    },
    expected: ["deny", "deny", "deny", "deny", "deny"],
  },
  {
    name: "Execute, read-only search",
    request: {
      toolId: "execute-cli",
      toolClass: "execute",
      riskLevel: "high",
      readOnlySearch: true,
    },
    expected: ["allow", "allow", "allow", "allow", "allow"],
  },
  {
    name: "MCP tool (opaque impact)",
    request: { toolId: "mcp_server_tool", toolClass: "mcp" },
    expected: ["ask", "ask", "ask", "ask", "allow"],
  },
];

test("the permission matrix holds for every tool class and autonomy", () => {
  for (const row of ROWS) {
    const actual = COLUMNS.map((column) =>
      decide(row.request, contextFor(column)),
    );
    assert.deepEqual(actual, row.expected, row.name);
  }
});

test("file edits prompt in an interactive session at every level", () => {
  for (const column of ["off", "low", "medium", "high"] as const) {
    const context = {
      ...contextFor(column),
      interactionMode: "interactive" as const,
    };
    assert.equal(
      decide(
        { toolId: "edit-cli", toolClass: "file-edit", pathClass: "workspace" },
        context,
      ),
      "ask",
      column,
    );
  }
});

test("a missing or unparsable risk is high", () => {
  assert.equal(parseRiskLevel(undefined), "high");
  assert.equal(parseRiskLevel("catastrophic"), "high");
  assert.equal(parseRiskLevel(1), "high");
  assert.equal(parseRiskLevel("medium"), "medium");
});

test("the bypass is on only while the organization admits high", () => {
  assert.equal(
    skipsConfirmations({
      autonomy: "low",
      interactionMode: "auto",
      maxAutonomy: "high",
      skipConfirmations: true,
    }),
    true,
  );
  assert.equal(
    skipsConfirmations({
      autonomy: "low",
      interactionMode: "auto",
      maxAutonomy: "medium",
      skipConfirmations: true,
    }),
    false,
  );
  assert.equal(
    effectiveAutonomy({
      autonomy: "low",
      interactionMode: "auto",
      maxAutonomy: "medium",
      skipConfirmations: true,
    }),
    "medium",
  );
});

test("a non-interactive prompt becomes the early-exit denial", () => {
  const request: PermissionRequest = {
    toolId: "execute-cli",
    toolClass: "execute",
    riskLevel: "high",
  };
  const outcome = decideWithRefusal(request, {
    ...contextFor("low"),
    interactive: false,
  });
  assert.equal(outcome.decision, "deny");
  assert.equal(
    outcome.message,
    "Exec ended early: insufficient permission to proceed. " +
      "Re-run with --auto medium or --auto high. For destructive commands, use --skip-permissions-unsafe.",
  );
});

test("an MCP denial in exec mode names the MCP tool", () => {
  const request: PermissionRequest = {
    toolId: "mcp_github_create",
    llmId: "github___create",
    toolClass: "mcp",
  };
  assert.equal(
    mcpRefusal(request, { ...contextFor("high"), interactive: false }),
    "Exec ended early: MCP tool github___create requires higher autonomy to proceed. " +
      "Re-run with --skip-permissions-unsafe.",
  );
});

test("the block refusal quotes the matched rule and is final", () => {
  const request: PermissionRequest = {
    toolId: "execute-cli",
    toolClass: "execute",
    commandPolicy: { decision: "block", pattern: "rm -rf /" },
  };
  const context = contextFor("high");
  assert.equal(decide(request, context), "deny");
  assert.equal(
    refusal(request, context),
    "This command is blocked by your organization's security policy and can never " +
      'be run (matched blocked-command rule "rm -rf /"). Do not run this command again.',
  );
});

test("a deny-floor refusal uses the sandbox wording", () => {
  const request: PermissionRequest = {
    toolId: "edit-cli",
    toolClass: "file-edit",
    pathClass: "deny-floor",
    path: "/home/me/.factory/settings.json",
  };
  assert.equal(
    refusal(request, contextFor("high")),
    "Sandbox: write denied to /home/me/.factory/settings.json",
  );
});
