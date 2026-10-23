import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { useShellActions, type ShellActionsContextValue } from "../src/app/shell/shell-context";
import { ShellAvailableAppsRoute } from "../src/app/shell/shell-route-pages";
import type { CoreApp } from "../src/app/shell/types";

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  toast: { info: vi.fn(() => "confirmation"), dismiss: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  router: { replace: vi.fn(), push: vi.fn() }, params: new URLSearchParams(),
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => "/apps", useSearchParams: () => fixture.params }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", resolvedTheme: "light" }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: {}, subscribeToCoreEvents: () => () => {} }));
vi.mock("../src/app/shell/assistant/use-assistant-selection", () => ({
  useAssistantSelection: () => ({ assistants: [], selected: null, selectedId: null, select: () => {}, choose: async () => null }),
}));
vi.mock("../src/app/shell/update-notifications", () => ({ useAppUpdateNotifications: () => {} }));
vi.mock("../src/components/reui/operation-toast", async () => {
  const { createContext } = await import("react");
  return { toast: fixture.toast, AssistantFeedbackContext: createContext({}), errorReportText: () => "" };
});
vi.mock("../src/components/reui/confirmation", () => ({ useConfirmation: () => ({ confirm: vi.fn(), dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", () => ({ ResourceUsageProvider: ({ children }: { children: ReactNode }) => children, ResourceUsage: () => null }));
vi.mock("../src/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../src/app/shell/sidebar/shell-sidebar", () => ({ ShellSidebar: () => null }));
vi.mock("../src/app/shell/chrome/shell-mobile-tabs", () => ({ ShellMobileTabs: () => null }));
vi.mock("../src/app/shell/chrome/shell-top-strip", () => ({ ShellTopStrip: () => null }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUiHost: () => null }));
vi.mock("../src/app/shell/chrome/shell-panel-workspace", () => ({ ShellPanelWorkspace: ({ children }: { children: ReactNode }) => children }));

let root: Root, container: HTMLDivElement, actions: ShellActionsContextValue;
let apps: CoreApp[], role: string, decision: string, prepareError: boolean;
const target: CoreApp = {
  id: "example.media", displayName: "Media", version: "1.0.0", kind: "app", system: true,
  source: "manifest", operationStatus: "started", runtimeState: "running", capabilities: [],
  embeddedUrl: "https://media.test/", navigation: [{ label: "Media", path: "/", embeddedUrl: "https://media.test/" }],
};
const draft = { id: "removal", status: "draft", plan: null,
  approvalUrl: "https://core.test/install/confirm/removal", expiresAt: "2099-01-01T00:00:00Z" };
const callsTo = (path: string, method = "POST") => fixture.read.mock.calls.filter(([url, init]) => new URL(url).pathname === path && (init?.method ?? "GET") === method);
function Contents() {
  const current = useShellActions();
  useEffect(() => { actions = current; }, [current]);
  return <ShellAvailableAppsRoute />;
}
beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(window, "open").mockReturnValue(null);
  apps = [target]; role = "host.admin"; decision = "denied"; prepareError = false;
  vi.clearAllMocks();
  fixture.read.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/core/status") return Response.json({ status: "ready", warnings: [], launch: { mode: "dev" } });
    if (path === "/api/auth/session") return Response.json({ authenticated: true, user: { id: "viewer", role } });
    if (path === "/api/auth/csrf") return Response.json({ token: "csrf" });
    if (path === "/api/apps") return Response.json({ apps });
    if (path === "/api/apps/execution-targets") return Response.json({ apps: [] });
    if (path === "/api/global-mounts") return Response.json({ mounts: [] });
    if (path === "/api/installations") return prepareError
      ? Response.json({ message: "Target changed", code: "removal_stale" }, { status: 409 }) : Response.json(draft);
    if (path === "/api/installations/removal/submit") return Response.json({ ...draft, status: "pending" });
    if (path === "/api/installations/removal") {
      if (decision === "succeeded") apps = apps.filter(app => app.id !== target.id);
      return Response.json({ ...draft, status: decision, error: decision === "failed" ? "Runtime could not stop" : null });
    }
    if (path.endsWith("/logs")) return Response.json({ text: "", services: [] });
    throw new Error(`Unexpected request: ${url} (${init?.method ?? "GET"})`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const mount = () => act(async () => root.render(<ShellClient coreOrigin="https://core.test" shellAppId="hosty.shell"
  initialSidebarCompact={false} initialRightPanelOpen={false} initialRightPanelWidth={360}><Contents /></ShellClient>));
const uninstall = () => container.querySelector<HTMLButtonElement>('[aria-label="Uninstall Media"]')!;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });

it("opens Core removal directly from Apps with default choices, CSRF and blocked-popup fallback", async () => {
  await mount();
  expect(container.textContent).toContain("Open"); expect(container.textContent).toContain("Standalone");
  expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toContain("/api/apps/example.media/open");
  await act(async () => { uninstall().click(); uninstall().click(); });
  expect(window.open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank", "popup,width=640,height=720");
  expect(callsTo("/api/installations")).toHaveLength(1);
  const init = callsTo("/api/installations")[0][1];
  expect(JSON.parse(init.body)).toEqual({ removeAppId: target.id });
  expect(new Headers(init.headers).get("X-Hosty-CSRF")).toBe("csrf");
  expect(callsTo("/api/installations/removal/submit")).toHaveLength(1);
  expect(fixture.toast.info).toHaveBeenCalledWith("Open Core confirmation", expect.objectContaining({ action: expect.objectContaining({ label: "Open confirmation" }) }));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(container.textContent).not.toContain("Delete app data");
  expect(uninstall().disabled).toBe(true);
  await settle();
  expect(fixture.toast.info).toHaveBeenCalledWith("App removal cancelled");
  expect(fixture.toast.dismiss).toHaveBeenCalledWith("confirmation");
  expect(fixture.toast.success).not.toHaveBeenCalled(); expect(uninstall().disabled).toBe(false);
  await act(async () => uninstall().click()); await settle();
  expect(callsTo("/api/installations")).toHaveLength(2);
});

it("leaves ordinary users' Open and Standalone controls while hiding and refusing uninstall", async () => {
  role = "host.user"; await mount();
  expect(uninstall()).toBeNull();
  expect(container.textContent).toContain("Open"); expect(container.querySelector('a[target="_blank"]')).not.toBeNull();
  await act(async () => actions.openAppPanel(target, "remove"));
  expect(window.open).not.toHaveBeenCalled(); expect(callsTo("/api/installations")).toHaveLength(0);
});

it("keeps stopped system apps removable and preserves their disabled launch controls", async () => {
  apps = [{ ...target, runtimeState: "stopped" }]; await mount();
  expect(uninstall().disabled).toBe(false);
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Open")?.disabled).toBe(true);
  expect(container.querySelector('a[target="_blank"]')?.getAttribute("aria-disabled")).toBe("true");
  expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBeNull();
  await act(async () => uninstall().click()); await settle();
  expect(JSON.parse(callsTo("/api/installations")[0][1].body)).toEqual({ removeAppId: target.id });
});

it("routes existing removal entrypoints to Core and refreshes only after success", async () => {
  decision = "succeeded"; await mount();
  const reads = callsTo("/api/apps", "GET").length;
  await act(async () => actions.openAppPanel(target, "remove"));
  expect(callsTo("/api/apps", "GET")).toHaveLength(reads);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await settle();
  expect(callsTo("/api/apps", "GET").length).toBeGreaterThan(reads);
  expect(fixture.toast.success).toHaveBeenCalledExactlyOnceWith("App removed", { description: "Media" });
  expect(container.textContent).toContain("No apps available");
});

it("shows preparation and execution errors without a removed Shell dialog", async () => {
  prepareError = true; await mount();
  const popup = { close: vi.fn() } as unknown as Window;
  vi.mocked(window.open).mockReturnValueOnce(popup);
  await act(async () => uninstall().click());
  expect(popup.close).toHaveBeenCalledOnce();
  expect(fixture.toast.error).toHaveBeenCalledWith("App removal failed", { description: "Target changed" });
  expect(callsTo("/api/installations/removal/submit")).toHaveLength(0);
  prepareError = false; decision = "failed";
  await act(async () => uninstall().click()); await settle();
  expect(fixture.toast.error).toHaveBeenCalledWith("App removal failed", { description: "Runtime could not stop" });
  expect(fixture.toast.success).not.toHaveBeenCalled(); expect(uninstall().disabled).toBe(false);
});

it("keeps the selected app identity and another app’s Logs destination while removal completes", async () => {
  const other: CoreApp = { ...target, id: "example.other", displayName: "Other", capabilities: ["logs"] };
  apps = [target, other]; decision = "succeeded"; await mount();
  await act(async () => uninstall().click());
  await act(async () => actions.openAppPanel(other, "logs"));
  expect(fixture.router.push).toHaveBeenLastCalledWith("/apps/example.other?section=logs", { scroll: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await settle();
  expect(JSON.parse(callsTo("/api/installations")[0][1].body)).toEqual({ removeAppId: target.id });
  expect(fixture.router.push).toHaveBeenLastCalledWith("/apps/example.other?section=logs", { scroll: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.toast.success).toHaveBeenCalledExactlyOnceWith("App removed", { description: "Media" });
});
