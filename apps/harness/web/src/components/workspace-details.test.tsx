// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceDetails } from "./workspace-details";
import { developmentRequest, type DevelopmentWorkspace } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const workspace = (): DevelopmentWorkspace => ({ id: "workspace", state: "active", owner: { kind: "assistant", reference: "session", label: "Harness" },
  workflow: { state: "in-progress", revision: 0 }, worktrees: ["one", "two"].map(id => ({ id, workspaceId: "workspace", repository: `https://example.test/${id}.git`, branch: "work", state: "active", apps: [], leases: [],
    observation: { at: new Date().toISOString(), state: "ok" }, sessionChanges: [{ path: "README.md", status: "M", lineStats: { additions: 3, deletions: 2 } }],
    pullRequests: [{ url: `https://example.test/${id}/pull/1` }] })) });
function replies(w: DevelopmentWorkspace) {
  vi.mocked(developmentRequest).mockImplementation(async (path = "") => {
    if (path.endsWith("/previews")) return { environments: [], instances: [], applications: {} } as never;
    if (path.includes("/diff?")) return { combined: "+new text", binary: false, truncated: false } as never;
    return w.worktrees.find(t => path.endsWith(t.id)) as never;
  });
}
it("shows each repository and honestly missing CI; opens a repository-specific diff without a sandbox section", async () => {
  const w = workspace(); replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Multi-repo change" refresh={() => {}} />));
  expect(container.textContent).toContain("one · CI unknown"); expect(container.textContent).toContain("two · CI unknown");
  expect(container.querySelector('[aria-label="Sandbox previews"]')).toBeNull();
  const changes = [...container.querySelectorAll("button")].filter(b => b.textContent?.startsWith("Changes"));
  expect(changes).toHaveLength(2);
  await act(async () => changes[1].click());
  expect(developmentRequest).toHaveBeenCalledWith(expect.stringContaining("/workspace/worktrees/two/diff?"), undefined, expect.any(AbortSignal));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("+new text");
  });
});
it("recovers deletion from Core after browser storage loss and keeps the original revision and UUID", async () => {
  const w = workspace(); const id = "94fcd992-875a-46dd-a729-a4ae6b0f0b69";
  w.workflow = { state: "deleting", revision: 4, operations: [{ id, kind: "delete", expectedRevision: 4, state: "pending" }] }; replies(w);
  const refresh = vi.fn();
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Recover" refresh={refresh} />));
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "deleted", revision: 5 });
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry action")!.click());
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/workflow/delete", { requestId: id, expectedRevision: 4 });
  expect(refresh).toHaveBeenCalledOnce();
});

it("keeps each PR's repository, head evidence, failed checks and review threads distinct", async () => {
  const w = workspace();
  w.worktrees[0].repository = "/retained/local/source/.git";
  w.worktrees[0].pullRequests = [{ url: "https://example.test/one/pull/3", observation: {
    title: "Fix layout", at: new Date().toISOString(), state: "open", draft: false, commentCount: 7,
    checks: [{ name: "Build", state: "SUCCESS" }, { name: "Tests", state: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2,
  } }, { url: "https://example.test/one/pull/2", observation: { title: "Earlier change", at: "2026-01-01", state: "merged", draft: false, unresolvedThreads: 0, checks: [] } }];
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="PR evidence" refresh={() => {}} />));
  expect(container.textContent).toContain("one · CI 2/2 · 7 discussion comments");
  expect(container.textContent).not.toContain("Tests: FAILURE");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const checks = container.querySelector<HTMLButtonElement>('[aria-label="one #3: CI 2/2, show checks"]')!;
  await act(async () => checks.click());
  const popover = document.querySelector('[role="dialog"][aria-label="one #3: CI checks"]')!;
  expect(popover.textContent).toContain("Build");
  expect(popover.textContent).toContain("Success");
  expect(popover.textContent).toContain("Tests");
  expect(popover.textContent).toContain("Failure");
  expect(popover.textContent).not.toContain("Earlier change");
  expect(container.textContent).toContain("CHANGES_REQUESTED · 2 unresolved threads");
  expect(container.textContent).toContain("merged · Stale / unobserved");
  expect(container.textContent).toContain("two · CI unknown");
});

