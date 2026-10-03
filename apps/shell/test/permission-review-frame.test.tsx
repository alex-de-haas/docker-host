import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EmbeddedAppFrame } from "../src/app/shell/embedding/embedded-app-frame";
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.test" }) }));
it("opens review for the mounted frame, ignoring forged ids, and provides a popup fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    await act(async () => root.render(<EmbeddedAppFrame src="https://own.test/page" title="Own" appId="own" theme="light" themePreference="light" />));
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
