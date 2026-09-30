// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContextAppIcon } from "./context-app-icon";
it("loads the asset first, falls back on failure and retries a changed asset", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const app = { id: "media", displayName: "Media Server", available: true, iconUrl: "http://127.0.0.1:7070/api/apps/media/assets/icon.svg" };
  try {
    await act(async () => root.render(<ContextAppIcon app={app} />));
    expect(container.querySelector("img")?.src).toBe(`http://${window.location.hostname}:7070/api/apps/media/assets/icon.svg`);
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull(); expect(container.querySelector("svg")).not.toBeNull();
    await act(async () => root.render(<ContextAppIcon app={{ ...app, iconUrl: app.iconUrl + "?v=2" }} />));
    expect(container.querySelector("img")?.src).toContain("?v=2");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
