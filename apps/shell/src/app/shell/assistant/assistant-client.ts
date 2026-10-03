import type { CoreApp } from "../types";
import { assistantContractError, createAssistantRequestId, resolveAssistantDestination, type AssistantHandoffResult } from "@hosty-sdk/app/assistant";
export { createAssistantRequestId };
export const ASSISTANT_INTERFACE = "assistant";
export type AssistantGateway = {
  appId: string; key?: string; baseUrl: string; running: boolean;
  version?: number | null; capabilities?: readonly string[] | null; problem?: string | null;
};
export function findAssistantGateways(apps: readonly CoreApp[]): AssistantGateway[] {
  return apps.flatMap(app => {
    if (!app.confirmedRoles?.includes("assistant")) return [];
    const declarations = app.interfaces?.assistant;
    if (!declarations?.length) return [];
    const declaration = declarations.find(item => item.key === "default") ?? declarations[0]!;
    return [{ appId: app.id, key: declaration.key, baseUrl: declaration.url?.replace(/\/$/, "") ?? "",
      running: app.runtimeState === "running" && !!declaration.url, version: declaration.version,
      capabilities: declaration.capabilities, problem: assistantContractError(declaration) }];
  });
}
export function selectAssistant(assistants: readonly AssistantGateway[], selectedId: string | null): AssistantGateway | null {
  const candidate = selectedId !== null ? assistants.find(app => app.appId === selectedId)
    : assistants.length === 1 ? assistants[0] : null;
  return candidate && !candidate.problem ? candidate : null;
}
/** Pending handoffs stay with the chosen app and actor across tab/preference changes. */
export function assistantMessageFor<T extends { userId: string | null; appId: string }>(
  message: T | null,
  userId: string | null,
  activeAppId: string | undefined,
  eligibleAppIds: readonly string[],
): T | null {
  return message && message.userId === userId && message.appId === activeAppId
    && eligibleAppIds.includes(message.appId) ? message : null;
}


export function assistantSupportsContext(gateway: AssistantGateway): Promise<boolean> {
  return Promise.resolve(gateway.running && !assistantContractError(gateway));
}
export function assistantOpenUrl(app: CoreApp, result: AssistantHandoffResult): string {
  return resolveAssistantDestination(result.open, [
    ...(app.panelSurfaces ?? []).map(surface => ({ ...surface, url: surface.embeddedUrl })),
    ...(app.navigation ?? []).map(surface => ({ ...surface, url: surface.embeddedUrl })),
    { endpoint: app.entryEndpoint, path: app.entryPath, url: app.embeddedUrl },
  ]);
}
type SendHandoff = (path: string, body: unknown) => Promise<Response>;
export async function createHandoff(gateway: AssistantGateway, send: SendHandoff,
  prompt: string, appIds: string[], requestId: string): Promise<{ id: string; result: AssistantHandoffResult }> {
  const incompatible = assistantContractError(gateway);
  if (incompatible) throw new Error(incompatible);
  const input = { providerAppId: gateway.appId, key: gateway.key ?? "default", prompt, appIds, requestId };
  const run = async () => {
    const response = await send("/api/assistant/handoff", input);
    return response.json() as Promise<{ id: string; result: AssistantHandoffResult }>;
  };
  try { return await run(); } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    return run(); // The server repeats prepare/finalize with the same durable request identity.
  }
}
export function createAppSession(gateway: AssistantGateway, send: SendHandoff, appId: string, requestId: string) {
  return createHandoff(gateway, send, "", [appId], requestId);
}
export function createErrorSession(gateway: AssistantGateway, send: SendHandoff, appId: string | undefined, requestId: string, prompt = "") {
  return createHandoff(gateway, send, prompt, appId ? [appId] : [], requestId);
}

/** Retain uncertain intents across page reloads; clear only after the destination is accepted. */
export async function pendingAssistantIntent(userId: string | null, assistantId: string, prompt: string, appIds: string[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([userId, assistantId, prompt, [...appIds].sort()])));
  const key = `hosty:assistant-intent:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const requestId = sessionStorage.getItem(key) ?? createAssistantRequestId();
  sessionStorage.setItem(key, requestId);
  return { requestId, complete: () => sessionStorage.removeItem(key) };
}
