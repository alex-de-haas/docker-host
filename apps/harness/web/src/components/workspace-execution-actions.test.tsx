// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceActivation } from "./workspace-activation";
import { developmentRequest, DevelopmentRequestError } from "@/lib/development-api";
import { useWorkspaceApplications, type WorkspaceApplication } from "@/lib/workspace-applications";
import { approveWorkspaceAccess } from "@/lib/workspace-access-review";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("@/lib/workspace-applications", async original => ({ ...await original<object>(), useWorkspaceApplications: vi.fn() }));
vi.mock("@/lib/workspace-access-review", async original => ({ ...await original<object>(), approveWorkspaceAccess: vi.fn() }));
let root: Root, container: HTMLDivElement;
const refreshApplications = vi.fn(), refresh = vi.fn();
let applicationRows: WorkspaceApplication[];
const row = (appId = "notes", overrides: Partial<WorkspaceApplication> = {}): WorkspaceApplication => ({ appId, name: appId === "notes" ? "Notes" : "Shell", version: "1.2.3",
  runtimeState: "running", current: { kind: "package", runtime: "podman", name: "podman" },
  target: { kind: "workspace", name: "This workspace", workspaceId: "workspace", worktreeId: "a".repeat(64), runtime: "dev", available: true }, canSwitch: true, ...overrides });
