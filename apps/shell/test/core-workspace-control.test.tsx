import { act } from "react";
import { APP_SESSION_ENDED } from "@hosty-sdk/app/browser-auth";
import { CoreRequestError } from "../src/app/shell/core-api";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCoreWorkspaceControl, type CoreWorkspaceControlProps } from "../src/app/shell/core-workspace-control";
import type { CoreDevelopment, CoreLaunch } from "../src/app/shell/core-development";
import type { ActivationWorkspace } from "../src/app/shell/workspace-sources";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../src/components/ui/dropdown-menu";

const fixture = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), release: vi.fn(), userId: "admin",
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellActions: () => ({ sendCsrfJson: fixture.send }),
  useShellState: () => ({ activeUser: { id: fixture.userId } }),
}));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: fixture.toast }));
const origin = "https://core.test";
const releaseOperationId = "1234567890abcdef1234567890abcdef";
const project = "apps/core/Core.csproj";
const workspace: ActivationWorkspace = { id: "workspace-a", name: "Hosty redesign", state: "active", owner: { label: "External task" },
  worktrees: [{ id: "tree-a", path: "/managed/tree-a", state: "active", branch: "hosty/session/tree-a", apps: [{ appId: "hosty.shell", subpath: "apps/shell" }] }] };
const state: CoreDevelopment = {
  instance: "42:start", manageable: true, launch: { mode: "release", projectPath: null, generationPath: null, processId: 42, startedAt: "2026-10-22T12:00:00Z" },
  source: { overridePath: null, revision: "source-a", repositoryUrl: "https://example.test/hosty.git", projectPath: project },
  managedPath: "/managed/main", sourcePath: "/managed/main", selectedProjectPath: `/managed/main/${project}`,
  restartRequired: false, branch: "main", commit: "abc123", changedFiles: 0, additions: 0, deletions: 0, gitError: null,
};

