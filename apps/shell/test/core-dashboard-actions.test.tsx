import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/app/shell/pages/dashboard-page";
import type { CoreDevelopment } from "../src/app/shell/core-development";
import type { CoreStatus, CoreUpdateStatus } from "../src/app/shell/types";

const fixture = vi.hoisted(() => ({ restart: vi.fn(), stop: vi.fn(), update: vi.fn(), logs: vi.fn(), developmentBusy: false, runtimeBusy: false, runtimeAttention: false, recover: vi.fn(), stopBusy: false, phase: null as string | null }));
let development: CoreDevelopment;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../src/app/shell/workspace-sources", () => ({ useWorkspaceSources: () => [], coreWorkspaceSource: () => undefined }));
vi.mock("../src/app/shell/core-development", () => ({ useCoreDevelopment: () => ({ state: development, busy: fixture.developmentBusy, phase: null, restart: fixture.restart, refresh: vi.fn() }), CoreGitCell: () => <span>Source</span> }));
vi.mock("../src/app/shell/core-workspace-control", () => ({ useCoreWorkspaceControl: () => ({ busy: fixture.runtimeBusy, needsAttention: fixture.runtimeAttention, showRecovery: fixture.recover, control: null, dialog: null }) }));
vi.mock("../src/app/shell/core-stop", () => ({ useCoreStop: () => ({ busy: fixture.stopBusy, phase: fixture.phase, stop: fixture.stop, dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", () => ({ ResourceUsageProvider: ({ children }: { children: ReactNode }) => children, ResourceUsage: () => null }));
vi.mock("../src/app/shell/pages/dashboard-sandboxes", () => ({ DashboardSandboxes: ({ connectedCore }: { connectedCore: ReactNode }) => connectedCore }));
vi.mock("../src/app/shell/dialogs/core-logs-dialog", () => ({ CoreLogsDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Core logs</div> : null }));

let root: Root, container: HTMLDivElement;
let status: CoreStatus, admin: boolean, coreUpdating: boolean;
let coreUpdate: CoreUpdateStatus | null;
const primary = () => container.querySelector<HTMLButtonElement>('[data-testid="core-row"] .dashboard-context-action button');
async function render() {
  await act(async () => root.render(<DashboardPage coreOrigin="https://core.test" apps={[]} status={status} coreUpdate={coreUpdate} coreUpdating={coreUpdating}
    canManageApps={admin} loading={false} busyAction={null} pendingAppActions={{}} updateCheck={null} shellAppId="shell.app"
    onUpdateCore={fixture.update} onRefresh={() => {}} onInstall={() => {}} onAction={() => {}} onSwitchRuntime={() => {}}
    onUpdateApp={() => {}} onCheckUpdates={() => {}} onUpdateAll={() => {}} onOpenPanel={() => {}} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.restart.mockReset(); fixture.stop.mockReset(); fixture.update.mockReset();
  fixture.developmentBusy = false; fixture.runtimeBusy = false; fixture.runtimeAttention = false; fixture.recover.mockReset(); fixture.stopBusy = false; fixture.phase = null;
  development = { launch: { mode: "dev", projectPath: "/tree/Core.csproj", generationPath: "/output", processId: 1, startedAt: "before" }, instance: "1:before", manageable: true,
    source: { overridePath: null, revision: "source" }, managedPath: "/source", sourcePath: "/tree", selectedProjectPath: "/tree/Core.csproj",
    restartRequired: false, branch: "main", commit: null, changedFiles: 0, additions: 0, deletions: 0, gitError: null };
  status = { status: "running", component: "hosty-core", dataRoot: "/data", listenUrl: "https://core.test", serverTime: "now", warnings: [] };
  admin = true; coreUpdating = false; coreUpdate = null;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("uses Stop for healthy Core and dispatches its confirmation hook", async () => {
  await render(); expect(primary()?.textContent).toBe("Stop");
  expect(container.querySelectorAll('.dashboard-actions .dashboard-context-action button')).toHaveLength(1);
  await act(async () => primary()!.click()); expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.restart).not.toHaveBeenCalled();
});
it.each(["running", "degraded", "unhealthy", "failed"])("prioritizes one Restart action and title badge for %s Core", async value => {
  status.status = value; development.restartRequired = true; await render();
  const title = container.querySelector('[data-testid="core-row"] .dashboard-identity .font-medium')!.parentElement!;
  expect(title.querySelector('[data-slot="badge"]')?.textContent).toBe("Restart required");
  expect(primary()?.textContent).toBe("Restart");
  expect(container.querySelectorAll('.dashboard-actions .dashboard-context-action button')).toHaveLength(1);
  expect(container.querySelector('.dashboard-identity button')).toBeNull();
  await act(async () => primary()!.click()); expect(fixture.restart).toHaveBeenCalledOnce(); expect(fixture.stop).not.toHaveBeenCalled();
});
it.each(["degraded", "unhealthy", "failed"])("offers Logs only for the factual %s status", async value => {
  status.status = value; await render(); expect(primary()?.textContent).toBe("Logs");
  await act(async () => primary()!.click()); expect(container.querySelector('[role="dialog"]')?.textContent).toBe("Core logs");
});
it("does not mistake source or configuration diagnostics for runtime health", async () => {
  status.warnings = ["Ingress configuration unavailable"]; development.gitError = "Git inspection unavailable";
  await render(); expect(primary()?.textContent).toBe("Stop");
});
it.each(["restart", "workspace", "update", "stop"])("shows one disabled contextual action during %s", async kind => {
  development.restartRequired = true;
  fixture.developmentBusy = kind === "restart"; fixture.runtimeBusy = kind === "workspace"; coreUpdating = kind === "update"; fixture.stopBusy = kind === "stop";
  await render(); expect(primary()?.disabled).toBe(true);
  expect(container.querySelectorAll('.dashboard-actions .dashboard-context-action button')).toHaveLength(1);
  await act(async () => primary()!.click()); expect(fixture.restart).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled();
});
it("keeps unmanaged Core lifecycle disabled and hides controls from ordinary users", async () => {
  development.manageable = false; await render(); expect(primary()?.disabled).toBe(true);
  development.restartRequired = true; await render(); expect(primary()?.textContent).toBe("Restart"); expect(primary()?.disabled).toBe(true);
  admin = false; await render(); expect(primary()).toBeNull();
});
it("retains guarded Stop in More when the narrow contextual shortcut is hidden", async () => {
  await render();
  const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions for Hosty Core"]')!;
  await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === "Stop Core")!;
  expect(item).toBeDefined(); expect(item.hasAttribute("data-disabled")).toBe(false);
  await act(async () => item.click()); expect(fixture.stop).toHaveBeenCalledOnce();
});

it("blocks contextual Update during an accepted or unconfirmed stop", async () => {
  development.launch.mode = "release"; fixture.stopBusy = true;
  coreUpdate = { currentVersion: "1.0.0", updateAvailable: true, releaseTag: "next", checkedAt: "now" };
  await render();
  expect(container.querySelector('[aria-label="Update Core"]')).toBeNull();
  expect(primary()?.disabled).toBe(true);
  await act(async () => primary()!.click()); expect(fixture.update).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="More actions for Hosty Core"]')?.disabled).toBe(true);
});


it.each([
  ["installing", "Installing update", "text-info-foreground", "loader-circle"],
  ["reconnecting", "Reconnecting", "text-info-foreground", "loader-circle"],
  ["verifying", "Verifying update", "text-info-foreground", "loader-circle"],
  ["completed", "Updated", "text-success-foreground", "check"],
  ["unconfirmed", "Update not confirmed", "text-warning-foreground", "triangle-alert"],
] as const)("uses factual %s update feedback without changing the Core lifecycle", async (phase, label, tone, icon) => {
  development.launch.mode = "release";
  coreUpdating = true;
  coreUpdate = { currentVersion: "1.0.0", updateAvailable: true, releaseTag: "next", checkedAt: "now", clientPhase: phase };
  await render();
  const message = container.querySelector('.dashboard-status [role="status"]')!;
  expect(message.textContent).toBe(label);
  expect(message.classList.contains(tone)).toBe(true);
  expect(message.querySelector(`.lucide-${icon}[aria-hidden="true"]`)).not.toBeNull();
  expect(!!message.querySelector('.animate-spin')).toBe(icon === "loader-circle");
  expect(!!primary()?.querySelector('.animate-spin')).toBe(icon === "loader-circle");
  if (phase === "completed" || phase === "unconfirmed") {
    expect(container.querySelector('[data-testid="core-row"] .animate-spin')).toBeNull();
    expect(primary()?.textContent).toBe(phase === "completed" ? "Updated" : "Needs confirmation");
  }
  expect(container.querySelector('.dashboard-status')?.textContent).toContain("Running");
  expect(primary()?.disabled).toBe(true);
  expect(fixture.stop).not.toHaveBeenCalled(); expect(fixture.restart).not.toHaveBeenCalled();
});

it.each(["Waiting for confirmation", "Stop not confirmed"])("keeps %s static and guarded", async phase => {
  fixture.stopBusy = true; fixture.phase = phase;
  await render();
  const message = container.querySelector('.dashboard-status [role="status"]')!;
  expect(message.textContent).toBe(phase);
  expect(message.classList.contains("text-warning-foreground")).toBe(true);
  expect(message.querySelector('.lucide-triangle-alert')).not.toBeNull();
  expect(message.querySelector('.animate-spin')).toBeNull();
  expect(primary()?.textContent).toBe("Needs confirmation");
  expect(primary()?.querySelector('.animate-spin')).toBeNull();
  expect(primary()?.disabled).toBe(true);
});

it("offers the package update through the contextual action while preserving lifecycle priorities", async () => {
  development.launch.mode = "release"; status.version = "1.0.0";
  coreUpdate = { currentVersion: "1.0.0", availableVersion: "1.1.0", updateAvailable: true, releaseTag: "main", checkedAt: "now" };
  await render();
  expect(primary()?.textContent).toBe("Update");
  expect(container.querySelector('.dashboard-identity button')).toBeNull();
  await act(async () => primary()!.click()); expect(fixture.update).toHaveBeenCalledOnce();
  status.status = "degraded"; await render(); expect(primary()?.textContent).toBe("Logs");
  development.restartRequired = true; await render(); expect(primary()?.textContent).toBe("Restart");
  development.restartRequired = false; status.status = "running"; development.launch.mode = "dev";
  await render(); expect(primary()?.textContent).toBe("Stop");
});

it("replaces a stalled switch spinner with an enabled recovery action while guarding Core lifecycle", async () => {
  fixture.runtimeBusy = true; fixture.runtimeAttention = true;
  await render();
  expect(primary()?.textContent).toBe("Check switch");
  expect(primary()?.disabled).toBe(false);
  expect(primary()?.querySelector(".animate-spin")).toBeNull();
  expect(primary()?.querySelector(".lucide-triangle-alert")).not.toBeNull();
  await act(async () => primary()!.click());
  expect(fixture.recover).toHaveBeenCalledOnce();
  expect(fixture.restart).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled();
  const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions for Hosty Core"]')!;
  await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  for (const label of ["Restart Core", "Stop Core"]) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)!;
    expect(item.hasAttribute("data-disabled")).toBe(true);
  }
});
