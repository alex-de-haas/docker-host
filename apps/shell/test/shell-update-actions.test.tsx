import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { useShellActions, useShellState, type ShellActionsContextValue, type ShellContextValue } from "../src/app/shell/shell-context";
import { DashboardPage } from "../src/app/shell/pages/dashboard-page";
import { CoreRequestError } from "../src/app/shell/core-api";
import type { CoreApp } from "../src/app/shell/types";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), settle: vi.fn(), switchSettle: vi.fn(), showConfirmation: vi.fn(), confirm: vi.fn(),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  router: { replace: vi.fn(), push: vi.fn() },
  params: new URLSearchParams(),
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => "/dashboard", useSearchParams: () => fixture.params }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", resolvedTheme: "light" }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: {}, subscribeToCoreEvents: (_origin: string, options: { topic?: string; onSync: () => Promise<void> }) => { if (!options.topic) void options.onSync(); return () => {}; } }));
vi.mock("../src/app/shell/assistant/use-assistant-selection", () => ({
  useAssistantSelection: () => ({ assistants: [], selected: null, selectedId: null, select: () => {}, choose: async () => null }),
}));
vi.mock("../src/app/shell/update-notifications", () => ({ useAppUpdateNotifications: () => {} }));
vi.mock("../src/app/shell/self-update", () => ({ waitForShellUpdateToSettle: fixture.settle }));
vi.mock("../src/app/shell/self-runtime-switch", () => ({ waitForShellRuntimeSwitch: fixture.switchSettle }));
vi.mock("../src/app/shell/core-confirmation", () => ({ showCoreConfirmation: fixture.showConfirmation }));
vi.mock("../src/components/reui/operation-toast", async () => {
  const { createContext } = await import("react");
  return { toast: fixture.toast, AssistantFeedbackContext: createContext({}), errorReportText: () => "" };
});
vi.mock("../src/components/reui/confirmation", () => ({ useConfirmation: () => ({ confirm: fixture.confirm, dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", () => ({ ResourceUsageProvider: ({ children }: { children: ReactNode }) => children, ResourceUsage: () => null }));
vi.mock("../src/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../src/app/shell/sidebar/shell-sidebar", () => ({ ShellSidebar: () => null }));
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
    canManageApps loading={false} busyAction={state.busyAction} pendingAppActions={state.pendingAppActions}
    updateCheck={null} updateStatusInvalidations={{}} onRefresh={() => {}} onInstall={() => {}}
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
  apps = [target];
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
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(dashboard = false) {
  await act(async () => root.render(<ShellClient coreOrigin="https://core.test" shellAppId="hosty.shell"
    initialSidebarCompact={false} initialRightPanelOpen={false} initialRightPanelWidth={360}><ActionCapture dashboard={dashboard} /></ShellClient>));
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
    .find(row => row.textContent?.includes(id))!;
}

it("shows immediate restart progress and keeps each queued app busy without submitting duplicates", async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  const other = { ...target, id: "other.app", displayName: "Other app", restartRequired: true };
  apps = [{ ...target, restartRequired: true }, other];
  overrideRequests(path => path === "/api/apps/routine.app/restart" ? first.promise
    : path === "/api/apps/other.app/restart" ? second.promise : undefined);
  await mount(true);
  const restart = [...appRow().querySelectorAll("button")].find(button => button.textContent === "Restart")!;
  expect(restart.disabled).toBe(false);
  await act(async () => {
    restart.click(); restart.click();
    // The handler also protects toast/menu callers before React has committed the disabled UI.
    void actions.runAppAction(target, "restart");
    void actions.runAppAction(target, "stop");
  });
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(1);
  expect(callsTo("/api/apps/routine.app/stop")).toHaveLength(0);
  expect(appRow().querySelector('[role="status"]')?.textContent).toBe("Restarting…");
  expect(appRow().textContent).not.toContain("Restart required");
  expect(appRow().querySelector<HTMLButtonElement>('button[title="Restart app"]')?.disabled).toBe(true);

  let otherAction!: Promise<void>;
  await act(async () => { otherAction = actions.runAppAction(other, "restart"); });
  expect(shell.busyAction).toBe("other.app:restart");
  expect(shell.pendingAppActions).toEqual({ "routine.app": "restart", "other.app": "restart" });
  // The second app waits in the CSRF queue, but its progress is already visible.
  expect(callsTo("/api/apps/other.app/restart")).toHaveLength(0);
  expect(appRow(other.id).querySelector('[role="status"]')?.textContent).toBe("Restarting…");
  await act(async () => actions.runAppAction(target, "restart"));
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(1);

  apps = [{ ...target, restartRequired: false }, other];
  await act(async () => { first.resolve(Response.json({ status: "restarted" })); });
  expect(shell.pendingAppActions).toEqual({ "other.app": "restart" });
  expect(appRow().querySelector('[role="status"]')).toBeNull();
  expect(appRow(other.id).querySelector<HTMLButtonElement>('button[title="Restart app"]')?.disabled).toBe(true);
  expect(callsTo("/api/apps/other.app/restart")).toHaveLength(1);
  apps = apps.map(app => ({ ...app, restartRequired: false }));
  await act(async () => { second.resolve(Response.json({ status: "restarted" })); await otherAction; });
  expect(shell.pendingAppActions).toEqual({});
  expect(appRow(other.id).querySelector('[role="status"]')).toBeNull();
});

it("uses server lifecycle stages in the row, including for operations started by another client", async () => {
  apps = [{ ...target, runtimeState: "stopping", restartRequired: true }];
  await mount(true);
  expect(appRow().querySelector('[role="status"]')?.textContent).toBe("Stopping…");
  await act(async () => actions.runAppAction(target, "restart"));
  expect(callsTo("/api/apps/routine.app/restart")).toHaveLength(0);
  apps = [{ ...target, runtimeState: "starting", restartRequired: false }];
  await act(async () => actions.refresh());
  expect(appRow().querySelector('[role="status"]')?.textContent).toBe("Starting…");
  expect(appRow().querySelector<HTMLButtonElement>('button[title="Restart app"]')?.disabled).toBe(true);
  apps = [{ ...target, runtimeState: "running", restartRequired: false }];
  await act(async () => actions.refresh());
  expect(appRow().querySelector('[role="status"]')).toBeNull();
  expect(appRow().querySelector<HTMLButtonElement>('button[title="Restart app"]')?.disabled).toBe(false);
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
  expect(appRow().textContent).toContain("Restart required");
  expect(fixture.toast.error).toHaveBeenCalledWith("App action failed", expect.objectContaining({ description: "Restart preflight failed" }));
  await act(async () => actions.runAppAction(target, "restart"));
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
  const trigger = appRow().querySelector('button[aria-label="Switch runtime for Routine app"]')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const menu = document.querySelector('[role="menu"]');
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
  expect(appRow().querySelector('button[aria-label="Switch runtime for Routine app"]')).toBeNull();
  expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe(development ? "workspace" : "docker");
  expect(appRow().querySelector(".dashboard-runtime .lucide-radio")).toBeNull();
});

it("offers a single package choice when it is an alternative to the current legacy source runtime", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles }];
  mockWorkspaceRequests();
  overrideRequests(path => path === "/api/apps/execution-targets" ? Response.json({ apps: [{ appId: target.id,
    current: { kind: "legacy", runtime: "dev" }, choices: [{ kind: "package", runtime: "docker", available: true }],
  }] }) : undefined);
  await mount(true);
  const trigger = appRow().querySelector('button[aria-label="Switch runtime for Routine app"]')!;
  expect(trigger).not.toBeNull();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "docker")!;
  await act(async () => item.click());
  expect(JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body)).toMatchObject({ kind: "package", runtime: "docker" });
});

