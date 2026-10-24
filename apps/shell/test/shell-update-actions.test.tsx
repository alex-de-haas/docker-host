import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { useShellActions, useShellState, type ShellActionsContextValue, type ShellContextValue } from "../src/app/shell/shell-context";
import { DashboardPage } from "../src/app/shell/pages/dashboard-page";
import { CoreRequestError } from "../src/app/shell/core-api";
import type { CoreApp } from "../src/app/shell/types";
import { getManageAppHref } from "../src/app/shell/shell-routes";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), settle: vi.fn(), switchSettle: vi.fn(), showConfirmation: vi.fn(), confirm: vi.fn(),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  router: { replace: vi.fn(), push: vi.fn() },
  params: new URLSearchParams(), pathname: "/dashboard", realResources: false,
  openUpdateLogs: null as ((app: CoreApp) => void) | null,
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => fixture.pathname, useSearchParams: () => fixture.params }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", resolvedTheme: "light" }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: {}, subscribeToCoreEvents: (_origin: string, options: { topic?: string; onSync: () => Promise<void> }) => { if (!options.topic) void options.onSync(); return () => {}; } }));
vi.mock("../src/app/shell/assistant/use-assistant-selection", () => ({
  useAssistantSelection: () => ({ assistants: [], selected: null, selectedId: null, select: () => {}, choose: async () => null }),
}));
vi.mock("../src/app/shell/update-notifications", () => ({
  useAppUpdateNotifications: (_apps: readonly CoreApp[], openLogs: (app: CoreApp) => void) => { fixture.openUpdateLogs = openLogs; },
}));
vi.mock("../src/app/shell/self-update", () => ({ waitForShellUpdateToSettle: fixture.settle }));
vi.mock("../src/app/shell/self-runtime-switch", () => ({ waitForShellRuntimeSwitch: fixture.switchSettle }));
vi.mock("../src/app/shell/core-confirmation", () => ({ showCoreConfirmation: fixture.showConfirmation }));
vi.mock("../src/components/reui/operation-toast", async () => {
  const { createContext } = await import("react");
  return { toast: fixture.toast, AssistantFeedbackContext: createContext({}), errorReportText: () => "" };
});
vi.mock("../src/components/reui/confirmation", () => ({ useConfirmation: () => ({ confirm: fixture.confirm, dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/app/shell/resources/resource-usage")>();
  return { ResourceUsageProvider: ({ children }: { children: ReactNode }) => children,
    ResourceUsage: (props: React.ComponentProps<typeof actual.ResourceUsage>) => fixture.realResources ? <actual.ResourceUsage {...props} /> : null };
});
vi.mock("../src/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../src/app/shell/sidebar/shell-sidebar", () => ({ ShellSidebar: () => null }));
vi.mock("../src/app/shell/chrome/shell-mobile-tabs", () => ({ ShellMobileTabs: () => null }));
vi.mock("../src/app/shell/chrome/shell-top-strip", () => ({ ShellTopStrip: () => null }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUiHost: () => null }));
vi.mock("../src/app/shell/chrome/shell-panel-workspace", () => ({ ShellPanelWorkspace: ({ children }: { children: ReactNode }) => children }));

let root: Root;
let container: HTMLDivElement;
let actions: ShellActionsContextValue;
let shell: ShellContextValue;
let apps: CoreApp[];
const target: CoreApp = {
  id: "routine.app", displayName: "Routine app", version: "1.0.0", kind: "app", system: false,
  source: "https://publisher.test/manifest.json", operationStatus: "started", runtimeState: "running", capabilities: [],
  updateCheck: { requiresReview: false, planDigest: "old-digest", updateAvailable: true, checkedAt: "2026-10-08T00:00:00Z" },
};
const plan = (digest = "old-digest", review = false) => ({ planDigest: digest, requiresReview: review, changes: ["version"], sourceConfigured: true });
const refusal = (code = "update_plan_stale", status = 409) => Response.json({ code, message: "Candidate changed" }, { status });
const callsTo = (path: string, method = "POST") => fixture.read.mock.calls.filter(([url, init]) => new URL(url).pathname === path && (init?.method ?? "GET") === method);
function ActionCapture({ dashboard = false }: { dashboard?: boolean }) {
  const current = useShellActions();
  const state = useShellState();
  useEffect(() => { actions = current; shell = state; }, [current, state]);
  return dashboard ? <DashboardPage coreOrigin={current.coreOrigin} apps={state.state.apps} status={null}
    coreUpdate={null} coreUpdating={false} onUpdateCore={() => {}} shellAppId={current.shellAppId}
    canManageApps={state.canManageApps} loading={false} busyAction={state.busyAction} pendingAppActions={state.pendingAppActions}
    updateCheck={null} onRefresh={() => {}} onInstall={() => {}}
    onAction={current.runAppAction} onSwitchRuntime={current.switchAppRuntime} onUpdateApp={current.applyUpdateFromRow}
    onCheckUpdates={() => {}} onUpdateAll={() => {}} onOpenPanel={current.openAppPanel} /> : null;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no layout observer; the real tooltip measures its arrow with one.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(window, "open").mockReturnValue(null);
  apps = [target]; fixture.realResources = false;
  fixture.pathname = "/dashboard"; fixture.params = new URLSearchParams(); fixture.openUpdateLogs = null;
  fixture.router.push.mockReset(); fixture.router.replace.mockReset();
  fixture.read.mockReset(); fixture.settle.mockReset(); fixture.showConfirmation.mockReset();
  fixture.confirm.mockReset();
  fixture.switchSettle.mockReset().mockResolvedValue({ kind: "unresolved" });
  for (const toast of Object.values(fixture.toast)) toast.mockReset();
  fixture.read.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/core/status") return Response.json({ status: "ready", warnings: [], launch: { mode: "dev" } });
    if (path === "/api/auth/session") return Response.json({ authenticated: true, user: { id: "admin", role: "host.admin" } });
    if (path === "/api/auth/csrf") return Response.json({ token: "csrf" });
    if (path === "/api/apps") return Response.json({ apps });
    if (path === "/api/apps/execution-targets") return Response.json({ apps: apps.map(app => ({ appId: app.id,
      packageRuntime: app.selectedRuntime, current: { kind: "package", runtime: app.selectedRuntime },
      choices: app.runtimeProfiles?.filter(profile => !profile.development).map(profile => ({ kind: "package", runtime: profile.key, available: true })) ?? [],
    })) });
    if (path.endsWith("/execution-target") && init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      const app = { ...apps[0], selectedRuntime: request.runtime || "dev", live: request.kind === "workspace" };
      apps = [app]; return Response.json({ requestId: request.requestId, state: "completed", app });
    }
    if (path === "/api/global-mounts") return Response.json({ mounts: [] });
    if (path.endsWith("/update/plan")) return Response.json(init?.method === "POST" ? plan("fresh-digest") : { plan: plan() });
    if (path.endsWith("/update")) return Response.json({ status: "updating" });
    if (path.endsWith("/switch-runtime/plan")) return Response.json({ currentRuntime: "dev", targetRuntime: "docker", planDigest: "switch-digest" });
    if (path.endsWith("/switch-runtime")) return Response.json({ status: "runtime-switched" });
    throw new Error(`Unexpected request: ${url}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(dashboard = false) {
  await act(async () => root.render(<ShellClient coreOrigin="https://core.test" shellAppId="hosty.shell"
    initialSidebarCompact={false} initialRightPanelOpen={false} initialRightPanelWidth={360}><ActionCapture dashboard={dashboard} /></ShellClient>));
}
function setRoute(href: string) {
  const url = new URL(href, "https://shell.test");
  fixture.pathname = url.pathname; fixture.params = url.searchParams;
}
function overrideRequests(override: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fallback = fixture.read.getMockImplementation()!;
  fixture.read.mockImplementation(async (url: string, init?: RequestInit) => override(new URL(url).pathname, init) ?? fallback(url, init));
}

it.each(["stopped", "starting", "ready"])("reports whether Shell accepts a workspace launch for a %s service", async state => {
  const app: CoreApp = { ...target, runtimeState: state === "stopped" ? "stopped" : "running",
    health: { status: state === "starting" ? "starting" : "healthy", services: [], observedAt: "2026-10-11T00:00:00Z" } };
  apps = [app]; await mount(); fixture.router.push.mockClear();
  let result: boolean | undefined;
  await act(async () => { result = await actions.launchAppPage(app, { label: "Page", path: "/page", redirectUri: "https://routine.test/page" }); });
  expect(result).toBe(state === "ready");
  if (state === "ready") expect(fixture.router.push).toHaveBeenCalledWith(expect.stringContaining("app=routine.app"));
  else { expect(fixture.router.push).not.toHaveBeenCalled(); expect(shell.state.error).toContain(state === "starting" ? "is starting" : "must be running"); }
});

it.each([400, 409].flatMap(status => ["update_plan_expired", "update_plan_stale", "update_plan_digest_mismatch"].map(code => [status, code] as const)))(
  "refreshes the actual row transport's HTTP %i %s refusal once and queues the new digest", async (status, code) => {
    let attempts = 0;
    overrideRequests(path => path.endsWith("/update") && ++attempts === 1 ? refusal(code, status) : undefined);
    await mount();
    await act(async () => actions.applyUpdateFromRow(target));
    expect(callsTo("/api/apps/routine.app/update").map(([, init]) => JSON.parse(init.body))).toEqual([
      { planDigest: "old-digest" }, { planDigest: "fresh-digest" },
    ]);
    expect(callsTo("/api/apps/routine.app/update/plan")).toHaveLength(1);
    expect(callsTo("/api/installations")).toHaveLength(0);
    expect(fixture.toast.error).not.toHaveBeenCalled();
  },
);

it("reclassifies a refreshed routine candidate and opens Core review instead of blindly queuing it", async () => {
  let attempts = 0;
  const approval = { id: "review", status: "draft", approvalUrl: "https://core.test/install/confirm/review", expiresAt: "2099-01-01T00:00:00Z" };
  overrideRequests((path, init) => {
    if (path.endsWith("/update")) { attempts++; return refusal("update_plan_stale", 400); }
    if (path.endsWith("/update/plan") && init?.method === "POST") return Response.json(plan("review-digest", true));
    if (path === "/api/installations") return Response.json(approval);
    if (path === "/api/installations/review/submit") return Response.json({ ...approval, status: "pending" });
    if (path === "/api/installations/review") return Response.json({ ...approval, status: "denied" });
  });
  await mount();
  await act(async () => {
    const applying = actions.applyUpdateFromRow(target);
    await vi.advanceTimersByTimeAsync(1000); await applying;
  });
  expect(attempts).toBe(1);
  expect(callsTo("/api/installations").map(([, init]) => JSON.parse(init.body))).toEqual([{ updateAppId: target.id, planDigest: "review-digest" }]);
  expect(fixture.showConfirmation).toHaveBeenCalledWith(null, expect.objectContaining({ id: "review", status: "pending" }));
  expect(fixture.toast.info).toHaveBeenCalledWith("Update cancelled", expect.anything());
  expect(fixture.toast.error).not.toHaveBeenCalled();
});

it("stops after the second definite stale refusal", async () => {
  overrideRequests(path => path.endsWith("/update") ? refusal("update_plan_stale", 400) : undefined);
  await mount(); await act(async () => actions.applyUpdateFromRow(target));
  expect(callsTo("/api/apps/routine.app/update")).toHaveLength(2);
  expect(callsTo("/api/apps/routine.app/update/plan")).toHaveLength(1);
  expect(fixture.toast.error).toHaveBeenCalledExactlyOnceWith("Update could not be prepared", expect.objectContaining({ description: "Candidate changed" }));
});

it.each(["transport", "server", "authorization", "other-bad-request", "other-conflict"])("does not replay a %s routine failure", async kind => {
  overrideRequests(path => {
    if (!path.endsWith("/update")) return;
    if (kind === "transport") throw new TypeError("Response lost after queueing");
    return kind === "server" ? refusal("update_plan_stale", 503) : kind === "authorization" ? refusal("update_plan_stale", 403) : refusal("operation_failed", kind === "other-bad-request" ? 400 : 409);
  });
  await mount(); await act(async () => actions.applyUpdateFromRow(target));
  expect(callsTo("/api/apps/routine.app/update")).toHaveLength(1);
  expect(callsTo("/api/apps/routine.app/update/plan")).toHaveLength(0);
  expect(callsTo("/api/installations")).toHaveLength(0);
  expect(fixture.toast.error).toHaveBeenCalledTimes(1);
});

it.each([400, 409])("never retries an HTTP %i stale-shaped error after Shell's routine update was accepted", async status => {
  const shell = { ...target, id: "hosty.shell", displayName: "Shell" };
  apps = [shell];
  fixture.settle.mockRejectedValue(new CoreRequestError("Status changed after acceptance", "update_plan_stale", status, null));
  await mount(); await act(async () => actions.applyUpdateFromRow(shell));
  expect(callsTo("/api/apps/hosty.shell/update")).toHaveLength(1);
  expect(callsTo("/api/apps/hosty.shell/update/plan")).toHaveLength(0);
  expect(fixture.settle).toHaveBeenCalledTimes(1);
  expect(fixture.toast.error).toHaveBeenCalledExactlyOnceWith("Update not completed", expect.objectContaining({ description: "Status changed after acceptance" }));
});

it("continues bulk updates after one app's definite stale refusal without preparing new consent", async () => {
  const second = { ...target, id: "second.app" }; apps = [target, second];
  overrideRequests(path => path === "/api/apps/routine.app/update" ? refusal() : undefined);
  await mount(); await act(async () => actions.updateAllApps());
  expect(callsTo("/api/apps/routine.app/update")).toHaveLength(1);
  expect(callsTo("/api/apps/second.app/update")).toHaveLength(1);
  expect(callsTo("/api/apps/routine.app/update/plan")).toHaveLength(0);
  expect(callsTo("/api/installations")).toHaveLength(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function appRow(id = target.id) {
  return [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Installed apps"] tbody tr')]
    .find(row => row.dataset.testid === `app-row-${id}`)!;
}

function expectDevelopmentMetadata(kind: "source" | "workspace") {
  expect(appRow().querySelector(".dashboard-runtime")).toBeNull();
  const version = appRow().querySelector<HTMLElement>(".dashboard-version")!;
  const trigger = version.querySelector("button")!;
  const icon = trigger.querySelector(kind === "workspace" ? ".lucide-hammer" : ".lucide-git-branch");
  expect(icon).not.toBeNull();
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  expect([...version.parentElement!.children].filter(child => child.textContent?.trim() === "·")).toHaveLength(0);
}

async function openAppMenu(id = target.id) {
  const trigger = appRow(id).querySelector('button[aria-label="More actions"]')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
async function openRuntimeMenu() {
  await openAppMenu();
  const trigger = document.querySelector('[aria-label="Switch runtime for Routine app"]')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  return [...document.querySelectorAll('[role="menu"]')].at(-1);
}
async function restartDisabled(id = target.id) {
  await openAppMenu(id);
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Restart app")!;
  const disabled = item.hasAttribute("data-disabled");
  await act(async () => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  return disabled;
}


const contextAction = (id = target.id) => appRow(id).querySelector<HTMLButtonElement>(".dashboard-context-action > button");
const observedHealth = (status: string): NonNullable<CoreApp["health"]> => ({ status, services: [], observedAt: "2026-10-22T00:00:00Z" });

it.each([
  { runtime: "running", status: "Running", stage: "queued", label: "Update queued", operation: "updating" },
  { runtime: "stopping", status: "Stopping…", stage: "stopping", label: "Updating", operation: "updating" },
  { runtime: "stopped", status: "Stopped", stage: "stopping", label: "Updating", operation: "updating" },
  { runtime: "starting", status: "Starting…", stage: "starting", service: "web", label: "Updating", operation: "updating" },
  { runtime: "running", status: "Running", stage: "starting", label: "Updating", operation: "updating" },
  { runtime: "unknown", status: "Unknown", stage: "stopping", label: "Updating", operation: "updating" },
  { runtime: "stopped", status: "Stopped", stage: "installing", service: "web", label: "Installing · web", operation: "updating" },
  { runtime: "starting", status: "Starting…", stage: "checking", label: "Checking readiness", operation: "updating" },
])("keeps $runtime runtime status above $stage update feedback in the Status column", async ({ runtime, status, stage, service, label, operation }) => {
  apps = [{ ...target, updateCheck: null, runtimeState: runtime, operationStatus: operation, lastOperation: "update",
    health: observedHealth("healthy"),
    updateProgress: { stage, changedAt: new Date(Date.now()).toISOString(), service } }];
  await mount(true);
  const cell = appRow().querySelector<HTMLElement>(".dashboard-status")!;
  const main = [...cell.querySelectorAll("span")].find(node => node.textContent === status)!;
  const feedback = [...cell.querySelectorAll("span, button")].find(node => node.textContent === label)!;
  expect(main).toBeDefined(); expect(feedback).toBeDefined();
  const progress = feedback.closest('[role="status"]')!;
  expect(progress.classList.contains("text-info-foreground")).toBe(true);
  expect(progress.querySelector('svg[aria-hidden="true"]')?.classList.contains("motion-reduce:animate-none")).toBe(true);
  expect(main.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(appRow().querySelector(".dashboard-identity")?.textContent).not.toContain(label);
  expect(appRow().querySelector(".dashboard-version")?.textContent).toContain(target.version);
});

it.each([
  { runtime: "running", status: "Running", stage: "completed", label: "Updated", operation: "updated", error: null },
  { runtime: "running", status: "Running · degraded", stage: "needs-attention", label: "Updated · needs attention", operation: "updated", error: null },
  { runtime: "stopped", status: "Stopped", stage: "failed", label: "Update failed", operation: "failed", error: "Image download failed" },
  { runtime: "running", status: "Running", stage: "interrupted", label: "Update interrupted", operation: "failed", error: "Core stopped before the update finished" },
])("omits terminal $stage row feedback without losing runtime status or diagnostic icons", async ({ runtime, status, stage, label, operation, error }) => {
  apps = [{ ...target, updateCheck: null, runtimeState: runtime, operationStatus: operation, lastOperation: "update", lastError: error,
    health: observedHealth(stage === "needs-attention" ? "degraded" : "healthy"),
    updateProgress: { stage, changedAt: new Date(Date.now()).toISOString() } }];
  await mount(true);
  const cell = appRow().querySelector<HTMLElement>(".dashboard-status")!;
  expect(cell.textContent).toBe(status);
  expect(cell.querySelector("button")).toBeNull();
  expect(appRow().querySelector(".dashboard-identity")?.textContent).not.toContain(label);
  const diagnostic = appRow().querySelector<HTMLElement>('[role="img"][aria-label*="problem"]');
  if (stage === "completed") expect(diagnostic).toBeNull();
  else {
    expect(diagnostic).not.toBeNull();
    await act(async () => diagnostic!.focus());
    await act(async () => vi.advanceTimersByTime(200));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(error ?? "readiness checks did not pass");
  }
  await act(async () => vi.advanceTimersByTime(31_000));
  expect(cell.textContent).toBe(status);
  expect(appRow().querySelector(".dashboard-identity")?.textContent).not.toContain(label);
});

it.each(["completed", "needs-attention", "failed", "interrupted"])("does not show terminal %s feedback when the operation snapshot still says updating", async stage => {
  apps = [{ ...target, updateCheck: null, operationStatus: "updating", lastOperation: "update",
    updateProgress: { stage, changedAt: new Date(Date.now()).toISOString() } }];
  await mount(true);
  expect(appRow().querySelector(".dashboard-status")?.textContent).toBe("Running");
  expect(appRow().querySelector(".dashboard-identity")?.textContent).not.toMatch(/Updated|Update failed|Update interrupted|needs attention/);
});

it.each([
  { runtime: "running", status: "Running" },
  { runtime: "", status: "Unknown" },
])("shows legacy Updating feedback beneath $status when progress is unavailable", async ({ runtime, status }) => {
  apps = [{ ...target, updateCheck: null, runtimeState: runtime, operationStatus: "updating" }];
  await mount(true);
  const cell = appRow().querySelector<HTMLElement>(".dashboard-status")!;
  expect(cell.textContent).toBe(`${status}Updating`);
  expect(appRow().querySelector(".dashboard-identity")?.textContent).not.toContain("Updating");
});

it.each(["source", "workspace"])("retains update feedback below runtime status for %s metadata", async kind => {
  apps = [{ ...target, updateCheck: null, live: true, selectedRuntime: "debug", runtimeProfiles: workspaceProfiles,
    sourceLivePath: "/work/dashboard", operationStatus: "updating", lastOperation: "update",
    updateProgress: { stage: "checking", changedAt: new Date(Date.now()).toISOString() } }];
  mockWorkspaceRequests();
  if (kind === "source") overrideRequests(path => path === "/api/apps/execution-targets"
    ? Response.json({ apps: [{ appId: target.id, current: { kind: "legacy", runtime: "debug" }, choices: [] }] })
    : path === "/api/development/activation-workspaces" ? Response.json({ workspaces: [] }) : undefined);
  await mount(true);
  expectDevelopmentMetadata(kind === "workspace" ? "workspace" : "source");
  expect(appRow().querySelector(".dashboard-status")?.textContent).toBe("RunningChecking readiness");
  expect(appRow().querySelector(".dashboard-identity")?.textContent).not.toContain("Checking readiness");
});

it.each([undefined, observedHealth("healthy")])("offers Stop for a running app without a reported problem, with health %j", async health => {
  apps = [{ ...target, capabilities: ["logs"], health, updateCheck: null }];
  await mount(true);
  expect(contextAction()?.textContent).toBe("Stop");
  expect(contextAction()?.disabled).toBe(false);
  await openAppMenu();
  expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === "Console logs")).toBe(true);
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  const stopping = deferred<Response>();
  overrideRequests(path => path.endsWith("/stop") ? stopping.promise : undefined);
  await act(async () => contextAction()!.click());
  expect(callsTo("/api/apps/routine.app/stop")).toHaveLength(1);
  expect(contextAction()?.textContent).toBe("Stopping…");
  expect(contextAction()?.disabled).toBe(true);
  await act(async () => { stopping.resolve(Response.json({ status: "stopped" })); });
});

it.each([
  { health: observedHealth("degraded") },
  { health: observedHealth("unhealthy") },
  { health: { ...observedHealth("degraded"), services: [{ service: "sidecar", status: "stopped", health: null }] } },
  { health: { ...observedHealth("unhealthy"), services: [{ service: "web", status: "exited", health: "unhealthy" }] } },
])("offers Logs for an observed runtime-health failure: %j", async problem => {
  apps = [{ ...target, updateCheck: null, ...problem, capabilities: ["logs"] }];
  await mount(true);
  expect(contextAction()?.textContent).toBe("Logs");
  await openAppMenu();
  const stop = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === "Stop app");
  expect(stop).toBeDefined();
  expect(stop?.hasAttribute("data-disabled")).toBe(false);
});

it.each([
  { lastError: "Last operation failed" },
  { operationStatus: "failed", lastError: "The previous update failed" },
  { updateCheck: { ...target.updateCheck!, updateAvailable: false, error: "Feed unavailable" } },
  { manifestError: "Unable to inspect the update manifest" },
  { permissionState: {
    status: "stale", required: [], optional: [], acceptedRequired: [], acceptedOptional: [], granted: [],
    missingRequired: [], reviewRequired: false, unconfirmedRoles: [], error: "Permission check unavailable",
    checkedAt: "2026-10-22T00:00:00Z", descriptions: {},
  } satisfies NonNullable<CoreApp["permissionState"]> },
])("keeps Stop for a healthy running app despite an unrelated diagnostic: %j", async problem => {
  apps = [{ ...target, updateCheck: null, health: observedHealth("healthy"), ...problem, capabilities: ["logs"] }];
  await mount(true);
  expect(contextAction()?.textContent).toBe("Stop");
  expect(appRow().querySelector('[role="img"][aria-label*="problem"], button[aria-label="Permission manifest could not be checked"]')).not.toBeNull();
});

it.each(["unknown", "starting", "stopped"])("does not infer a runtime-health failure from %s health", async status => {
  apps = [{ ...target, updateCheck: null, health: observedHealth(status), capabilities: ["logs"] }];
  await mount(true);
  expect(contextAction()?.textContent).toBe("Stop");
});

it.each([
  { runtime: "stopped", action: "start", label: "Start", pending: "Starting…" },
  { runtime: "running", action: "stop", label: "Stop", pending: "Stopping…" },
])("keeps $label working for an unhealthy $runtime app without logs", async ({ runtime, action, label, pending }) => {
  apps = [{ ...target, updateCheck: null, runtimeState: runtime, health: observedHealth("unhealthy") }];
  const lifecycle = deferred<Response>();
  overrideRequests(path => path.endsWith("/" + action) ? lifecycle.promise : undefined);
  await mount(true);
  expect(contextAction()?.textContent).toBe(label);
  expect(contextAction()?.disabled).toBe(false);
  await act(async () => contextAction()!.click());
  expect(callsTo("/api/apps/routine.app/" + action)).toHaveLength(1);
  expect(contextAction()?.textContent).toBe(pending);
  expect(contextAction()?.disabled).toBe(true);
  expect(callsTo("/api/apps/routine.app/logs", "GET")).toHaveLength(0);
  await act(async () => { lifecycle.resolve(Response.json({ status: action === "start" ? "started" : "stopped" })); });
});

it.each(["healthy", "degraded"])("does not offer Stop to a non-administrator for a %s running app", async status => {
  apps = [{ ...target, updateCheck: null, capabilities: ["logs"], health: observedHealth(status), restartRequired: true }];
  overrideRequests(path => path === "/api/auth/session" ? Response.json({ authenticated: true, user: { id: "reader", role: "host.user" } }) : undefined);
  await mount(true);
  expect(contextAction()?.textContent).toBe("Logs");
  expect([...appRow().querySelectorAll("button")].some(button => button.textContent === "Stop")).toBe(false);
  expect(appRow().querySelector('.dashboard-identity [data-slot="badge"]')?.textContent).toBe("Restart required");
  expect(appRow().querySelectorAll(".dashboard-context-action > button")).toHaveLength(1);
  expect(appRow().querySelector('.dashboard-actions button[aria-label^="Restart "]')).toBeNull();
});

it.each([
  { name: "configuration", app: { updateCheck: null, configurationReadiness: { required: true, missingSettings: ["apiKey"], mounts: [] } } },
  { name: "an offered update", app: {} },
  { name: "unhealthy runtime logs", app: { updateCheck: null, capabilities: ["logs"], health: observedHealth("unhealthy") } },
  { name: "degraded runtime logs, configuration and an update", app: { capabilities: ["logs"], health: observedHealth("degraded"),
    configurationReadiness: { required: true, missingSettings: ["apiKey"], mounts: [] } } },
  { name: "a previous operation error", app: { updateCheck: null, operationStatus: "failed", lastError: "Previous runtime operation failed" } },
] satisfies { name: string; app: Partial<CoreApp> }[])("prioritizes the single Restart action over $name", async ({ app }) => {
  apps = [{ ...target, ...app, restartRequired: true }];
  await mount(true);
  expect(contextAction()?.textContent).toBe("Restart");
  expect(contextAction()?.disabled).toBe(false);
  expect(appRow().querySelectorAll(".dashboard-context-action")).toHaveLength(1);
  expect(appRow().querySelectorAll(".dashboard-context-action > button")).toHaveLength(1);
  expect(appRow().querySelector('.dashboard-identity [data-slot="badge"]')?.textContent).toBe("Restart required");
});

it.each(["degraded", "unhealthy"])("prioritizes %s runtime Logs over configuration and an update", async status => {
  apps = [{ ...target, capabilities: ["logs"], health: observedHealth(status),
    configurationReadiness: { required: true, missingSettings: ["apiKey"], mounts: [] } }];
  await mount(true);
  expect(contextAction()?.textContent).toBe("Logs");
  expect(contextAction()?.disabled).toBe(false);
  fixture.router.push.mockClear();
  await act(async () => contextAction()!.click());
  expect(fixture.router.push).toHaveBeenCalledWith(getManageAppHref(target.id, "logs"), { scroll: false });
  expect(callsTo("/api/apps/routine.app/stop")).toHaveLength(0);
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(0);
});

it.each([
  { name: "configuration for a healthy app", expected: "Configure",
    app: { capabilities: ["logs"], health: observedHealth("healthy"), configurationReadiness: { required: true, missingSettings: ["apiKey"], mounts: [] } } },
  { name: "an update for a healthy app", expected: "Update", app: { capabilities: ["logs"], health: observedHealth("healthy") } },
  { name: "an update despite an unrelated operation error", expected: "Update",
    app: { capabilities: ["logs"], health: observedHealth("healthy"), lastError: "Previous operation failed" } },
  { name: "configuration without runtime logs", expected: "Configure",
    app: { health: observedHealth("unhealthy"), configurationReadiness: { required: true, missingSettings: ["apiKey"], mounts: [] } } },
  { name: "an update without runtime logs", expected: "Update", app: { health: observedHealth("unhealthy") } },
  { name: "stopped runtime with stale unhealthy logs", expected: "Start",
    app: { runtimeState: "stopped", updateCheck: null, capabilities: ["logs"], health: observedHealth("unhealthy") } },
] satisfies { name: string; expected: string; app: Partial<CoreApp> }[])("keeps the contextual fallback for $name", async ({ app, expected }) => {
  apps = [{ ...target, ...app }];
  await mount(true);
  expect(contextAction()?.textContent).toBe(expected);
  expect(contextAction()?.disabled).toBe(false);
  expect(appRow().querySelectorAll(".dashboard-context-action > button")).toHaveLength(1);
  expect(appRow().textContent).not.toContain("Restart required");
});

it("uses the existing Shell stop confirmation from the contextual shortcut", async () => {
  apps = [{ ...target, id: "hosty.shell", updateCheck: null, capabilities: ["logs"] }];
  fixture.confirm.mockResolvedValue(false);
  await mount(true);
  const stop = container.querySelector<HTMLButtonElement>('[data-testid="app-row-hosty.shell"] .dashboard-context-action button')!;
  expect(stop.textContent).toBe("Stop");
  await act(async () => stop.click());
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  expect(callsTo("/api/apps/hosty.shell/stop")).toHaveLength(0);
});

it("places the restart badge after title icons and uses Restart as the single contextual action", async () => {
  apps = [{ ...target, system: true, restartRequired: true, lastError: "Previous runtime operation failed" }];
  await mount(true);
  const identity = appRow().querySelector('.dashboard-identity')!;
  const title = identity.querySelector('a')!.parentElement!;
  const badge = title.querySelector('[data-slot="badge"]')!;
  expect(badge.textContent).toBe("Restart required");
  expect(title.querySelector('[role="img"][aria-label="System app"]')).not.toBeNull();
  expect(title.querySelector('[role="img"][aria-label*="problem"]')).not.toBeNull();
  for (const icon of title.querySelectorAll('[role="img"]')) {
    expect(icon.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect([...identity.querySelectorAll('button')].some(button => button.textContent === "Restart")).toBe(false);
  expect(contextAction()?.textContent).toBe("Restart");
  expect(contextAction()?.disabled).toBe(false);
  expect(appRow().querySelectorAll(".dashboard-context-action")).toHaveLength(1);
  expect(appRow().querySelectorAll(".dashboard-context-action > button")).toHaveLength(1);
});

it("keeps the contextual Restart disabled while Core reports an update in progress", async () => {
  apps = [{ ...target, restartRequired: true, operationStatus: "updating" }];
  await mount(true);
  expect(appRow().querySelector('.dashboard-identity [data-slot="badge"]')?.textContent).toBe("Restart required");
  expect(contextAction()?.disabled).toBe(true);
  await act(async () => contextAction()!.click());
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(0);
});

it("keeps the contextual Restart disabled during another same-app action without hiding its badge", async () => {
  apps = [{ ...target, restartRequired: true }];
  const saving = deferred<Response>();
  overrideRequests(path => path.endsWith("/autostart") ? saving.promise : undefined);
  await mount(true);
  let action!: Promise<void>;
  await act(async () => { action = actions.runAppAction(target, "autostart"); });
  expect(shell.busyAction).toBe("routine.app:autostart");
  expect(appRow().querySelector('.dashboard-identity [data-slot="badge"]')?.textContent).toBe("Restart required");
  expect(contextAction()?.disabled).toBe(true);
  await act(async () => contextAction()!.click());
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(0);
  await act(async () => { saving.resolve(Response.json({ status: "configured" })); await action; });
  expect(contextAction()?.disabled).toBe(false);
});

it("shows immediate restart progress and keeps each queued app busy without submitting duplicates", async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  const other = { ...target, id: "other.app", displayName: "Other app", restartRequired: true };
  apps = [{ ...target, restartRequired: true }, other];
  overrideRequests(path => path === "/api/apps/routine.app/restart" ? first.promise
    : path === "/api/apps/other.app/restart" ? second.promise : undefined);
  await mount(true);
  const restart = contextAction()!;
  expect(restart.disabled).toBe(false);
  fixture.router.push.mockClear();
  await act(async () => {
    restart.click(); restart.click();
    // The handler also protects toast/menu callers before React has committed the disabled UI.
    void actions.runAppAction(target, "restart");
    void actions.runAppAction(target, "stop");
  });
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(1);
  expect(callsTo("/api/apps/routine.app/stop")).toHaveLength(0);
  expect(fixture.router.push).not.toHaveBeenCalled();
  expect(contextAction()?.textContent).toBe("Restarting…");
  expect(contextAction()?.disabled).toBe(true);
  expect(appRow().querySelectorAll(".dashboard-context-action > button")).toHaveLength(1);
  expect(appRow().querySelector('.dashboard-status [role="status"]')?.textContent).toBe("Restarting…");
  expect(appRow().querySelector('.dashboard-identity [role="status"]')).toBeNull();
  expect(appRow().querySelector('.dashboard-identity')?.textContent).not.toContain("Restarting");
  expect(appRow().textContent).not.toContain("Restart required");
  expect(await restartDisabled()).toBe(true);

  let otherAction!: Promise<void>;
  await act(async () => { otherAction = actions.runAppAction(other, "restart"); });
  expect(shell.busyAction).toBe("other.app:restart");
  expect(shell.pendingAppActions).toEqual({ "routine.app": "restart", "other.app": "restart" });
  // The second app waits in the CSRF queue, but its progress is already visible.
  expect(callsTo("/api/apps/other.app/restart")).toHaveLength(0);
  expect(appRow(other.id).querySelector('[role="status"]')?.textContent).toBe("Restarting…");
  expect(contextAction(other.id)?.textContent).toBe("Restarting…");
  expect(contextAction(other.id)?.disabled).toBe(true);
  await act(async () => actions.runAppAction(target, "restart"));
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(1);

  apps = [{ ...target, restartRequired: false }, other];
  await act(async () => { first.resolve(Response.json({ status: "restarted" })); });
  expect(shell.pendingAppActions).toEqual({ "other.app": "restart" });
  expect(appRow().querySelector('[role="status"]')).toBeNull();
  expect(await restartDisabled(other.id)).toBe(true);
  expect(callsTo("/api/apps/other.app/restart")).toHaveLength(1);
  apps = apps.map(app => ({ ...app, restartRequired: false }));
  await act(async () => { second.resolve(Response.json({ status: "restarted" })); await otherAction; });
  expect(shell.pendingAppActions).toEqual({});
  expect(appRow(other.id).querySelector('[role="status"]')).toBeNull();
});

it("uses server lifecycle stages in the row, including for operations started by another client", async () => {
  apps = [{ ...target, runtimeState: "stopping", restartRequired: true }];
  await mount(true);
  expect(appRow().querySelector('.dashboard-status [role="status"]')?.textContent).toBe("Stopping…");
  expect(contextAction()?.textContent).toBe("Stopping…");
  expect(contextAction()?.disabled).toBe(true);
  expect(appRow().querySelector('.dashboard-identity')?.textContent).not.toContain("Stopping");
  await act(async () => actions.runAppAction(target, "restart"));
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(0);
  apps = [{ ...target, runtimeState: "starting", restartRequired: false }];
  await act(async () => actions.refresh());
  expect(appRow().querySelector('.dashboard-status [role="status"]')?.textContent).toBe("Starting…");
  expect(contextAction()?.textContent).toBe("Starting…");
  expect(contextAction()?.disabled).toBe(true);
  expect(appRow().querySelector('.dashboard-identity')?.textContent).not.toContain("Starting");
  expect(await restartDisabled()).toBe(true);
  apps = [{ ...target, runtimeState: "running", restartRequired: false }];
  await act(async () => actions.refresh());
  expect(appRow().querySelector('[role="status"]')).toBeNull();
  expect(await restartDisabled()).toBe(false);
});

it("clears failed restart progress, preserves the warning and allows an explicit retry", async () => {
  apps = [{ ...target, restartRequired: true }];
  let attempts = 0;
  overrideRequests(path => path.endsWith("/restart") ? (++attempts === 1
    ? Response.json({ message: "Restart preflight failed" }, { status: 409 })
    : Response.json({ status: "restarted" })) : undefined);
  await mount(true);
  await act(async () => actions.runAppAction(target, "restart"));
  expect(shell.pendingAppActions).toEqual({});
  expect(appRow().querySelector('[role="status"]')).toBeNull();
  expect(appRow().querySelector('.dashboard-identity [data-slot="badge"]')?.textContent).toBe("Restart required");
  expect(contextAction()?.disabled).toBe(false);
  expect(fixture.toast.error).toHaveBeenCalledWith("App action failed", expect.objectContaining({ description: "Restart preflight failed" }));
  await act(async () => contextAction()!.click());
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(2);
  expect(shell.pendingAppActions).toEqual({});
});

it("guards duplicate Shell confirmations and releases the guard on cancellation", async () => {
  const self = { ...target, id: "hosty.shell" };
  apps = [self];
  const confirmation = deferred<boolean>();
  fixture.confirm.mockReturnValueOnce(confirmation.promise).mockResolvedValue(false);
  await mount();
  let action!: Promise<void>;
  await act(async () => {
    action = actions.runAppAction(self, "restart");
    void actions.runAppAction(self, "restart");
  });
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  expect(shell.pendingAppActions).toEqual({});
  await act(async () => { confirmation.resolve(false); await action; });
  await act(async () => actions.runAppAction(self, "restart"));
  expect(fixture.confirm).toHaveBeenCalledTimes(2);
  expect(callsTo("/api/apps/hosty.shell/restart")).toHaveLength(0);
  expect(shell.pendingAppActions).toEqual({});
});

it("switches directly to a package without planning or compatibility confirmation", async () => {
  apps = [{ ...target, selectedRuntime: "dev", live: true, devMode: { operationId: "trial", phase: "active", previousRuntime: "docker" } }];
  await mount();
  await act(async () => actions.switchAppRuntime(apps[0], { kind: "package", runtime: "docker" }));
  expect(callsTo("/api/apps/routine.app/execution-target")).toHaveLength(1);
  expect(JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body)).toMatchObject({ kind: "package", runtime: "docker" });
  expect(callsTo("/api/apps/routine.app/dev-mode/plan")).toHaveLength(0);
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(fixture.toast.success).toHaveBeenCalledWith("Runtime switched", expect.objectContaining({ description: "Routine app" }));
});

it("retains one request while Shell is switching and recovers its lost response by reading Core", async () => {
  const self = { ...target, id: "hosty.shell", selectedRuntime: "dev", live: true };
  apps = [self];
  const status = deferred<Response>();
  overrideRequests(path => path === "/api/apps/hosty.shell/execution-target" ? Promise.reject(new TypeError("Proxy stopped"))
    : path.includes("/execution-target/") ? status.promise : undefined);
  await mount();
  let switching!: Promise<void>;
  await act(async () => { switching = actions.switchAppRuntime(self, "docker"); });
  await act(async () => { await actions.switchAppRuntime(self, "docker"); await actions.runAppAction(self, "start"); });
  const calls = callsTo("/api/apps/hosty.shell/execution-target");
  expect(calls).toHaveLength(1); expect(callsTo("/api/apps/hosty.shell/start")).toHaveLength(0);
  const request = JSON.parse(calls[0][1].body);
  expect(fixture.read.mock.calls.some(([url]) => new URL(url).pathname.endsWith(`/execution-target/${request.requestId}`))).toBe(true);
  expect(shell.busyAction).toBe("hosty.shell:switch-runtime:docker");
  await act(async () => { status.resolve(Response.json({ requestId: request.requestId, state: "failed", error: "Build failed; current app retained" })); await switching; });
  expect(fixture.toast.error).toHaveBeenCalledWith("Runtime switch failed", expect.objectContaining({ description: "Build failed; current app retained" }));
  expect(callsTo("/api/apps/hosty.shell/execution-target")).toHaveLength(1);
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(shell.busyAction).toBeNull();
});

it("reconnects using the original saved request instead of inventing another switch", async () => {
  const request = { kind: "workspace", workspaceId: "workspace-a", worktreeId: "tree-a", requestId: "4d12ad26-e645-41de-9814-98b6d60811a9" };
  localStorage.setItem("hosty.execution-target:https://core.test:routine.app", JSON.stringify(request));
  await mount();
  await act(async () => {});
  expect(callsTo("/api/apps/routine.app/execution-target").map(([, init]) => JSON.parse(init.body))).toEqual([request]);
});

it("reconciles a saved return after reload when the package already appears selected, then permits another workspace", async () => {
  const request = { kind: "package", runtime: "docker", requestId: "6a054af9-997b-47de-9758-bda46d5609f1" };
  const key = "hosty.execution-target:https://core.test:routine.app";
  apps = [{ ...target, selectedRuntime: "docker", live: false }];
  localStorage.setItem(key, JSON.stringify(request)); localStorage.setItem(key + ":state", "running");
  await mount();
  expect(callsTo("/api/apps/routine.app/execution-target").map(([, init]) => JSON.parse(init.body))).toEqual([request]);
  expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(key + ":state")).toBeNull();
  await act(async () => actions.switchAppRuntime(shell.state.apps[0], { kind: "workspace", workspaceId: "workspace-b", worktreeId: "tree-b" }));
  const requests = callsTo("/api/apps/routine.app/execution-target").map(([, init]) => JSON.parse(init.body));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ kind: "workspace", workspaceId: "workspace-b", worktreeId: "tree-b" });
  expect(requests[1].requestId).not.toBe(request.requestId);
  expect(fixture.toast.error).not.toHaveBeenCalled();
});

it.each(["starting", "stopping", "updating"])("reconciles a saved intent during initial %s without dropping recovery or submitting another request", async phase => {
  const request = { kind: "workspace", workspaceId: "workspace-a", worktreeId: "tree-a", requestId: "4fc3b0a5-328f-453b-80a3-f5a277d4053d" };
  const key = "hosty.execution-target:https://core.test:routine.app";
  apps = [{ ...target, selectedRuntime: "dev", live: true,
    runtimeState: phase === "updating" ? "running" : phase, operationStatus: phase === "updating" ? "updating" : "started" }];
  localStorage.setItem(key, JSON.stringify(request)); localStorage.setItem(key + ":state", "running");
  const receipt = deferred<Response>();
  overrideRequests(path => path === "/api/apps/routine.app/execution-target" ? Response.json({ requestId: request.requestId, state: "running" })
    : path.endsWith(`/execution-target/${request.requestId}`) ? receipt.promise : undefined);
  await mount();
  expect(callsTo("/api/apps/routine.app/execution-target").map(([, init]) => JSON.parse(init.body))).toEqual([request]);
  expect(shell.busyAction).toBe("routine.app:switch-runtime:workspace-a");
  await act(async () => actions.switchAppRuntime(apps[0], { kind: "workspace", workspaceId: "workspace-b", worktreeId: "tree-b" }));
  expect(callsTo("/api/apps/routine.app/execution-target")).toHaveLength(1);
  await act(async () => {
    apps = [{ ...apps[0], runtimeState: "running", operationStatus: "started" }];
    receipt.resolve(Response.json({ requestId: request.requestId, state: "completed", app: apps[0] }));
  });
  expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(key + ":state")).toBeNull();
  expect(shell.busyAction).toBeNull();
  expect(callsTo("/api/apps/routine.app/execution-target")).toHaveLength(1);
});

it.each(["succeeded", "denied"])("registers and submits actual access review, then handles %s without repeating consent", async outcome => {
  const review = { workspaceManifest: { appId: target.id, planDigest: "candidate-digest", additionalAccess: ["Host write access"] } };
  const prepared = { id: "approval", status: "draft", plan: null, approvalUrl: "https://core.test/approve/approval", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const submitted = { ...prepared, status: "pending" };
  let targetCalls = 0;
  overrideRequests((path, init) => {
    if (path.endsWith("/execution-target")) return Response.json(++targetCalls === 1 ? { state: "review-required", review } : { state: "completed" });
    if (path === "/api/installations" && init?.method === "POST") return Response.json(prepared);
    if (path === "/api/installations/approval/submit") return Response.json(submitted);
    if (path === "/api/installations/approval") return Response.json({ ...prepared, status: outcome });
  });
  await mount();
  let switching!: Promise<void>;
  await act(async () => { switching = actions.switchAppRuntime(target, { kind: "workspace", workspaceId: "w", worktreeId: "t" }); });
  expect(fixture.showConfirmation).toHaveBeenCalledWith(null, submitted);
  expect(callsTo("/api/installations").map(([, init]) => JSON.parse(init.body))).toEqual([review]);
  expect(callsTo("/api/installations/approval/submit")).toHaveLength(1);
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(targetCalls).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); await switching; });
  const requests = callsTo("/api/apps/routine.app/execution-target").map(([, init]) => JSON.parse(init.body));
  if (outcome === "succeeded") expect(requests).toEqual([requests[0], requests[0]]);
  else expect(requests).toHaveLength(1);
});

it("surfaces a definite refusal and allows a new explicit retry", async () => {
  overrideRequests(path => path.endsWith("/execution-target") ? Response.json({ message: "Workspace unavailable", code: "workspace_unavailable" }, { status: 409 }) : undefined);
  await mount();
  await act(async () => actions.switchAppRuntime(target, "docker"));
  expect(fixture.toast.error).toHaveBeenCalledWith("Runtime switch failed", expect.objectContaining({ description: "Workspace unavailable" }));
  expect(localStorage.getItem("hosty.execution-target:https://core.test:routine.app")).toBeNull();
});

const workspaceProfiles = [
  { key: "docker", type: "docker", default: true },
  { key: "dev", type: "localCommand", default: false, development: true },
  { key: "debug", type: "localCommand", default: false, development: true },
];
const dashboardWorkspace = { id: "workspace-a", state: "active", owner: { label: "Dashboard layout" },
  worktrees: [{ id: "tree-a", state: "active", path: "/work/dashboard", branch: "feature/dashboard",
    apps: [{ appId: target.id, subpath: "apps/shell" }] }] };
function mockWorkspaceRequests() {
  overrideRequests(path => {
    if (path === "/api/development/activation-workspaces") return Response.json({ workspaces: [dashboardWorkspace] });
    if (path === "/api/apps/execution-targets") return Response.json({ apps: apps.map(app => ({ appId: app.id, packageRuntime: "docker",
      current: app.selectedRuntime === "docker" ? { kind: "package", runtime: "docker" } : { kind: "workspace", runtime: app.selectedRuntime, workspaceId: dashboardWorkspace.id, worktreeId: "tree-a", name: "Dashboard layout" },
      choices: [{ kind: "package", runtime: "docker", available: true }, { kind: "workspace", runtime: "debug", workspaceId: dashboardWorkspace.id, worktreeId: "tree-a", name: "Dashboard layout", available: true }],
    })) });
    if (path.endsWith("/source/summary")) return Response.json({ state: "clean", branch: "feature/dashboard", head: "abc123", fileCount: 0, observedAt: "2026-10-20T00:00:00Z" });
    if (path.endsWith("/activation/list")) return Response.json([]);
    if (path.endsWith("/activation/plan")) return Response.json({ plan: { participants: [{ id: target.id, kind: "app", name: "Routine app", selected: true, availableRuntimes: ["dev", "debug"], targetRuntime: "dev" }] }, planDigest: "workspace-review", consequences: [] });
  });
}

it("offers only package profiles and named app-bound workspaces in one dropdown", async () => {
  apps = [{ ...target, selectedRuntime: "docker", runtimeProfiles: workspaceProfiles }];
  mockWorkspaceRequests(); await mount(true);
  const menu = await openRuntimeMenu();
  expect(menu?.textContent).toContain("docker"); expect(menu?.textContent).toContain("Dashboard layout");
  expect(menu?.textContent).not.toMatch(/Run from|debug|dev|previous|session|feature\/dashboard/);
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Dashboard layout")!;
  await act(async () => choice.click());
  expect(JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body)).toMatchObject({ kind: "workspace", workspaceId: "workspace-a", worktreeId: "tree-a" });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.confirm).not.toHaveBeenCalled();
});

it.each(["empty", "current package", "current workspace", "unavailable alternative"])("hides the runtime menu for %s without an available alternative", async kind => {
  const development = kind !== "current package";
  apps = [{ ...target, selectedRuntime: development ? "dev" : "docker", runtimeProfiles: workspaceProfiles }];
  mockWorkspaceRequests();
  overrideRequests(path => path === "/api/apps/execution-targets" ? Response.json({ apps: [{ appId: target.id,
    current: development ? { kind: "workspace", workspaceId: dashboardWorkspace.id, worktreeId: "tree-a", runtime: "dev" }
      : { kind: "package", runtime: "docker" },
    choices: kind === "empty" ? [] : kind === "current package" ? [{ kind: "package", runtime: "docker", available: true }]
      : [{ kind: "workspace", workspaceId: dashboardWorkspace.id, worktreeId: "tree-a", runtime: "dev", available: true },
        ...(kind === "unavailable alternative" ? [{ kind: "package", runtime: "docker", available: false }] : [])],
  }] }) : undefined);
  await mount(true);
  await openAppMenu();
  expect(document.querySelector('[aria-label="Switch runtime for Routine app"]')).toBeNull();
  if (development) expectDevelopmentMetadata("workspace");
  else expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe("docker");
});

it("offers a single package choice when it is an alternative to the current legacy source runtime", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles }];
  mockWorkspaceRequests();
  overrideRequests(path => path === "/api/apps/execution-targets" ? Response.json({ apps: [{ appId: target.id,
    current: { kind: "legacy", runtime: "dev" }, choices: [{ kind: "package", runtime: "docker", available: true }],
  }] }) : undefined);
  await mount(true);
  await openRuntimeMenu();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "docker")!;
  await act(async () => item.click());
  expect(JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body)).toMatchObject({ kind: "package", runtime: "docker" });
});

it("keeps package choices enabled while a workspace is active, with no duplicate return action", async () => {
  apps = [{ ...target, selectedRuntime: "debug", live: true, runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests(); await mount(true);
  await openRuntimeMenu();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "docker")!;
  expect(item.hasAttribute("data-disabled")).toBe(false);
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Return");
  await act(async () => item.click());
  expect(JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body)).toMatchObject({ kind: "package", runtime: "docker" });
  expect(fixture.confirm).not.toHaveBeenCalled();
});

it("shows one workspace name with its icon and Git details, clearing them after Return", async () => {
  apps = [{ ...target, live: true, autostart: false, selectedRuntime: "debug", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests();
  await mount(true);
  expectDevelopmentMetadata("workspace");
  const source = appRow().querySelector(".dashboard-version")!;
  expect(source.textContent).toContain("Dashboard layout");
  expect(source.textContent).not.toContain("feature/dashboard");
  expect(source.textContent?.match(/Dashboard layout/g)).toHaveLength(1);
  const workspaceLabel = source.querySelector<HTMLElement>('[aria-label="Workspace: Dashboard layout"]')!;
  expect(workspaceLabel).not.toBeNull();
  expect(workspaceLabel.textContent).toBe("Dashboard layout");
  expect(workspaceLabel.querySelector('.lucide-hammer[aria-hidden="true"]')).not.toBeNull();
  expect(source.querySelector(".lucide-git-branch")).toBeNull();
  await act(async () => workspaceLabel.focus());
  await act(async () => vi.advanceTimersByTime(200));
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Branch: feature/dashboard");
  expect(tooltip?.textContent).toContain("Commit: abc123");
  expect(tooltip?.textContent).toContain("Installed package: 1.0.0");
  expect(callsTo("/api/development/activation-workspaces", "GET")).toHaveLength(1);
  expect(source.parentElement?.textContent).not.toContain("Manual start");
  await openAppMenu();
  expect(document.querySelector('[role="menuitemcheckbox"]')?.textContent).toBe("Autostart");
  expect(document.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  apps = [{ ...apps[0], autostart: true }];
  await act(async () => actions.refresh());
  expectDevelopmentMetadata("workspace");
  expect(appRow().querySelector(".dashboard-version")?.parentElement?.textContent).not.toContain("Manual start");
  apps = [{ ...apps[0], selectedRuntime: "docker", live: false }];
  await act(async () => actions.refresh());
  expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe("docker");
  expect(appRow().querySelector(".dashboard-version")?.textContent).toContain("1.0.0");
  expect(appRow().textContent).not.toContain("Dashboard layout");
});

it.each(["dev_selection_changed", "dev_installation_changed", "execution_request_conflict"])("clears terminal %s so a new explicit selection can start", async code => {
  overrideRequests(path => path.endsWith("/execution-target") ? Response.json({ state: "failed", code, error: "Select the current target again." }) : undefined);
  await mount();
  await act(async () => actions.switchAppRuntime(target, { kind: "workspace", workspaceId: "w", worktreeId: "t" }));
  const first = JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body);
  expect(localStorage.getItem("hosty.execution-target:https://core.test:routine.app")).toBeNull();
  await act(async () => actions.switchAppRuntime(target, { kind: "workspace", workspaceId: "w", worktreeId: "t" }));
  const second = JSON.parse(callsTo("/api/apps/routine.app/execution-target")[1][1].body);
  expect(second.requestId).not.toBe(first.requestId);
});

it.each(["localCommand", "docker", "mixed", "extensionRuntime"])("identifies the %s development recipe as source without exposing its engine", async type => {
  apps = [{ ...target, selectedRuntime: "preview", runtimeProfiles: [{ key: "docker", type: "docker", default: true },
    { key: "preview", type, default: false, development: true }] }];
  await mount(true);
  expectDevelopmentMetadata("source");
  expect(appRow().querySelector(".dashboard-version")).not.toBeNull();
});

it.each(["running", "stopped"])("does not label an unregistered %s development folder as a workspace", async runtimeState => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeState, runtimeProfiles: workspaceProfiles, sourceLivePath: "/ordinary/source" }];
  overrideRequests(path => path === "/api/development/activation-workspaces" ? Response.json({ workspaces: [] }) : undefined);
  await mount(true);
  expectDevelopmentMetadata("source");
  expect(appRow().querySelector(".dashboard-version")?.textContent).not.toContain("Workspace");
});
it("recognizes an older workspace source binding without a unified current workspace target", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests();
  overrideRequests(path => path === "/api/apps/execution-targets" ? Response.json({ apps: [{ appId: target.id, current: { kind: "legacy", runtime: "dev" }, choices: [] }] }) : undefined);
  await mount(true);
  expectDevelopmentMetadata("workspace");
});
it.each(["native", "local"])("keeps the actual %s package runtime without a development icon for a local-command profile", async runtime => {
  apps = [{ ...target, selectedRuntime: runtime, runtimeProfiles: [{ key: runtime, type: "localCommand", default: true }], sourceManagedPath: "/work/dashboard" }];
  await mount(true);
  expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe(runtime);
  expect(appRow().querySelector(".dashboard-version")?.textContent).toContain(target.version);
  expect(appRow().querySelector(".dashboard-version .lucide-hammer, .dashboard-version .lucide-git-branch")).toBeNull();
});
it("labels a development source without guessing a workspace when metadata is inaccessible", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  overrideRequests(path => ["/api/development/activation-workspaces", "/api/apps/execution-targets"].includes(path) ? new Response(null, { status: 403 }) : undefined);
  await mount(true);
  expectDevelopmentMetadata("source");
  expect(appRow().querySelector(".dashboard-version")?.textContent).not.toContain("Workspace");
});
it("retains authoritative workspace provenance when its selected profile metadata is missing", async () => {
  apps = [{ ...target, selectedRuntime: "preview" }];
  mockWorkspaceRequests();
  await mount(true);
  expectDevelopmentMetadata("workspace");
  expect(appRow().querySelector('[aria-label="Workspace: Dashboard layout"]')).not.toBeNull();
});

it("shows factual source counts after the source name and retains them in the accessible disclosure", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests();
  overrideRequests(path => path.endsWith("/source/summary") ? Response.json({ state: "changes", branch: "feature/dashboard", head: "abc123",
    fileCount: 7, truncated: true, lineStats: { additions: 12, deletions: 3 }, observedAt: "2026-10-20T00:00:00Z" }) : undefined);
  await mount(true);
  const source = appRow().querySelector(".dashboard-version")!;
  expect(source.textContent).toContain("7+ files");
  expect(source.querySelector('[aria-label="12 lines added, 3 lines deleted"]')).not.toBeNull();
  await act(async () => source.querySelector<HTMLElement>('[aria-label="Workspace: Dashboard layout"]')!.focus());
  await act(async () => vi.advanceTimersByTime(200));
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Changed files: 7+ (incomplete list)");
  expect(tooltip?.textContent).toContain("Lines: +12 / −3 (HEAD to working tree)");
  await act(async () => source.querySelector<HTMLButtonElement>('[aria-label="Workspace: Dashboard layout"]')!.click());
  const disclosure = document.querySelector('[role="dialog"][aria-label="Source details for Routine app"]');
  expect(disclosure?.textContent).toContain("Changed files: 7+ (incomplete list)");
  expect(disclosure?.textContent).toContain("Lines: +12 / −3 (HEAD to working tree)");
});


it("keeps update-check errors on the problem icon instead of the release version", async () => {
  const error = "No update source is configured; choose a manifest URL or folder.";
  const successfulAt = "2026-10-20T09:09:53Z";
  apps = [{ ...target, updateCheck: { ...target.updateCheck!, updateAvailable: false, error, lastSuccessfulCheckAt: successfulAt } }];
  await mount(true);
  const version = appRow().querySelector(".dashboard-version")!;
  expect(version.querySelector("[title]")).toBeNull();
  expect(version.closest("[title]")).toBeNull();
  const icon = appRow().querySelector<HTMLElement>('[role="img"][aria-label="1 problem needing attention"]')!;
  expect(icon.hasAttribute("title")).toBe(false);
  expect(icon.tabIndex).toBe(0);
  await act(async () => icon.focus());
  await act(async () => vi.advanceTimersByTime(200));
  const diagnostic = document.querySelector('[role="tooltip"]');
  expect(diagnostic?.textContent).toContain(`Update check failed: ${error}`);
  expect(diagnostic?.textContent).toContain(`Last successful check: ${new Date(successfulAt).toLocaleString()}.`);
  expect(icon.getAttribute("aria-describedby")).toBe(diagnostic?.id);
  fixture.router.push.mockClear();
  await act(async () => icon.click());
  expect(fixture.router.push).not.toHaveBeenCalled();
  await act(async () => version.querySelector<HTMLElement>("[tabindex]")!.focus());
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Installed 1.0.0");
  expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain(error);
});

it("keeps the full diagnostic detail on each corresponding severity icon", async () => {
  apps = [{ ...target, updateCheck: null, lastError: "Runtime failed to start: port is occupied", manifestError: "Unknown manifest field" }];
  await mount(true);
  const error = appRow().querySelector<HTMLElement>('[role="img"][aria-label="1 problem affecting this app"]')!;
  const warning = appRow().querySelector<HTMLElement>('[role="img"][aria-label="1 problem needing attention"]')!;
  expect(error.hasAttribute("title")).toBe(false);
  expect(warning.hasAttribute("title")).toBe(false);
  await act(async () => error.focus());
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')?.textContent)
    .toBe("Last operation failed: Runtime failed to start: port is occupied");
  await act(async () => warning.focus());
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Unknown manifest field");
});


it("opens app settings inside the focusable SDK host without Dashboard detail expanders", async () => {
  // The real SDK frame wraps Shell in a tabindex=-1 content surface, outside the app row.
  container.className = "hosty-app-content";
  container.tabIndex = -1;
  await mount(true); fixture.router.push.mockClear();
  await act(async () => appRow().querySelector<HTMLElement>(".dashboard-status")!.click());
  expect(fixture.router.push).toHaveBeenCalledExactlyOnceWith(getManageAppHref(target.id), { scroll: false });
  expect(callsTo(`/api/apps/${target.id}/health`, "GET")).toHaveLength(0);
  expect(appRow().querySelector('button[aria-label="Show services"]')).toBeNull();
  expect(appRow().querySelector('button[aria-label="Hide services"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Show Core details"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Hide Core details"]')).toBeNull();
  const core = container.querySelector('table[aria-label="Hosty Core"]')!;
  expect(core.querySelector('button[aria-label="More actions for Hosty Core"]')).not.toBeNull();
  expect(core.textContent).toContain("Hosty Core");
  expect(container.textContent).not.toContain("Listen address");
  expect(container.textContent).not.toContain("Data root");
});

it("exposes the app name as a keyboard-focusable native settings link without a second row tab stop", async () => {
  await mount(true); fixture.router.push.mockClear();
  const link = [...appRow().querySelectorAll<HTMLAnchorElement>("a")].find(node => node.textContent === target.displayName)!;
  expect(link.href).toBe(new URL(getManageAppHref(target.id), window.location.href).href);
  expect(link.tabIndex).toBe(0);
  expect(appRow().hasAttribute("tabindex")).toBe(false);
  await act(async () => link.focus());
  expect(document.activeElement).toBe(link);
  // The native anchor owns Enter activation; the row must not synthesize another navigation.
  await act(async () => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(fixture.router.push).not.toHaveBeenCalled();
});

it("does not hijack modified, non-primary or text-selection clicks on an app row", async () => {
  await mount(true); fixture.router.push.mockClear();
  const cell = appRow().querySelector<HTMLElement>(".dashboard-status")!;
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }]) {
    await act(async () => cell.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, ...init })));
  }
  const range = document.createRange(); range.selectNodeContents(cell);
  window.getSelection()!.addRange(range);
  await act(async () => cell.click());
  expect(fixture.router.push).not.toHaveBeenCalled();
  window.getSelection()!.removeAllRanges();
  await act(async () => cell.click());
  expect(fixture.router.push).toHaveBeenCalledExactlyOnceWith(getManageAppHref(target.id), { scroll: false });
});

it("keeps lifecycle and menu actions independent of row settings navigation", async () => {
  apps = [{ ...target, updateCheck: null, capabilities: ["logs"] }];
  overrideRequests(path => path.endsWith("/stop") ? Response.json({ status: "stopped" })
    : path.endsWith("/logs") ? Response.json({ text: "Recent output", services: [] }) : undefined);
  await mount(true); fixture.router.push.mockClear();
  await act(async () => contextAction()!.click());
  expect(callsTo(`/api/apps/${target.id}/stop`)).toHaveLength(1);
  await openAppMenu();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).not.toContain("Manage application");
  const logs = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === "Console logs")!;
  await act(async () => logs.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(fixture.router.push).toHaveBeenCalledExactlyOnceWith(getManageAppHref(target.id, "logs"), { scroll: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(callsTo(`/api/apps/${target.id}/logs`, "GET")).toHaveLength(0);
});

it.each(["host.admin", "host.user"])("routes the contextual Logs shortcut to the app Logs tab for %s", async role => {
  apps = [{ ...target, updateCheck: null, capabilities: ["logs"], health: observedHealth("degraded") }];
  overrideRequests(path => path === "/api/auth/session"
    ? Response.json({ authenticated: true, user: { id: role === "host.admin" ? "admin" : "reader", role } }) : undefined);
  await mount(true); fixture.router.push.mockClear();
  await act(async () => contextAction()!.click());
  expect(fixture.router.push).toHaveBeenCalledExactlyOnceWith(getManageAppHref(target.id, "logs"), { scroll: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(callsTo(`/api/apps/${target.id}/logs`, "GET")).toHaveLength(0);
});

it("does not show a late backup read failure after navigating to Logs", async () => {
  apps = [{ ...target, updateCheck: null, capabilities: ["backup", "logs"] }];
  const backups = deferred<Response>();
  overrideRequests(path => path.endsWith("/backups") ? backups.promise : path.endsWith("/logs") ? Response.json({ text: "Runtime output" }) : undefined);
  await mount();
  setRoute(getManageAppHref(target.id, "backups")); await mount();
  expect(callsTo(`/api/apps/${target.id}/backups`, "GET")).toHaveLength(1);
  await act(async () => actions.openAppPanel(apps[0], "logs"));
  setRoute(getManageAppHref(target.id, "logs")); await mount();
  await act(async () => backups.resolve(Response.json({ message: "Old backup error" }, { status: 503 })));
  expect(container.querySelector("pre")?.textContent).toBe("Runtime output");
  expect(container.textContent).not.toContain("Old backup error");
});

it("routes the update notification's Logs callback to the same app Logs tab", async () => {
  apps = [{ ...target, updateCheck: null, capabilities: ["logs"] }];
  await mount(); fixture.router.push.mockClear();
  expect(fixture.openUpdateLogs).toBeTypeOf("function");
  await act(async () => fixture.openUpdateLogs!(apps[0]));
  expect(fixture.router.push).toHaveBeenCalledExactlyOnceWith(getManageAppHref(target.id, "logs"), { scroll: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each([false, true])("opens an administrator Logs deep link as App Details without a modal or hidden-service probes, legacy=%s", async legacy => {
  apps = [{ ...target, updateCheck: null, capabilities: ["logs"] }];
  setRoute(legacy ? `/settings?tab=manage:${target.id}&section=logs` : getManageAppHref(target.id, "logs"));
  overrideRequests(path => path.endsWith("/logs") ? Response.json({ text: "Recent runtime output", services: [] }) : undefined);
  await mount();
  expect(container.querySelector("h1")?.textContent).toBe(target.displayName);
  expect(container.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute("href")).toBe("/dashboard");
  if (legacy) expect(fixture.router.replace).toHaveBeenCalledWith(getManageAppHref(target.id, "logs"));
  const selected = container.querySelector('[role="tab"][data-state="active"]');
  expect(selected?.textContent).toBe("Logs");
  expect(container.querySelector("pre")?.textContent).toContain("Recent runtime output");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(callsTo(`/api/apps/${target.id}/logs`, "GET")).toHaveLength(1);
  expect(callsTo(`/api/apps/${target.id}/health`, "GET")).toHaveLength(0);
  expect(callsTo(`/api/apps/${target.id}/update-status`, "GET")).toHaveLength(0);
  expect(fixture.router.replace).not.toHaveBeenCalledWith("/");
});

it.each([false, true])("retains an assigned ordinary user's Logs page and factual Core refusal without exposing management, legacy=%s", async legacy => {
  apps = [{ ...target, updateCheck: null, capabilities: ["logs"] }];
  setRoute(legacy ? `/settings?tab=manage:${target.id}&section=logs` : getManageAppHref(target.id, "logs"));
  overrideRequests(path => path === "/api/auth/session"
    ? Response.json({ authenticated: true, user: { id: "reader", role: "host.user" } })
    : path.endsWith("/logs") ? Response.json({ code: "forbidden", message: "Host administrator access is required." }, { status: 403 }) : undefined);
  await mount();
  expect(container.querySelector("h1")?.textContent).toBe(target.displayName);
  expect(container.textContent).toContain("Host administrator access is required.");
  expect(container.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute("href")).toBe("/");
  if (legacy) expect(fixture.router.replace).toHaveBeenCalledWith(getManageAppHref(target.id, "logs"));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.router.replace).not.toHaveBeenCalledWith("/");
  expect(callsTo(`/api/apps/${target.id}/logs`, "GET")).toHaveLength(1);
  expect(container.querySelector("form")).toBeNull();
  expect([...container.querySelectorAll('[role="tab"]')].every(tab => tab.textContent === "Logs")).toBe(true);
  expect([...container.querySelectorAll("button")].some(button => ["Start", "Restart", "Stop", "Remove app…"].includes(button.textContent || ""))).toBe(false);
  expect(callsTo(`/api/apps/${target.id}/health`, "GET")).toHaveLength(0);
  expect(fixture.read.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it.each([
  { section: "logs", logs: false, assigned: true },
  { section: "source", logs: true, assigned: true },
  { section: "permissions", logs: true, assigned: true },
  { section: "logs", logs: true, assigned: false },
])("refuses an ordinary-user management deep link without the exact assigned Logs capability: %j", async ({ section, logs, assigned }) => {
  apps = assigned ? [{ ...target, updateCheck: null, capabilities: logs ? ["logs"] : [] }] : [];
  setRoute(getManageAppHref(target.id, section));
  overrideRequests(path => path === "/api/auth/session"
    ? Response.json({ authenticated: true, user: { id: "reader", role: "host.user" } }) : undefined);
  await mount();
  expect(fixture.router.replace).toHaveBeenCalledWith("/");
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("pre")).toBeNull();
  expect(callsTo(`/api/apps/${target.id}/logs`, "GET")).toHaveLength(0);
  expect(callsTo(`/api/apps/${target.id}/health`, "GET")).toHaveLength(0);
});

it("keeps version and diagnostic disclosures from opening app settings", async () => {
  apps = [{ ...target, updateCheck: null, lastError: "Runtime failed" }];
  await mount(true); fixture.router.push.mockClear();
  const version = appRow().querySelector<HTMLElement>('.dashboard-version [tabindex="0"]')!;
  await act(async () => version.focus());
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Installed 1.0.0");
  await act(async () => version.click());
  const problem = appRow().querySelector<HTMLElement>('[role="img"][aria-label="1 problem affecting this app"]')!;
  await act(async () => problem.click());
  expect(fixture.router.push).not.toHaveBeenCalled();
});

it("keeps source popover triggers and their portaled content independent of the app row", async () => {
  apps = [{ ...target, live: true, selectedRuntime: "debug", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests(); await mount(true); fixture.router.push.mockClear();
  await act(async () => appRow().querySelector<HTMLElement>('[aria-label="Workspace: Dashboard layout"]')!.click());
  const details = document.querySelector<HTMLElement>('[data-slot="popover-content"][aria-label="Source details for Routine app"]')!;
  expect(details.textContent).toContain("Branch: feature/dashboard");
  await act(async () => details.querySelector<HTMLElement>(".font-medium")!.click());
  expect(fixture.router.push).not.toHaveBeenCalled();
});

it("keeps the real resource popover trigger and portaled readings from opening app settings", async () => {
  fixture.realResources = true; await mount(true); fixture.router.push.mockClear();
  const resource = appRow().querySelector<HTMLElement>('button[aria-label^="Routine app resources:"]')!;
  await act(async () => resource.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
  expect(content.textContent).toContain("Waiting for resource samples");
  await act(async () => content.querySelector<HTMLElement>("p")!.click());
  expect(fixture.router.push).not.toHaveBeenCalled();
});

it("does not expose a settings link or navigate ordinary-user app rows", async () => {
  overrideRequests(path => path === "/api/auth/session" ? Response.json({ authenticated: true, user: { id: "member", role: "host.user" } }) : undefined);
  await mount(true); fixture.router.push.mockClear();
  expect([...appRow().querySelectorAll("a")].some(link => link.textContent === target.displayName)).toBe(false);
  await act(async () => appRow().querySelector<HTMLElement>(".dashboard-status")!.click());
  expect(fixture.router.push).not.toHaveBeenCalled();
});

it.each([false, true])("keeps explicit update checks guarded and retryable after failure=%s without row navigation", async fails => {
  const response = deferred<Response>();
  overrideRequests(path => path.endsWith("/update-status") ? response.promise : undefined);
  await mount(true); fixture.router.push.mockClear(); await openAppMenu();
  const check = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Check for updates")!;
  await act(async () => { check.click(); check.click(); });
  const requests = callsTo(`/api/apps/${target.id}/update-status`, "GET");
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0][0]).searchParams.get("refresh")).toBe("true");
  expect(check.hasAttribute("data-disabled")).toBe(true);
  await act(async () => response.resolve(fails
    ? Response.json({ message: "Feed is unavailable" }, { status: 502 }) : Response.json({ updateAvailable: true })));
  expect(check.hasAttribute("data-disabled")).toBe(false);
  if (fails) expect(fixture.toast.error).toHaveBeenCalledWith("Update check failed", {
    description: "Routine app: Feed is unavailable", appId: target.id,
  });
  else expect(fixture.toast.success).toHaveBeenCalledWith("Update available", { description: target.displayName });
  await act(async () => check.click());
  expect(callsTo(`/api/apps/${target.id}/update-status`, "GET")).toHaveLength(2);
  expect(fixture.router.push).not.toHaveBeenCalled();
});


it("does not dispatch an aborted workspace mutation after waiting in the CSRF queue", async () => {
  const held = deferred<Response>();
  overrideRequests(path => path === "/api/test/held" ? held.promise
    : path === "/api/test/after" ? Response.json({ ok: true }) : undefined);
  await mount();
  let first!: Promise<Response>, cancelled!: Promise<unknown>;
  const controller = new AbortController();
  await act(async () => {
    first = actions.sendCsrfJson("https://core.test/api/test/held", {});
    cancelled = actions.sendCsrfJson("https://core.test/api/development/workspaces/tree/activation/apply", {}, "POST", controller.signal).catch(error => error);
  });
  controller.abort();
  await act(async () => { held.resolve(Response.json({ ok: true })); await first; });
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect(callsTo("/api/development/workspaces/tree/activation/apply")).toHaveLength(0);
  await act(async () => { await actions.sendCsrfJson("https://core.test/api/test/after", {}); });
  expect(callsTo("/api/test/after")).toHaveLength(1);
});

it("does not dispatch Core restart when its actor is cancelled during CSRF acquisition", async () => {
  const token = deferred<Response>();
  overrideRequests(path => path === "/api/auth/csrf" ? token.promise : undefined);
  await mount();
  const controller = new AbortController();
  let cancelled!: Promise<unknown>;
  await act(async () => {
    cancelled = actions.sendCsrfJson("https://core.test/api/core/restart", {}, "POST", controller.signal).catch(error => error);
  });
  controller.abort();
  await act(async () => { token.resolve(Response.json({ token: "expired-actor-token" })); });
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect(callsTo("/api/core/restart")).toHaveLength(0);
});

it.each(["configure", "mounts"])("clears a failed Manage %s banner only after an explicit successful retry", async kind => {
  const configured = { ...target, settings: [{ key: "MODE", type: "string", value: "normal", secret: false }],
    mounts: [{ key: "library", mode: "ro", required: false, multiple: false, bindings: [{ source: "local", label: "Library", hostPath: "/library", containerPath: "/external/library" }] }] };
  apps = [configured]; setRoute(`/apps/${target.id}?section=${kind === "configure" ? "parameters" : "mounts"}`);
  let attempts = 0;
  overrideRequests((path, init) => {
    if (path !== `/api/apps/${target.id}/${kind}` || init?.method !== "POST") return;
    if (++attempts === 1) return Response.json({ message: "First save failed", code: "invalid_fixture" }, { status: 400 });
    const body = JSON.parse(String(init.body));
    apps = [{ ...configured, ...(kind === "configure" ? { settings: [{ ...configured.settings[0], value: body.settings.MODE }] }
      : { mounts: [{ ...configured.mounts[0], bindings: [{ ...configured.mounts[0].bindings[0], hostPath: body.mounts[0].hostPath }] }] }) }];
    return Response.json({ status: "configured" });
  });
  await mount();
  const input = container.querySelector<HTMLInputElement>(kind === "configure" ? "#setting-MODE" : '[aria-label="library host path"]')!;
  const draft = kind === "configure" ? "quiet" : "/new-library";
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, draft); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === (kind === "configure" ? "Save settings" : "Save mounts"))!;
  await act(async () => save().click()); expect(container.textContent).toContain("First save failed"); expect(input.value).toBe(draft);
  await act(async () => save().click()); expect(container.textContent).not.toContain("First save failed"); expect(input.value).toBe(draft);
  expect(attempts).toBe(2); expect(fixture.toast.success).toHaveBeenCalledExactlyOnceWith(kind === "configure" ? "Settings saved" : "Mounts saved", { description: configured.displayName });
});

it("does not attach a late configure failure to another app's Manage page", async () => {
  const configured = { ...target, settings: [{ key: "MODE", type: "string", value: "normal", secret: false }] };
  const other = { ...configured, id: "other.app", displayName: "Other app" }; apps = [configured, other];
  setRoute(`/apps/${target.id}?section=parameters`); const response = deferred<Response>();
  overrideRequests((path, init) => path === `/api/apps/${target.id}/configure` && init?.method === "POST" ? response.promise : undefined);
  await mount();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save settings")!.click());
  await act(async () => actions.openAppPanel(other, "settings", { settingsTab: "parameters" }));
  setRoute(`/apps/${other.id}?section=parameters`); await mount(); expect(container.querySelector("h1")?.textContent).toBe("Other app");
  await act(async () => response.resolve(Response.json({ message: "Old app failed" }, { status: 400 })));
  expect(container.textContent).not.toContain("Old app failed"); expect(container.querySelector("h1")?.textContent).toBe("Other app");
});
