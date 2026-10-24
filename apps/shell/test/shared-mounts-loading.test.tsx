import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellClient } from "../src/app/shell-client";
import { useShellActions, useShellState, type ShellActionsContextValue, type ShellContextValue } from "../src/app/shell/shell-context";
import { ShellSettingsRoute } from "../src/app/shell/shell-route-pages";
import type { CoreGlobalMount } from "../src/app/shell/types";
import { APP_SESSION_ENDED } from "@hosty-sdk/app/browser-auth";

const fixture = vi.hoisted(() => ({
  read: vi.fn(), confirm: vi.fn(),
  toast: { info: vi.fn(), dismiss: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
  router: { replace: vi.fn(), push: vi.fn() }, params: new URLSearchParams("tab=host&section=mounts"),
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => "/settings", useSearchParams: () => fixture.params }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", resolvedTheme: "light" }) }));
vi.mock("../src/app/shell/events/core-event-stream", () => ({ CoreEventNames: {}, subscribeToCoreEvents: () => () => {} }));
vi.mock("../src/app/shell/assistant/use-assistant-selection", () => ({ useAssistantSelection: () => ({ assistants: [], selected: null, selectedId: null, select: () => {}, choose: async () => null }) }));
vi.mock("../src/app/shell/update-notifications", () => ({ useAppUpdateNotifications: () => {} }));
vi.mock("../src/components/reui/operation-toast", async () => { const { createContext } = await import("react"); return { toast: fixture.toast, AssistantFeedbackContext: createContext({}), errorReportText: () => "" }; });
vi.mock("../src/components/reui/confirmation", () => ({ useConfirmation: () => ({ confirm: fixture.confirm, dialog: null }) }));
vi.mock("../src/app/shell/resources/resource-usage", () => ({ ResourceUsageProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("../src/app/shell/sidebar/shell-sidebar", () => ({ ShellSidebar: () => null }));
vi.mock("../src/app/shell/chrome/shell-mobile-tabs", () => ({ ShellMobileTabs: () => null }));
vi.mock("../src/app/shell/chrome/shell-top-strip", () => ({ ShellTopStrip: () => null }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUiHost: () => null }));
vi.mock("../src/app/shell/chrome/shell-panel-workspace", () => ({ ShellPanelWorkspace: ({ children }: { children: ReactNode }) => children }));

let root: Root, container: HTMLDivElement, actions: ShellActionsContextValue, snapshot: ShellContextValue;
let actor: string, role: string;
let readMounts: () => Promise<Response>;
let removeMount: () => Promise<Response>;
let saveMount: () => Promise<Response>;
let readApps: () => Promise<Response>;
const mount = (name: string): CoreGlobalMount => ({ name, hostPath: "/srv/" + name, mode: "rw", usedBy: 0 });
function Contents() {
  const currentActions = useShellActions(), currentState = useShellState();
  useEffect(() => { actions = currentActions; snapshot = currentState; }, [currentActions, currentState]);
  return <ShellSettingsRoute />;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "open").mockReturnValue(null); fixture.confirm.mockResolvedValue(true);
  actor = "alice"; role = "host.admin";
  readMounts = async () => Response.json({ mounts: [mount("library")] });
  removeMount = async () => Response.json({ mounts: [] });
  saveMount = async () => Response.json({ mounts: [] });
  readApps = async () => Response.json({ apps: [] });
  fixture.read.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/core/status") return Response.json({ status: "ready", warnings: [], launch: { mode: "dev" } });
    if (path === "/api/auth/session") return Response.json({ authenticated: true, user: { id: actor, role } });
    if (path === "/api/auth/csrf") return Response.json({ token: "csrf" });
    if (path === "/api/apps") return readApps();
    if (path === "/api/global-mounts") return init?.method === "POST" ? saveMount() : readMounts();
    if (path.startsWith("/api/global-mounts/") && init?.method === "DELETE") return removeMount();
    if (path === "/api/core/development") return Response.json({ message: "No development target" }, { status: 404 });
    if (path === "/api/development/activation-workspaces") return Response.json({ workspaces: [] });
    if (path === "/api/core-environments") return Response.json({ environments: [] });
    if (path === "/api/sandbox-instances") return Response.json({ instances: [] });
    throw new Error("Unexpected request: " + path);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const render = (origin = "https://core.test") => act(async () => root.render(<ShellClient coreOrigin={origin} shellAppId="hosty.shell" initialSidebarCompact={false} initialRightPanelOpen={false} initialRightPanelWidth={360}><Contents /></ShellClient>));
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
const refresh = () => act(async () => { await actions.refresh(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it("does not turn a failed first library read into a confirmed empty result and retries inside the existing Frame", async () => {
  readMounts = async () => Response.json({ message: "Mount service unavailable" }, { status: 503 });
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Mount service unavailable");
  expect(container.textContent).not.toContain("No shared mounts");
  expect(snapshot.globalMountsStatus).toMatchObject({ loading: false, loaded: false, error: "Mount service unavailable" });
  const next = deferred<Response>(); readMounts = () => next.promise;
  await click("Retry shared mounts");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading shared mounts…");
  expect(container.textContent).not.toContain("No shared mounts");
  await act(async () => next.resolve(Response.json({ mounts: [] })));
  expect(container.textContent).toContain("No shared mounts");
  expect(snapshot.globalMountsStatus).toMatchObject({ loading: false, loaded: true, error: null });
  expect(fixture.read.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
});
it("retains the last confirmed table only for the same actor and keeps editor drafts through a transient read failure", async () => {
  await render(); await click("Add mount");
  const input = document.getElementById("shared-mount-name") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "draft-folder"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  readMounts = async () => { throw new Error("Mount read offline"); };
  await refresh();
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["library"]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loaded: true, error: "Mount read offline" });
  expect(container.textContent).toContain("Previously loaded shared mounts are shown.");
  expect((document.getElementById("shared-mount-name") as HTMLInputElement).value).toBe("draft-folder");
});
it("clears prior-actor data and editor drafts before waiting for the new actor's library", async () => {
  await render(); await click("Add mount");
  const next = deferred<Response>(); actor = "bob"; readMounts = () => next.promise;
  let pending!: Promise<void>;
  await act(async () => { pending = actions.refresh(); });
  expect(snapshot.globalMounts).toEqual([]);
  expect(document.getElementById("shared-mount-name")).toBeNull();
  expect(container.textContent).not.toContain("/srv/library");
  await act(async () => { next.resolve(Response.json({ message: "Bob library unavailable" }, { status: 503 })); await pending; });
  expect(snapshot.activeUser?.id).toBe("bob");
  expect(snapshot.globalMountsStatus).toMatchObject({ loaded: false, loading: false, error: "Bob library unavailable" });
  expect(container.textContent).not.toContain("No shared mounts");
});
it("ignores an old read after a newer actor refresh and clears library access for an ordinary account", async () => {
  await render();
  const old = deferred<Response>(); readMounts = () => old.promise;
  let pending!: Promise<void>; await act(async () => { pending = actions.refresh(); });
  actor = "bob"; readMounts = async () => Response.json({ mounts: [mount("bob-folder")] });
  await refresh();
  await act(async () => { old.resolve(Response.json({ mounts: [mount("alice-secret")] })); await pending; });
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["bob-folder"]);
  expect(container.textContent).not.toContain("alice-secret");
  const requests = fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/global-mounts").length;
  role = "host.user"; await refresh();
  expect(snapshot.globalMounts).toEqual([]);
  expect(fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/global-mounts")).toHaveLength(requests);
  expect(container.textContent).not.toContain("Shared mounts");
});
it.each([401, 403])("does not retain cached mount data after authority refusal %s", async status => {
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit mount"]')!.click());
  expect((document.getElementById("shared-mount-path") as HTMLInputElement).value).toBe("/srv/library");
  const ended = vi.fn(); window.addEventListener(APP_SESSION_ENDED, ended);
  try {
    readMounts = async () => Response.json({ message: "Mount access denied" }, { status });
    await refresh();
    expect(snapshot.globalMounts).toEqual([]);
    expect(snapshot.globalMountsStatus?.loaded).toBe(false);
    expect(container.textContent).not.toContain("/srv/library");
    expect(document.getElementById("shared-mount-path")).toBeNull();
    expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  } finally { window.removeEventListener(APP_SESSION_ENDED, ended); }
});
it("does not project malformed success as empty and accepts an exact delete receipt without an extra read", async () => {
  await render(); readMounts = async () => Response.json({}); await refresh();
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["library"]);
  expect(container.textContent).toContain("Core did not return the shared mount library");
  const requests = fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/global-mounts").length;
  await act(async () => { await actions.deleteGlobalMount("library"); });
  const mutation = fixture.read.mock.calls.find(([url, init]) => new URL(url).pathname === "/api/global-mounts/library" && init?.method === "DELETE")!;
  expect(new Headers(mutation[1].headers).get("X-Hosty-CSRF")).toBe("csrf");
  expect(snapshot.globalMounts).toEqual([]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loaded: true, loading: false, error: null });
  expect(fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/global-mounts")).toHaveLength(requests);
});
it("ignores a prior actor's late delete receipt and resets the library on Core origin change", async () => {
  await render();
  const oldDelete = deferred<Response>(); removeMount = () => oldDelete.promise;
  let pending!: Promise<void>; await act(async () => { pending = actions.deleteGlobalMount("library"); });
  actor = "bob"; readMounts = async () => Response.json({ mounts: [mount("bob-folder")] }); await refresh();
  await act(async () => { oldDelete.resolve(Response.json({ mounts: [] })); await pending; });
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["bob-folder"]);
  readMounts = async () => Response.json({ message: "Other Core unavailable" }, { status: 503 });
  await render("https://another-core.test");
  expect(snapshot.globalMounts).toEqual([]);
  expect(snapshot.globalMountsStatus?.loaded).toBe(false);
  expect(container.textContent).not.toContain("bob-folder");
});

it("keeps existing mount save payload and CSRF, then projects only the refreshed confirmed list", async () => {
  await render();
  readMounts = async () => Response.json({ mounts: [mount("library"), { ...mount("archive"), mode: "ro" }] });
  const input = { name: "archive", hostPath: "/srv/archive", mode: "ro", description: null };
  await act(async () => { await actions.saveGlobalMount(input); });
  const mutation = fixture.read.mock.calls.find(([url, init]) => new URL(url).pathname === "/api/global-mounts" && init?.method === "POST")!;
  expect(JSON.parse(mutation[1].body)).toEqual(input);
  expect(new Headers(mutation[1].headers).get("X-Hosty-CSRF")).toBe("csrf");
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["library", "archive"]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loaded: true, loading: false, error: null });
});
it("does not start an old actor's post-save read after the session changes", async () => {
  await render();
  const oldSave = deferred<Response>(); saveMount = () => oldSave.promise;
  let pending!: Promise<void>; await act(async () => { pending = actions.saveGlobalMount({ name: "archive", hostPath: "/srv/archive" }); });
  actor = "bob"; readMounts = async () => Response.json({ mounts: [mount("bob-folder")] }); await refresh();
  const reads = fixture.read.mock.calls.filter(([url, init]) => new URL(url).pathname === "/api/global-mounts" && !init?.method).length;
  await act(async () => { oldSave.resolve(Response.json({ mounts: [] })); await pending; });
  expect(fixture.read.mock.calls.filter(([url, init]) => new URL(url).pathname === "/api/global-mounts" && !init?.method)).toHaveLength(reads);
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["bob-folder"]);
});
it("does not restore an older same-actor list over a newer confirmed delete receipt", async () => {
  await render();
  const oldRead = deferred<Response>(); readMounts = () => oldRead.promise;
  let pending!: Promise<void>; await act(async () => { pending = actions.refresh(); });
  await act(async () => { await actions.deleteGlobalMount("library"); });
  expect(snapshot.globalMounts).toEqual([]);
  await act(async () => { oldRead.resolve(Response.json({ mounts: [mount("library")] })); await pending; });
  expect(snapshot.globalMounts).toEqual([]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loaded: true, loading: false, error: null });
});

it("does not let a stale refresh leaving apps discovery invalidate the current mount read", async () => {
  await render();
  const olderApps = deferred<Response>();
  readApps = () => olderApps.promise;
  let olderRefresh!: Promise<void>;
  await act(async () => { olderRefresh = actions.refresh(); });
  const latestMounts = deferred<Response>();
  readApps = async () => Response.json({ apps: [] });
  readMounts = () => latestMounts.promise;
  let latestRefresh!: Promise<void>;
  await act(async () => { latestRefresh = actions.refresh(); });
  expect(snapshot.globalMountsStatus?.loading).toBe(true);
  const reads = fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/global-mounts").length;
  await act(async () => { olderApps.resolve(Response.json({ apps: [] })); await olderRefresh; });
  expect(fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/global-mounts")).toHaveLength(reads);
  await act(async () => { latestMounts.resolve(Response.json({ mounts: [mount("latest-folder")] })); await latestRefresh; });
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["latest-folder"]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loading: false, loaded: true, error: null });
  expect(container.textContent).not.toContain("Loading shared mounts…");
});

