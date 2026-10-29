import type { ProviderServerOptions } from "./providers-server.js";

export interface SandboxContext { workspaceId?: string; sessionId?: string; jobId?: string }
export interface SandboxOperation { id: string; kind: string; state: string; errorCode?: string; message?: string }
export class SandboxError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null) { super(message); this.name = "SandboxError"; }
}

export const coreEnvironmentActions = ["environment-consent", "environment-create", "environment-list", "environment-status", "environment-start",
  "environment-stop", "environment-restart", "environment-finish", "environment-setup", "environment-api", "environment-initialization", "environment-initialization-resume", "environment-setup-link"] as const;
export type CoreEnvironmentAction = typeof coreEnvironmentActions[number];
export interface CoreEnvironmentSavedConsent { id: string; appId: string; label: string; mode: string; target: string; state: string }
export interface CoreEnvironment { id: string; label: string; mode: string; projectPath?: string; context?: SandboxContext;
  state: string; revision: number; port: number; dataRoot?: string; previewUrl: string; initializationRequested?: boolean; coreVersion?: string | null;
  process?: { pid: number; startedAt: string }; error?: string; operations: SandboxOperation[];
  limits?: { memoryBytes: number; cpus: number; pids: number; diskBytes: number; applicationMemoryBytes: number; applicationCpus: number; applicationPids: number };
  access?: { state: string; grantId?: string; saved: boolean; description: string };
  usage?: { ownedDiskBytes: number; containerMemoryBytes: number; coreMemoryBytes: number; state: string; observedAt: string; error?: string } }
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
    const read = action === "environment-list" || action === "environment-status" || action === "environment-initialization";
    let suffix = action === "environment-consent" ? "/consent" : "";
    if (action !== "environment-list" && action !== "environment-create" && action !== "environment-consent") {
      if (typeof environmentId !== "string" || !/^[a-f0-9]{32}$/.test(environmentId)) throw new SandboxError("environment_id_invalid", "Select a Core-issued environment ID.", 400);
      suffix = `/${environmentId}` + (action === "environment-status" ? "" : action === "environment-api" ? "/api"
        : action === "environment-initialization" ? "/initialization" : action === "environment-initialization-resume" ? "/initialization/resume"
        : action === "environment-setup-link" ? "/setup-link" : action === "environment-setup" ? "/setup" : `/operations/${action.slice("environment-".length)}`);
    }
    const replayable = !read && action !== "environment-api" && action !== "environment-setup" && action !== "environment-setup-link" && action !== "environment-initialization-resume";
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
