import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/app/shell/pages/dashboard-page";
import type { CoreApp } from "../src/app/shell/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../src/app/shell/workspace-sources", () => ({ useWorkspaceSources: () => [], coreWorkspaceSource: () => undefined, workspaceSource: () => undefined }));
vi.mock("../src/app/shell/execution-targets", () => ({ useExecutionTargets: () => [] }));
vi.mock("../src/app/shell/core-development", () => ({ useCoreDevelopment: () => ({ state: null, busy: false, phase: null, refresh: vi.fn() }), CoreGitCell: () => null }));
vi.mock("../src/app/shell/core-workspace-control", () => ({ useCoreWorkspaceControl: () => ({ busy: false, control: null, dialog: null }) }));
vi.mock("../src/app/shell/core-stop", () => ({ useCoreStop: () => ({ busy: false, phase: null, dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", () => ({ ResourceUsageProvider: ({ children }: { children: ReactNode }) => children, ResourceUsage: () => null }));
vi.mock("../src/app/shell/source/source-changes", () => ({ SourceVersionCell: () => null }));
vi.mock("../src/app/shell/pages/dashboard-sandboxes", () => ({ DashboardSandboxes: () => null }));

let root: Root, container: HTMLDivElement, apps: CoreApp[];
let resize: () => void;
let compactVisible: boolean;
const onAction = vi.fn();
const app = (id: string, runtimeState: string): CoreApp => ({ id, displayName: id, runtimeState,
  version: "1.0.0", kind: "runtime", system: false, source: "package", operationStatus: "idle", capabilities: [] });
const trigger = () => container.querySelector<HTMLButtonElement>('.dashboard-state-filters-compact button')!;
const wide = (name: string) => container.querySelector<HTMLButtonElement>(`.dashboard-state-filters-wide [aria-label="${name}"]`)!;
const menuItem = (name: string) => document.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="${name}"]`)!;
const rows = () => [...container.querySelectorAll('[role="region"][aria-label="Installed apps"] .dashboard-table tbody tr')].map(row => row.textContent);
async function render(canManageApps = false) {
  await act(async () => root.render(<DashboardPage coreOrigin="https://core.test" apps={apps} status={null} coreUpdate={null} coreUpdating={false}
    canManageApps={canManageApps} loading={false} busyAction={null} pendingAppActions={{}} updateCheck={null} shellAppId="shell.app"
    onUpdateCore={() => {}} onRefresh={() => {}} onInstall={() => {}} onAction={onAction} onSwitchRuntime={() => {}}
    onUpdateApp={() => {}} onCheckUpdates={() => {}} onUpdateAll={() => {}} onOpenPanel={() => {}} />));
}
async function openMenu() {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: () => void) {} observe(element: Element) { if (element.classList.contains("dashboard-layout")) resize = this.callback; } disconnect() {} });
  compactVisible = true;
  onAction.mockClear();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function(this: HTMLElement) {
    return (this.closest('.dashboard-state-filters-compact') && !compactVisible ? [] : [new DOMRect(0, 0, 100, 32)]) as unknown as DOMRectList;
  });
  apps = [app("Alpha running", "running"), app("Alpha stopped", "stopped"), app("Beta running", "running"), app("Starting", "starting")];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("combines a compact filter with the actual Dashboard search and keeps host counts", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search apps by name or ID"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Alpha");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await openMenu();
  expect(menuItem("All, 4 total").getAttribute("aria-checked")).toBe("true");
  await act(async () => menuItem("Running, 2 running").click());
  expect(rows()).toHaveLength(1); expect(rows()[0]).toContain("Alpha running");
  expect(trigger().textContent).toBe("Running2");
  expect(wide("2 running").getAttribute("aria-pressed")).toBe("true");
  expect(input.value).toBe("Alpha"); expect(container.textContent).toContain("1 of 4 apps");
  await openMenu();
  expect(menuItem("Running, 2 running").getAttribute("aria-checked")).toBe("true");
  await act(async () => menuItem("Running, 2 running").click());
  expect(rows()).toHaveLength(2); expect(trigger().textContent).toBe("All4"); expect(input.value).toBe("Alpha");
});

it("retains a selected transition after live state changes empty it, then resets through All", async () => {
  await render(); await openMenu(); await act(async () => menuItem("In progress, 1 in progress").click());
  expect(rows()).toHaveLength(1);
  apps = apps.map(item => item.id === "Starting" ? { ...item, runtimeState: "running" } : item);
  await render(); expect(trigger().textContent).toBe("In progress0");
  expect(container.textContent).toContain("No apps match your search and filters.");
  await openMenu(); expect(menuItem("In progress, 0 in progress").getAttribute("aria-checked")).toBe("true");
  await act(async () => menuItem("All, 4 total").click());
  expect(rows()).toHaveLength(4);
  await openMenu(); expect(menuItem("In progress, 0 in progress")).toBeNull();
});

it("shares wide selection with the compact menu, and closes a portalled menu on expansion", async () => {
  await render(); await act(async () => wide("2 running").click());
  expect(trigger().textContent).toBe("Running2"); await openMenu();
  expect(menuItem("Running, 2 running").getAttribute("aria-checked")).toBe("true");
  compactVisible = false;
  await act(async () => resize());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(wide("2 running")));
  expect(rows()).toHaveLength(2);
});

it("keeps empty and zero-count filters available without inventing a transition", async () => {
  apps = []; await render(); await openMenu();
  expect(menuItem("All, 0 total").getAttribute("aria-checked")).toBe("true");
  expect(menuItem("In progress, 0 in progress")).toBeNull();
  await act(async () => menuItem("Attention, 0 need attention").click());
  expect(trigger().textContent).toBe("Attention0"); expect(container.textContent).toContain("No installed apps");
});

it("opens with a touch pointer and selects without changing lifecycle state", async () => {
  await render();
  await act(async () => {
    const event = new MouseEvent("pointerdown", { button: 0, bubbles: true });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    trigger().dispatchEvent(event);
  });
  expect(menuItem("Running, 2 running")).not.toBeNull();
  await act(async () => menuItem("Running, 2 running").click());
  expect(rows()).toHaveLength(2);
  expect(onAction).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
});


it("shows dependency waiting as attention and lets an administrator cancel the pending start", async () => {
  apps = [app("Waiting consumer", "waiting")];
  await render(true);
  expect(container.textContent).toContain("Waiting for dependencies");
  const cancel = [...container.querySelectorAll("button")].find(button => button.textContent === "Cancel start")!;
  expect(cancel.disabled).toBe(false);
  await act(async () => cancel.click());
  expect(onAction).toHaveBeenCalledWith(apps[0], "stop");
  expect(wide("1 need attention")).not.toBeNull();
  expect(container.querySelector(".animate-spin")).toBeNull();
});
