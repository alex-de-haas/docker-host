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

// Codex CAN ask the user a question — `item/tool/requestUserInput` sits in the same server→client
// request family as the approval methods below — but the gateway does not implement it, and the
// adapter reports `questions: false` so the gateway degrades loudly instead of appearing to support
// it. Read out of the pinned 0.147.0 binary on 2026-08-11:
//
//   * It is gated behind `tools.experimental_request_user_input` in `ToolsToml` — experimental, and
//     off by default, so a stock Codex never sends the request at all.
//   * Its wire shape is only inferable from serde symbol tables (`ToolRequestUserInputResponse` and
//     `ToolRequestUserInputAnswer`, both single-field; request fields near `questions`, `isBlocking`,
//     `autoResolutionMs`; per-question `header`, `question`, `options`, `isOther`, `isSecret`). That
//     is a guess, not a contract.
//
// Implementing a guessed shape is precisely how this adapter has been bitten twice: a reply Codex
// cannot act on is indistinguishable from one it never received. The one mitigation that survives is
// that the binary carries "failed to deserialize ToolRequestUserInputResponse", so a wrong reply
// fails loudly rather than silently — which is why the generic `{}` fallback for unimplemented
// server requests is safe to leave in place here. Implement this only against a live Codex run with
// the flag enabled, not against these symbols.
export const REQUEST_USER_INPUT_METHOD = "item/tool/requestUserInput";

/** Server→client requests that block until answered. Anything here becomes a Hosty approval card. */
export const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  // Legacy aliases still emitted by older Codex builds.
  "execCommandApproval",
  "applyPatchApproval",
]);

// Two decision vocabularies, and sending the wrong one is NOT a protocol error — Codex simply fails
// to act on it, which reads exactly like a denial (observed 2026-08-09: allow silently did nothing
// while a v1-shaped reply went to a v2 method). They must be chosen per method:
//   * v2 item/* methods: "accept" | "decline" | "cancel"
//   * legacy execCommandApproval / applyPatchApproval: "approved" | { denied: { rejection } }
// The session-scoped variants ("acceptForSession", "approved_for_session") are never sent: they
// grant blanket approval for the rest of the thread and would break the every-write-asks rule.
const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);

export function approvalDecision(method: string, decision: "allow" | "deny", reason: string): unknown {
  if (LEGACY_APPROVAL_METHODS.has(method)) {
    return decision === "allow" ? "approved" : { denied: { rejection: reason } };
  }
  // "decline" (not "cancel") so the agent finishes its turn and explains, matching how a denied
  // tool call behaves on the Claude adapter; "cancel" would kill the turn outright.
  return decision === "allow" ? "accept" : "decline";
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
