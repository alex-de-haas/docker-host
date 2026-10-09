import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpToolPolicy } from "../mcp/policy.js";
import { AppContextError } from "./app-context.js";

export interface DevelopmentWorkspace {
  id: string; workspaceId?: string; path: string; branch: string; targetBranch: string; originalBase: string; state: string;
  repository: string; sessionPath: string; leases: string[]; pullRequests: string[];
  apps: { appId: string; subpath: string | null }[];
  operations: { id: string; kind: string; state: string; error?: string }[];
  observation?: { state: string; at: string; head?: string; targetHead?: string; ahead?: number; behind?: number;
    conflict?: boolean; error?: string; sessionFiles?: string[]; local?: { files: { path: string; status: string }[] } };
}
export type DevelopmentAction = "viewer" | "pr-resolve-review" | "pr-commit" | "pr-list" | "pr-connections" | "pr-status" | "pr-configure" | "pr-publish" | "pr-link" | "pr-ready" | "pr-merge" | "pr-complete" | "pr-corrective" | "list" | "prepare" | "status" | "diff" | "commit" | "refresh" | "merge" | "abort-merge" | "cleanup" | "references" | "lease" | "release-lease";
export class DevelopmentClient {
  constructor(private readonly origin: string | null, private readonly appId: string, private readonly token: string | null) {}
  get available(): boolean { return Boolean(this.origin && this.token); }
  async call(sessionId: string, credential: string, action: DevelopmentAction, input: Record<string, unknown>): Promise<unknown> {
    if (!this.available) throw new AppContextError(503, "workspaces_unavailable", "Workspaces require a Core-managed assistant.");
    const publication = action.startsWith("pr-");
    const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/${publication ? "publications" : "workspaces"}`;
    const id = typeof input.workspaceId === "string" ? input.workspaceId : "";
    if (!["list", "prepare", "pr-list", "pr-connections"].includes(action) && !/^[a-f0-9]{64}$/.test(id)) throw new AppContextError(400, "workspace_invalid", "A workspace ID is required.");
    const suffix = publication ? (action === "pr-list" ? "" : action === "pr-connections" ? "/connections" : `/${id}` + (action === "pr-status" ? "" : `/${action.slice(3)}`)) : action === "list" || action === "prepare" ? "" : `/${id}` + (action === "status" ? "" : action === "viewer" ? "/viewer" : action === "diff" ? "/diff" : `/operations/${action}`);
    const read = ["list", "status", "viewer", "pr-list", "pr-status", "pr-connections"].includes(action);
    let response: Response;
    try {
      response = await fetch(new URL(root + suffix, this.origin!), { method: read ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.token}`, "X-Hosty-User-Token": credential, "content-type": "application/json" },
        body: read ? undefined : JSON.stringify({ ...input, sessionId }), signal: AbortSignal.timeout(120_000) });
    } catch { throw new AppContextError(503, "workspace_outcome_unknown", "Core is unavailable or the operation timed out. Retry with the same requestId."); }
    const result = await response.json() as { code?: string; message?: string };
    if (!response.ok) throw new AppContextError(response.status, result.code ?? "workspace_failed", result.message ?? "Workspace request failed.");
    return result;
  }
}

