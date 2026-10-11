// @vitest-environment-options {"url":"https://shell.test/"}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EmbeddedWorkspacePanel } from "../src/app/shell/workspace/embedded-workspace-panel";
import { AppSettingsTabPanel } from "../src/app/shell/pages/settings-app-section";
import { ShellRightPanel } from "../src/app/shell/surfaces/shell-right-panel";
import type { AppSurfaceTab } from "../src/app/shell/surfaces/app-surface-tabs";
import type { EmbeddedWorkspace } from "../src/app/shell/types";

vi.mock("../src/app/shell/shell-context", () => ({ useShellState: () => ({ state: { apps: [{
  id: "tool", installationId: "installed", entryEndpoint: "web", embeddedUrl: "http://tool.test/",
  framePolicy: { microphone: false, popupEscape: false },
}] } }) }));
const workspace: EmbeddedWorkspace = { appId: "tool", title: "Tool", pageLabel: "Document", path: "/document",
  src: "http://tool.test/document?hosty_launch=embedded", externalUrl: "https://core.test/api/apps/tool/open?redirectUri=http%3A%2F%2Ftool.test%2Fdocument" };
const tab: AppSurfaceTab = { appId: "tool", key: "tool#settings", label: "Tool", embeddedUrl: "http://tool.test/settings?section=general",
  running: true, transitioning: false, runtimeState: "running", readiness: "ready" };
const launch = async () => `${tab.embeddedUrl}&hosty_launch=embedded`;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "open").mockReturnValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["workspace", "settings", "panel"])("retains explicit standalone recovery for an HTTP %s surface in HTTPS Shell", async surface => {
  expect(window.location.protocol).toBe("https:");
  await act(async () => root.render(surface === "workspace"
    ? <EmbeddedWorkspacePanel workspace={workspace} theme="light" themePreference="system" />
    : surface === "settings"
      ? <AppSettingsTabPanel tab={tab} theme="light" themePreference="system" onOpenSurfaceFrame={launch} />
      : <ShellRightPanel tabs={[tab]} activeTab={tab} expanded theme="light" themePreference="system" onSelectTab={() => {}} onOpenSurfaceFrame={launch} />));
  expect(container.querySelector("iframe")).toBeNull();
  const link = container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
  expect(link?.textContent).toBe("Open separately");
  expect(link.href).toBe(surface === "workspace" ? workspace.externalUrl : tab.embeddedUrl);
  expect(link.href).not.toContain("hosty_launch=embedded");
  expect(link.rel).toBe("noopener noreferrer");
  expect(window.open).not.toHaveBeenCalled();
});

it("continues embedding an HTTPS workspace instead of rendering recovery chrome", async () => {
  await act(async () => root.render(<EmbeddedWorkspacePanel workspace={{ ...workspace, src: "https://tool.test/document?hosty_launch=embedded" }} theme="light" themePreference="system" />));
  expect(container.querySelector("iframe")?.src).toContain("https://tool.test/document");
  expect(container.querySelector("a")).toBeNull();
});