it("refreshes a successful same-actor save after a full refresh completed during its request", async () => {
  await render();
  const saving = deferred<Response>(); saveMount = () => saving.promise;
  let pending!: Promise<void>;
  await act(async () => { pending = actions.saveGlobalMount({ name: "archive", hostPath: "/srv/archive" }); });
  await refresh();
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["library"]);
  readMounts = async () => Response.json({ mounts: [mount("library"), mount("archive")] });
  await act(async () => { saving.resolve(Response.json({ mounts: [] })); await pending; });
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["library", "archive"]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loading: false, loaded: true, error: null });
});

it("projects a successful same-actor delete after a full refresh completed during its request", async () => {
  await render();
  const deleting = deferred<Response>(); removeMount = () => deleting.promise;
  let pending!: Promise<void>;
  await act(async () => { pending = actions.deleteGlobalMount("library"); });
  await refresh();
  expect(snapshot.globalMounts.map(item => item.name)).toEqual(["library"]);
  await act(async () => { deleting.resolve(Response.json({ mounts: [] })); await pending; });
  expect(snapshot.globalMounts).toEqual([]);
  expect(snapshot.globalMountsStatus).toMatchObject({ loading: false, loaded: true, error: null });
  expect(container.textContent).toContain("No shared mounts");
});
