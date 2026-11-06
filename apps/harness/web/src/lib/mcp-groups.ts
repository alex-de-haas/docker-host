import type { Provider, ToolCatalog } from "./api";

export const coreFeatures = [
  ["host", "Host & Core"], ["apps", "App management"], ["logs", "Logs & audit"],
  ["workspaces", "Workspaces"], ["git", "Git & pull requests"], ["app-creation", "App creation"],
  ["development", "Runtime & development"], ["environments", "Test environments"],
  ["agent-sessions", "Agent sessions"], ["history", "History & search"], ["tasks", "Tasks"],
  ["workflow", "Work lifecycle"],
] as const;
export type McpRow = { id: string; title: string; provider: Provider; catalog?: ToolCatalog; tools: ToolCatalog["tools"]; feature: boolean };

// This metadata is trusted only on the reserved Core resource. An application's claims about
// ownership never move its tools into the platform group. Unknown schemas remain visible.
function featureOf(tool: ToolCatalog["tools"][number]): string {
  const value = tool._meta?.["io.hosty/core-tool"];
  if (!value || typeof value !== "object") return "other";
  const metadata = value as { owner?: unknown; schemaVersion?: unknown; feature?: { id?: unknown } };
  return metadata.owner === "hosty:core" && metadata.schemaVersion === 1 &&
    coreFeatures.some(([id]) => id === metadata.feature?.id) ? metadata.feature!.id as string : "other";
}
export function mcpGroups(providers: Provider[], catalogs: ToolCatalog[]): { title: string; rows: McpRow[] }[] {
  const core = providers.find(p => p.appId === "hosty:core"), catalog = catalogs.find(c => c.provider === "hosty:core");
  const rows: McpRow[] = core ? [...coreFeatures, ["other", "Other Hosty tools"] as const].flatMap(([id, title]) => {
    const tools = catalog?.tools.filter(t => featureOf(t) === id) ?? [];
    return tools.length ? [{ id, title, provider: core, catalog, tools, feature: true }] : [];
  }) : [];
  if (core && !catalog) rows.push({ id: "unavailable", title: "Hosty tools", provider: core, tools: [], feature: true });
  const applications = providers.filter(p => p.appId !== "hosty:core").map(provider => {
    const catalog = catalogs.find(c => c.provider === provider.appId);
    return { id: provider.appId, title: provider.displayName, provider, catalog, tools: catalog?.tools ?? [], feature: false };
  });
  return [{ title: "Hosty tools", rows }, { title: "Applications", rows: applications }];
}