it("labels external ownership and per-repository observation age without implying agent activity", async () => {
  const w = workspace(); w.owner = { kind: "external", label: "External QA", reference: "task" };
  w.worktrees[0].observation!.at = "2020-01-01T00:00:00Z";
  w.worktrees[1].observation = undefined; replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="External QA" refresh={() => {}} />));
  expect(container.textContent).toContain("External work: External QA");
  expect(container.textContent).toContain("Conversation and agent activity are not synchronized.");
  expect(container.querySelector("time")?.dateTime).toBe("2020-01-01T00:00:00Z");
  expect(container.textContent).toContain("Stale");
  expect(container.textContent).toContain("Observation unavailable");
});

it("retains each repository's file and scope after closing its diff", async () => {
  const w = workspace();
  for (const tree of w.worktrees) {
    tree.sessionChanges!.push({ path: "details.txt", status: "M", lineStats: { additions: 1, deletions: 1 } });
    tree.observation!.local = { files: tree.sessionChanges!, truncated: false };
  }
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Remember diff" refresh={() => {}} />));
  const changes = [...container.querySelectorAll("button")].filter(b => b.textContent?.startsWith("Changes"));
  await act(async () => changes[0].click());
  await act(async () => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === "details.txt")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await act(async () => {
    const scope = document.querySelector<HTMLSelectElement>('[aria-label="Diff scope"]')!;
    scope.value = "local"; scope.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const close = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Close")!;
  await act(async () => close().click());
  await act(async () => changes[1].click());
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Diff scope"]')!.value).toBe("session");
  await act(async () => close().click());
  await act(async () => changes[0].click());
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Diff scope"]')!.value).toBe("local");
  expect(document.querySelector('[aria-label="Changed files"] [aria-current="true"]')?.textContent).toBe("details.txt");
});


it("uses refreshed workflow state and stops offering a successful journal request for retry", async () => {
  const w = workspace(); const id = "8a6a4d08-56d5-4d03-8758-43a9af547009";
  localStorage.setItem("hosty.workspace.action.workspace", JSON.stringify({ kind: "complete", requestId: id, expectedRevision: 0 }));
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Refresh" refresh={() => {}} />));
  expect(container.textContent).toContain("Pending action: complete");
  const updated = { ...w, workflow: { state: "completed", revision: 1, operations: [{ id, kind: "complete", expectedRevision: 0, state: "succeeded" }] } };
  await act(async () => root.render(<WorkspaceDetails workspace={updated} title="Refresh" refresh={() => {}} />));
  expect(container.textContent).toContain("completed");
  expect(container.textContent).not.toContain("Pending action:");
  await act(async () => root.render(<WorkspaceDetails workspace={{ ...updated, workflow: { state: "in-progress", revision: 2 } }} title="Refresh" refresh={() => {}} />));
  expect(container.textContent).toContain("in progress");
});

it("recovers interrupted closure from Core without browser storage and retains the conversation", async () => {
  const w = workspace(), requestId = "c6168d4b-26f9-40df-83f4-0452a9186626";
  w.workflow = { state: "in-progress", closure: "closing", revision: 3,
    operations: [{ id: requestId, kind: "close", expectedRevision: 3, state: "pending", error: "Execution stop is unconfirmed" }] };
  replies(w); const remove = vi.fn();
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Unfinished" refresh={() => {}} deleteConversation={remove} />));
  expect(container.textContent).toContain("Execution stop is unconfirmed");
  expect(container.textContent).not.toContain("Dismiss");
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "in-progress", closure: "closed", revision: 4 });
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry action")!.click());
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/workflow/close", { requestId, expectedRevision: 3 });
  expect(container.textContent).toContain("source, previews and conversation are retained");
  expect(remove).not.toHaveBeenCalled();
});

it("blocks deletion when an open confirmation is overtaken by a durable close", async () => {
  const w = workspace(); w.workflow = { state: "completed", revision: 3 }; replies(w);
  const render = (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="Completed" refresh={() => {}} />));
  await render(w);
  const deleteEntry = () => [...container.querySelectorAll("button")].find(b => b.textContent === "Delete workspace…")!;
  await act(async () => deleteEntry().click());
  const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Delete workspace")!;
  expect(confirm().disabled).toBe(false);
  const request = { kind: "close", requestId: "4637074a-7c1f-4227-9104-d6811dd4bea3", expectedRevision: 3 };
  const journal = JSON.stringify(request);
  localStorage.setItem("hosty.workspace.action.workspace", journal);
  await render({ ...w, workflow: { ...w.workflow, closure: "closing", operations: [{ id: request.requestId, kind: "close", expectedRevision: 3, state: "pending" }] } });
  expect(deleteEntry().disabled).toBe(true);
  expect(confirm().disabled).toBe(true);
  await act(async () => confirm().click());
  expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path?.endsWith("/workflow/delete"))).toBe(false);
  expect(localStorage.getItem("hosty.workspace.action.workspace")).toBe(journal);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Close")!.click());
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "completed", closure: "closed", revision: 4 });
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry action")!.click());
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/workflow/close", { requestId: request.requestId, expectedRevision: 3 });
});


