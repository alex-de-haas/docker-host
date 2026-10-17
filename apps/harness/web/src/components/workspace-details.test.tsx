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
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("+new text");
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
  w.worktrees[0].pullRequests = [{ url: "https://example.test/one/pull/3", observation: {
    title: "Fix layout", at: new Date().toISOString(), state: "open", draft: false, commentCount: 7,
    checks: [{ name: "Build", state: "SUCCESS" }, { name: "Tests", state: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2,
  } }, { url: "https://example.test/one/pull/2", observation: { title: "Earlier change", at: "2026-01-01", state: "merged", draft: false, unresolvedThreads: 0, checks: [] } }];
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="PR evidence" refresh={() => {}} />));
  expect(container.textContent).toContain("one · CI 1/2 · 7 discussion comments");
  expect(container.textContent).toContain("Tests: FAILURE");
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
