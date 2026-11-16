import type { AgentMcpTarget, AgentOperation, AgentSessionWorkflowRequest } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { DecisionClient } from "@hosty-sdk/app/decisions";
import type { VerifiedOperation } from "./store.js";

export interface ProviderAuthority {
  introspect(token: string, operation: AgentOperation, method: string, path: string, bodyHash: string): Promise<VerifiedOperation>;
  admit(admissionRef: string): Promise<unknown>;
  renew(admissionRef: string): Promise<unknown>;
  mcp(admissionRef: string, target: AgentMcpTarget, tools?: string[]): Promise<{ url: string; token: string; expiresAt: string }>;
  workspace<T>(admissionRef: string, operation: string, input: unknown): Promise<T>;
  skills(admissionRef: string, requestId: string, configurationId: string, skills: Array<{ skillId: string; expectedDigest?: string }>): Promise<{ id: string; path: string; digest: string; skills: Array<{ skillId: string; digest: string }> }>;
  decisions(admissionRef: string): DecisionClient;
  workflow<T>(admissionRef: string, action: string, input: Record<string, unknown>, source?: AgentSessionWorkflowRequest["source"]): Promise<T>;
}

/** Each hop uses this provider's service identity and the original admitted actor retained by Core. */
export class CoreAuthority implements ProviderAuthority {
  constructor(readonly origin: string, readonly appId: string, private readonly serviceToken: string) {}
  private async request(route: string, body: unknown, timeoutMs = 10_000): Promise<Response> {
    try {
      return await fetch(`${this.origin.replace(/\/$/, "")}/api/internal/apps/${encodeURIComponent(this.appId)}/agent${route}`, {
        method: "POST", headers: { authorization: `Bearer ${this.serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new AgentApiError("core_unavailable", "Core is unavailable. The operation has not been authorized.", 503, true); }
  }
  private async json<T>(route: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    const response = await this.request(route, body, timeoutMs);
    const value = await response.json().catch(() => null) as { code?: string; message?: string; error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new AgentApiError(value?.error?.code ?? value?.code ?? "core_rejected", value?.error?.message ?? value?.message ?? "Core rejected this operation.", response.status, response.status >= 500);
    if (!value) throw new AgentApiError("core_response_invalid", "Core returned no authorized result.", 502);
    return value as T;
  }
  async introspect(token: string, operation: AgentOperation, method: string, path: string, bodyHash: string) {
    const result = await this.json<VerifiedOperation>("/introspect", { token, operation, method, path, bodyHash });
    // Core serializes absent nullable metadata as JSON null. It imposes no optional
    // configuration constraint until a caller supplies a concrete digest.
    for (const key of ["sessionId", "runId", "configurationDigest", "ceiling"] as const)
      if (result[key] === null) delete result[key];
    return result;
  }
  admit(admissionRef: string) { return this.json("/admit", { admissionRef }); }
  renew(admissionRef: string) { return this.json("/renew", { admissionRef }); }
  mcp(admissionRef: string, target: AgentMcpTarget, tools?: string[]) { return this.json<{ url: string; token: string; expiresAt: string }>("/mcp/token", { admissionRef, target, tools }); }
  workspace<T>(admissionRef: string, operation: string, input: unknown) { return this.json<T>("/workspace", { admissionRef, operation, input }); }
  workflow<T>(admissionRef: string, action: string, input: Record<string, unknown>, source?: AgentSessionWorkflowRequest["source"]) { return this.json<T>("/workflow", { admissionRef, action, input, ...(source ? { source } : {}) }, 120_000); }
  skills(admissionRef: string, requestId: string, configurationId: string, skills: Array<{ skillId: string; expectedDigest?: string }>) {
    return this.json<{ id: string; path: string; digest: string; skills: Array<{ skillId: string; digest: string }> }>("/skills/snapshots", { admissionRef, requestId, configurationId, skills });
  }
  decisions(admissionRef: string): DecisionClient {
    return new DecisionClient((route, method, body, signal) => fetch(`${this.origin.replace(/\/$/, "")}/api/internal/apps/${encodeURIComponent(this.appId)}/decisions/v1${route}`, {
      method, headers: { authorization: `Bearer ${this.serviceToken}`, "content-type": "application/json", "X-Hosty-Agent-Execution": admissionRef },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: signal ?? AbortSignal.timeout(10_000),
    }));
  }
}
