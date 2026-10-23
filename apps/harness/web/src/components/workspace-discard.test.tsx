// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceDiscard, type DiscardPlan, type DiscardProgress } from "./workspace-discard";
import { developmentRequest, DevelopmentRequestError } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
const requestId = "94fcd992-875a-46dd-a729-a4ae6b0f0b69";
const command = { requestId, expectedRevision: 3, digest: "review-digest", confirmationName: "Disposable experiment" };
const plan = (): DiscardPlan => ({ workspaceId: "workspace", name: command.confirmationName, revision: 3, digest: command.digest,
  expiresAt: new Date(Date.now() + 60000).toISOString(), blockers: [], trees: ["one", "two"].map(id => ({ id, repository: `https://example.test/${id}.git`,
    path: `/owned/trees/${id}`, branch: `work/${id}`, head: "head", fingerprint: "dirty-bytes", changedFiles: ["changed.txt"], untrackedFiles: ["new.txt"], ignoredFiles: ["build/output"], unmergedCommits: 2 })),
  resources: [{ id: "sandbox", kind: "sandbox", name: "Test app", state: "stopped", revision: 1, dataPath: "/owned/sandbox/data" }] });
const progress = (state: DiscardProgress["state"] = "pending"): DiscardProgress => ({ workspaceId: "workspace", requestId, command, state,
  trees: [{ id: "one", state: "removed" }, { id: "two", state: "pending" }], resources: [] });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name)!;
const refresh = vi.fn(), close = vi.fn(), pause = vi.fn(), removeConversation = vi.fn();
async function render(extra: Partial<Parameters<typeof WorkspaceDiscard>[0]> = {}) {
  await act(async () => root.render(<WorkspaceDiscard workspaceId="workspace" disabled={false} canPause onPause={pause} onClose={close} refresh={refresh} {...extra} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(developmentRequest).mockResolvedValue(plan());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("reviews every physical tree, branch, dirty class and temporary data without mutating", async () => {
  await render();
  expect(document.body.textContent).toContain("/owned/trees/one"); expect(document.body.textContent).toContain("/owned/trees/two");
  expect(document.body.textContent).toContain("work/one"); expect(document.body.textContent).toContain("1 changed · 1 untracked · 1 ignored · 2 unmerged commits");
  expect(document.body.textContent).toContain("/owned/sandbox/data");
  expect(document.querySelector("input, textarea, [role=\"textbox\"]")).toBeNull();
  expect(button("Discard and remove").disabled).toBe(false);
  expect([...document.querySelectorAll('[data-slot="dialog-footer"] button')].map(action => action.textContent))
    .toEqual(["Keep workspace", "Refresh review", "Discard and remove"]);
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  await act(async () => button("Keep workspace").click()); expect(close).toHaveBeenCalledOnce();
});
it("journals exact reviewed scope before applying and deletes a conversation only after verified cleanup", async () => {
  const reviewed = { ...plan(), name: "Current reviewed workspace" };
  vi.mocked(developmentRequest).mockResolvedValueOnce(reviewed);
  await render({ deleteConversation: removeConversation });
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  vi.mocked(developmentRequest).mockImplementationOnce(async (path, body) => {
    expect(path).toBe("/workspace/discard/apply"); expect(body).toMatchObject({ expectedRevision: reviewed.revision, digest: reviewed.digest, confirmationName: reviewed.name });
    expect(JSON.parse(localStorage.getItem("hosty.workspace.discard.workspace")!)).toEqual(body);
    expect(removeConversation).not.toHaveBeenCalled(); return { ...progress("removed"), requestId: body!.requestId } as never;
  });
  await act(async () => button("Discard and remove").click());
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull(); expect(removeConversation).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Workspace removed");
});
it("blocks apply for live or unknown consumers and offers existing pause without original agent", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...plan(), blockers: ["External activity lease is active", "Consumer verification unavailable"] });
  await render(); expect(document.body.textContent).toContain("Consumer verification unavailable"); expect(button("Discard and remove").disabled).toBe(true);
  await act(async () => button("Pause workspace").click()); expect(pause).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(developmentRequest).toHaveBeenCalledTimes(1);
});
it("rejects an expired review and requests a fresh review without automatically applying it", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...plan(), expiresAt: "2000-01-01T00:00:00Z" });
  await render(); expect(button("Discard and remove").disabled).toBe(true); expect(document.body.textContent).toContain("This review expired");
  await act(async () => button("Refresh review").click()); expect(button("Discard and remove").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/discard/plan", undefined, expect.any(AbortSignal));
  expect(vi.mocked(developmentRequest).mock.calls.every(([, body]) => body === undefined)).toBe(true);
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull();
});
it("recovers an admitted removal after browser storage loss using Core's exact original command", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress()); await render({ pendingRequestId: requestId });
  expect(developmentRequest).toHaveBeenCalledWith(`/workspace/discard/status?requestId=${requestId}`, undefined, expect.any(AbortSignal));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("removed")); await act(async () => button("Resume removal").click());
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/discard/apply", command);
});
it("retains an uncertain request across timeout and reload, even when status is unavailable", async () => {
  await render(); vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost")).mockRejectedValueOnce(new DevelopmentRequestError("Not found", "not_found", 404));
  await act(async () => button("Discard and remove").click()); const saved = JSON.parse(localStorage.getItem("hosty.workspace.discard.workspace")!);
  expect(button("Resume removal").disabled).toBe(false); expect(removeConversation).not.toHaveBeenCalled();
  await act(async () => root.unmount()); root = createRoot(container);
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Disconnected")); await render();
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...progress("removed"), requestId: saved.requestId }); await act(async () => button("Resume removal").click());
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/discard/apply", saved);
});
it("retires an unadmitted stale review only after a definitive refusal and absent receipt", async () => {
  await render();
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Files changed; review again", "workspace_stale_review", 409)).mockRejectedValueOnce(new DevelopmentRequestError("Not admitted", "not_found", 404));
  await act(async () => button("Discard and remove").click());
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull(); expect(button("Discard and remove").disabled).toBe(true);
  expect(document.body.textContent).toContain("Files changed"); expect(button("Refresh review")).toBeTruthy();
});
it("keeps accepted cleanup after a 409 and preserves identity for recovery", async () => {
  await render();
  vi.mocked(developmentRequest).mockRejectedValueOnce(new DevelopmentRequestError("Temporary cleanup failed", "workspace_pending", 409)).mockResolvedValueOnce(progress());
  await act(async () => button("Discard and remove").click());
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).not.toBeNull(); expect(document.body.textContent).toContain("Removal is pending");
  expect(button("Resume removal")).toBeTruthy();
});
it("requires explicit fresh review when source changes during admitted cleanup", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("review-required")); await render({ pendingRequestId: requestId });
  expect(document.body.textContent).toContain("remaining source changed"); expect(button("Resume removal")).toBeUndefined();
  await act(async () => button("Refresh review").click());
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull();
  expect(button("Discard and remove").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(developmentRequest).mock.calls.every(([, body]) => body === undefined)).toBe(true);
  vi.mocked(developmentRequest).mockImplementationOnce(async (_path, body) => {
    expect(body!.requestId).not.toBe(requestId); return { ...progress("removed"), requestId: body!.requestId } as never;
  });
  await act(async () => button("Discard and remove").click()); expect(document.body.textContent).toContain("Workspace removed");
});

