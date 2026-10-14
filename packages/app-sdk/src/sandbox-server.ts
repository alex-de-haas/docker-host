import type { ProviderServerOptions } from "./providers-server.js";

export type SandboxSource = { kind: "worktree"; worktreeId: string } | { kind: "appArtifact"; artifactDigest?: string };
export interface SandboxLimits { memoryBytes?: number; cpus?: number; pids?: number; dataBytes?: number; cacheBytes?: number; startupSeconds?: number }
export interface SandboxContext { workspaceId?: string; sessionId?: string; jobId?: string }
export interface SandboxPlanInput { appId: string; profile: string; source: SandboxSource; limits?: SandboxLimits; context?: SandboxContext }
export interface SandboxPlan { id: string; digest: string; inputDigest: string; request: SandboxPlanInput; blockers: string[]; expiresAt: string }
export interface SandboxOperation { id: string; kind: string; state: string; errorCode?: string; message?: string }
export interface SandboxUser { id: string; fixtureKey: string; displayName: string; role: string; permissions: string[]; enabled: boolean; revision: number }
export interface SandboxInstance { id: string; appId: string; source: SandboxSource; context?: SandboxContext; revision: number; generation: string;
  dataRevision: string; state: string; previewUrl?: string; errorCode?: string; operations: SandboxOperation[]; users: SandboxUser[]; viewers?: string[]; endpoints?: { key: string; url: string }[];
  metrics?: { at: string; memoryBytes: number | null; sampledPeakMemoryBytes: number | null; services: { service: string; memoryBytes: number | null; cpuPercent: number | null }[] };
  storage?: { at: string; dataBytes: number; seedBytes: number; cacheBytes: number; evidenceBytes: number; totalBytes: number; warning: boolean; errorCode?: string } }
export interface SandboxDiagnostics { instanceId: string; state: string; errorCode?: string; services: { service: string; state: string; text: string }[] }
export const sandboxActions = ["sandbox-logs", "sandbox-plan", "sandbox-prepare", "sandbox-list", "sandbox-status", "sandbox-users", "sandbox-seed",
  "sandbox-start", "sandbox-restart", "sandbox-stop", "sandbox-reset", "sandbox-dispose", "sandbox-browser", "sandbox-export", "sandbox-user-delete", "sandbox-viewers", "sandbox-evidence-clear", "sandbox-preview", "sandbox-browser-cancel"] as const;
export type SandboxAction = typeof sandboxActions[number];
export class SandboxError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null) { super(message); this.name = "SandboxError"; }
}

/** Server-only transport. The authority callback can supply an interactive grant or an explicitly
 * approved BackgroundGrantClient.token(); neither workspaces nor assistant roles are required. */
export class SandboxClient {
  private readonly origin: URL;
  private readonly appId: string;
  private readonly service: string;
  constructor(private readonly authority: () => Promise<string>, options: ProviderServerOptions = {}) {
    this.origin = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!this.appId || !this.service || !["http:", "https:"].includes(this.origin.protocol) || this.origin.username || this.origin.password
      || this.origin.pathname !== "/" || this.origin.search || this.origin.hash) throw new Error("A valid Core origin and calling app service identity are required.");
  }
  plan(input: SandboxPlanInput): Promise<SandboxPlan> { return this.call("sandbox-plan", input as unknown as Record<string, unknown>); }
  prepare(input: { requestId: string; planId: string; digest: string }): Promise<SandboxInstance> { return this.call("sandbox-prepare", input); }
  list(): Promise<{ instances: SandboxInstance[] }> { return this.call("sandbox-list", {}); }
  status(runtimeInstanceId: string): Promise<SandboxInstance> { return this.call("sandbox-status", { runtimeInstanceId }); }
  command(runtimeInstanceId: string, action: "start" | "restart" | "stop" | "reset" | "dispose", input: { requestId: string; expectedRevision: number; seedRevision?: string }): Promise<SandboxInstance> {
    return this.call(`sandbox-${action}`, { runtimeInstanceId, ...input });
  }
  async call<T = unknown>(action: SandboxAction, input: Record<string, unknown>): Promise<T> {
    if (!sandboxActions.includes(action)) throw new SandboxError("sandbox_operation_invalid", "Unknown sandbox operation.", 400);
    const { runtimeInstanceId, ...body } = input;
    const jobId = body.jobId;
    const root = `/api/internal/apps/${encodeURIComponent(this.appId)}/sandbox-instances`;
    const read = action === "sandbox-logs" || action === "sandbox-list" || action === "sandbox-status" || action === "sandbox-export" || action === "sandbox-preview";
    let suffix = "";
    if (action === "sandbox-plan") suffix = "/plans";
    else if (action !== "sandbox-list" && action !== "sandbox-prepare") {
      if (typeof runtimeInstanceId !== "string" || !/^[a-f0-9]{32}$/.test(runtimeInstanceId))
        throw new SandboxError("sandbox_id_invalid", "Use the Core-issued runtime instance ID.", 400);
      suffix = `/${runtimeInstanceId}`;
      if (action === "sandbox-logs") suffix += "/diagnostics";
      else if (action === "sandbox-users") suffix += "/users";
      else if (action === "sandbox-user-delete") suffix += "/users/delete";
      else if (action === "sandbox-viewers") suffix += "/viewers";
      else if (action === "sandbox-evidence-clear") suffix += "/evidence/clear";
      else if (action === "sandbox-seed") suffix += "/seeds";
      else if (action === "sandbox-browser") suffix += "/browser-runs";
      else if (action === "sandbox-browser-cancel") suffix += "/browser-runs/cancel";
      else if (action === "sandbox-preview") suffix += "/preview" + (typeof body.userId === "string" ? "?userId=" + encodeURIComponent(body.userId) : "");
      else if (action === "sandbox-export") {
        if (typeof jobId !== "string" || !/^[a-f0-9]{32}$/.test(jobId)) throw new SandboxError("sandbox_job_invalid", "Select a recorded browser run.", 400);
        suffix += `/browser-runs/${jobId}`;
      }
      else if (!read) suffix += `/operations/${action.slice("sandbox-".length)}`;
    }
    if (!read && action !== "sandbox-plan" && (typeof body.requestId !== "string" || !/^[a-f0-9-]{32,36}$/i.test(body.requestId)))
      throw new SandboxError("sandbox_request_required", "Persist a request UUID before sending a mutation. Replay the same UUID and arguments after an uncertain result.", 400);
    const credential = await this.authority();
    let response: Response;
    try {
      response = await fetch(new URL(root + suffix, this.origin), { method: read ? "GET" : "POST", redirect: "error", cache: "no-store",
        headers: { authorization: `Bearer ${this.service}`, "X-Hosty-User-Token": credential, "content-type": "application/json" },
        body: read ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(action === "sandbox-browser" ? 330_000 : 180_000) });
    } catch { throw new SandboxError("sandbox_outcome_unknown", "Core could not confirm the outcome. Read the operation or replay its original request UUID and arguments.", null); }
    const result = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    if (!result) throw new SandboxError("sandbox_outcome_unknown", "Core returned no readable outcome; keep the original operation identity.", response.status);
    if (!response.ok) throw new SandboxError(result.code ?? "sandbox_failed", result.message ?? "Sandbox request failed.", response.status);
    return result as T;
  }
}