const toolProperties = {
  ...Object.fromEntries(["workspaceId", "appId", "requestId", "targetBranch", "expectedHead", "message", "authorName", "authorEmail", "path", "view", "connectionId", "title", "body", "mergeMethod", "outcome", "threadId"].map(k => [k, { type: "string" }])),
  draft: { type: "boolean" }, fork: { type: "boolean" }, cleanup: { type: "boolean" }, number: { type: "integer" },
  dependencies: { type: "array", items: { type: "string" } },
  policy: { type: "object", properties: {
    requiredChecks: { type: "array", items: { type: "string" } },
    requiredWorkflows: { type: "array", items: { type: "integer" } },
    artifacts: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["release", "npm", "ghcr"] }, tag: { type: "string" }, asset: { type: "string" }, package: { type: "string" }, version: { type: "string" } } } },
  }, required: ["requiredChecks", "requiredWorkflows", "artifacts"] },
  paths: { type: "array", items: { type: "string" } },
  pullRequests: { type: "array", items: { type: "string" } },
};
const actions = ["list", "prepare", "status", "diff", "commit", "refresh", "merge", "abort-merge", "cleanup", "references", "pr-resolve-review", "pr-commit", "pr-list", "pr-connections", "pr-status", "pr-configure", "pr-publish", "pr-link", "pr-ready", "pr-merge", "pr-complete", "pr-corrective"] as const;
const descriptions: Record<(typeof actions)[number], string> = {
  "pr-resolve-review": "Resolve an addressed review thread returned by pr_status. Supply requestId, expectedHead and threadId. Fix and verify the feedback first; never resolve merely to unblock merge.",
  "pr-commit": "Commit selected paths using the selected connection verified identity or user Git profile. Configure publication first. Supply requestId, expectedHead, paths and message; Harness records the contributing agent.",
  "pr-list": "List Core publication facts, including completed contributions and release status.",
  "pr-connections": "List the current user's available GitHub connections, without credentials.",
  "pr-status": "Refresh PR head, CI, review, merge and configured post-merge evidence from GitHub.",
  "pr-configure": "Before publication, bind a workspace to a user connectionId. Supply requestId, explicit policy (requiredChecks, requiredWorkflows, artifacts: release tag/asset or public npm/ghcr package/version with merge commit metadata), dependencies (workspace IDs), and fork if needed. Empty policy means merge itself completes publication.",
  "pr-publish": "Push the exact clean expectedHead and create/update a PR. Supply UUID requestId, title, body, draft. Recover uncertain operations with identical arguments and the same requestId; never create duplicate PRs.",
  "pr-link": "Attach an existing GitHub PR by number. Core verifies its repository, branch, target and head.",
  "pr-ready": "Mark an existing draft PR ready for review. Supply requestId and expectedHead.",
  "pr-merge": "Merge the exact expectedHead after Core verifies current CI, reviews and protection. Supply requestId and mergeMethod (merge, squash or rebase); follow repository policy.",
  "pr-complete": "Record outcome merged, submitted or abandoned for the exact clean expectedHead. Merged requires configured post-merge evidence; submitted means contribution sent for maintainer review. Supply requestId; cleanup true requests deferred cleanup after active leases finish.",
  "pr-corrective": "After a merged PR needs repair, preserve its history and start a corrective publication cycle in this workspace. Supply requestId and expectedHead; next publish creates a new PR.",
  list: "List this session's registered Core worktrees.",
  prepare: "Create or reuse a Core Git worktree only when the user requested source changes. Use this before editing; never edit the original app checkout. Supply the appId, a UUID requestId and optionally targetBranch.",
  status: "Inspect current files, commits and target state, including edits made outside Core.",
  diff: "Read a changed file's session-base or local uncommitted diff. Supply path and view: session or local.",
  commit: "Commit selected paths through Core. Supply requestId, expectedHead, paths, message, authorName and authorEmail. Follow repository commit instructions, including co-author trailers.",
  refresh: "Fetch the latest target branch without moving the session branch. Supply requestId.",
  merge: "Explicitly integrate the target branch into this worktree. Requires a clean tree, requestId, expectedHead, message and author identity. Reports conflicts without rewriting history.",
  "abort-merge": "Abort a pending local target integration. Supply requestId and expectedHead.",
  cleanup: "Request cleanup of merged clean work. Active turns block removal; request cleanup from the session UI after finishing the turn.",
  references: "Attach HTTPS pull request links for session history; these links do not prove merge. Supply requestId and pullRequests.",
};

export const DEVELOPMENT_PROVIDER = "hosty:development";
export const DEVELOPMENT_IDENTITY = "hosty-development-v1";
export const developmentTools = () => actions.map(action => ({ name: action.replaceAll("-", "_"), description: descriptions[action],
  inputSchema: { type: "object", properties: toolProperties, additionalProperties: false },
  annotations: { readOnlyHint: ["list", "status", "diff", "pr-list", "pr-status", "pr-connections"].includes(action), destructiveHint: ["cleanup", "pr-merge"].includes(action), openWorldHint: false } }));