it.each(["deleting", "deleted"])("does not offer Resume or retained-source guidance for a closed %s workspace", async state => {
  const w = workspace(); w.workflow = { state, closure: "closed", revision: 4 };
  w.worktrees = w.worktrees.map(tree => ({ ...tree, state: "released" }));
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Retained conversation" refresh={() => {}} />));
  await act(async () => container.querySelector('[aria-label="Workspace actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const resume = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Resume workspace")!;
  expect(resume).toBeDefined();
  expect(resume.getAttribute("aria-disabled")).toBe("true");
  await act(async () => resume.click());
  expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path?.endsWith("/workflow/resume"))).toBe(false);
  expect(localStorage.getItem("hosty.workspace.action.workspace")).toBeNull();
  expect(container.textContent).not.toContain("Resume to continue development");
});

it("clears a recovered detail-read error without retaining a stale authentication warning", async () => {
  const w = workspace(); replies(w);
  vi.mocked(developmentRequest).mockImplementation(async (path = "") => {
    if (path.endsWith("/previews")) return { environments: [], instances: [], applications: {} } as never;
    throw new Error("Temporary access failure");
  });
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Recovery" refresh={() => {}} />));
  expect(container.textContent).toContain("Temporary access failure");
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={{ ...w }} title="Recovery" refresh={() => {}} />));
  expect(container.textContent).not.toContain("Temporary access failure");
  expect(container.textContent).toContain("one · CI unknown");
});


it("offers one Pause action instead of Close and Defer, including while execution runs", async () => {
  const w = workspace(); replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} running title="Active work" refresh={() => {}} />));
  await act(async () => container.querySelector('[aria-label="Workspace actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const entries = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(entries.some(item => /Close workspace|Defer workspace/.test(item.textContent ?? ""))).toBe(false);
  const pause = entries.find(item => item.textContent === "Pause workspace")!;
  expect(pause.getAttribute("aria-disabled")).not.toBe("true");
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "in-progress", closure: "closed", revision: 1 });
  await act(async () => pause.click());
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/workflow/pause", { requestId: expect.any(String), expectedRevision: 0 });
  expect(container.textContent).toContain("Paused: source");
});

it.each([
  { state: "completed", revision: 1 },
  { state: "deferred", revision: 1 },
  { state: "in-progress", closure: "closed", revision: 1 },
  { state: "in-progress", closure: "closing", revision: 1 },
])("does not repeat inactive Git detail reads on inventory refresh, but allows manual refresh: %j", async workflow => {
  const w = { ...workspace(), workflow }; replies(w);
  const refresh = vi.fn();
  const render = (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="Inactive" refresh={refresh} />));
  await render(w);
  const detailCalls = () => vi.mocked(developmentRequest).mock.calls.filter(([path]) => path?.includes("/worktrees/"));
  expect(detailCalls()).toHaveLength(2);
  await render({ ...w, workflow: { ...workflow }, worktrees: w.worktrees.map(t => ({ ...t })) });
  expect(detailCalls()).toHaveLength(2);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh workspace"]')!.click());
  expect(detailCalls()).toHaveLength(4);
  expect(refresh).toHaveBeenCalledOnce();
  await render({ ...w, workflow: { state: "in-progress", revision: 2 } });
  expect(detailCalls()).toHaveLength(6);
});

it("keeps one lease recovery panel across inventory refreshes", async () => {
  const w = workspace(); w.owner.kind = "external"; w.worktrees[0].leases = ["lease"];
  replies(w);
  for (let i = 0; i < 4; i++) {
    await act(async () => root.render(<WorkspaceDetails workspace={{ ...w }} title="External" refresh={() => {}} />));
    expect(container.querySelectorAll('details summary')).toHaveLength(1);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.textContent).not.toContain('External activity leases');
  }
});
