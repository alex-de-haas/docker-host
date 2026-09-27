import type { CoreApp } from "../types";
import { AssistantClient, assistantContractError, createAssistantRequestId, resolveAssistantDestination, type AssistantHandoffResult } from "@hosty-sdk/app/assistant";
export { createAssistantRequestId };
export const ASSISTANT_INTERFACE = "assistant";
export type AssistantGateway = {
  appId: string; baseUrl: string; running: boolean;
  version?: number | null; capabilities?: readonly string[] | null; problem?: string | null;
};
export function findAssistantGateways(apps: readonly CoreApp[]): AssistantGateway[] {
  return apps.flatMap(app => {
    if (!app.confirmedRoles?.includes("assistant")) return [];
    const declarations = app.interfaces?.assistant;
    if (!declarations?.length) return [];
    const declaration = declarations.find(item => item.key === "default") ?? declarations[0]!;
    return [{ appId: app.id, baseUrl: declaration.url?.replace(/\/$/, "") ?? "",
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


export function assistantSupportsContext(gateway: AssistantGateway, _issue?: (refresh: boolean) => Promise<{ token: string }>): Promise<boolean> {
  void _issue;
  return Promise.resolve(gateway.running && !assistantContractError(gateway));
}
export function assistantOpenUrl(app: CoreApp, result: AssistantHandoffResult): string {
  return resolveAssistantDestination(result.open, [
    ...(app.panelSurfaces ?? []).map(surface => ({ ...surface, url: surface.embeddedUrl })),
    ...(app.navigation ?? []).map(surface => ({ ...surface, url: surface.embeddedUrl })),
    { endpoint: app.entryEndpoint, path: app.entryPath, url: app.embeddedUrl },
  ]);
}
export async function createHandoff(gateway: AssistantGateway, issue: (refresh: boolean) => Promise<{ token: string }>,
  prompt: string, appIds: string[], requestId: string): Promise<{ id: string; result: AssistantHandoffResult }> {
  const client = new AssistantClient(gateway.baseUrl, gateway, issue);
  const run = async () => {
    const prepared = await client.prepare({ requestId, prompt, appIds });
    const finalized = await client.finalize(prepared.handoffId, []);
    if (!finalized.result) throw new Error("The assistant did not return a finalized handoff.");
    return { id: finalized.conversationId, result: finalized.result };
  };
  try { return await run(); } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    return run(); // Repeat the same identities after transport uncertainty.
  }
}
export function createAppSession(gateway: AssistantGateway, issue: (refresh: boolean) => Promise<{ token: string }>, appId: string, requestId: string) {
  return createHandoff(gateway, issue, "", [appId], requestId);
}
export function createErrorSession(gateway: AssistantGateway, issue: (refresh: boolean) => Promise<{ token: string }>, appId: string | undefined, requestId: string, prompt = "") {
  return createHandoff(gateway, issue, prompt, appId ? [appId] : [], requestId);
}

/** Retain uncertain intents across page reloads; clear only after the destination is accepted. */
export async function pendingAssistantIntent(userId: string | null, assistantId: string, prompt: string, appIds: string[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([userId, assistantId, prompt, [...appIds].sort()])));
  const key = `hosty:assistant-intent:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const requestId = sessionStorage.getItem(key) ?? createAssistantRequestId();
  sessionStorage.setItem(key, requestId);
  return { requestId, complete: () => sessionStorage.removeItem(key) };
}
