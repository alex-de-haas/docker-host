import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellSidebar } from "../src/app/shell/sidebar/shell-sidebar";
import { ShellMobileTabs } from "../src/app/shell/chrome/shell-mobile-tabs";
import type { CoreApp } from "../src/app/shell/types";
import type { UiHost, UiHostSnapshot } from "@hosty-sdk/app/ui/host";

const toolUi = vi.hoisted(() => ({ host: null as Pick<UiHost, "getSnapshot" | "subscribeSnapshot" | "collapseWorkspace"> | null }));
vi.mock("@hosty-sdk/app/ui/react", () => ({
  useHostyUiHost: () => toolUi.host,
  useHostyChrome: () => ({ tools: { enabled: false, launcher: "hide" } }),
}));

let root: Root, container: HTMLDivElement;
const app = (id: string, name: string, runtimeState = "running"): CoreApp => ({
  id, displayName: name, runtimeState, operationStatus: "started", version: "1.0.0", kind: "runtime", system: false,
  source: "manifest", capabilities: [], autostart: false,
  navigation: [{ label: "Library", path: "/library", embeddedUrl: `https://${id}.test/library`, service: "web" }],
});
const running = app("example.notes", "Notes"), stopped = app("example.archive", "Archive", "stopped");
const sidebarProps = (): ComponentProps<typeof ShellSidebar> => ({
  compact: false, activeView: "dashboard", workspace: null, coreOrigin: "https://core.test", activeUser: null,
  canManageApps: true, uiApps: [running, stopped], busyAction: null, onNavigate: vi.fn(), settingsPages: [],
  selectedSettings: "profile", onOpenSettings: vi.fn(), onLaunchApp: vi.fn(async () => true), onStartApp: vi.fn(),
  getStandaloneHref: (selected, page) => `https://core.test/open/${selected.id}?path=${page.path}`,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toolUi.host = null;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label)!;

it.each([false, true])("keeps direct app launch rows while the Apps heading is noninteractive (compact=%s)", async compact => {
  const props = { ...sidebarProps(), compact };
  await act(async () => root.render(<ShellSidebar {...props} />));
  const heading = [...container.querySelectorAll("h2")].find(node => node.textContent === "Apps")!;
  expect(heading).toBeDefined();
  expect(heading.querySelector("button,a")).toBeNull();
  expect(button("Apps")).toBeUndefined();
  expect(button("All apps")).toBeUndefined();
  expect(container.querySelector('a[href="/apps"]')).toBeNull();
  await act(async () => heading.click());
  expect(props.onNavigate).not.toHaveBeenCalled();
  await act(async () => button("Notes").click());
  expect(props.onLaunchApp).toHaveBeenCalledExactlyOnceWith(running, {
    label: "Library", path: "/library", redirectUri: "https://example.notes.test/library", iconUrl: null, service: "web",
  }, "workspace");
  expect(props.onNavigate).not.toHaveBeenCalled();
});

it("retains stopped-app start authority and in-flight disabling without making its page launchable", async () => {
  const props = sidebarProps(); await act(async () => root.render(<ShellSidebar {...props} />));
  expect(button("Archive").disabled).toBe(true);
  await act(async () => button("Start Archive").click());
  expect(props.onStartApp).toHaveBeenCalledExactlyOnceWith(stopped.id);
  expect(props.onLaunchApp).not.toHaveBeenCalled();
  await act(async () => root.render(<ShellSidebar {...props} busyAction={`${stopped.id}:start`} />));
  expect(button("Start Archive").disabled).toBe(true);
  await act(async () => button("Start Archive").click());
  expect(props.onStartApp).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<ShellSidebar {...props} canManageApps={false} onStartApp={undefined} />));
  expect(button("Start Archive")).toBeUndefined();
  expect(button("Dashboard")).toBeUndefined();
  expect(button("Notes").disabled).toBe(false);
});

it.each([false, true])("opens the phone app sidebar without navigation for canManage=%s", async canManage => {
  const onNavigate = vi.fn(), onOpenApps = vi.fn();
  await act(async () => root.render(<ShellMobileTabs active="workspace" canManage={canManage} onNavigate={onNavigate} onOpenApps={onOpenApps} />));
  expect(button("Apps").getAttribute("aria-current")).toBe("page");
  await act(async () => button("Apps").click());
  expect(onOpenApps).toHaveBeenCalledExactlyOnceWith();
  expect(onNavigate).not.toHaveBeenCalled();
  await act(async () => button("Settings").click());
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("settings");
  if (canManage) {
    await act(async () => button("Dashboard").click());
    expect(onNavigate).toHaveBeenLastCalledWith("dashboard");
  } else expect(button("Dashboard")).toBeUndefined();
  await act(async () => root.render(<ShellMobileTabs active="home" canManage={canManage} onNavigate={onNavigate} onOpenApps={onOpenApps} />));
  expect(button("Apps").hasAttribute("aria-current")).toBe(false);
});

it("collapses the tool sheet before opening the phone app sidebar without releasing its selected tool", async () => {
  const panel = { appId: "example.notes", installationId: "notes-one", panelId: "discussion" };
  const surface = { ...panel, endpoint: "web", route: "/discussion", origin: "https://notes.test", framePolicy: { microphone: false, popupEscape: false } };
  const tools: UiHostSnapshot["tools"] = [{ key: "notes-discussion", presentationId: "retained-discussion", workspaceId: "default", target: { panel },
    resolved: { target: { panel }, surface, available: true, state: "running", standaloneHref: "https://core.test/open" },
    panelSurface: surface, readiness: "ready", attention: 0, currentRoute: "/discussion", focusedAt: 1 }];
  let snapshot: UiHostSnapshot = { bootstrap: null, catalog: [], tools, selected: panel, expanded: true, width: 360, error: null,
    workspaces: [{ workspaceId: "default", selectedId: "retained-discussion", expanded: true, width: 360 }] };
  const listeners = new Set<() => void>(), order: string[] = [];
  const collapse = vi.fn((id: string) => {
    order.push(`collapse:${id}`);
    snapshot = { ...snapshot, expanded: false, workspaces: snapshot.workspaces!.map(workspace => workspace.workspaceId === id ? { ...workspace, expanded: false } : workspace) };
    listeners.forEach(listener => listener());
  });
  toolUi.host = { getSnapshot: () => snapshot, subscribeSnapshot: listener => { listeners.add(listener); return () => listeners.delete(listener); }, collapseWorkspace: collapse };
  const onNavigate = vi.fn(), onOpenApps = vi.fn(() => {
    order.push("open:apps");
    expect(snapshot.workspaces?.[0].expanded).toBe(false);
  });
  await act(async () => root.render(<ShellMobileTabs active="workspace" canManage onNavigate={onNavigate} onOpenApps={onOpenApps} />));
  await act(async () => button("Apps").click());
  expect(collapse).toHaveBeenCalledExactlyOnceWith("default");
  expect(onOpenApps).toHaveBeenCalledExactlyOnceWith();
  expect(order).toEqual(["collapse:default", "open:apps"]);
  expect(onNavigate).not.toHaveBeenCalled();
  expect(snapshot.tools).toBe(tools);
  expect(snapshot.workspaces?.[0].selectedId).toBe("retained-discussion");
});
