// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceActivation } from "./workspace-activation";
import { developmentRequest } from "@/lib/development-api";
import { useWorkspaceApplications, type WorkspaceApplication } from "@/lib/workspace-applications";
import { approveWorkspaceAccess } from "@/lib/workspace-access-review";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("@/lib/workspace-applications", async original => ({ ...await original<object>(), useWorkspaceApplications: vi.fn() }));
vi.mock("@/lib/workspace-access-review", async original => ({ ...await original<object>(), approveWorkspaceAccess: vi.fn() }));
vi.mock("@hosty-sdk/app/install", async original => ({ ...await original<object>(), openInstallationConfirmation: vi.fn(), showInstallationConfirmation: vi.fn() }));
let root: Root, container: HTMLDivElement;
const refreshApplications = vi.fn();
let applicationRows: WorkspaceApplication[];
const row = (appId = "notes", overrides: Partial<WorkspaceApplication> = {}): WorkspaceApplication => ({ appId, name: appId === "notes" ? "Notes" : "Shell", version: "1.2.3",
  runtimeState: "running", current: { kind: "package", runtime: "podman", name: "podman" },
  target: { kind: "workspace", name: "This workspace", workspaceId: "workspace", worktreeId: "a".repeat(64), runtime: "dev", available: true }, canSwitch: true, ...overrides });
const currentRow = (appId = "notes") => row(appId, { current: row(appId).target });
const apps = [{ appId: "notes", name: "Notes" }, { appId: "shell", name: "Shell" }];
const refresh = vi.fn();
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applicationRows = [];
  vi.mocked(useWorkspaceApplications).mockImplementation(() => ({ applications: applicationRows, loading: false, error: "", refresh: refreshApplications }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(developmentRequest).mockImplementation(async (_path, body) => ({ requestId: body?.requestId, state: "completed", apps: apps.map(app => ({ appId: app.appId, state: "completed" })) }) as never);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<WorkspaceActivation workspaceId="workspace" apps={apps} refresh={refresh} />));
it("switches associated apps with one action and returns directly to packages", async () => {
  applicationRows = [row(), row("shell")];
  await render();
  expect(button("Return to packages")).toBeUndefined();
  expect(container.querySelector("select, input[type=checkbox]")).toBeNull();
  expect([...container.querySelectorAll('[aria-label="Bound applications"] li')].map(app => app.getAttribute("aria-label"))).toEqual(["Notes", "Shell"]);
  expect(container.textContent).not.toMatch(/previous|activation|Review selection/);
  await act(async () => button("Use workspace").click());
  const request = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(request).toMatchObject({ kind: "workspace", requestId: expect.any(String) });
  expect(vi.mocked(developmentRequest).mock.calls[0][0]).toBe("/workspace/execution-target");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // Visibility follows a fresh observation, never the operation's success alone.
  expect(button("Return to packages")).toBeUndefined();
  applicationRows = [currentRow(), currentRow("shell")]; await render();
  expect(button("Use workspace")).toBeUndefined();
  await act(async () => button("Return to packages").click());
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toMatchObject({ kind: "package" });
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).not.toHaveProperty("acceptDataChanges");
});
it("retries partial failures with the original ID so Core skips completed apps", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ requestId: "same", state: "failed", apps: [{ appId: "notes", state: "completed" }, { appId: "shell", state: "failed", error: "Build failed" }] });
  await render(); await act(async () => button("Use workspace").click());
  expect(container.textContent).toContain("Shell: Build failed");
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  await act(async () => button("Retry runtime switch").click());
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toEqual(original);
  expect(button("Retry runtime switch")).toBeUndefined();
});
it("recovers a retained request after response loss and remount", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await act(async () => button("Return to packages").click());
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  await act(async () => root.unmount()); root = createRoot(container);
  vi.mocked(developmentRequest).mockResolvedValueOnce({ requestId: original!.requestId, state: "failed", apps: [] });
  await render();
  expect(vi.mocked(developmentRequest).mock.calls[1][0]).toBe(`/workspace/execution-target/${original!.requestId}`);
  await act(async () => button("Retry runtime switch").click());
  expect(vi.mocked(developmentRequest).mock.calls[2][1]).toEqual(original);
});
it("keeps package return available after a failed workspace activation", async () => {
  applicationRows = [row(), row("shell")];
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", apps: [{ appId: "shell", state: "failed", error: "Manifest invalid" }] });
  await render(); await act(async () => button("Use workspace").click());
  const original = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(button("Return to packages").disabled).toBe(false);
  await act(async () => button("Return to packages").click());
  const request = vi.mocked(developmentRequest).mock.calls[1][1]!;
  expect(request.kind).toBe("package"); expect(request.requestId).not.toBe(original.requestId);
});
it("starts a fresh group intent only after Core definitively superseded the old one", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", apps: [{ appId: "shell", state: "failed", code: "dev_selection_changed", error: "A newer selection owns this app." }] });
  await render(); await act(async () => button("Use workspace").click());
  const first = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(button("Retry runtime switch")).toBeUndefined();
  await act(async () => button("Use workspace").click());
  const second = vi.mocked(developmentRequest).mock.calls[1][1]!;
  expect(second.requestId).not.toBe(first.requestId);
});

