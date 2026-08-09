// Wire shapes for the Codex app-server stdio JSON-RPC protocol, pinned to the version in
// package.json and verified by the 2026-08-09 spike (docs/features/ai-gateway/plan.md).
//
// Two quirks the spike found the hard way, both encoded here so a caller cannot get them wrong:
//   * `thread/start` takes `sandbox` as a plain string ("read-only"), while `turn/start` takes
//     `sandboxPolicy` as an internally tagged object ({ type: "readOnly" }). Swapping them is a
//     -32600 from the server.
//   * An approval reply is `{ decision }`, where a denial is an object and an allow is the bare
//     string "approved". The protocol also accepts "approved_for_session" — see APPROVE below.

export const CODEX_METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
} as const;

/** Server→client requests that block until answered. Anything here becomes a Hosty approval card. */
export const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  // Legacy aliases still emitted by older Codex builds.
  "execCommandApproval",
  "applyPatchApproval",
]);

// The allow decision. Deliberately NOT "approved_for_session": that grants blanket approval for the
// rest of the thread and would silently break the every-write-asks rule this feature is built on.
export const APPROVE = "approved" as const;

export function denial(reason: string): { denied: { rejection: string } } {
  return { denied: { rejection: reason } };
}

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** Sandbox vocabulary for `thread/start` (plain string). */
export type ThreadSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Sandbox vocabulary for `turn/start` (internally tagged object). */
export type TurnSandboxPolicy = { type: "readOnly" | "workspaceWrite" | "dangerFullAccess" };

/**
 * "untrusted" still auto-runs Codex's own trusted-command list (the spike saw `echo` run
 * unprompted), so the gateway never relies on this to enforce its policy — every approval request
 * the server does raise is surfaced to the operator, and nothing is auto-allowed on Codex's behalf.
 */
export const APPROVAL_POLICY = "untrusted" as const;

export function describeApproval(method: string, params: Record<string, unknown>): {
  toolName: string;
  input: unknown;
} {
  const command = typeof params.command === "string" ? params.command : null;
  const changes = Array.isArray(params.changes) ? params.changes : null;
  if (method.includes("commandExecution") || method === "execCommandApproval") {
    return { toolName: "Command", input: { command, cwd: params.cwd ?? null, reason: params.reason ?? null } };
  }
  if (method.includes("fileChange") || method === "applyPatchApproval") {
    return { toolName: "FileChange", input: { changes, grantRoot: params.grantRoot ?? null, reason: params.reason ?? null } };
  }
  return { toolName: "Permissions", input: params };
}
