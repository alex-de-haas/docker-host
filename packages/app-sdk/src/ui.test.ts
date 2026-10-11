import { describe, expect, it } from "vitest";
import { resolveAssistantPresentation, type AssistantHandoffResult } from "./assistant";
import type { ProviderDescriptor } from "./providers";
import { buildSurfaceOpenUrl, isSurfaceRoute, routeWithin } from "./ui-types";

const expectedProvider = { appId: "assistant", installationId: "install-1", key: "default" };
const provider: ProviderDescriptor = { ...expectedProvider, displayName: "Assistant", kind: "assistant", version: 1,
  capabilities: ["attachments"], url: "https://assistant.test/api", available: true,
  uiSurfaces: [
    { endpoint: "web", path: "/", url: "https://assistant.test/", kind: "entrypoint" },
    { endpoint: "web", path: "/assistant", url: "https://assistant.test/assistant", kind: "panel", panelId: "chat" },
  ] };
const result: AssistantHandoffResult = { conversationId: "conversation-1", disposition: "draft",
  open: { endpoint: "web", path: "/assistant/conversation-1?draft=1#composer" } };

describe("finalized assistant presentation", () => {
  it("keeps the exact route and frozen installation without selecting a provider", () => {
    const mapped = resolveAssistantPresentation(provider, result, { expectedProvider });
    expect(mapped.target).toEqual({ panel: { appId: "assistant", installationId: "install-1", panelId: "chat" }, route: result.open.path });
    const link = new URL(buildSurfaceOpenUrl("https://core.test", mapped.destination));
    expect(link.searchParams.get("installationId")).toBe("install-1");
    expect(link.searchParams.get("route")).toBe(result.open.path);
    expect(link.pathname).toBe("/api/apps/assistant/open");
  });
  it("refuses changed provider installation, app or key even at the same URL", () => {
    for (const changed of [{ installationId: "install-2" }, { appId: "other" }, { key: "other" }])
      expect(() => resolveAssistantPresentation({ ...provider, ...changed }, result, { expectedProvider })).toThrow(/original assistant/);
  });
  it("does not infer panels from navigation, and retains separate opening", () => {
    expect(resolveAssistantPresentation({ ...provider, uiSurfaces: provider.uiSurfaces!.filter(s => s.kind !== "panel") }, result,
      { expectedProvider })).toMatchObject({ target: null, reason: "no_panel", destination: { route: result.open.path } });
  });
  it("chooses the longest path boundary, requires IDs on ties and validates explicit IDs", () => {
    const narrow = { endpoint: "web", path: "/assistant/conversation-1", url: "https://assistant.test/assistant/conversation-1", kind: "panel" as const, panelId: "narrow" };
    const p = { ...provider, uiSurfaces: [...provider.uiSurfaces!, narrow] };
    expect(resolveAssistantPresentation(p, result, { expectedProvider }).target?.panel.panelId).toBe("narrow");
    p.uiSurfaces.push({ ...narrow, panelId: "second" });
    expect(resolveAssistantPresentation(p, result, { expectedProvider }).reason).toBe("ambiguous_surface");
    expect(resolveAssistantPresentation(p, { ...result, open: { ...result.open, panelId: "second" } }, { expectedProvider }).target?.panel.panelId).toBe("second");
    expect(() => resolveAssistantPresentation(p, { ...result, open: { ...result.open, panelId: "missing" } }, { expectedProvider })).toThrow(/panel/);
  });
});

describe("surface paths", () => {
  it.each(["//foreign.test/x", "https://foreign.test/", "/a/../b", "/a/%2e%2e/b", "/a/%2f/b", "/a/%255c", "/a\\b", "/a\n", "/a/%xx"])("rejects %s before URL normalization", route => {
    expect(isSurfaceRoute(route)).toBe(false);
  });
  it("keeps encoded query/fragment and requires segment boundaries", () => {
    expect(routeWithin("/assistant/a?q=%2f#draft", "/assistant")).toBe(true);
    expect(routeWithin("/assistant-other", "/assistant")).toBe(false);
  });
});