it("honors explicit conversation cleanup when status recovery first confirms physical removal", async () => {
  await render({ deleteConversation: removeConversation });
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress()); await act(async () => button("Discard and remove").click());
  expect(removeConversation).not.toHaveBeenCalled();
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("removed")); await act(async () => button("Check removal status").click());
  expect(removeConversation).toHaveBeenCalledOnce(); expect(button("Close")).toBeTruthy();
});
it("lets the operator pause owned running execution while destructive apply remains blocked", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...plan(), blockers: ["Owned agent is running"] });
  await render({ disabled: true });
  expect(button("Discard and remove").disabled).toBe(true); expect(button("Pause workspace").disabled).toBe(false);
  await act(async () => button("Pause workspace").click()); expect(pause).toHaveBeenCalledOnce();
});

it("allows cancelling a slow read-only review and aborts its request without mutation", async () => {
  vi.mocked(developmentRequest).mockImplementationOnce(() => new Promise(() => {}));
  await render(); expect(button("Keep workspace").disabled).toBe(false);
  const signal = vi.mocked(developmentRequest).mock.calls[0][2]!;
  await act(async () => button("Keep workspace").click()); expect(close).toHaveBeenCalledOnce();
  await act(async () => root.unmount()); root = createRoot(container);
  expect(signal.aborted).toBe(true); expect(developmentRequest).toHaveBeenCalledTimes(1);
});

