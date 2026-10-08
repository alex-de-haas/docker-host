import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { useShellActions, type ShellActionsContextValue } from "../src/app/shell/shell-context";
import { CoreRequestError } from "../src/app/shell/core-api";
import type { CoreApp } from "../src/app/shell/types";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), settle: vi.fn(), showConfirmation: vi.fn(),
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
vi.mock("../src/components/reui/confirmation", () => ({ useConfirmation: () => ({ confirm: vi.fn(), dialog: null }) }));
vi.mock("../src/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../src/app/shell/sidebar/shell-sidebar", () => ({ ShellSidebar: () => null }));
vi.mock("../src/app/shell/chrome/shell-top-strip", () => ({ ShellTopStrip: () => null }));
vi.mock("../src/app/shell/chrome/shell-workspace-split", () => ({ ShellWorkspaceSplit: ({ children }: { children: ReactNode }) => children }));

let root: Root;
let container: HTMLDivElement;
let actions: ShellActionsContextValue;
let apps: CoreApp[];
const target: CoreApp = {
  id: "routine.app", displayName: "Routine app", version: "1.0.0", kind: "app", system: false,
  source: "https://publisher.test/manifest.json", operationStatus: "started", runtimeState: "running", capabilities: [],
  updateCheck: { requiresReview: false, planDigest: "old-digest", updateAvailable: true, checkedAt: "2026-10-08T00:00:00Z" },
};
const plan = (digest = "old-digest", review = false) => ({ planDigest: digest, requiresReview: review, changes: ["version"], sourceConfigured: true });
const refusal = (code = "update_plan_stale", status = 409) => Response.json({ code, message: "Candidate changed" }, { status });
const callsTo = (path: string, method = "POST") => fixture.read.mock.calls.filter(([url, init]) => new URL(url).pathname === path && (init?.method ?? "GET") === method);
function ActionCapture() {
  const current = useShellActions();
  useEffect(() => { actions = current; }, [current]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(window, "open").mockReturnValue(null);
  apps = [target];
  fixture.read.mockReset(); fixture.settle.mockReset(); fixture.showConfirmation.mockReset();
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
async function mount() {
  await act(async () => root.render(<ShellClient coreOrigin="https://core.test" shellAppId="hosty.shell"
    initialSidebarCompact={false} initialRightPanelOpen={false} initialRightPanelWidth={360}><ActionCapture /></ShellClient>));
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