export const coreEnvironmentActions = ["environment-create", "environment-list", "environment-status", "environment-start",
  "environment-stop", "environment-restart", "environment-finish", "environment-setup", "environment-api"] as const;
export type CoreEnvironmentAction = typeof coreEnvironmentActions[number];
export interface CoreEnvironment { id: string; label: string; mode: string; projectPath?: string; context?: SandboxContext;
  state: string; revision: number; port: number; dataRoot?: string; previewUrl: string;
  process?: { pid: number; startedAt: string }; error?: string; operations: SandboxOperation[] }
/** Full child Core transport. Requires core.environments permissions and live administrator authority.
 * Setup uses ordinary password authentication. Parent credentials are never forwarded to the child. */
export class CoreEnvironmentClient {
  private readonly origin: URL;
  private readonly appId: string;
  private readonly service: string;
  constructor(private readonly authority: () => Promise<string>, options: ProviderServerOptions = {}) {
    this.origin = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!this.appId || !this.service || !["http:", "https:"].includes(this.origin.protocol) || this.origin.username || this.origin.password
      || this.origin.pathname !== "/" || this.origin.search || this.origin.hash) throw new Error("Core origin and app service identity are required.");
  }
  async call<T = unknown>(action: CoreEnvironmentAction, input: Record<string, unknown>): Promise<T> {
    if (!coreEnvironmentActions.includes(action)) throw new SandboxError("environment_operation_invalid", "Unknown environment operation.", 400);
    const { environmentId, ...body } = input;
    const read = action === "environment-list" || action === "environment-status";
    let suffix = "";
    if (action !== "environment-list" && action !== "environment-create") {
      if (typeof environmentId !== "string" || !/^[a-f0-9]{32}$/.test(environmentId)) throw new SandboxError("environment_id_invalid", "Select a Core-issued environment ID.", 400);
      suffix = `/${environmentId}` + (action === "environment-status" ? "" : action === "environment-api" ? "/api"
        : action === "environment-setup" ? "/setup" : `/operations/${action.slice("environment-".length)}`);
    }
    const replayable = !read && action !== "environment-api" && action !== "environment-setup";
    if (replayable && (typeof body.requestId !== "string" || !/^[a-f0-9-]{32,36}$/i.test(body.requestId)))
      throw new SandboxError("environment_request_required", "Persist a request UUID before sending lifecycle operations.", 400);
    let response: Response;
    try {
      response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.appId)}/core-environments${suffix}`, this.origin), {
        method: read ? "GET" : "POST", redirect: "error", cache: "no-store",
        headers: { authorization: `Bearer ${this.service}`, "X-Hosty-User-Token": await this.authority(), "content-type": "application/json" },
        body: read ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(490_000),
      });
    } catch { throw new SandboxError("environment_outcome_unknown", "Core did not confirm the outcome. Observe state; replay lifecycle UUIDs unchanged. Child API mutations follow their own recovery contract.", null); }
    const result = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    if (!result) throw new SandboxError("environment_outcome_unknown", "Core returned no readable outcome.", response.status);
    if (!response.ok) throw new SandboxError(result.code ?? "environment_failed", result.message ?? "Environment request failed.", response.status);
    return result as T;
  }
}