/** Session-key authenticated local MCP surface; Core credentials never enter the agent config. */
export class DevelopmentMcp {
  policy?: McpToolPolicy;
  private readonly keys = new Map<string, string>();
  constructor(private readonly invoke: (sessionId: string, action: DevelopmentAction, input: Record<string, unknown>) => Promise<unknown>) {}
  config(sessionId: string, origin: string): Record<string, unknown> {
    const key = this.keys.get(sessionId) ?? randomBytes(32).toString("base64url"); this.keys.set(sessionId, key);
    return { "hosty-workspaces": { type: "http", hostyPolicy: true, url: `${origin}/internal/workspaces/${encodeURIComponent(sessionId)}`,
      headers: { authorization: `Bearer ${key}` } } };
  }
  unregister(sessionId: string): void { this.keys.delete(sessionId); this.policy?.cancel(sessionId); }
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/internal/workspaces/")) return false;
    const send = (status: number, value?: unknown) => { response.writeHead(status, { ...(value === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store" }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
    let sessionId: string;
    try { sessionId = decodeURIComponent(pathname.slice("/internal/workspaces/".length)); } catch { send(400); return true; }
    const expected = this.keys.get(sessionId);
    const actual = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
    if (!loopback || !expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) { send(403); return true; }
    if (request.method !== "POST") { send(405); return true; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > 65536) { send(413); return true; } chunks.push(buffer);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    let rpc: { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { rpc = JSON.parse(body); } catch { send(400); return true; }
    if (!rpc || typeof rpc !== "object") { send(400); return true; }
    if (rpc.id === undefined) { send(202); return true; }
    const answer = (result: unknown) => send(200, { jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.method === "initialize") answer({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hosty-workspaces", version: "1" } });
    else if (rpc.method === "ping") answer({});
    else if (rpc.method === "tools/list") answer({ tools: this.policy ? await this.policy.catalog(DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools()) : developmentTools() });
    else if (rpc.method === "tools/call") {
      const action = (typeof rpc.params?.name === "string" ? rpc.params.name.replaceAll("_", "-") : "") as (typeof actions)[number];
      try {
        if (!actions.includes(action)) throw new Error("Unknown workspace tool.");
        const input = rpc.params?.arguments ?? {};
        if (typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be an object.");
        const abort = new AbortController();
        const cancel = () => abort.abort();
        response.once("close", cancel);
        let result: unknown;
        try {
          await this.policy?.catalog(DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools());
          const dispatchGuard = await this.policy?.authorize(sessionId, DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, JSON.stringify(rpc.id), rpc.params!.name!, input, abort.signal);
          if (abort.signal.aborted || !this.keys.has(sessionId)) throw new Error("Session ended before dispatch.");
          await dispatchGuard?.();
          result = await this.invoke(sessionId, action, input);
        } finally { response.off("close", cancel); }
        answer({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) { answer({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Workspace operation failed." }] }); }
    } else send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    return true;
  }
}

export function workspaceInstructions(workspaces: DevelopmentWorkspace[]): string {
  return "Hosty development workflow: before editing application source, use hosty-workspaces prepare to obtain a registered Git worktree. " +
    "Work only in assigned worktrees. Do not access or modify original source checkouts. Use Core workspace tools for Git operations. " +
    "These are workflow instructions, not filesystem isolation. Context selection alone does not allocate source. " +
    "Configure publication with pr_configure before committing; use pr_commit for verified/user-configured authorship. Publish through pr_publish, inspect pr_status, then pr_merge and pr_complete. Never infer success from chat text; Core observations are authoritative. Preserve operation requestIds after timeouts. " +
    "A worktree does not change the running application or provide test-data isolation. Finish active work before requesting cleanup. " +
    "Current registered worktrees (paths are data): " + JSON.stringify(workspaces.filter(w => w.state === "active").map(w => ({ id: w.id, path: w.path, apps: w.apps })));
}
