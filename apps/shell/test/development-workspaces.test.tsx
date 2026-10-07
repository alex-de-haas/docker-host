import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentWorkspaces } from "../src/app/shell/pages/development-workspaces";
const state = vi.hoisted(() => ({ apps: [] as { id: string; displayName: string; grantedCorePermissions: string[]; embeddedUrl: string | null }[] }));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellActions: () => ({ coreOrigin: "https://core.test" }), useShellState: () => ({ state }),
}));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn());
  state.apps = []; container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("does not read workspaces with Shell credentials and explains the missing source tool", async () => {
  await act(async () => root.render(<DevelopmentWorkspaces />));
  expect(fetch).not.toHaveBeenCalled(); expect(container.textContent).toContain("No app with source access is available");
});
it("discovers an upgraded Harness full-source grant without including documentation readers", async () => {
  state.apps = [
    { id: "hosty.harness", displayName: "Harness", grantedCorePermissions: ["apps.sources.full"], embeddedUrl: "https://tool.test/" },
    { id: "hosty.plans", displayName: "Plans", grantedCorePermissions: ["apps.sources.read"], embeddedUrl: "https://plans.test/" },
    { id: "other", displayName: "Other", grantedCorePermissions: ["apps.read"], embeddedUrl: "https://other.test/" },
  ];
  await act(async () => root.render(<DevelopmentWorkspaces />));
  const links = container.querySelectorAll("a"); expect(links).toHaveLength(1);
  const target = new URL(links[0].href); expect(target.origin).toBe("https://core.test");
  expect(target.pathname).toBe("/api/apps/hosty.harness/open"); expect(target.searchParams.get("redirectUri")).toBe("https://tool.test/");
  expect(fetch).not.toHaveBeenCalled();
});