it("shows compact authoritative status and package/workspace/source metadata without treating selection as readiness", async () => {
  applicationRows = [row(), row("shell", { runtimeState: "stopped", current: { kind: "workspace", workspaceId: "other", worktreeId: "b".repeat(64), name: "Other work" } })];
  await render();
  const notes = container.querySelector('[aria-label="Bound applications"] [aria-label="Notes"]')!;
  const shell = container.querySelector('[aria-label="Bound applications"] [aria-label="Shell"]')!;
  expect(notes.textContent).toContain("Running"); expect(notes.textContent).toContain("1.2.3"); expect(notes.textContent).toContain("podman");
  expect(shell.textContent).toContain("Stopped"); expect(shell.textContent).toContain("Other work");
  expect(shell.textContent).not.toContain("Running");
  applicationRows = [row("notes", { current: { kind: "legacy", runtime: "dev", name: "dev" }, source: { path: "/sources/notes", branch: "feature/fix", state: "changes" } })];
  await render(); expect(notes.textContent).toContain("Source"); expect(notes.textContent).toContain("feature/fix");
});
it("switches one app with its exact worktree and recipe rather than invoking the group action", async () => {
  applicationRows = [row(), row("shell")]; await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.click());
  const [path, body] = vi.mocked(developmentRequest).mock.calls[0];
  expect(path).toBe("/workspace/applications/notes/execution-target");
  expect(body).toEqual({ requestId: expect.any(String), kind: "workspace", workspaceId: "workspace", worktreeId: "a".repeat(64), runtime: "dev" });
  expect(body).not.toHaveProperty("appId");
  expect(refreshApplications).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
});
it("hides only the exact selected workspace/worktree action and keeps other-tree selection explicit", async () => {
  applicationRows = [row("notes", { current: { kind: "workspace", workspaceId: "workspace", worktreeId: "a".repeat(64), name: "This workspace" } }),
    row("shell", { current: { kind: "workspace", workspaceId: "workspace", worktreeId: "b".repeat(64), name: "This workspace" } })];
  await render();
  expect(container.querySelector('[aria-label="Use this workspace for Notes"]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Shell"]')!.disabled).toBe(false);
});
it("keeps missing authority, unknown targets and transitions unavailable without guessing package or running", async () => {
  applicationRows = [row("notes", { canSwitch: false, unavailable: "Application lifecycle access is required.", current: undefined, runtimeState: undefined }),
    row("shell", { runtimeState: "starting" })];
  await render();
  const notes = container.querySelector('[aria-label="Bound applications"] [aria-label="Notes"]')!;
  expect(notes.textContent).toContain("Unknown"); expect(notes.textContent).not.toContain("Package");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.title).toContain("lifecycle access");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Shell"]')!.disabled).toBe(true);
  expect(vi.mocked(developmentRequest)).not.toHaveBeenCalled();
});
it("retains the exact per-app intent after response loss, remount and a changed candidate", async () => {
  applicationRows = [row()];
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.click());
  const original = vi.mocked(developmentRequest).mock.calls[0][1]!;
  await act(async () => root.unmount()); root = createRoot(container);
  applicationRows = [row("notes", { target: { ...row().target!, worktreeId: "b".repeat(64), runtime: "other-dev" } })];
  vi.mocked(developmentRequest).mockResolvedValueOnce({ requestId: original.requestId, state: "failed", error: "Build failed" });
  await render();
  expect(vi.mocked(developmentRequest).mock.calls[1][0]).toBe(`/workspace/applications/notes/execution-target/${original.requestId}`);
  await act(async () => button("Retry runtime switch").click());
  expect(vi.mocked(developmentRequest).mock.calls[2][1]).toEqual(original);
});
it("blocks group and other-app changes while a per-app switch is admitted", async () => {
  applicationRows = [row(), row("shell")];
  let complete!: (value: unknown) => void;
  vi.mocked(developmentRequest).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }) as never);
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.click());
  expect(button("Use workspace").disabled).toBe(true); expect(button("Return to packages").disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Shell"]')!.disabled).toBe(true);
  expect(container.textContent).toContain("Switching Notes…");
  await act(async () => complete({ state: "completed" }));
  expect(button("Use workspace").disabled).toBe(false);
});
it("keeps per-app access review attached to the original request", async () => {
  applicationRows = [row()];
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "review-required", error: "Additional access", review: { manifestUrl: "https://example.test/app.json", workspaceManifest: {} } });
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.click());
  expect(container.textContent).toContain("Notes: Additional access");
  expect(button("Review access")).toBeDefined(); expect(button("Retry runtime switch")).toBeDefined();
});
it("offers a fresh read after status failure without enabling an unverified target", async () => {
  vi.mocked(useWorkspaceApplications).mockReturnValue({ applications: [], loading: false, error: "Disconnected", refresh: refreshApplications });
  await render(); expect(container.textContent).toContain("Application status unavailable.");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.disabled).toBe(true);
  await act(async () => button("Retry").click()); expect(refreshApplications).toHaveBeenCalledOnce();
});