it("keeps package choices enabled while a workspace is active, with no duplicate return action", async () => {
  apps = [{ ...target, selectedRuntime: "debug", live: true, runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests(); await mount(true);
  const trigger = appRow().querySelector('button[aria-label="Switch runtime for Routine app"]')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "docker")!;
  expect(item.hasAttribute("data-disabled")).toBe(false);
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Return");
  await act(async () => item.click());
  expect(JSON.parse(callsTo("/api/apps/routine.app/execution-target")[0][1].body)).toMatchObject({ kind: "package", runtime: "docker" });
  expect(fixture.confirm).not.toHaveBeenCalled();
});

it("shows one workspace runtime label and its purpose with Git details, clearing them after Return", async () => {
  apps = [{ ...target, live: true, selectedRuntime: "debug", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests();
  await mount(true);
  expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe("workspace");
  expect(appRow().querySelector(".dashboard-runtime .lucide-radio")).toBeNull();
  const source = appRow().querySelector(".dashboard-version")!;
  expect(source.textContent).toContain("Dashboard layout");
  expect(source.textContent).not.toContain("feature/dashboard");
  expect(source.textContent?.match(/Dashboard layout/g)).toHaveLength(1);
  const workspaceLabel = source.querySelector<HTMLElement>('[aria-label="Workspace: Dashboard layout"]')!;
  expect(workspaceLabel).not.toBeNull();
  expect(workspaceLabel.querySelector(".lucide-boxes")).not.toBeNull();
  expect(source.querySelector(".lucide-git-branch")).toBeNull();
  await act(async () => workspaceLabel.focus());
  await act(async () => vi.advanceTimersByTime(200));
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Branch: feature/dashboard");
  expect(tooltip?.textContent).toContain("Commit: abc123");
  expect(tooltip?.textContent).toContain("Installed package: 1.0.0");
  expect(callsTo("/api/development/activation-workspaces", "GET")).toHaveLength(1);
  apps = [{ ...apps[0], selectedRuntime: "docker", live: false }];
  await act(async () => actions.refresh());
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

it.each(["localCommand", "docker", "mixed", "extensionRuntime"])("uses one source label for an unregistered %s development runtime", async type => {
  apps = [{ ...target, selectedRuntime: "preview", runtimeProfiles: [{ key: "docker", type: "docker", default: true },
    { key: "preview", type, default: false, development: true }] }];
  await mount(true);
  const runtime = appRow().querySelector(".dashboard-runtime")!;
  expect(runtime.textContent).toBe("source");
  expect(runtime.querySelector(".lucide-radio")).toBeNull();
});

it.each(["running", "stopped"])("labels an unregistered %s development folder only as source", async runtimeState => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeState, runtimeProfiles: workspaceProfiles, sourceLivePath: "/ordinary/source" }];
  overrideRequests(path => path === "/api/development/activation-workspaces" ? Response.json({ workspaces: [] }) : undefined);
  await mount(true);
  const runtime = appRow().querySelector(".dashboard-runtime")!;
  expect(runtime.textContent).toBe("source");
  expect(runtime.querySelector(".lucide-radio")).toBeNull();
});
it("recognizes an older workspace source binding without a unified current workspace target", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests();
  overrideRequests(path => path === "/api/apps/execution-targets" ? Response.json({ apps: [{ appId: target.id, current: { kind: "legacy", runtime: "dev" }, choices: [] }] }) : undefined);
  await mount(true);
  expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe("workspace");
  expect(appRow().querySelector(".dashboard-runtime .lucide-radio")).toBeNull();
});
it("keeps package runtime names without a source marker even when the profile uses a local command", async () => {
  apps = [{ ...target, selectedRuntime: "native", runtimeProfiles: [{ key: "native", type: "localCommand", default: true }], sourceManagedPath: "/work/dashboard" }];
  await mount(true);
  expect(appRow().querySelector(".dashboard-runtime")?.textContent).toBe("native");
});
it("uses source without guessing a workspace when workspace metadata is inaccessible", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  overrideRequests(path => ["/api/development/activation-workspaces", "/api/apps/execution-targets"].includes(path) ? new Response(null, { status: 403 }) : undefined);
  await mount(true);
  const runtime = appRow().querySelector(".dashboard-runtime")!;
  expect(runtime.textContent).toBe("source");
  expect(runtime.querySelector(".lucide-radio")).toBeNull();
});
it("retains authoritative workspace provenance when its selected profile metadata is missing", async () => {
  apps = [{ ...target, selectedRuntime: "preview" }];
  mockWorkspaceRequests();
  await mount(true);
  const runtime = appRow().querySelector(".dashboard-runtime")!;
  expect(runtime.textContent).toBe("workspace");
  expect(runtime.querySelector(".lucide-radio")).toBeNull();
});

it("puts app line totals before the changed-file count using the same spaced summary as Core", async () => {
  apps = [{ ...target, selectedRuntime: "dev", runtimeProfiles: workspaceProfiles, sourceLivePath: "/work/dashboard" }];
  mockWorkspaceRequests();
  overrideRequests(path => path.endsWith("/source/summary") ? Response.json({ state: "changes", branch: "feature/dashboard", head: "abc123",
    fileCount: 7, truncated: true, lineStats: { additions: 12, deletions: 3 }, observedAt: "2026-10-20T00:00:00Z" }) : undefined);
  await mount(true);
  const source = appRow().querySelector(".dashboard-version")!;
  const totals = source.querySelector<HTMLElement>('[role="img"][aria-label="12 lines added, 3 lines deleted"]')!;
  expect(totals).not.toBeNull();
  expect(totals.textContent).toBe("+12−3");
  const files = [...source.querySelectorAll<HTMLElement>("span")].find(span => span.textContent === "7+ changed files")!;
  expect(files).toBeDefined();
  expect(totals.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(totals.parentElement).toBe(files.parentElement);
});
