// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://host.test/"}
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HostyPanelWorkspace, HostyUiRoot, useHostyUiHost } from "./ui-react";
import type { UiHost } from "./ui-host";
vi.mock("./browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

it.each(["catalog", "opened"] as const)("retains a pinned recovery link for an HTTP panel in the HTTPS %s workspace", async railMode => {
  const panel = { appId: "assistant", installationId: "assistant-1", panelId: "chat" };
  const framePolicy = { microphone: false, popupEscape: false };
  const target = { panel, route: "/panel?session=completed" };
  const standaloneHref = "https://core.test/open/pinned-completed-session";
  const surface = { ...panel, endpoint: "web", origin: "http://assistant.test", route: target.route, framePolicy };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.includes("bootstrap")) return Response.json({ version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
      app: { appId: "plans", installationId: "plans-1", origins: ["https://host.test"] } });
    if (path.endsWith("resolve")) return Response.json({ target, available: true, state: "running", standaloneHref, surface });
    return Response.json({ panels: [{ panel, ...surface, label: "Assistant", appName: "Assistant", icon: null, available: true, state: "running", canStart: false }] });
  }));
  const popup = vi.spyOn(window, "open");
  let host: UiHost | null = null;
  function Document() { host = useHostyUiHost(); return <textarea defaultValue="Document draft" />; }
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<HostyUiRoot panelLayout="slot"><HostyPanelWorkspace railMode={railMode}><Document /></HostyPanelWorkspace></HostyUiRoot>));
    await act(async () => {
      await host!.refresh();
      const result = await host!.openSurface(target, { placement: "side", requestId: crypto.randomUUID() });
      expect(result).toMatchObject({ status: "opened", readiness: "unreported" });
    });
    expect(host!.getSnapshot()).toMatchObject({ expanded: true, selected: panel, tools: [{ resolved: { standaloneHref }, readiness: "unreported" }] });
    expect(element.querySelector("iframe")).toBeNull();
    expect(element.textContent).toContain("Assistant needs HTTPS to appear here");
    const link = element.querySelector<HTMLAnchorElement>(".hosty-panel-notice a")!;
    expect(link.href).toBe(standaloneHref);
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(popup).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
