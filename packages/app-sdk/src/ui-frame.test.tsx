// @vitest-environment jsdom
import React, { act, type ContextType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HostyAppFrame } from "./ui-frame";
import { UiHostContext } from "./ui-context";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("uses target frame policy and exact peer review routing, retaining a link when popups are blocked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element), open = vi.spyOn(window, "open").mockReturnValue(null), attention = vi.fn();
  const host = { getSnapshot: () => ({ bootstrap: { coreOrigin: "https://core.test" } }), registerFrame: () => () => {} } as unknown as ContextType<typeof UiHostContext>;
  const surface = { appId: "tool", installationId: "install", endpoint: "web", route: "/panel", origin: "https://tool.test", framePolicy: { microphone: true, popupEscape: false } };
  try {
    await act(async () => root.render(<UiHostContext.Provider value={host}><HostyAppFrame surface={surface} title="Tool" onAttention={attention} /></UiHostContext.Provider>));
    const frame = element.querySelector("iframe")!;
    expect(frame.getAttribute("allow")).toBe("clipboard-write; microphone 'src'");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups-to-escape-sandbox");
    const send = (data: object, origin = surface.origin, source: Window | null = frame.contentWindow) => window.dispatchEvent(new MessageEvent("message", { origin, source, data }));
    await act(async () => {
      send({ type: "hosty:request-mcp-review", targetAppId: "target" }, "https://foreign.test");
      send({ type: "hosty:request-permission-review" }, surface.origin, window);
    });
    expect(open).not.toHaveBeenCalled();
    await act(async () => send({ type: "hosty:request-mcp-review", appId: "victim", targetAppId: "target", url: "https://evil.test" }));
    expect(open).toHaveBeenLastCalledWith("https://core.test/install/agents/tool/target", "_blank", "noopener,noreferrer");
    expect(element.querySelector("a")!.href).toBe("https://core.test/install/agents/tool/target");
    await act(async () => send({ type: "hosty:request-permission-review", appId: "victim", url: "https://evil.test" }));
    expect(open).toHaveBeenLastCalledWith("https://core.test/install/permissions/tool", "_blank", "noopener,noreferrer");
    expect(element.querySelector("a")!.href).toBe("https://core.test/install/permissions/tool");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => send({ type: "hosty:request-token", audience: "hosty:core" }));
    expect(post).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it("delivers theme changes without navigating the tool and grants popup escape only from policy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  const surface = { appId: "tool", installationId: "install", endpoint: "web", route: "/panel?draft=existing", origin: "https://tool.test", framePolicy: { microphone: false, popupEscape: true } };
  try {
    await act(async () => root.render(<HostyAppFrame surface={surface} title="Tool" theme="light" />));
    const frame = element.querySelector("iframe")!, src = frame.src;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    await act(async () => frame.dispatchEvent(new Event("load")));
    await act(async () => root.render(<HostyAppFrame surface={surface} title="Tool" theme="dark" themePreference="dark" />));
    expect(element.querySelector("iframe")).toBe(frame); expect(frame.src).toBe(src);
    expect(frame.getAttribute("allow")).toBe("clipboard-write"); expect(frame.getAttribute("sandbox")).toContain("allow-popups-to-escape-sandbox");
    expect(post).toHaveBeenLastCalledWith({ type: "hosty:shell-theme", theme: "dark", preference: "dark" }, surface.origin);
  } finally { await act(async () => root.unmount()); element.remove(); }
});