it("replays only the same per-app request after explicit Core access approval", async () => {
  applicationRows = [row()];
  const review = { workspaceManifest: { appId: "notes", worktreeId: "a".repeat(64) } };
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "review-required", review });
  vi.mocked(approveWorkspaceAccess).mockResolvedValueOnce({ status: "succeeded" } as never);
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.click());
  const original = vi.mocked(developmentRequest).mock.calls[0];
  await act(async () => button("Review access").click());
  expect(approveWorkspaceAccess).toHaveBeenCalledWith(review, expect.any(Function));
  expect(vi.mocked(developmentRequest).mock.calls[1]).toEqual(original);
  expect(button("Retry runtime switch")).toBeUndefined();
});

it("makes a paused-workspace retry explicitly unavailable while retaining package recovery", async () => {
  applicationRows = [row()];
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", error: "Build failed" });
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!.click());
  await act(async () => root.render(<WorkspaceActivation workspaceId="workspace" apps={apps} canUse={false} refresh={refresh} />));
  expect(button("Retry runtime switch").disabled).toBe(true);
  expect(button("Retry runtime switch").title).toContain("Resume this workspace");
  expect(button("Return to packages").disabled).toBe(false);
});

it.each([
  { name: "packages", rows: [row(), row("shell")], workspace: true, packages: false },
  { name: "another workspace", rows: [row("notes", { current: { ...row().target!, workspaceId: "other-workspace" } }), row("shell")], workspace: true, packages: false },
  { name: "all exact current worktrees", rows: [currentRow(), currentRow("shell")], workspace: false, packages: true },
  { name: "mixed targets", rows: [currentRow(), row("shell")], workspace: true, packages: true },
  { name: "another tree in this workspace", rows: [row("notes", { current: { ...row().target!, worktreeId: "b".repeat(64) } }), row("shell")], workspace: true, packages: true },
  { name: "legacy source", rows: [row("notes", { current: { kind: "legacy", runtime: "dev" }, source: { path: "/source/notes" } }), row("shell")], workspace: true, packages: true },
  { name: "a missing bound app", rows: [currentRow()], workspace: true, packages: true },
  { name: "an unavailable current target", rows: [row("notes", { current: undefined }), row("shell")], workspace: true, packages: true },
  { name: "incomplete workspace identity", rows: [row("notes", { current: { kind: "workspace", workspaceId: "workspace" } }), currentRow("shell")], workspace: true, packages: true },
])("offers the useful group actions for $name", async ({ rows, workspace, packages }) => {
  applicationRows = rows; await render();
  expect(!!button("Use workspace")).toBe(workspace);
  expect(!!button("Return to packages")).toBe(packages);
});

it.each([{ loading: true, error: "" }, { loading: false, error: "Disconnected" }])(
  "does not hide group recovery while observations are unavailable: %j", async state => {
    vi.mocked(useWorkspaceApplications).mockReturnValue({ applications: [currentRow(), currentRow("shell")], refresh: refreshApplications, ...state });
    await render();
    expect(button("Use workspace")).toBeDefined(); expect(button("Return to packages")).toBeDefined();
  },
);
