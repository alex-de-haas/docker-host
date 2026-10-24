import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ShellAppDetailsRoute,
  ShellDashboardRoute,
  ShellHomeRoute,
  ShellSettingsRoute,
  ShellWorkspaceRoute,
} from "../src/app/shell/shell-route-pages";

const fixture = vi.hoisted(() => ({
  canManageApps: false,
  settingsTab: "profile",
  apps: [
    { id: "example.media", displayName: "Media", navigation: [{ label: "Media", path: "/" }] },
    { id: "example.worker", displayName: "Worker", navigation: [] },
  ],
  dashboard: vi.fn(),
  settings: vi.fn(),
  actions: { coreOrigin: "https://core.test", shellAppId: "hosty.shell" },
}));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellState: () => ({
    canManageApps: fixture.canManageApps,
    settingsTab: fixture.settingsTab,
    state: { apps: fixture.apps, status: null, loading: false, error: null },
    uiApps: fixture.apps.filter(app => app.navigation.length > 0),
    pendingAppActions: {},
    appSettingsTabs: [],
    globalMounts: [],
  }),
  useShellActions: () => fixture.actions,
}));
vi.mock("../src/app/shell/pages/dashboard-page", () => ({ DashboardPage: fixture.dashboard }));
vi.mock("../src/app/shell/pages/settings-page", () => ({ SettingsPage: fixture.settings }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.canManageApps = false;
  fixture.settingsTab = "profile";
  fixture.dashboard.mockReset().mockImplementation(() => <p>Dashboard content</p>);
  fixture.settings.mockReset().mockImplementation(({ activeTab }: { activeTab: string }) => <p>Settings: {activeTab}</p>);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renders an empty ordinary-user home even when launchable apps exist", async () => {
  await act(async () => root.render(<ShellHomeRoute />));
  expect(container.innerHTML).toBe("");
  expect(fixture.dashboard).not.toHaveBeenCalled();
  expect(fixture.settings).not.toHaveBeenCalled();
});

it("keeps the administrator home on Dashboard with the complete managed roster", async () => {
  fixture.canManageApps = true;
  await act(async () => root.render(<ShellHomeRoute />));
  expect(container.textContent).toBe("Dashboard content");
  expect(fixture.dashboard).toHaveBeenCalledOnce();
  expect(fixture.dashboard.mock.calls[0][0]).toEqual(expect.objectContaining({
    apps: fixture.apps, canManageApps: true, coreOrigin: "https://core.test", shellAppId: "hosty.shell",
  }));
});

it("guards a direct ordinary-user Dashboard route without rendering a replacement app overview", async () => {
  await act(async () => root.render(<ShellDashboardRoute />));
  expect(container.innerHTML).toBe("");
  expect(fixture.dashboard).not.toHaveBeenCalled();
});

it.each(["users", "ingress", "hosty.private-settings"])(
  "keeps the forbidden ordinary-user settings tab %s empty",
  async tab => {
    fixture.settingsTab = tab;
    await act(async () => root.render(<ShellSettingsRoute />));
    expect(container.innerHTML).toBe("");
    expect(fixture.settings).not.toHaveBeenCalled();
    expect(fixture.dashboard).not.toHaveBeenCalled();
  },
);

it.each(["profile", "tokens"])("preserves ordinary-user access to personal %s settings", async tab => {
  fixture.settingsTab = tab;
  await act(async () => root.render(<ShellSettingsRoute />));
  expect(container.textContent).toBe("Settings: " + tab);
  expect(fixture.settings.mock.calls[0][0]).toEqual(expect.objectContaining({ activeTab: tab, canManageApps: false }));
});

it("preserves administrator access to host settings", async () => {
  fixture.canManageApps = true;
  fixture.settingsTab = "users";
  await act(async () => root.render(<ShellSettingsRoute />));
  expect(fixture.settings.mock.calls[0][0]).toEqual(expect.objectContaining({ activeTab: "users", canManageApps: true }));
});

it.each([false, true])("does not duplicate persistent workspace/details content for admin=%s", async admin => {
  fixture.canManageApps = admin;
  await act(async () => root.render(<ShellWorkspaceRoute />));
  expect(container.innerHTML).toBe("");
  await act(async () => root.render(<ShellAppDetailsRoute />));
  expect(container.innerHTML).toBe("");
  expect(fixture.dashboard).not.toHaveBeenCalled();
  expect(fixture.settings).not.toHaveBeenCalled();
});
