import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { useShellActions, useShellState, type ShellActionsContextValue, type ShellContextValue } from "../src/app/shell/shell-context";
import { DashboardPage } from "../src/app/shell/pages/dashboard-page";
import { CoreRequestError } from "../src/app/shell/core-api";
import type { CoreApp } from "../src/app/shell/types";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), settle: vi.fn(), showConfirmation: vi.fn(), confirm: vi.fn(),
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  router: { replace: vi.fn(), push: vi.fn() },
  params: new URLSearchParams(),
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => "/dashboard", useSearchParams: () => fixture.params }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", resolvedTheme: "light" }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: {}, subscribeToCoreEvents: () => () => {} }));
vi.mock("../src/app/shell/assistant/use-assistant-selection", () => ({
  useAssistantSelection: () => ({ assistants: [], selected: null, selectedId: null, select: () => {}, choose: async () => null }),
}));
vi.mock("../src/app/shell/update-notifications", () => ({ useAppUpdateNotifications: () => {} }));
vi.mock("../src/app/shell/self-update", () => ({ waitForShellUpdateToSettle: fixture.settle }));
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
vi.mock("../src/app/shell/chrome/shell-workspace-split", () => ({ ShellWorkspaceSplit: ({ children }: { children: ReactNode }) => children }));

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
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(window, "open").mockReturnValue(null);
  apps = [target];
  fixture.read.mockReset(); fixture.settle.mockReset(); fixture.showConfirmation.mockReset();
  fixture.confirm.mockReset();
  for (const toast of Object.values(fixture.toast)) toast.mockReset();
  fixture.read.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/core/status") return Response.json({ status: "ready", warnings: [], launch: { mode: "dev" } });
    if (path === "/api/auth/session") return Response.json({ authenticated: true, user: { id: "admin", role: "host.admin" } });
    if (path === "/api/auth/csrf") return Response.json({ token: "csrf" });
    if (path === "/api/apps") return Response.json({ apps });
    if (path === "/api/global-mounts") return Response.json({ mounts: [] });
    if (path.endsWith("/update/plan")) return Response.json(init?.method === "POST" ? plan("fresh-digest") : { plan: plan() });
    if (path.endsWith("/update")) return Response.json({ status: "updating" });
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
