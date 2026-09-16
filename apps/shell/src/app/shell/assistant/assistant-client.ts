import type { CoreApp } from "../types";

// Shell discovers the gateway and creates app-bound sessions using Core-issued delegated tokens.
// The gateway's embedded page owns chat, history and streaming; Shell only selects its panel.
export const AI_GATEWAY_INTERFACE = "ai-gateway";

export type AssistantGateway = {
  appId: string;
  /** Resolved interface URL, e.g. http://127.0.0.1:3400/api */
  baseUrl: string;
  running: boolean;
};

/** Finds the installed ai-gateway provider among the apps Core reports. Hidden ⇒ no assistant UI. */
export function findAssistantGateway(apps: CoreApp[]): AssistantGateway | null {
  for (const app of apps) {
    const declarations = app.interfaces?.[AI_GATEWAY_INTERFACE];
    const url = declarations?.find((declaration) => declaration.url)?.url;
    if (url) {
      return { appId: app.id, baseUrl: url.replace(/\/$/, ""), running: app.runtimeState === "running" };
    }
  }
  return null;
}

/** Minimal operator client: Shell creates a session, while the gateway owns its conversation. */
export async function assistantRequest<T>(gateway: AssistantGateway, issue: (refresh: boolean) => Promise<{ token: string }>, route: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const grant = await issue(attempt > 0);
    const response = await fetch(`${gateway.baseUrl}${route}`, { ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && attempt === 0) continue;
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message ?? `Assistant request failed (${response.status}).`);
    return body as T;
  }
  throw new Error("Assistant authorization expired. Sign in again.");
}
export async function assistantSupportsContext(gateway: AssistantGateway, issue: (refresh: boolean) => Promise<{ token: string }>): Promise<boolean> {
  const health = await assistantRequest<{ harness?: { available?: boolean; capabilities?: { appContext?: boolean } } }>(gateway, issue, "/health");
  return health.harness?.available === true && health.harness?.capabilities?.appContext === true;
}
export async function createAppSession(gateway: AssistantGateway, issue: (refresh: boolean) => Promise<{ token: string }>, appId: string, clientRequestId: string): Promise<{ id: string }> {
  if (!await assistantSupportsContext(gateway, issue)) throw new Error("Assistant is unavailable. Check its runtime and sign-in, then retry.");
  // An uncertain network response is retried with the same id; only a later deliberate action
  // generates a new id. Server-side actor-scoped deduplication owns session identity.
  try {
    return await assistantRequest(gateway, issue, "/sessions", { method: "POST", body: JSON.stringify({ appIds: [appId], clientRequestId }) });
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    return assistantRequest(gateway, issue, "/sessions", { method: "POST", body: JSON.stringify({ appIds: [appId], clientRequestId }) });
  }
}