const other: ActivationWorkspace = { ...workspace, id: "app-only", name: "Media repository", worktrees: [{ ...workspace.worktrees[0], id: "media-tree", path: "/media" }] };
type Selection = { coreSelected?: boolean; coreWorktreeId?: string; apps?: { appId: string; selected: boolean; worktreeId?: string; runtime?: string }[] };
type Activation = { id: string; workspaceId?: string; coreWorktreeId?: string; activatedCore?: CoreLaunch; coreReturnTarget?: { launch: CoreLaunch }; phase: string; coreProject: string; coreReturned?: boolean; previousCore?: { mode: string; projectPath?: string }; returns?: { request: { requestId: string }; state: string }[] };
let props: CoreWorkspaceControlProps, root: Root, container: HTMLDivElement;
let records: Record<string, Activation[]>, current: Activation | null, statusError: boolean;
let operationStatus: string, operationMissing: boolean;
let intercept: ((kind: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined) | null;
const journalKey = () => `hosty:core-workspace:${props.coreOrigin}:${fixture.userId}:v1`;
function review(workspaceId: string, selection: Selection) {
  const item = props.workspaces.find(row => row.id === workspaceId)!;
  const trees = item.worktrees.filter(tree => tree.state === "active");
  const tree = trees.find(tree => tree.id === selection.coreWorktreeId) ?? trees[0];
  const unavailable = workspaceId === other.id ? "The configured Core repository is not in this workspace." : null;
  return { plan: { coreInstance: props.state!.instance, coreSourceRevision: props.state!.source.revision, participants: [
    ...["hosty.shell", "media.app"].map(id => ({ id, kind: "app", selected: selection.apps?.find(row => row.appId === id)?.selected ?? true,
      worktreeId: trees[0]?.id, targetRuntime: "dev", sourcePath: "/unrelated/application" })),
    { id: "hosty:core", kind: "core", selected: selection.coreSelected === true && !unavailable, worktreeId: !unavailable && (trees.length === 1 || selection.coreWorktreeId) ? tree?.id : null,
      worktreeOptions: unavailable ? [] : trees.map(tree => tree.id), sourcePath: !unavailable && tree ? `${tree.path}/${project}` : null, unavailable,
      branch: tree?.branch, commit: "abc123", changedFiles: 2 },
  ] }, planDigest: `${props.state!.instance}:${workspaceId}:${tree?.id}`, consequences: ["Core restarts; application runtimes stay unchanged."] };
}
function Probe() {
  const control = useCoreWorkspaceControl(props);
  return <><output aria-label="Busy">{String(control.busy)}</output><output aria-label="Needs attention">{String(control.needsAttention)}</output><button onClick={control.showRecovery}>Check switch</button>{props.menu ? <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button">Core actions</button></DropdownMenuTrigger>
    <DropdownMenuContent>{control.control}</DropdownMenuContent>
  </DropdownMenu> : control.control}{control.dialog}</>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const calls = (kind: string) => fixture.send.mock.calls.filter(([url]) => new URL(url).pathname.endsWith(`/activation/${kind}`));
const mutations = () => fixture.send.mock.calls.filter(([url]) => /\/activation\/(apply|return|resume|cancel)$/.test(new URL(url).pathname));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;
const click = (label: string) => act(async () => button(label).click());
const render = () => act(async () => root.render(<Probe />));
async function openMenu() {
  if (props.menu) {
    await act(async () => button("Core actions").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => document.querySelector('[aria-label="Switch runtime for Hosty Core"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  } else await act(async () => document.querySelector('[aria-label="Switch runtime for Hosty Core"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.startsWith(label))!;
async function choose(label: string) { await openMenu(); await act(async () => item(label).click()); }
async function refreshStatus() { if (button("Check progress")) await click("Check progress"); else await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await act(async () => {}); }
function active(id = "old-activation"): Activation { return { id, workspaceId: workspace.id, coreWorktreeId: "tree-a", phase: "active", coreProject: `/managed/tree-a/${project}`, previousCore: { mode: "dev", projectPath: "/managed/previous/Core.csproj" } }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); fixture.userId = "admin";
  props = { coreOrigin: origin, state, workspaces: [workspace], disabled: false, onRelease: fixture.release };
  records = {}; current = null; statusError = false; intercept = null; operationStatus = "starting"; operationMissing = false;
  fixture.release.mockResolvedValue(releaseOperationId);
  fixture.read.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/core/execution-targets") return Response.json({
      targets: props.workspaces.filter(item => item.state !== "released" && item.id !== other.id).flatMap(item => {
        const trees = item.worktrees.filter(tree => tree.state === "active");
        return trees.map(tree => ({ workspaceId: item.id, worktreeId: tree.id,
          label: item.name + (trees.length > 1 ? " · " + tree.branch : ""), projectPath: `${tree.path}/${project}` }));
      }), activations: Object.entries(records).flatMap(([workspaceId, activations]) => activations.map(activation => ({ workspaceId, activation }))),
    });
    return path.includes("/operations/")
      ? operationMissing ? Response.json({ message: "Operation not found" }, { status: 404 }) : Response.json({ id: releaseOperationId, status: operationStatus })
      : Response.json(props.state);
  });
  fixture.send.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    const match = /\/workspaces\/([^/]+)\/activation\/([^/]+)$/.exec(new URL(url).pathname)!;
    const workspaceId = decodeURIComponent(match[1]), kind = match[2];
    const intercepted = intercept?.(kind, body); if (intercepted) return intercepted;
    if (kind === "list") return Response.json(records[workspaceId] ?? []);
    if (kind === "plan") return Response.json(review(workspaceId, body.selection as Selection));
    if (kind === "apply") {
      current = { id: String(body.requestId), workspaceId, coreWorktreeId: (body.selection as Selection).coreWorktreeId, phase: "prepared", coreProject: `${props.workspaces.find(row => row.id === workspaceId)!.worktrees.find(tree => tree.id === (body.selection as Selection).coreWorktreeId)!.path}/${project}` };
      return Response.json({ state: "accepted" });
    }
    if (kind === "status") return statusError ? Response.json({ message: "Operation status unavailable" }, { status: 503 })
      : Response.json({ status: { activation: current ?? { id: body.activationId, phase: "preparing", coreProject: `/managed/tree-a/${project}` }, helper: { state: current?.phase === "active" ? "completed" : "running" } }, children: [] });
    if (kind === "return") {
      current = { ...current!, phase: "return-core-starting", returns: [{ request: { requestId: (body.return as { requestId: string }).requestId }, state: "pending" }] };
      return Response.json({ state: "accepted" });
    }
    if (["resume", "cancel"].includes(kind)) return Response.json({ state: "accepted" });
    throw new Error(`Unexpected request ${url}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads named registered choices without admitting lifecycle work when opening the menu", async () => {
  props.workspaces = [workspace, other, { ...workspace, id: "released", name: "Released", state: "released" }];
  await render(); expect(fixture.send).not.toHaveBeenCalled(); await openMenu();
  expect(item("Release").hasAttribute("data-disabled")).toBe(true);
  expect(item("Hosty redesign").hasAttribute("data-disabled")).toBe(false);
  expect(item("Media repository")).toBeUndefined();
  expect(item("Released")).toBeUndefined();
  expect(mutations()).toHaveLength(0); expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/core/execution-targets")).toHaveLength(1);
});

it("loads a large workspace catalog in one read without per-workspace plans or activation reads", async () => {
  props.workspaces = Array.from({ length: 70 }, (_, index) => ({ ...workspace, id: `workspace-${index}`, name: `Workspace ${index}` }));
  await render(); await openMenu();
  expect(item("Workspace 69")).toBeDefined();
  expect(fixture.read).toHaveBeenCalledOnce();
  expect(fixture.send).not.toHaveBeenCalled();
});

it("shows catalog failure without falling back to expensive activation plans", async () => {
  fixture.read.mockResolvedValue(Response.json({ message: "Workspace catalog is unavailable." }, { status: 503 }));
  await render(); await openMenu();
  expect(document.body.textContent).toContain("Workspace catalog is unavailable.");
  expect(item("Release").hasAttribute("data-disabled")).toBe(true);
  expect(fixture.send).not.toHaveBeenCalled();
});

it("ignores a delayed catalog from the previous user", async () => {
  const pending = deferred<Response>(); fixture.read.mockReturnValueOnce(pending.promise);
  await render(); await openMenu(); fixture.userId = "another-admin"; await render();
  await act(async () => pending.resolve(Response.json({ targets: [{ workspaceId: "private", worktreeId: "private-tree", label: "Previous user's workspace", projectPath: "/private/Core.csproj" }], activations: [] })));
  expect(document.body.textContent).not.toContain("Previous user's workspace");
  expect(fixture.send).not.toHaveBeenCalled();
});

it("keeps the selected named Core worktree and its review after More closes, then admits it once", async () => {
  props.menu = true;
  props.workspaces = [{ ...workspace, worktrees: [...workspace.worktrees, { ...workspace.worktrees[0], id: "tree-b", path: "/managed/tree-b", branch: "feature/second" }] }];
  await render(); await choose("Hosty redesign · feature/second");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Core will start from Hosty redesign · feature/second");
  expect(mutations()).toHaveLength(0);
  expect(calls("plan")).toHaveLength(2);
  expect(calls("plan").every(([url]) => new URL(url).pathname.includes("/workspaces/workspace-a/"))).toBe(true);
  await act(async () => { button("Switch Core").click(); button("Switch Core").click(); });
  expect(calls("apply")).toHaveLength(1);
  const body = calls("apply")[0][1];
  expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(body.selection.coreWorktreeId).toBe("tree-b");
  expect(body.selection.apps.every((row: { selected: boolean }) => row.selected === false)).toBe(true);
  expect(body.planDigest).toBe("42:start:workspace-a:tree-b");
  expect(document.body.textContent).not.toContain("readiness is confirmed");
  expect(fixture.release).not.toHaveBeenCalled();
});

it("marks only the factual current project as active and suppresses its duplicate selection", async () => {
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: `/managed/tree-a/${project}` } };
  props.workspace = { id: workspace.id, label: workspace.name! };
  await render(); await openMenu();
  expect(item("Hosty redesign").hasAttribute("data-disabled")).toBe(true);
  expect(item("Release").hasAttribute("data-disabled")).toBe(false);
  await act(async () => item("Hosty redesign").click());
  expect(mutations()).toHaveLength(0);
});

it.each(["disabled", "unmanaged", "missing-state"])("keeps runtime selection unavailable for %s", async reason => {
  if (reason === "disabled") props.disabled = true;
  if (reason === "unmanaged") props.state = { ...state, manageable: false, launch: { ...state.launch, mode: "unmanaged" } };
  if (reason === "missing-state") props.state = null;
  await render();
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Switch runtime for Hosty Core"]')!;
  expect(trigger.disabled).toBe(true); expect(mutations()).toHaveLength(0);
});

it("retains the exact uncertain apply across unmount and retries only its original UUID/body", async () => {
  statusError = true;
  intercept = kind => kind === "apply" ? Promise.reject(new TypeError("Connection lost after submission")) : undefined;
  await render(); await choose("Hosty redesign"); await click("Switch Core");
  const original = calls("apply")[0][1];
  const saved = JSON.parse(localStorage.getItem(journalKey())!);
  expect(saved.pending.body).toEqual(original);
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain("Reconnecting to Core…");
  expect(document.querySelector('[role="dialog"] [role="status"] svg')?.classList.contains("animate-spin")).toBe(true);
  expect(document.querySelector('[role="dialog"] [role="status"]')?.classList.contains("text-info-foreground")).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Connection lost after submission");
  expect(button("Check progress")).toBeUndefined();
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(calls("apply")).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  await openMenu(); await act(async () => item("Recover Core switch…").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("original request is retained");
  await click("Retry switch");
  expect(calls("apply").map(([, body]) => body)).toEqual([original, original]);
});

it("does not continue to Release until Core Return is confirmed and the user explicitly continues", async () => {
  current = active(); records[workspace.id] = [current];
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: current.coreProject } };
  await render(); await choose("Release");
  expect(button("Return Core").disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  await click("Return Core");
  expect(calls("return")).toHaveLength(1);
  const returning = calls("return")[0][1];
  expect(returning).toMatchObject({ activationId: "old-activation", return: { apps: [], core: true, acceptDataChanges: true } });
  expect(fixture.release).not.toHaveBeenCalled();
  current = { ...current!, phase: "active", coreReturned: true };
  props.state = { ...state, instance: "43:return", launch: { ...state.launch, mode: "dev", projectPath: "/managed/previous/Core.csproj" } };
  await render(); await refreshStatus();
  expect(button("Continue to Release")).toBeDefined(); expect(fixture.release).not.toHaveBeenCalled();
  await click("Continue to Release"); expect(fixture.release).toHaveBeenCalledOnce();
});

it("switches directly between Core workspaces with one reviewed apply and no Return", async () => {
  current = active(); records[workspace.id] = [current];
  const targetWorkspace = { ...workspace, id: "workspace-b", name: "Settings rework", worktrees: [{ ...workspace.worktrees[0], id: "tree-b", path: "/managed/tree-b" }] };
  props.workspaces = [workspace, targetWorkspace];
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: current.coreProject } };
  props.workspace = { id: workspace.id, label: workspace.name! };
  await render(); await choose("Settings rework");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Current CoreHosty redesign");
  expect(dialog.textContent).toContain("Switch toSettings rework");
  expect(dialog.textContent).not.toContain("Return Core");
  expect(dialog.textContent).not.toContain("Core is now running");
  expect(dialog.textContent).not.toContain("old-activation");
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(mutations()).toHaveLength(0);
  await click("Switch Core");
  expect(calls("apply")).toHaveLength(1); expect(calls("return")).toHaveLength(0); expect(fixture.release).not.toHaveBeenCalled();
  expect(calls("apply")[0][1]).toMatchObject({ planDigest: "42:start:workspace-b:tree-b", selection: { coreSelected: true, coreWorktreeId: "tree-b" } });
  expect(calls("apply")[0][1].selection.apps.every((row: { selected: boolean }) => !row.selected)).toBe(true);
  expect(JSON.parse(localStorage.getItem(journalKey())!).expectedCoreProject).toBe(`/managed/tree-b/${project}`);
});

it("confirms success only for the selected workspace, worktree and factual Core project", async () => {
  props.workspaces = [{ ...workspace, worktrees: [...workspace.worktrees, { ...workspace.worktrees[0], id: "tree-b", path: "/managed/tree-b", branch: "feature/second" }] }];
  await render(); await choose("Hosty redesign · feature/second"); await click("Switch Core");
  current = { ...current!, phase: "active", coreWorktreeId: "tree-a" };
  props.state = { ...state, instance: "43:new", launch: { ...state.launch, mode: "dev", generationPath: "/build/new", processId: 43, startedAt: "2026-10-23T12:00:00Z", projectPath: current.coreProject } };
  current = { ...current!, activatedCore: props.state.launch };
  await render(); await refreshStatus();
  expect(document.body.textContent).not.toContain("Core is now running from");
  expect(document.body.textContent).toContain("Waiting for Core to be ready…");
  current = { ...current!, coreWorktreeId: "tree-b", workspaceId: "different-workspace" };
  await refreshStatus(); expect(document.body.textContent).not.toContain("Core is now running from");
  current = { ...current!, workspaceId: workspace.id };
  props.state = { ...props.state!, launch: { ...props.state!.launch, projectPath: `/managed/tree-a/${project}` } };
  await render(); await refreshStatus(); expect(document.body.textContent).not.toContain("Core is now running from");
  current = { ...current!, coreProject: `/managed/unreviewed/${project}` };
  props.state = { ...props.state!, launch: { ...props.state!.launch, projectPath: current.coreProject } };
  await render(); await refreshStatus(); expect(document.body.textContent).not.toContain("Core is now running from");
  current = { ...current!, coreProject: `/managed/tree-b/${project}` };
  props.state = { ...props.state!, launch: { ...props.state!.launch, projectPath: current.coreProject } };
  for (const mismatch of [{ generationPath: "/build/old" }, { processId: 41 }, { startedAt: "2026-10-22T12:00:00Z" }]) {
    current = { ...current!, activatedCore: { ...props.state!.launch, ...mismatch } };
    await render(); await refreshStatus();
    expect(document.body.textContent).not.toContain("Core is now running from");
  }
  current = { ...current!, activatedCore: props.state.launch };
  await render(); await refreshStatus();
  expect(document.body.textContent).toContain("Core is now running from Hosty redesign · feature/second.");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(current.id);
  expect(button("Done")).toBeDefined();
});

it("uses animated progress while reviewing and switching and hides technical operation controls", async () => {
  await render(); await openMenu();
  const planning = deferred<Response>();
  intercept = (kind, body) => kind === "plan" && (body.selection as Selection).coreSelected ? planning.promise : undefined;
  await act(async () => item("Hosty redesign").click());
  const progress = document.querySelector('[role="dialog"] [role="status"]')!;
  expect(progress.textContent).toContain("Checking workspace…");
  expect(progress.querySelector('svg')?.classList.contains("animate-spin")).toBe(true);
  expect(progress.querySelector('svg')?.getAttribute("aria-hidden")).toBe("true");
  await act(async () => planning.resolve(Response.json(review(workspace.id, { coreSelected: true, coreWorktreeId: "tree-a", apps: [{ appId: "hosty.shell", selected: false }, { appId: "media.app", selected: false }] }))));
  const applying = deferred<Response>();
  intercept = kind => kind === "apply" ? applying.promise : undefined;
  await act(async () => { button("Switch Core").click(); button("Switch Core").click(); });
  expect(calls("apply")).toHaveLength(1); expect(button("Switch Core")).toBeUndefined();
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain("Preparing the switch…");
  expect(button("Check progress")).toBeUndefined(); expect(button("Refresh status")).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(calls("apply")[0][1].requestId);
  current = { id: String(calls("apply")[0][1].requestId), workspaceId: workspace.id, coreWorktreeId: "tree-a", phase: "core-starting", coreProject: `/managed/tree-a/${project}` };
  await act(async () => applying.resolve(Response.json({ state: "accepted" })));
  expect(document.body.textContent).toContain("Waiting for Core to be ready…");
});

it("finishes Return to a saved Release without asking for a second restart", async () => {
  current = { ...active(), previousCore: { mode: "dev", projectPath: "/managed/tree-before/Core.csproj" }, coreReturnTarget: { launch: { ...state.launch, mode: "release" } } }; records[workspace.id] = [current];
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: current.coreProject } };
  await render(); await choose("Release");
  expect(document.body.textContent).toContain("activated (Release)");
  expect(document.body.textContent).not.toContain("saved version is another development Core");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click()); await click("Return Core");
  current = { ...current!, phase: "active", coreReturned: true };
  props.state = { ...state, instance: "43:return" };
  await render(); await refreshStatus();
  expect(document.body.textContent).toContain("Core is now running the installed Release.");
  expect(button("Use Release")).toBeUndefined(); expect(button("Continue to Release")).toBeUndefined();
  expect(fixture.release).not.toHaveBeenCalled(); expect(calls("return")).toHaveLength(1);
});

it.each([false, true])("omits routine details and refresh for a healthy active switch (browser receipt: %s)", async saved => {
  current = active(); records[workspace.id] = [current];
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: current.coreProject } };
  props.workspace = { id: workspace.id, label: workspace.name! };
  if (saved) localStorage.setItem(journalKey(), JSON.stringify({ workspaceId: workspace.id, activationId: current.id, target: null }));
  await render(); await openMenu();
  expect(item("Core switch details…")).toBeUndefined();
  expect(item("Refresh choices")).toBeUndefined();
  expect(item("Switch progress…")).toBeUndefined();
  expect(item("Recover Core switch…")).toBeUndefined();
  await act(async () => item("Release").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Switch toRelease");
  expect(button("Return Core")).toBeDefined();
  expect(mutations()).toHaveLength(0);
});

it("refreshes the catalog by reopening the menu without a separate refresh action", async () => {
  await render(); await openMenu();
  expect(item("Refresh choices")).toBeUndefined();
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  props.workspaces = [{ ...workspace, name: "Renamed workspace" }];
  await render(); await openMenu();
  expect(item("Renamed workspace")).toBeDefined(); expect(item("Hosty redesign")).toBeUndefined();
  expect(fixture.read.mock.calls.filter(([url]) => new URL(url).pathname === "/api/core/execution-targets")).toHaveLength(2);
  expect(fixture.send).not.toHaveBeenCalled();
});

it("keeps recovery discoverable for an interrupted server receipt after browser state is lost", async () => {
  current = { ...active(), phase: "preparing" }; records[workspace.id] = [current];
  await render(); await openMenu(); await act(async () => item("Recover Core switch…").click());
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain("Building Core…");
  expect(mutations()).toHaveLength(0);
});

it("honors disabled state arriving while an already reviewed dialog is open", async () => {
  await render(); await choose("Hosty redesign"); props.disabled = true; await render();
  expect(button("Switch Core").disabled).toBe(true);
  await act(async () => button("Switch Core").click());
  expect(calls("apply")).toHaveLength(0);
});

it("ignores a delayed old-user preparation response after the actor changes", async () => {
  const pending = deferred<Response>();
  await render(); await openMenu();
  intercept = (kind, body) => kind === "plan" && (body.selection as Selection).coreSelected ? pending.promise : undefined;
  await act(async () => item("Hosty redesign").click());
  fixture.userId = "another-admin"; await render();
  await act(async () => pending.resolve(Response.json(review(workspace.id, { coreSelected: true, coreWorktreeId: "tree-a", apps: [{ appId: "hosty.shell", selected: false }, { appId: "media.app", selected: false }] }))));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(mutations()).toHaveLength(0);
  expect(localStorage.getItem(journalKey())).toBeNull();
});


it.each(["user", "origin"])("ignores a delayed 401 apply response from the previous %s without ending the new session", async scope => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  const pending = deferred<Response>();
  intercept = kind => kind === "apply" ? pending.promise : undefined;
  await render(); await choose("Hosty redesign"); await click("Switch Core");
  const oldKey = journalKey(), original = JSON.parse(localStorage.getItem(oldKey)!);
  const reads = calls("status").length;
  if (scope === "user") fixture.userId = "another-admin";
  else props.coreOrigin = "https://other-core.test";
  await render();
  await act(async () => pending.resolve(Response.json({ message: "Old session expired" }, { status: 401 })));
  expect(dispatch.mock.calls.filter(([event]) => event.type === APP_SESSION_ENDED)).toHaveLength(0);
  expect(calls("status")).toHaveLength(reads);
  expect(localStorage.getItem(journalKey())).toBeNull();
  expect(JSON.parse(localStorage.getItem(oldKey)!)).toEqual(original);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});


it.each(["starting", "404", "completed"])("retains the Release journal while operation %s has not proved the factual target", async status => {
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: "/managed/main/apps/core/Core.csproj" } };
  operationStatus = status; operationMissing = status === "404";
  await render(); await choose("Release"); await click("Use Release");
  expect(fixture.release).toHaveBeenCalledOnce();
  expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(localStorage.getItem(journalKey())!).release.operationId).toBe(releaseOperationId);
  expect(document.body.textContent).not.toContain("Core is now running the installed Release.");
  await refreshStatus(); expect(fixture.release).toHaveBeenCalledOnce();
  expect(localStorage.getItem(journalKey())).not.toBeNull();
  props.state = { ...state, launch: { ...state.launch, mode: "release" } };
  await render(); await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(localStorage.getItem(journalKey())).not.toBeNull();
  props.state = { ...props.state, instance: "99:release", launch: { ...props.state.launch, processId: 99 } };
  await render(); await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(localStorage.getItem(journalKey())).toBeNull();
  expect(document.body.textContent).toContain("Core is now running the installed Release.");
});

it("recovers a staged Release using the original generic restart ID without another dispatch", async () => {
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: "/managed/main/Core.csproj" } };
  localStorage.setItem(journalKey(), JSON.stringify({ target: { kind: "release" }, workspaceId: "", activationId: "", release: { fromInstance: state.instance } }));
  sessionStorage.setItem(`hosty:core-operation:${origin}`, releaseOperationId);
  await render();
  expect(JSON.parse(localStorage.getItem(journalKey())!).release.operationId).toBe(releaseOperationId);
  expect(fixture.read.mock.calls.some(([url]) => new URL(url).pathname === `/api/core/operations/${releaseOperationId}`)).toBe(true);
  expect(fixture.release).not.toHaveBeenCalled(); expect(mutations()).toHaveLength(0);
  await openMenu(); await act(async () => item("Switch progress…").click());
  expect(document.body.textContent).toContain("Restarting Core…");
  await refreshStatus(); expect(fixture.release).not.toHaveBeenCalled();
});

it("keeps failed preparation diagnostics and retries the reviewed original apply instead of a new request", async () => {
  intercept = (kind, body) => kind === "status" ? Response.json({ status: { activation: { id: body.activationId, phase: "preparing", coreProject: `/managed/tree-a/${project}` },
    helper: { state: "failed", error: "Build failed before services stopped", logPath: "/synthetic/core-build.log" } }, children: [] }) : undefined;
  await render(); await choose("Hosty redesign"); await click("Switch Core");
  expect(document.body.textContent).toContain("Build failed before services stopped");
  expect(document.body.textContent).toContain("/synthetic/core-build.log");
  const original = calls("apply")[0][1];
  await click("Retry preparation");
  expect(calls("apply").map(([, body]) => body)).toEqual([original, original]);
  expect(fixture.release).not.toHaveBeenCalled();
});


it("repairs a real stale-plan refusal after a failed review read without replacing its Core-only request", async () => {
  let stale = false, failRepairRead = true;
  intercept = (kind, body) => {
    if (kind === "apply" && !stale) {
      stale = true;
      return Promise.reject(new CoreRequestError("Review inputs changed", "activation_review_changed", 409, null));
    }
    if (kind === "status") return Response.json({ status: { activation: { id: body.activationId, phase: "preparing", preparationReleased: true,
      coreProject: `/managed/tree-a/${project}` }, helper: { state: "failed", error: "Preparation was released" } }, children: [] });
    if (kind === "plan" && stale) {
      if (failRepairRead) { failRepairRead = false; return Promise.reject(new TypeError("Review read was interrupted")); }
      const repaired = review(workspace.id, body.selection as Selection);
      repaired.plan.participants = repaired.plan.participants.map(row => row.kind === "core" ? { ...row, sourcePath: "/managed/tree-a/apps/core/Renamed.csproj" } : row);
      return Response.json({ ...repaired, planDigest: "repaired-digest" });
    }
  };
  await render(); await choose("Hosty redesign"); await click("Switch Core");
  const original = calls("apply")[0][1];
  await click("Review workspace again");
  expect(document.body.textContent).toContain("Review read was interrupted");
  expect(button("Review workspace again")).toBeDefined();
  await click("Review workspace again"); await click("Retry reviewed switch");
  const repaired = calls("apply")[1][1];
  expect(calls("apply")).toHaveLength(2);
  expect(repaired).toEqual({ ...original, planDigest: "repaired-digest" });
  expect(JSON.parse(localStorage.getItem(journalKey())!).expectedCoreProject).toBe("/managed/tree-a/apps/core/Renamed.csproj");
  expect(repaired.selection.apps.every((row: { selected: boolean }) => !row.selected)).toBe(true);
  expect(mutations().every(([url]) => new URL(url).pathname.endsWith("/activation/apply"))).toBe(true);
});

it("shows a missing workspace and dismisses only its stale browser journal after a fresh catalog read", async () => {
  const saved = { workspaceId: "deleted-workspace", activationId: "returned-activation", target: { kind: "release" } };
  localStorage.setItem(journalKey(), JSON.stringify(saved));
  current = active("current-activation"); records[workspace.id] = [current];
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: current.coreProject } };
  intercept = kind => kind === "status" ? Response.json({ code: "workspace_not_found", message: "Workspace not found." }, { status: 404 }) : undefined;
  await render();
  expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toBe("true");
  await click("Check switch");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Workspace not found.");
  expect(document.querySelector('[role="dialog"] .animate-spin')).toBeNull();
  expect(localStorage.getItem(journalKey())).not.toBeNull();
  const reads = fixture.read.mock.calls.length;
  await click("Dismiss saved switch");
  expect(fixture.read.mock.calls.length).toBeGreaterThan(reads);
  expect(localStorage.getItem(journalKey())).toBeNull();
  expect(container.querySelector('[aria-label="Busy"]')?.textContent).toBe("false");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Core and applications were not changed.");
  expect(mutations()).toHaveLength(0); expect(fixture.release).not.toHaveBeenCalled();
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toBe("false");
  expect(container.querySelector('[aria-label="Busy"]')?.textContent).toBe("false");
});

it.each(["workspace", "activation", "catalog-error"])("retains a missing-workspace journal when fresh catalog evidence is %s", async evidence => {
  const saved = { workspaceId: workspace.id, activationId: "saved-activation", target: { kind: "release" } };
  localStorage.setItem(journalKey(), JSON.stringify(saved));
  intercept = kind => kind === "status" ? Response.json({ code: "workspace_not_found", message: "Workspace not found." }, { status: 404 }) : undefined;
  if (evidence !== "workspace") props.workspaces = [];
  if (evidence === "activation") records[workspace.id] = [active(saved.activationId)];
  if (evidence === "catalog-error") fixture.read.mockResolvedValue(Response.json({ message: "Catalog unavailable" }, { status: 503 }));
  await render(); await click("Check switch"); await click("Dismiss saved switch");
  expect(JSON.parse(localStorage.getItem(journalKey())!)).toEqual(saved);
  expect(document.body.textContent).toContain(evidence === "catalog-error" ? "Catalog unavailable" : "Core still lists");
  expect(mutations()).toHaveLength(0);
});

it.each([[403, "workspace_forbidden"], [404, "activation_not_found"]])("exposes status refusal %s without forgetting or replaying an uncertain action", async (status, code) => {
  const pending = { kind: "apply", workspaceId: workspace.id, body: { requestId: "original-request", selection: { coreSelected: true } } };
  const saved = { workspaceId: workspace.id, activationId: "original-request", target: null, pending };
  localStorage.setItem(journalKey(), JSON.stringify(saved));
  intercept = kind => kind === "status" ? Response.json({ code, message: "The saved switch cannot be inspected." }, { status: Number(status) }) : undefined;
  await render(); await click("Check switch");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("The saved switch cannot be inspected.");
  expect(document.querySelector('[role="dialog"] .animate-spin')).toBeNull();
  expect(button("Dismiss saved switch")).toBeUndefined();
  await click("Check progress");
  expect(JSON.parse(localStorage.getItem(journalKey())!)).toEqual(saved);
  expect(calls("status").every(([, body]) => body.activationId === saved.activationId)).toBe(true);
  expect(mutations()).toHaveLength(0);
});

it("shows a sustained outage after three checks and clears attention when the original operation is readable again", async () => {
  current = active();
  const saved = { workspaceId: workspace.id, activationId: current.id, target: null };
  localStorage.setItem(journalKey(), JSON.stringify(saved));
  statusError = true;
  await render(); await click("Check switch");
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toBe("true");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Operation status unavailable");
  expect(document.querySelector('[role="dialog"] .animate-spin')).toBeNull();
  expect(JSON.parse(localStorage.getItem(journalKey())!)).toEqual(saved);
  statusError = false; await click("Check progress");
  expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toBe("false");
  expect(container.querySelector('[aria-label="Busy"]')?.textContent).toBe("false");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Operation status unavailable");
  expect(mutations()).toHaveLength(0);
});

it("keeps a missing Release operation visible and retained without pretending a restart is still progressing", async () => {
  props.state = { ...state, launch: { ...state.launch, mode: "dev", projectPath: "/managed/Core.csproj" } };
  const saved = { workspaceId: "", activationId: "", target: { kind: "release" }, release: { fromInstance: state.instance, operationId: releaseOperationId } };
  localStorage.setItem(journalKey(), JSON.stringify(saved)); operationMissing = true;
  await render(); await click("Check switch");
  expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toBe("true");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Operation not found");
  expect(document.querySelector('[role="dialog"] .animate-spin')).toBeNull();
  expect(button("Dismiss saved switch")).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(journalKey())!)).toEqual(saved);
  expect(fixture.release).not.toHaveBeenCalled();
});

it("does not dismiss recovery if a successful status arrives during the catalog check", async () => {
  current = active();
  const saved = { workspaceId: workspace.id, activationId: current.id, target: null };
  localStorage.setItem(journalKey(), JSON.stringify(saved));
  intercept = kind => kind === "status" ? Response.json({ code: "workspace_not_found", message: "Workspace not found." }, { status: 404 }) : undefined;
  await render(); await click("Check switch");
  const catalog = deferred<Response>(); fixture.read.mockReturnValueOnce(catalog.promise);
  await click("Dismiss saved switch");
  intercept = null;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  await act(async () => catalog.resolve(Response.json({ targets: [], activations: [] })));
  expect(JSON.parse(localStorage.getItem(journalKey())!)).toEqual(saved);
  expect(document.body.textContent).not.toContain("removed from this browser");
  expect(mutations()).toHaveLength(0);
});

it.each(["user", "origin"])("ignores a delayed dismissal catalog after the %s changes", async scope => {
  const saved = { workspaceId: "deleted", activationId: "saved", target: null };
  const oldKey = journalKey(); localStorage.setItem(oldKey, JSON.stringify(saved));
  intercept = kind => kind === "status" ? Response.json({ code: "workspace_not_found", message: "Workspace not found." }, { status: 404 }) : undefined;
  await render(); await click("Check switch");
  const catalog = deferred<Response>(); fixture.read.mockReturnValueOnce(catalog.promise);
  await click("Dismiss saved switch");
  if (scope === "user") fixture.userId = "other-admin"; else props.coreOrigin = "https://other-core.test";
  await render();
  await act(async () => catalog.resolve(Response.json({ targets: [], activations: [] })));
  expect(JSON.parse(localStorage.getItem(oldKey)!)).toEqual(saved);
  expect(localStorage.getItem(journalKey())).toBeNull();
  expect(document.body.textContent).not.toContain("removed from this browser");
  expect(mutations()).toHaveLength(0);
});