const currentRow = (appId = "notes") => row(appId, { current: row(appId).target });
const apps = [{ appId: "notes", name: "Notes" }, { appId: "shell", name: "Shell" }];
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!;
const appButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Use this workspace for Notes"]')!;
const storageKey = `hosty.workspace.execution:${location.origin}:workspace`;
const review = { workspaceManifest: { appId: "notes", planDigest: "candidate" } };
const finished = { state: "completed", apps: [] };
const failed = { state: "failed", apps: [{ appId: "shell", state: "failed", error: "Build failed" }] };
const needsReview = { state: "review-required", apps: [{ appId: "notes", state: "review-required", review }] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "open").mockReturnValue(null);
  applicationRows = [row(), row("shell")];
  vi.mocked(useWorkspaceApplications).mockImplementation(() => ({ applications: applicationRows, loading: false, error: "", refresh: refreshApplications }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(developmentRequest).mockResolvedValue(finished);
  vi.mocked(approveWorkspaceAccess).mockResolvedValue({ status: "succeeded" } as never);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = (canUse = true, single = false) => act(async () => root.render(<WorkspaceActivation workspaceId="workspace" apps={single ? apps.slice(0, 1) : apps} canUse={canUse} refresh={refresh} />));
const click = (label: string) => act(async () => button(label).click());
const remount = async () => { await act(async () => root.unmount()); root = createRoot(container); await render(); };

it("has one primary transition based on observed targets, never inferred from a successful request", async () => {
  await render(); expect(button("Return to packages")).toBeUndefined();
  await click("Use workspace");
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/execution-target", { kind: "workspace", requestId: expect.any(String) }, expect.any(AbortSignal));
  expect(button("Return to packages")).toBeUndefined();
  applicationRows = [currentRow(), currentRow("shell")]; await render();
  expect(button("Use workspace")).toBeUndefined(); await click("Return to packages");
  expect(vi.mocked(developmentRequest).mock.calls.at(-1)?.[1]).toMatchObject({ kind: "package" });
  expect(window.open).not.toHaveBeenCalled();
});
it("avoids a duplicate per-app action in a single-app workspace", async () => {
  applicationRows = [row()]; await render(true, true);
  expect(appButton()).toBeNull(); expect(button("Use workspace")).toBeDefined();
});
it("replaces the primary action with one retry and preserves the original request after partial failure", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce(failed); await render(); await click("Use workspace");
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  expect(button("Use workspace")).toBeUndefined(); expect(button("Return to packages")).toBeUndefined();
  expect(button("Retry runtime switch")).toBeUndefined(); expect(appButton()).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("The switch could not be completed.");
  expect(container.querySelector("details")?.textContent).toContain("Build failed");
  vi.mocked(developmentRequest).mockResolvedValueOnce(failed).mockResolvedValueOnce(finished);
  await click("Try again");
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toBeUndefined();
  expect(vi.mocked(developmentRequest).mock.calls[2][1]).toEqual(original);
  expect(localStorage.getItem(storageKey)).toBeNull();
});
it("resolves response loss with GET and does not repeat an already completed mutation", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost")); await render(); await click("Use workspace");
  const original = vi.mocked(developmentRequest).mock.calls[0][1]!;
  await click("Try again");
  expect(developmentRequest).toHaveBeenLastCalledWith(`/workspace/execution-target/${original.requestId}`, undefined, expect.any(AbortSignal));
  expect(developmentRequest).toHaveBeenCalledTimes(2);
});
it("replays the same UUID only when Core confirms that an uncertain submission never arrived", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost")); await render(); await click("Use workspace");
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Missing", "execution_not_found", 404)).mockResolvedValueOnce(finished);
  await click("Try again"); expect(vi.mocked(developmentRequest).mock.calls[2][1]).toEqual(original);
});
it("automatically follows a running request after reload without resubmitting", async () => {
  vi.useFakeTimers();
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost")); await render(); await click("Use workspace");
  const original = vi.mocked(developmentRequest).mock.calls[0][1]!;
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "running", apps: [] }).mockResolvedValueOnce(finished);
  await remount(); expect(container.textContent).toContain("Switching applications");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(vi.mocked(developmentRequest).mock.calls.slice(1).every(([path, body]) => path?.endsWith(String(original.requestId)) && !body)).toBe(true);
  expect(localStorage.getItem(storageKey)).toBeNull();
});
it("clears a superseded request and creates a new intent only after a new user action", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", apps: [{ state: "failed", code: "dev_selection_changed" }] });
  await render(); await click("Use workspace"); const first = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(button("Try again")).toBeUndefined(); await click("Use workspace");
  expect(vi.mocked(developmentRequest).mock.calls[1][1]!.requestId).not.toBe(first.requestId);
});
it("uses an exact per-app worktree and retains it through remount and changed inventory", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost")); await render(); await act(async () => appButton().click());
  const [path, original] = vi.mocked(developmentRequest).mock.calls[0];
  expect(path).toBe("/workspace/applications/notes/execution-target");
  expect(original).toEqual({ requestId: expect.any(String), kind: "workspace", workspaceId: "workspace", worktreeId: "a".repeat(64), runtime: "dev" });
  applicationRows = [row("notes", { target: { ...row().target!, worktreeId: "b".repeat(64), runtime: "new-dev" } }), row("shell")];
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", error: "Build failed" }); await remount();
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", error: "Build failed" }).mockResolvedValueOnce({ state: "completed" });
  await click("Try again"); expect(vi.mocked(developmentRequest).mock.calls.at(-1)?.[1]).toEqual(original);
});
it("opens access confirmation immediately and automatically continues the same selection", async () => {
  const popup = { closed: false, close: vi.fn() } as unknown as Window;
  vi.mocked(window.open).mockReturnValue(popup);
  const approval = deferred<never>();
  vi.mocked(approveWorkspaceAccess).mockImplementation(async (_review, submitted) => { submitted({ status: "pending", approvalUrl: "https://core.test/confirm" } as never); return approval.promise; });
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview).mockResolvedValueOnce(finished);
  await render(); await click("Use workspace");
  expect(window.open).toHaveBeenCalledOnce(); expect(window.open).toHaveBeenCalledWith("https://core.test/confirm", "_blank", expect.stringContaining("noopener"));
  expect(button("Review access")).toBeUndefined(); expect(button("Use workspace")).toBeUndefined();
  expect(container.textContent).toContain("Waiting for access confirmation");
  await act(async () => approval.resolve({ status: "succeeded" } as never));
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toEqual(vi.mocked(developmentRequest).mock.calls[0][1]);
  expect(popup.close).not.toHaveBeenCalled();
});
it("reviews each app in a partial group and resumes the original group once", async () => {
  const otherReview = { workspaceManifest: { appId: "shell", planDigest: "other" } };
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...needsReview, apps: [...needsReview.apps, { appId: "shell", state: "review-required", review: otherReview }] });
  await render(); await click("Use workspace");
  expect(vi.mocked(approveWorkspaceAccess).mock.calls.map(call => call[0])).toEqual([review, otherReview]);
  expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toEqual(vi.mocked(developmentRequest).mock.calls[0][1]);
});
it("does not continue after denial and leaves only a retry without inventing package return", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview);
  vi.mocked(approveWorkspaceAccess).mockResolvedValueOnce({ status: "denied" } as never);
  await render(); await click("Use workspace");
  expect(developmentRequest).toHaveBeenCalledOnce(); expect(button("Try again")).toBeDefined();
  expect(button("Return to packages")).toBeUndefined(); expect(container.querySelector('[aria-label="Other application actions"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("not approved");
});
it("keeps a confirmation link reachable when the window is isolated or blocked, and cancel prevents late continuation", async () => {
  vi.mocked(window.open).mockReturnValue(null);
  const approval = deferred<never>();
  vi.mocked(approveWorkspaceAccess).mockImplementation(async (_review, submitted) => { submitted({ status: "pending", approvalUrl: "https://core.test/confirm" } as never); return approval.promise; });
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview); await render(); await click("Use workspace");
  expect(container.querySelector("a")?.textContent).toBe("Open access confirmation");
  await click("Cancel"); await act(async () => approval.resolve({ status: "succeeded" } as never));
  expect(developmentRequest).toHaveBeenCalledOnce(); expect(button("Try again")).toBeDefined();
});
it("retains the approval request identity across reload, without losing the original switch", async () => {
  const retained = { id: "approval", expiresAt: new Date(Date.now() + 60000).toISOString() };
  vi.mocked(approveWorkspaceAccess).mockImplementationOnce(async (_review, _submitted, options) => { options?.remember?.(retained); throw new DOMException("Closed", "AbortError"); });
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview); await render(); await click("Use workspace");
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview);
  await remount();
  expect(approveWorkspaceAccess).toHaveBeenCalledOnce(); expect(button("Try again")).toBeDefined();
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview).mockResolvedValueOnce(needsReview).mockResolvedValueOnce(finished);
  await click("Try again");
  expect(vi.mocked(approveWorkspaceAccess).mock.calls[1][2]?.retained).toEqual(retained);
  expect(vi.mocked(developmentRequest).mock.calls.at(-1)?.[1]).toEqual(vi.mocked(developmentRequest).mock.calls[0][1]);
});
it("stops repeated identical access challenges after approval instead of looping popups", async () => {
  vi.mocked(developmentRequest).mockResolvedValue(needsReview); await render(); await click("Use workspace");
  expect(approveWorkspaceAccess).toHaveBeenCalledOnce(); expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(button("Try again")).toBeDefined();
});
it("blocks a paused workspace retry while retaining observed package recovery in the alternative menu", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce(failed); await render(); await click("Use workspace");
  applicationRows = [currentRow(), row("shell")]; await render(false);
  expect(button("Try again").disabled).toBe(true); expect(button("Try again").title).toContain("Resume");
  expect(container.querySelector('[aria-label="Other application actions"]')).not.toBeNull();
  expect(button("Return to packages")).toBeUndefined();
});
it("hides all switch controls during submission and ignores duplicate clicks", async () => {
  const response = deferred<never>(); vi.mocked(developmentRequest).mockReturnValueOnce(response.promise);
  await render(); const use = button("Use workspace"); await act(async () => { use.click(); use.click(); });
  expect(developmentRequest).toHaveBeenCalledOnce(); expect(container.querySelectorAll("button")).toHaveLength(0);
  await act(async () => response.resolve(finished as never));
});
it.each([
  { name: "packages", rows: [row(), row("shell")], primary: "Use workspace", alternative: false },
  { name: "another workspace", rows: [row("notes", { current: { ...row().target!, workspaceId: "other" } }), row("shell")], primary: "Use workspace", alternative: false },
  { name: "all current", rows: [currentRow(), currentRow("shell")], primary: "Return to packages", alternative: false },
  { name: "mixed", rows: [currentRow(), row("shell")], primary: "Use workspace", alternative: true },
  { name: "other tree here", rows: [row("notes", { current: { ...row().target!, worktreeId: "b".repeat(64) } }), row("shell")], primary: "Use workspace", alternative: true },
  { name: "missing app", rows: [row()], primary: "Refresh applications", alternative: false },
  { name: "legacy", rows: [row("notes", { current: { kind: "legacy" } }), row("shell")], primary: "Refresh applications", alternative: false },
])("uses one observed primary action for $name", async ({ rows, primary, alternative }) => {
  applicationRows = rows; await render(); expect(button(primary)).toBeDefined();
  expect(button(primary === "Use workspace" ? "Return to packages" : "Use workspace")).toBeUndefined();
  expect(!!container.querySelector('[aria-label="Other application actions"]')).toBe(alternative);
});
it("never guesses targets when observation disconnects", async () => {
  vi.mocked(useWorkspaceApplications).mockReturnValue({ applications: [], loading: false, error: "Disconnected", refresh: refreshApplications });
  await render(); expect(button("Use workspace")).toBeUndefined(); expect(button("Return to packages")).toBeUndefined();
  await click("Refresh applications"); expect(refreshApplications).toHaveBeenCalledOnce();
});
it("keeps lifecycle state separate from workspace selection and disables unavailable per-app actions", async () => {
  applicationRows = [row("notes", { canSwitch: false, unavailable: "Lifecycle access required." }), row("shell", { runtimeState: "starting" })];
  await render(); expect(appButton().disabled).toBe(true); expect(appButton().title).toContain("Lifecycle access");
  expect(button("Use workspace").disabled).toBe(true); expect(container.textContent).toContain("Running"); expect(container.textContent).toContain("Starting");
});

it("keeps an explicit cancellation paused after reload and never applies a late approval", async () => {
  const approval = deferred<never>();
  vi.mocked(approveWorkspaceAccess).mockReturnValueOnce(approval.promise);
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview); await render(); await click("Use workspace");
  await click("Cancel");
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview); await remount();
  await act(async () => approval.resolve({ status: "succeeded" } as never));
  expect(approveWorkspaceAccess).toHaveBeenCalledOnce(); expect(button("Try again")).toBeDefined();
  expect(vi.mocked(developmentRequest).mock.calls.filter(call => !!call[1])).toHaveLength(1);
});

it("uses Core receipt status even when COOP makes the popup handle appear closed", async () => {
  vi.mocked(window.open).mockReturnValue({ closed: true } as Window);
  vi.mocked(approveWorkspaceAccess).mockImplementationOnce(async (_review, submitted, options) => {
    submitted({ status: "pending", approvalUrl: "https://core.test/confirm" } as never);
    expect(options?.cancelled?.()).toBe(false);
    return { status: "succeeded" } as never;
  });
  vi.mocked(developmentRequest).mockResolvedValueOnce(needsReview);
  await render(); await click("Use workspace"); expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(button("Try again")).toBeUndefined();
});