function expectBusy(label: "Checking removal…" | "Removing workspace…") {
  const status = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(node => node.textContent === label || [...node.querySelectorAll("p")].some(paragraph => paragraph.textContent === label));
  expect(status).toBeDefined();
  expect(status!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
}

it("shows review loading feedback until a slow read completes without starting removal", async () => {
  let resolvePlan!: (value: DiscardPlan) => void;
  const read = new Promise<DiscardPlan>(resolve => { resolvePlan = resolve; });
  vi.mocked(developmentRequest).mockImplementationOnce(() => read);
  await render();
  expectBusy("Checking removal…");
  expect(document.body.textContent).not.toContain("Removing workspace…");
  expect(button("Discard and remove").disabled).toBe(true);
  expect(button("Refresh review").disabled).toBe(true);
  expect(button("Keep workspace").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledExactlyOnceWith("/workspace/discard/plan", undefined, expect.any(AbortSignal));
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull();
  await act(async () => resolvePlan(plan()));
  expect(document.body.textContent).not.toContain("Checking removal…");
  expect(button("Discard and remove").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledTimes(1);
});

it("shows removal progress during a slow apply and prevents duplicate requests or cancellation", async () => {
  await render();
  let resolveApply!: (value: DiscardProgress) => void;
  const applying = new Promise<DiscardProgress>(resolve => { resolveApply = resolve; });
  vi.mocked(developmentRequest).mockImplementationOnce(() => applying);
  const apply = button("Discard and remove");
  await act(async () => apply.click());
  expectBusy("Removing workspace…");
  expect(document.body.textContent).not.toContain("Checking removal…");
  expect(apply.disabled).toBe(true);
  expect(apply.textContent).toBe("Removing…");
  expect(apply.getAttribute("aria-busy")).toBe("true");
  expect(button("Close for now").disabled).toBe(true);
  expect(button("Check removal status").disabled).toBe(true);
  expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  const saved = JSON.parse(localStorage.getItem("hosty.workspace.discard.workspace")!);
  expect(saved).toMatchObject({ expectedRevision: command.expectedRevision, digest: command.digest, confirmationName: command.confirmationName });
  await act(async () => {
    apply.click();
    button("Close for now").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(close).not.toHaveBeenCalled();
  expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/discard/apply", saved);
  await act(async () => resolveApply({ ...progress(), requestId: saved.requestId, command: saved }));
  expect(document.body.textContent).not.toContain("Removing workspace…");
  expect(document.body.textContent).toContain("Removal is pending.");
  expect(button("Resume removal").disabled).toBe(false);
  expect(button("Close for now").disabled).toBe(false);
  expect(JSON.parse(localStorage.getItem("hosty.workspace.discard.workspace")!)).toEqual(saved);
  expect(developmentRequest).toHaveBeenCalledTimes(2);
});

it("labels recovered and explicit status reads as checking instead of claiming removal is running", async () => {
  localStorage.setItem("hosty.workspace.discard.workspace", JSON.stringify(command));
  let resolveInitial!: (value: DiscardProgress) => void;
  const initial = new Promise<DiscardProgress>(resolve => { resolveInitial = resolve; });
  vi.mocked(developmentRequest).mockImplementationOnce(() => initial);
  await render();
  expectBusy("Checking removal…");
  expect(document.body.textContent).not.toContain("Removing workspace…");
  expect(button("Resume removal").disabled).toBe(true);
  expect(button("Close for now").disabled).toBe(false);
  await act(async () => resolveInitial(progress()));
  expect(document.body.textContent).not.toContain("Checking removal…");
  let resolveStatus!: (value: DiscardProgress) => void;
  const checking = new Promise<DiscardProgress>(resolve => { resolveStatus = resolve; });
  vi.mocked(developmentRequest).mockImplementationOnce(() => checking);
  await act(async () => button("Check removal status").click());
  expectBusy("Checking removal…");
  expect(document.body.textContent).not.toContain("Removing workspace…");
  expect(button("Resume removal").disabled).toBe(true);
  expect(button("Check removal status").disabled).toBe(true);
  expect(button("Close for now").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(developmentRequest).mock.calls.every(([path, body]) => path === `/workspace/discard/status?requestId=${requestId}` && body === undefined)).toBe(true);
  await act(async () => resolveStatus(progress()));
  expect(document.body.textContent).not.toContain("Checking removal…");
  expect(button("Resume removal").disabled).toBe(false);
  expect(JSON.parse(localStorage.getItem("hosty.workspace.discard.workspace")!)).toEqual(command);
});
