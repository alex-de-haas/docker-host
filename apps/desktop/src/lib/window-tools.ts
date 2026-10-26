import { assistantContractError, createAssistantRequestId } from "@hosty-sdk/app/assistant";
import type { UiHost, UiPlacementResolver } from "@hosty-sdk/app/ui/host";
import { panelKey, type PanelTarget, type UiPanel } from "@hosty-sdk/app/ui";
import { desktopMutation } from "./api";
import type { App } from "./model";

export const windowWorkspace = (appId: string) => `desktop-${appId}`;
export function assistantFor(panel: UiPanel, apps: App[]) {
  const app = apps.find(item => item.id === panel.panel.appId && item.installationId === panel.panel.installationId);
  if (!app?.confirmedRoles?.includes("assistant")) return null;
  const declaration = app.interfaces?.assistant?.find(item => item.key === "default") ?? app.interfaces?.assistant?.[0];
  return declaration ? { appId: app.id, installationId: panel.panel.installationId, ...declaration } : null;
}
const targetKey = (target: PanelTarget) => JSON.stringify([panelKey(target.panel), target.route ?? null]);
/** Route host-originated handoffs to their owning window, leaving embedded view placement intact. */
export function createWindowPlacement() {
  const pending = new Map<string, string>();
  const resolve: UiPlacementResolver = ({ source, target }) => ({
    workspaceId: source.workspaceId === "default" ? pending.get(targetKey(target)) ?? source.workspaceId : source.workspaceId,
  });
  return { resolve, async open(host: UiHost, workspaceId: string, target: PanelTarget) {
    const key = targetKey(target); pending.set(key, workspaceId);
    try { return await host.openSurface(target, { placement: "side", requestId: createAssistantRequestId() }); }
    finally { if (pending.get(key) === workspaceId) pending.delete(key); }
  } };
}
export async function prepareWindowDiscussion(userId: string, context: App, panel: UiPanel, apps: App[]) {
  const assistant = assistantFor(panel, apps);
  if (!assistant) throw new Error("This tool does not declare an assistant interface.");
  const problem = assistantContractError(assistant);
  if (problem) throw new Error(problem);
  const key = `hosty.desktop.discussion:${JSON.stringify([userId, context.id, context.installationId, assistant.appId, assistant.installationId, assistant.key])}`;
  // Keep the request identity after uncertain transport outcomes. Retrying never submits a prompt.
  const saved = sessionStorage.getItem(key);
  const requestId = saved && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(saved) ? saved : createAssistantRequestId();
  sessionStorage.setItem(key, requestId);
  const result = await desktopMutation<{ target: PanelTarget }>("/api/assistant/discussion", {
    providerAppId: assistant.appId, installationId: assistant.installationId, key: assistant.key, contextAppId: context.id, contextInstallationId: context.installationId, requestId,
  }, 60_000);
  return { ...result, complete: () => { if (sessionStorage.getItem(key) === requestId) sessionStorage.removeItem(key); } };
}
