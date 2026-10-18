import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UiHostContext } from "../../../packages/app-sdk/src/ui-context";
import type { ContextType } from "react";
import { EmbeddedAppFrame } from "../src/app/shell/embedding/embedded-app-frame";
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ launchAppPage: vi.fn() }), useShellState: () => ({ state: { apps: [{ id: "own", installationId: "installed-1", entryEndpoint: "web", embeddedUrl: "https://own.test/page", framePolicy: { microphone: false, popupEscape: false } }] } }) }));
it("opens review for the mounted frame, ignoring forged ids, and provides a popup fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    await act(async () => root.render(<UiHostContext.Provider value={{ getSnapshot: () => ({ bootstrap: { coreOrigin: "https://core.test" } }), registerFrame: () => () => {}, setViewChrome: () => {} } as unknown as ContextType<typeof UiHostContext>}><EmbeddedAppFrame src="https://own.test/page" title="Own" appId="own" theme="light" themePreference="light" /></UiHostContext.Provider>));
    const frame = container.querySelector("iframe")!;
    const send = (source: Window | null, origin = "https://own.test") => window.dispatchEvent(new MessageEvent("message", {
      origin, source, data: { type: "hosty:request-permission-review", appId: "victim", url: "https://evil.test" },
    }));
    await act(async () => { send(window); send(frame.contentWindow, "https://evil.test"); });
    expect(open).not.toHaveBeenCalled();
    await act(async () => { send(frame.contentWindow); });
    expect(open).toHaveBeenCalledWith("https://core.test/install/permissions/own", "_blank", "noopener,noreferrer");
    expect(container.querySelector("a")?.href).toBe("https://core.test/install/permissions/own");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups-to-escape-sandbox");
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
