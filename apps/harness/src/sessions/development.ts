import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpToolPolicy } from "../mcp/policy.js";
import { AppContextError } from "./app-context.js";
import { CoreEnvironmentClient, type CoreEnvironmentAction, SandboxError, SandboxClient, sandboxActions, type SandboxAction } from "@hosty-sdk/app/sandbox/server";
import { coreEnvironmentTools, harnessEnvironmentActions } from "./environment-tools.js";
import { sandboxTools } from "./sandbox-tools.js";
import { requestWorkspaceApplications } from "../workspace-applications.js";

export interface DevelopmentWorkspace {
  id: string; workspaceId?: string; name?: string; path: string; branch: string; targetBranch: string; originalBase: string; state: string;
  repository: string; sessionPath: string; leases: string[]; pullRequests: string[];
  apps: { appId: string; subpath: string | null }[];
  operations: { id: string; kind: string; state: string; error?: string }[];
  observation?: { state: string; at: string; head?: string; targetHead?: string; ahead?: number; behind?: number;
    conflict?: boolean; error?: string; sessionFiles?: string[]; local?: { files: { path: string; status: string }[] } };
}
export interface WorkspaceParticipation {
  id: string; revision: number; role: "owner" | "contributor";
  members: { userId: string; name: string; role: string; worktreeIds: string[]; revoked: boolean }[];
  sessions: { appId: string; userId: string; sessionId: string; title: string; attached: boolean; canOpen: boolean; viewerPath: string | null; status: string; activityAt: string | null }[];
  eligibleUsers: { id: string; name: string }[];
}
export type DevelopmentAction = "association" | "attach" | "detach" | "participants" | "commit-review" | "execution-select" | "execution-status" | "rename" | "activation-plan" | "activation-apply" | "activation-status" | "activation-list" | "activation-cancel" | "activation-resume" | "activation-return" | "app-dev-logs" | "app-dev-status" | "app-dev-plan" | "app-dev-apply" | "merge-upstream" | "remote-status" | "remote-connect" | "remote-fetch" | "remote-push-base" | "pr-push" | "app-local-status" | "app-local-accept" | "app-local-use" | "app-create" | "app-creation-status" | "app-creation-capabilities" | "app-creation-guide" | "workflow-status" | "workflow-complete" | "workflow-resume" | "workflow-pause" | "workflow-pause-confirm" | "workflow-defer" | "workflow-delete" | CoreEnvironmentAction | SandboxAction | "viewer" | "pr-resolve-review" | "pr-commit" | "pr-list" | "pr-connections" | "pr-status" | "pr-configure" | "pr-publish" | "pr-link" | "pr-ready" | "pr-merge" | "pr-complete" | "pr-corrective" | "list" | "prepare" | "status" | "diff" | "commit" | "refresh" | "merge" | "abort-merge" | "cleanup" | "references" | "lease" | "release-lease";
export interface RetentionSnapshot {
  kind: "chat" | "workspace" | "sandbox";
  workflow: { state: string; revision: number; completedAt?: string | null; closure?: string | null } | null;
  resourcesFinished: boolean;
  workspaceAbsent?: boolean;
  sessionDetached?: boolean;
}
export class DevelopmentClient {
  constructor(private readonly origin: string | null, private readonly appId: string, private readonly token: string | null) {}
  ownsApplication(appId: string): boolean { return this.appId === appId; }
  get available(): boolean { return Boolean(this.origin && this.token); }
  async retention(sessionId: string, userId: string, cleanup?: { requestId: string; expectedRevision: number }): Promise<RetentionSnapshot> {
    if (!this.available) throw new AppContextError(503, "core_unavailable", "Core cannot verify retention eligibility.");
    const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/retention`, this.origin!), {
      method: "POST", redirect: "error", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId, cleanup }), signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json() as RetentionSnapshot & { message?: string };
    if (!response.ok) throw new AppContextError(response.status, "retention_blocked", result.message ?? "Core could not verify cleanup.");
    return result;
  }

  async activity(sessionId: string, credential: string, input: { status: string; leaseId?: string; stopped?: boolean; title?: string; sequence?: number }): Promise<{ workspaceId: string | null; revision: number | null; stopRequested: boolean; state: string }> {
    return this.inspection(credential, `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/workspace-activity`, input, true) as Promise<{ workspaceId: string | null; revision: number | null; stopRequested: boolean; state: string }>;
  }

  async environment(credential: string, action: CoreEnvironmentAction, input: Record<string, unknown>): Promise<unknown> {
    if (!this.available) throw new AppContextError(503, "environments_unavailable", "Child Core environments require a Core-managed app identity.");
    try { return await new CoreEnvironmentClient(async () => credential, { coreOrigin: this.origin!, appId: this.appId, serviceToken: this.token! }).call(action, input); }
    catch (error) { if (error instanceof SandboxError) throw new AppContextError(error.status ?? 503, error.code, error.message); throw error; }
  }
  async sandbox(credential: string, action: SandboxAction, input: Record<string, unknown>): Promise<unknown> {
    if (!this.available) throw new AppContextError(503, "sandboxes_unavailable", "Sandbox operations require a Core-managed app identity.");
    try { return await new SandboxClient(async () => credential, { coreOrigin: this.origin!, appId: this.appId, serviceToken: this.token! }).call(action, input); }
    catch (error) { if (error instanceof SandboxError) throw new AppContextError(error.status ?? 503, error.code, error.message); throw error; }
  }
  async inspectionEvents(credential: string, signal: AbortSignal): Promise<Response> {
    if (!this.available) throw new AppContextError(503, "workspaces_unavailable", "Workspace inspection requires Core.");
    const route = `/api/internal/apps/${encodeURIComponent(this.appId)}/workspace-inspection/events`;
    const response = await fetch(new URL(route, this.origin!), { redirect: "error", signal,
      headers: { authorization: `Bearer ${this.token}`, "X-Hosty-User-Token": credential, accept: "text/event-stream" } });
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppContextError(response.ok ? 502 : response.status, "workspace_stream_unavailable", "Core could not open workspace updates.");
    }
    return response;
  }
  async workspaceApplications(credential: string, method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.available) throw new AppContextError(503, "workspaces_unavailable", "Workspace applications require Core.");
    return requestWorkspaceApplications(method, path, credential, body, { origin: this.origin!, serviceToken: this.token!,
      appId: this.appId, inspect: value => this.inspection(value) });
  }
  async inspection(credential: string, path = "", body?: Record<string, unknown>, absolute = false): Promise<unknown> {
    if (!this.available) throw new AppContextError(503, "workspaces_unavailable", "Workspace inspection requires Core.");
    const route = absolute ? path : `/api/internal/apps/${encodeURIComponent(this.appId)}/workspace-inspection${path}`;
    const response = await fetch(new URL(route, this.origin!), { method: body ? "POST" : "GET", redirect: "error",
      headers: { authorization: `Bearer ${this.token}`, "X-Hosty-User-Token": credential, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(/\/previews\/[^/]+\/[^/]+\/run$/.test(path) ? 360_000 : 120_000) });
    let value: unknown;
    try { value = await response.json(); }
    catch {
      if (response.ok) throw new AppContextError(502, "workspace_response_invalid", "Core returned an invalid workspace response.");
    }
    if (!response.ok) {
      const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
      throw new AppContextError(response.status,
        typeof error.code === "string" ? error.code : "workspace_failed",
        typeof error.message === "string" ? error.message : "Workspace request failed.");
    }
    return value;
  }
  async call(sessionId: string, credential: string, action: DevelopmentAction, input: Record<string, unknown>): Promise<unknown> {
    if (!this.available) throw new AppContextError(503, "workspaces_unavailable", "Workspaces require a Core-managed assistant.");
    if (["association", "attach", "detach"].includes(action)) {
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/workspace-association`;
      if (action === "association") return this.inspection(credential, root, undefined, true);
      if (typeof input.workspaceId !== "string" || !/^[a-f0-9]{64}$/.test(input.workspaceId))
        throw new AppContextError(400, "workspace_invalid", "Supply the aggregate workspace ID.");
      return this.inspection(credential, `${root}/${input.workspaceId}/${action}`, input, true);
    }
    if (action === "participants") {
      const current = await this.call(sessionId, credential, "association", {}) as { workspace: WorkspaceParticipation | null };
      return current.workspace;
    }
    if (action.startsWith("execution-")) {
      if (typeof input.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.appId)
          || typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId))
        throw new AppContextError(400, "execution_request_invalid", "Supply appId and the original UUID requestId.");
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/execution-target/${encodeURIComponent(input.appId)}`;
      return this.inspection(credential, action === "execution-status" ? `${root}/${input.requestId}` : root,
        action === "execution-status" ? undefined : input, true);
    }
    if (action === "rename") return this.inspection(credential,
      `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/workspaces/name`, input, true);
    if (action.startsWith("activation-")) {
      if (typeof input.workspaceId !== "string" || !/^[a-f0-9]{64}$/.test(input.workspaceId))
        throw new AppContextError(400, "activation_workspace_required", "Supply the registered workspace group ID.");
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/workspace-activation/${input.workspaceId}/${action.slice(11)}`;
      return this.inspection(credential, root, input, true);
    }
    if (action.startsWith("app-dev-")) {
      if (typeof input.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.appId))
        throw new AppContextError(400, "dev_app_required", "Supply the installed app id.");
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/dev-mode/${encodeURIComponent(input.appId)}`;
      return this.inspection(credential, root + (action === "app-dev-status" ? "" : "/" + action.slice(8)),
        ["app-dev-status", "app-dev-logs"].includes(action) ? undefined : { ...input, action: input.devAction }, true);
    }
    if (action.startsWith("remote-")) {
      if (typeof input.workspaceId !== "string" || !/^[a-f0-9]{64}$/.test(input.workspaceId) || typeof input.appId !== "string")
        throw new AppContextError(400, "remote_request_invalid", "Supply a local app and its worktree.");
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/workspaces/${input.workspaceId}/remote`;
      return this.inspection(credential, root + (action === "remote-status" ? `?sourceAppId=${encodeURIComponent(input.appId)}` : "/" + action.slice(7)),
        action === "remote-status" ? undefined : input, true);
    }
    if (action.startsWith("app-local-")) {
      if (typeof input.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.appId) || typeof input.workspaceId !== "string" || !/^[a-f0-9]{64}$/.test(input.workspaceId))
        throw new AppContextError(400, "local_request_invalid", "Supply the local app and its registered worktree.");
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/app-creations/local/${encodeURIComponent(input.appId)}`;
      return this.inspection(credential, root + (action === "app-local-status" ? `?workspaceId=${input.workspaceId}` : "/" + action.slice(10)),
        action === "app-local-status" ? undefined : input, true);
    }
    if (action.startsWith("app-creation-") || action === "app-create") {
      const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/app-creations`;
      if (action === "app-creation-status" && (typeof input.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.requestId)))
        throw new AppContextError(400, "creation_request_invalid", "Supply the original creation requestId.");
      if (action === "app-creation-guide" && input.topic !== undefined && (typeof input.topic !== "string" || input.topic.length > 32))
        throw new AppContextError(400, "development_guide_topic_invalid", "Supply a topic ID from overview.");
      const suffix = action === "app-create" ? "" : action === "app-creation-capabilities" ? "/capabilities" : action === "app-creation-guide" ? `/guide${input.topic === undefined ? "" : `?topic=${encodeURIComponent(input.topic as string)}`}` : "/" + encodeURIComponent(String(input.requestId));
      return this.inspection(credential, root + suffix, action === "app-create" ? input : undefined, true);
    }
    if (action.startsWith("workflow-")) return this.inspection(credential,
      `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/workspaces/workflow${action === "workflow-status" ? "" : "/" + action.slice(9)}`,
      action === "workflow-status" ? undefined : input, true);
    const publication = action.startsWith("pr-");
    const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sessions/${encodeURIComponent(sessionId)}/${publication ? "publications" : "workspaces"}`;
    const id = typeof input.workspaceId === "string" ? input.workspaceId : "";
    if (!["list", "prepare", "pr-list", "pr-connections"].includes(action) && !/^[a-f0-9]{64}$/.test(id)) throw new AppContextError(400, "workspace_invalid", "A workspace ID is required.");
    const suffix = publication ? (action === "pr-list" ? "" : action === "pr-connections" ? "/connections" : `/${id}` + (action === "pr-status" ? "" : `/${action.slice(3)}`)) : action === "list" || action === "prepare" ? "" : `/${id}` + (action === "status" ? "" : action === "viewer" ? "/viewer" : action === "diff" ? "/diff" : action === "commit-review" ? "/commit-review" : `/operations/${action}`);
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

  ...Object.fromEntries(["expectedRemoteHead", "repository", "name", "description", "workspaceId", "appId", "requestId", "targetBranch", "expectedTargetHead", "expectedHead", "message", "authorName", "authorEmail", "path", "view", "connectionId", "title", "body", "mergeMethod", "outcome", "threadId"].map(k => [k, { type: "string" }])),
  topic: { type: "string", maxLength: 32, description: "Guide topic ID from overview. Omit to read overview and the topic index." },
  workspaceId: { type: "string", description: "For source, Git, publication and app-local tools use the registered worktree id, not its aggregate workspaceId. Child environment tools declare their own aggregate workspaceId field." },
  allowUnrelatedHistories: { type: "boolean" },
  bootstrapCommit: { type: "boolean" },
  iconPng: { type: "string", maxLength: 174764, description: "Optional base64 PNG, at most 128 KiB and 1024×1024 pixels." },
  expectedRevision: { type: "integer" },
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
const devToolProperties = {
  devAction: { type: "string", enum: ["enter", "restart", "return"] },
  targetRuntime: { type: "string", description: "Installed Docker development profile key." },
  worktreeId: { type: "string", description: "Registered worktree id for live ordinary-data dev mode, not the aggregate workspace id." },
  planDigest: { type: "string" },
  acceptDataChanges: { type: "boolean", description: "For Return: explicitly accept current-data compatibility with the prior runtime. No data is restored." },
  appId: { type: "string" },
  requestId: { type: "string" },
};
const actions = ["participants", "commit-review","execution-select", "execution-status", "rename", "activation-plan", "activation-apply", "activation-status", "activation-list", "activation-cancel", "activation-resume", "activation-return", "app-dev-status", "app-dev-plan", "app-dev-apply", "merge-upstream", "remote-status", "remote-connect", "remote-fetch", "remote-push-base", "pr-push", "app-local-status","app-creation-guide", "app-create", "app-creation-status", "app-creation-capabilities", "workflow-status", "workflow-complete", "workflow-resume", "workflow-pause", ...harnessEnvironmentActions, ...sandboxActions, "list", "prepare", "status", "diff", "commit", "refresh", "merge", "abort-merge", "cleanup", "references", "pr-resolve-review", "pr-commit", "pr-list", "pr-connections", "pr-status", "pr-configure", "pr-publish", "pr-link", "pr-ready", "pr-merge", "pr-complete", "pr-corrective"] as const;
const descriptions: Partial<Record<(typeof actions)[number], string>> = {
  "execution-select": "Select the app execution target in one operation on this Core's ordinary users/data. Supply appId, UUID requestId and kind package or workspace. Package optionally selects a release runtime; workspace selects this session's aggregate workspaceId and optional worktreeId. Dev profiles are internal recipes. Switching workspaces preserves the Core-owned package baseline. Additional authority returns review-required with a concrete operator approval destination. Follow Ask/Run unprompted/Disabled policy. During an active turn, finish the turn after queueing so Harness releases writers before dispatch. Preserve exact request arguments after uncertainty; use execution_status to observe readiness.",
  "execution-status": "Observe an app target-selection operation with appId and its original UUID requestId. Reports running, succeeded, review-required or failed, including the additional-access approval destination when required. Does not retry, start or stop anything.",
  "activation-plan": "Legacy explicit app/Core activation review; prefer execution_select for ordinary app target selection. Review explicit workspace app/Core selection on this host's ordinary data. Supply workspaceId and selection. Inspect every participant, source, interruption and planDigest. Core defaults to its matching repository; deselect it explicitly for apps only.",
  "activation-apply": "Apply the reviewed selection with planDigest and stable UUID requestId. Requires source/app lifecycle permissions plus separately reviewed core.workspace.activate for Core. For an active agent turn, Harness queues the exact request until the turn exits and releases its leases; finish the turn after queueing. Changed source invalidates the review. This tool follows Ask/Run unprompted/Disabled policy. A detached helper owns recovery; keep the original request after disconnect.",
  "activation-status": "Read the original activationId, helper and child phases. An accepted request is not ready. No runtime mutation.",
  "activation-list": "List retained workspace activation receipts and Return results for workspaceId.",
  "activation-cancel": "Pause activationId at the next retained boundary; do not discard data or source or kill a writer.",
  "activation-resume": "Resume activationId after reviewing retained failure/cancellation. Reuses the original targets and receipts.",
  "activation-return": "Return explicit apps and/or Core using activationId and return: {requestId, apps, core, acceptDataChanges}. Review compatibility before accepting current data with old executables. Preserve source, data and unrelated bindings. No snapshot restoration or cleanup.",
  "app-dev-status": "Inspect the installed app's ordinary-data development operation, current runtime/health/build/restart state and recovery receipts. Supply appId. This is the same Core and users, not a child sandbox.",
  "app-dev-plan": "Legacy explicit development/recovery workflow; prefer execution_select for ordinary app target selection. Prepare ordinary-data dev enter/restart/return. Supply appId, devAction, stable UUID requestId; enter also needs targetRuntime and this session's worktreeId. Read changes, backup coverage and data compatibility before applying. Uncommitted source stays live; no commit or child Core is created. Return retains data and edits. acceptDataChanges explicitly accepts data compatibility with the prior runtime.",
  "app-dev-apply": "Apply the exact app-dev-plan request with its planDigest under this tool's configured Ask/Run unprompted/Disabled policy. Supply the same appId, requestId, devAction and arguments. Entry switches the existing app to live worktree code on ordinary data/users after a backup. Restart keeps that binding. Return restores previous execution, never data. Preserve the original request after uncertainty; do not bypass refusal with CLI.",
  "merge-upstream": "Explicitly integrate a fetched remote into a clean local-app worktree. Supply requestId, expectedHead, expectedRemoteHead, authorName, authorEmail and message. Unrelated histories need explicit user consent and allowUnrelatedHistories:true. Conflicts stay in the worktree; abort-merge cancels integration. Does not update local main or push.",
  "remote-status": "Read the separately attached remote and last upstream observation for appId/workspaceId. A local-only app has no remote or remote error. This does not fetch.",
  "remote-connect": "Attach an existing HTTPS repository using connectionId and explicit targetBranch. Supply appId, workspaceId, UUID requestId and repository. Preserves local source/worktree identity; no push or pull. Requires explicit user authorization to connect.",
  "remote-fetch": "Explicitly fetch the connected upstream and show observation time, head, ahead/behind and history relationship. Supply appId, workspaceId and requestId. Does not move local branches or change files.",
  "remote-push-base": "Explicitly publish accepted local main to a missing remote target branch. Supply appId, workspaceId, requestId and reviewed expectedTargetHead. This sends source to the selected provider and requires user authorization. Never overwrites a different existing target; preserve requestId after uncertainty.",
  "pr-push": "Push the reviewed clean expectedHead to the configured workspace branch without creating a PR. Supply requestId; publication must be configured. This sends source and requires authorization. Remote history must be reconciled first; never force-push.",
  "app-local-status": "Inspect local main, worktree commits, acceptance and ordinary runtime state. Supply appId and workspaceId. Commit reviewed work through the existing commit tool, then finish the turn so the operator can use Accept locally and Use locally in the panel. No publication is required.",
  "app-creation-guide": "Read one bounded topic of the running Core app development guide. Omit topic for overview and the topic index, then request relevant topics. Includes Core version, guide revision and manifest schema; covers Git/workspaces, Docker, SDK capabilities, direct HTTP identity, preview and recovery. Grants no additional authority.",
  "app-create": "Create a local app with no remote, one explicitly authorized fixed bootstrap commit and a registered worktree. Supply requestId, appId, name, optional description and bootstrapCommit:true. Use configured Git identity or explicit authorName/authorEmail. Keep the same requestId after uncertainty. The parent app remains stopped. Next create a child Core and install the worktree dev profile there for preview.",
  "app-creation-status": "Read a creation operation using its original requestId. This does not retry creation.",
  "app-creation-capabilities": "Read the current user's configured Git author for local app creation, without provider credentials.",

  "workflow-status": "Read the Core workspace workflow state, revision and completion evidence.",
  "workflow-complete": "Queue an explicit completion request; Harness submits it to Core only after this turn exits and releases its source leases. Core requires every repository to be clean and merged. Supply requestId and expectedRevision. Keep previews for operator review.",
  "workflow-resume": "Explicitly resume retained source work; invalidates completion. Supply requestId and expectedRevision.",
  "workflow-pause": "Pause work without deleting source or previews. Stop active execution first. Supply requestId and expectedRevision; preserve both for recovery.",
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
  rename: "Rename this session workspace when its scope changes materially. Supply a short purpose-based name (at most 120 plain-text characters) and UUID requestId. Reuse both after uncertainty. Changes display metadata only; source, branches, grants and active runtimes stay intact.",
  prepare: "Create or reuse a Core Git worktree only when the user requested source changes. Use this before editing; never edit the original app checkout. Supply the appId, a UUID requestId, a short meaningful purpose-based name and optionally targetBranch. Do not use agent names, IDs or generated branch names as the name.",
  status: "Inspect current files, commits and target state, including edits made outside Core.",
  diff: "Read a changed file's session-base or local uncommitted diff. Supply path and view: session or local.",
  participants: "Read the workspace participants and factual session activity. This contains no conversation history. Recheck before changing shared files.",
  "commit-review": "Freeze explicitly selected files for a shared-workspace commit. Supply workspaceId, UUID requestId, expectedHead and paths. Inspect the selection before requesting review; pass the returned id as reviewId to commit or pr-commit. Changed content invalidates review.",
  commit: "Commit selected paths through Core. Supply requestId, expectedHead, paths, message, authorName and authorEmail, plus reviewId from commit_review for a shared workspace. Follow repository commit instructions, including co-author trailers.",
  refresh: "Fetch the latest target branch without moving the session branch. Supply requestId.",
  merge: "Explicitly integrate the target branch into this worktree. Requires a clean tree, requestId, expectedHead, message and author identity. Reports conflicts without rewriting history.",
  "abort-merge": "Abort a pending local target integration. Supply requestId and expectedHead.",
  cleanup: "Request cleanup of merged clean work. Active turns block removal; request cleanup from the session UI after finishing the turn.",
  references: "Attach HTTPS pull request links for session history; these links do not prove merge. Supply requestId and pullRequests.",
};

const executionToolProperties = {
  appId: { type: "string" }, requestId: { type: "string", format: "uuid" },
  kind: { type: "string", enum: ["package", "workspace"] }, runtime: { type: "string" },
  workspaceId: { type: "string", description: "Aggregate workspaceId returned by prepare, not the individual worktree id." },
  worktreeId: { type: "string", description: "Optional owned registered worktree id when needed to select the app's source binding." },
};

const activationToolProperties = {
  workspaceId: { type: "string" }, requestId: { type: "string" }, planDigest: { type: "string" }, activationId: { type: "string" },
  selection: { type: "object", properties: { coreSelected: { type: "boolean" }, coreWorktreeId: { type: ["string", "null"] },
    apps: { type: "array", items: { type: "object", properties: { appId: { type: "string" }, selected: { type: "boolean" }, worktreeId: { type: ["string", "null"] }, runtime: { type: ["string", "null"] } }, required: ["appId", "selected"], additionalProperties: false } } }, additionalProperties: false },
  return: { type: "object", properties: { requestId: { type: "string" }, apps: { type: "array", items: { type: "string" } }, core: { type: "boolean" }, acceptDataChanges: { type: "boolean" } }, required: ["requestId", "apps", "core", "acceptDataChanges"], additionalProperties: false },
};

export const DEVELOPMENT_PROVIDER = "hosty:development";
export const DEVELOPMENT_IDENTITY = "hosty-development-v1";
export const developmentTools = () => [...coreEnvironmentTools(), ...sandboxTools(), ...actions.filter(action => !action.startsWith("sandbox-") && !action.startsWith("environment-")).map(action => ({ name: action.replaceAll("-", "_"), description: descriptions[action]!,
  inputSchema: { type: "object", ...(action.startsWith("execution-") ? { required: action === "execution-select" ? ["appId", "requestId", "kind"] : ["appId", "requestId"] } : {}), ...(["prepare", "rename"].includes(action) ? { required: action === "prepare" ? ["appId", "requestId", "name"] : ["requestId", "name"] } : {}), properties: action.startsWith("execution-") ? executionToolProperties : action.startsWith("activation-") ? activationToolProperties : action.startsWith("app-dev-") ? devToolProperties : toolProperties, additionalProperties: false },
  annotations: { readOnlyHint: ["execution-status", "activation-plan", "activation-status", "activation-list", "app-dev-status", "app-dev-plan", "remote-status", "app-local-status","app-creation-guide", "app-creation-status", "app-creation-capabilities", "workflow-status", "list", "status", "diff", "pr-list", "pr-status", "pr-connections"].includes(action), destructiveHint: ["execution-select", "activation-apply", "activation-return", "activation-resume", "app-dev-apply", "cleanup", "pr-merge"].includes(action), openWorldHint: false } }))];

/** Session-key authenticated local MCP surface; Core credentials never enter the agent config. */
export class DevelopmentMcp {
  policy?: McpToolPolicy;
  allowRemoteWorker = false;
  project: (value: unknown) => Promise<unknown> = async value => value;
  private readonly keys = new Map<string, string>();
  constructor(private readonly invoke: (sessionId: string, action: DevelopmentAction, input: Record<string, unknown>, dispatchGuard?: () => Promise<void>) => Promise<unknown>) {}
  config(sessionId: string, origin: string, recoveredKey?: string): Record<string, unknown> {
    const key = this.keys.get(sessionId) ?? recoveredKey ?? randomBytes(32).toString("base64url"); this.keys.set(sessionId, key);
    return { "hosty-workspaces": { type: "http", hostyPolicy: true, url: `${origin}/internal/workspaces/${encodeURIComponent(sessionId)}`,
      headers: { authorization: `Bearer ${key}` } } };
  }
  /** Revoke the client transport while retaining a reviewed request until its safe dispatch boundary. */
  disconnect(sessionId: string): void { this.keys.delete(sessionId); }
  unregister(sessionId: string): void { this.disconnect(sessionId); this.policy?.cancel(sessionId); }
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/internal/workspaces/")) return false;
    const send = (status: number, value?: unknown) => { response.writeHead(status, { ...(value === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store" }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
    let sessionId: string;
    try { sessionId = decodeURIComponent(pathname.slice("/internal/workspaces/".length)); } catch { send(400); return true; }
    const expected = this.keys.get(sessionId);
    const actual = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
    if ((!loopback && !this.allowRemoteWorker) || !expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) { send(403); return true; }
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
          result = (action.startsWith("activation-") || action === "execution-select") ? await this.invoke(sessionId, action, input, dispatchGuard) : await this.invoke(sessionId, action, input);
        } finally { response.off("close", cancel); }
        answer({ content: [{ type: "text", text: JSON.stringify(await this.project(result)) }] });
      } catch (error) { answer({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Workspace operation failed." }] }); }
    } else send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    return true;
  }
}

export function workspaceInstructions(workspaces: DevelopmentWorkspace[]): string {
  return "Hosty development workflow: before editing application source, use hosty-workspaces prepare to obtain a registered Git worktree. " +
    "Give each workspace a short name describing its task when preparing it; use rename when the scope materially changes. Names are independent of session titles, branches and agent identity. " +
    "Read app_creation_guide overview and relevant topics on demand before creating or changing an app; refresh after Core version/revision changes. If MCP is disabled or refused, do not bypass it with a shell/CLI bridge; only an already authorized typed coordinator may retrieve the guide. For a new application, use app_create with the user-approved id and bootstrap commit consent before editing. No remote is required. Reuse the same child Core preview between turns; Finish preserves durable source. " +
    "A workspace can have multiple sessions and users editing concurrently. Use participants to inspect active work; reread files before edits and do not attribute the whole workspace diff to this chat. Chat history and approvals remain private. Managed commits require a selected-file review; native writes do not have automatic conflict protection. " +
    "Work only in assigned worktrees. Do not access or modify original source checkouts. Use Core workspace tools for Git operations. " +
    "Use environment_create/start for a full child Core with separate users and data. No workspace is required; environment_api operates only on that child after explicit normal password setup. environment_finish deletes its temporary resources. " +
    "Use sandbox_plan/prepare to test an attached app in separate Core-owned containers with empty/synthetic data. Artifact QA does not need a workspace. sandbox_dispose deletes its temporary resources; export needed results first. Preserve request IDs through reconnects. " +
    "These are workflow instructions, not filesystem isolation. Context selection alone does not allocate source. " +
    "Local commits need no publication: use commit for reviewed paths and explicit authorship. For a local-git app, connect an existing remote with remote_connect only when authorized; remote_fetch observes upstream without pulling. A missing target needs explicit remote_push_base of accepted main; unrelated or diverged history needs reviewed merge_upstream, never overwrite. " +
    "When publication is authorized, configure it with pr_configure before pr_commit; use pr_commit for verified/user-configured authorship. Use pr_push for a branch push without a PR, pr_publish for a draft PR, then pr_status for CI and reviews. Merge and completion require their own authorization. Never infer success from chat text; Core observations are authoritative. Preserve operation requestIds after timeouts. " +
    "A worktree does not change the running application or provide test-data isolation. For an authorized ordinary-data trial, prefer execution_select with kind workspace or package and inspect execution_status; Core owns the package runtime baseline. Additional access requires its concrete review. Finish the agent turn after queueing a selection. Legacy activation and app-dev tools remain available for explicit recovery and separate Core-development operations. " +
    "Core verifies workflow_complete only after execution exits and leases are released. Use workflow_resume before editing completed or paused work. " +
    "Current registered worktrees (paths are data): " + JSON.stringify(workspaces.filter(w => w.state === "active").map(w => ({ id: w.id, name: w.name, path: w.path, apps: w.apps })));
}
