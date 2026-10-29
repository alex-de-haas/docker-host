// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceDetails } from "./workspace-details";
import { developmentRequest, DevelopmentRequestError, type DevelopmentWorkspace } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("@/lib/workspace-applications", async original => ({ ...await original<object>(), useWorkspaceApplications: () => ({ applications: [], loading: false, error: "", refresh: () => {} }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false); localStorage.clear();
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
    if (path.endsWith("/delete/details")) return { name: "Workspace", trees: [], resources: [], warnings: [] } as never;
    if (path.endsWith("/previews")) return { environments: [], instances: [], applications: {} } as never;
    if (path.includes("/review?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      if (query.get("scope") !== "pull-request") throw new DevelopmentRequestError("Endpoint unavailable", "workspace_failed", 404);
      return { source: { scope: "pull-request", label: "Published PR", base: "base", head: "published", revision: "pr-revision", observedAt: "", pullRequestUrl: query.get("pullRequestUrl"), published: true, notPublished: false }, files: [], threads: [], truncated: false } as never;
    }
    if (path.includes("/diff?")) return { combined: "+new text", binary: false, truncated: false } as never;
    return w.worktrees.find(t => path.split("?")[0].endsWith(t.id)) as never;
  });
}
async function expandCards() { for (const button of container.querySelectorAll<HTMLButtonElement>('[data-slot="pull-request-card"] > button')) if (button.getAttribute("aria-expanded") !== "true") await act(async () => button.click()); }
it("shows each repository and honestly missing CI; opens a repository-specific diff with a confirmed empty preview inventory", async () => {
  const w = workspace(); replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Multi-repo change" refresh={() => {}} />));
  expect(container.querySelector('[aria-label^="Expand one #1"]')).not.toBeNull(); expect(container.querySelector('[aria-label^="Expand two #1"]')).not.toBeNull(); expect(container.textContent).toContain("CI unknown");
  expect(container.querySelector('[aria-label="Sandbox previews"]')).toBeNull();
  const changes = [...container.querySelectorAll("button")].filter(b => b.textContent?.startsWith("Workspace changes"));
  expect(changes).toHaveLength(2);
  await act(async () => changes[1].click());
  expect(developmentRequest).toHaveBeenCalledWith(expect.stringContaining("/workspace/worktrees/two/diff?"), undefined, expect.any(AbortSignal));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(document.querySelector('[aria-label="Workspace review"]')?.textContent).toContain("+new text");
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
  await expandCards();
  expect(container.textContent).toContain("7 discussion comments");
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
  expect(container.textContent).toContain("Changes requested"); expect(container.textContent).toContain("2 unresolved threads");
  expect(container.textContent).toContain("Merged"); expect(container.textContent).toContain("Outdated");
  expect(container.textContent).toContain("CI unknown");
});

it("labels external ownership and per-repository observation age without implying agent activity", async () => {
  const w = workspace(); w.owner = { kind: "external", label: "External QA", reference: "task" };
  w.worktrees[0].observation!.at = "2020-01-01T00:00:00Z";
  w.worktrees[1].observation = undefined; replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="External QA" refresh={() => {}} />));
  expect(container.textContent).toContain("External work: External QA");
  expect(container.textContent).toContain("Conversation and agent activity are not synchronized.");
  expect(container.querySelector("time")?.dateTime).toBe("2020-01-01T00:00:00Z");
  await expandCards(); expect(container.textContent).toContain("Outdated");
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
  const changes = [...container.querySelectorAll("button")].filter(b => b.textContent?.startsWith("Workspace changes"));
  await act(async () => changes[0].click());
  await act(async () => [...document.querySelectorAll('[aria-label="Changed files"] button')].find(b => b.textContent?.startsWith("details.txt"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Diff scope"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === "Uncommitted changes")!.click(); });
  const close = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Workspace review"] button')].find(b => b.textContent === "Back to session")!;
  await act(async () => close().click());
  await act(async () => changes[1].click());
  expect(document.querySelector('[aria-label="Diff scope"]')!.textContent).toBe("All workspace changes");
  await act(async () => close().click());
  await act(async () => changes[0].click());
  expect(document.querySelector('[aria-label="Diff scope"]')!.textContent).toBe("Uncommitted changes");
  expect(document.querySelector('[aria-label="Changed files"] [aria-current="true"]')?.textContent).toContain("details.txt");
});


it("uses refreshed workflow state and stops offering a successful journal request for retry", async () => {
  const w = workspace(); const id = "8a6a4d08-56d5-4d03-8758-43a9af547009";
  localStorage.setItem("hosty.workspace.action.workspace", JSON.stringify({ kind: "complete", requestId: id, expectedRevision: 0 }));
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Refresh" refresh={() => {}} />));
  expect(container.textContent).toContain("Action outcome unconfirmed: complete");
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

it("keeps Delete available when a pending lifecycle action arrives after the popup opens", async () => {
  const w = workspace(); replies(w);
  const render = async (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="Delete" refresh={() => {}} />));
  await render(w); await chooseWorkflowAction("Delete workspace…");
  const pending = { ...w, workflow: { state: "in-progress", closure: "closing", revision: 3,
    operations: [{ id: "pending-close", kind: "close", expectedRevision: 3, state: "pending" }] } };
  await render(pending);
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Delete")!;
  expect(confirm.disabled).toBe(false);
  vi.mocked(developmentRequest).mockResolvedValueOnce({ workspaceId: "workspace", requestId: "delete-request", state: "removed", trees: [], resources: [] });
  await act(async () => confirm.click());
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/delete", { requestId: expect.any(String) });
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
  expect(container.textContent).toContain("CI unknown");
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
  expect(detailCalls().slice(2).every(([path]) => path?.endsWith("?refresh=true"))).toBe(true);
  expect(refresh).toHaveBeenCalledOnce();
  await render({ ...w, workflow: { state: "in-progress", revision: 2 } });
  expect(detailCalls()).toHaveLength(6);
  expect(detailCalls().slice(4).every(([path]) => !path?.includes("refresh=true"))).toBe(true);
});

it("retains active details across identical inventories and refreshes changed source or lease facts", async () => {
  const w = workspace(); replies(w);
  const render = (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="Active" refresh={vi.fn()} />));
  const reads = () => vi.mocked(developmentRequest).mock.calls.filter(([path]) => path?.includes("/worktrees/"));
  await render(w); expect(reads()).toHaveLength(2);
  await render(JSON.parse(JSON.stringify(w))); expect(reads()).toHaveLength(2);
  await render({ ...w, name: "New title", updatedAt: "2026-10-27" }); expect(reads()).toHaveLength(2);
  const changed = { ...w, worktrees: w.worktrees.map(t => ({ ...t, observationRevision: "new-source" })) };
  await render(changed); expect(reads()).toHaveLength(4);
  await render({ ...changed, worktrees: changed.worktrees.map(t => ({ ...t, leases: ["lease"] })) }); expect(reads()).toHaveLength(6);
});

it("refreshes PR status when only the inventory publication revision changes", async () => {
  const inventory = workspace();
  inventory.worktrees = inventory.worktrees.map(t => ({ ...t, observationRevision: "source:1:0" }));
  const details = structuredClone(inventory); replies(details);
  const render = (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="PR status" refresh={vi.fn()} />));
  await render(inventory);
  expect(container.textContent).toContain("CI unknown");
  details.worktrees[0].pullRequests[0].observation = {
    at: new Date().toISOString(), state: "merged", draft: false, reviewDecision: "APPROVED", unresolvedThreads: 0,
    checks: [{ name: "CI", state: "SUCCESS" }],
  };
  await render({ ...inventory, worktrees: inventory.worktrees.map(t => ({ ...t, observationRevision: "source:1:1" })) });
  await expandCards();
  expect(container.textContent).toContain("Merged");
  expect(container.textContent).toContain("Approved");
  expect(container.querySelector('[aria-label="one #1: CI 1/1, show checks"]')).not.toBeNull();
});

it("keeps an identical pending detail read and cancels it when source changes", async () => {
  const w = workspace(); replies(w);
  const fallback = vi.mocked(developmentRequest).getMockImplementation()!;
  const pending: AbortSignal[] = [];
  vi.mocked(developmentRequest).mockImplementation((path, body, signal) => {
    if (path?.includes("/worktrees/")) { pending.push(signal!); return new Promise(() => {}); }
    return fallback(path, body, signal);
  });
  const render = (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="Pending" refresh={vi.fn()} />));
  await render(w); expect(pending).toHaveLength(2);
  await render(JSON.parse(JSON.stringify(w))); expect(pending).toHaveLength(2);
  expect(pending.every(signal => !signal.aborted)).toBe(true);
  await render({ ...w, worktrees: w.worktrees.map(t => ({ ...t, observationRevision: "changed" })) });
  expect(pending).toHaveLength(4); expect(pending.slice(0, 2).every(signal => signal.aborted)).toBe(true);
  await act(async () => root.render(null)); expect(pending.every(signal => signal.aborted)).toBe(true);
});

it("does not accept a stale pending result when inventory returns to its previous source", async () => {
  const w = workspace(); replies(w);
  const render = (value: DevelopmentWorkspace) => act(async () => root.render(<WorkspaceDetails workspace={value} title="Reverted" refresh={vi.fn()} />));
  await render(w);
  const fallback = vi.mocked(developmentRequest).getMockImplementation()!;
  const pending: AbortSignal[] = [];
  vi.mocked(developmentRequest).mockImplementation((path, body, signal) => {
    if (path?.includes("/worktrees/")) { pending.push(signal!); return new Promise(() => {}); }
    return fallback(path, body, signal);
  });
  await render({ ...w, worktrees: w.worktrees.map(t => ({ ...t, observationRevision: "changed" })) });
  expect(pending).toHaveLength(2);
  await render(w); expect(pending).toHaveLength(4);
  expect(pending.slice(0, 2).every(signal => signal.aborted)).toBe(true);
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

it("uses the workspace name and renames it without running an app or altering source", async () => {
  const w = { ...workspace(), name: "Small layout fix" }; replies(w); const refresh = vi.fn();
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Conversation title" refresh={refresh} />));
  expect(container.querySelector("h2")?.textContent).toBe("Small layout fix");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Rename workspace"]')!.click());
  const input = container.querySelector<HTMLInputElement>('[id="workspace-name-workspace"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Simplify runtime selection");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  vi.mocked(developmentRequest).mockResolvedValueOnce({ name: "Simplify runtime selection", revision: 2 });
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save name")!.click());
  expect(container.querySelector("h2")?.textContent).toBe("Simplify runtime selection");
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/name", { requestId: expect.any(String), name: "Simplify runtime selection" });
  expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path?.includes("execution-target"))).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => root.render(<WorkspaceDetails workspace={{ ...w, name: "Runtime switch controls" }} title="Conversation title" refresh={refresh} />));
  expect(container.querySelector("h2")?.textContent).toBe("Runtime switch controls");
});

it("opens the exact bound PR and repository in review while retaining GitHub and CI controls", async () => {
  const w = workspace(); replies(w); const onReview = vi.fn();
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="PR review" refresh={() => {}} onReview={onReview} />));
  await expandCards();
  const review = container.querySelector<HTMLButtonElement>('[aria-label="Review changes for two #1"]')!;
  expect(review).toBeDefined();
  await act(async () => review.click());
  expect(onReview).toHaveBeenCalledExactlyOnceWith(w.worktrees[1], { view: "pr:https://example.test/two/pull/1", path: "" });
  expect(container.querySelector('a[href="https://example.test/two/pull/1"]')).not.toBeNull();
  expect(container.textContent).toContain("CI unknown");
  expect(container.querySelector('[aria-label="Workspace review"]')).toBeNull();
});

it("opens a PR-specific review without a parent callback and keeps released PR links available", async () => {
  const w = workspace(); w.worktrees[0].state = "released"; replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="PR fallback" refresh={() => {}} />));
  await expandCards();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Review changes for one #1"]')!.disabled).toBe(true);
  expect(container.querySelector('a[href="https://example.test/one/pull/1"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Review changes for two #1"]')!.click());
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Workspace review"]')).not.toBeNull());
  expect(container.querySelector('[aria-label="Diff scope"]')?.textContent).toContain("PR: https://example.test/two/pull/1");
});

it("keeps bound app icons and collapsed consumer diagnostics without obsolete management links", async () => {
  const w = workspace();
  w.worktrees[0].leases = ["diagnostic-lease"];
  w.worktrees[0].apps = [{ appId: "hosty.shell", name: "Shell" }];
  w.worktrees[0].consumers = [
    { kind: "local-service", reference: "hosty.shell/web", name: "Shell", managementUrl: "https://core.test/manage/shell" },
    { kind: "core-runtime", reference: "hosty:core", name: "Core" },
    { kind: "dev-runtime", reference: "outside.worker/service", name: "Unbound worker" },
  ];
  const metadata = [
    { id: "hosty.shell", displayName: "Shell", available: true, iconUrl: "http://127.0.0.1:7070/api/apps/hosty.shell/assets/assets/custom.svg?v=1" },
    { id: "hosty.harness", displayName: "Harness", available: true, iconUrl: "https://images.test/harness.svg" },
  ];
  replies(w);
  const render = (appMetadata = metadata) => act(async () => root.render(<WorkspaceDetails workspace={w} title="Manifest icons" appMetadata={appMetadata} refresh={vi.fn()} />));
  await render();
  const images = [...container.querySelectorAll<HTMLImageElement>("img")];
  expect(images).toHaveLength(2);
  expect(images.every(image => image.src === `http://${window.location.hostname}:7070/api/apps/hosty.shell/assets/assets/custom.svg?v=1`)).toBe(true);
  expect(container.querySelector('a[href="https://core.test/manage/shell"]')).toBeNull();
  expect(container.textContent).not.toContain("Manage application");
  expect(container.querySelector('[aria-label="Applications using source"]')).toBeNull();
  const diagnostics = container.querySelector<HTMLDetailsElement>('[aria-label="Workspace activity diagnostics"]')!;
  expect(diagnostics.open).toBe(false);
  expect(diagnostics.textContent).toContain("Core · core-runtime · hosty:core");
  expect(diagnostics.textContent).toContain("Unbound worker · dev-runtime · outside.worker/service");
  expect(diagnostics.textContent).toContain("Lease: diagnostic-lease");
  expect(diagnostics.textContent).toContain("Stop or return active runtimes");
  const reads = vi.mocked(developmentRequest).mock.calls.length;
  await render(metadata.map(app => ({ ...app, iconUrl: app.iconUrl.replace("v=1", "v=2") })));
  expect([...container.querySelectorAll<HTMLImageElement>("img")].every(image => image.src.includes("custom.svg?v=2"))).toBe(true);
  await render([]);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('[aria-label="Workspace activity diagnostics"]')?.textContent).toContain("Shell · local-service · hosty.shell/web");
  expect(container.querySelector('[aria-label="Workspace applications"]')?.textContent).toContain("Shell");
  expect(vi.mocked(developmentRequest).mock.calls).toHaveLength(reads);
});


const workflowJournal = "hosty.workspace.action.workspace";
type Workflow = DevelopmentWorkspace["workflow"];
function workflowReplies(w: DevelopmentWorkspace, action: (body: Record<string, unknown>) => Workflow | Promise<Workflow>, read: () => Workflow | Promise<Workflow>) {
  replies(w);
  const fallback = vi.mocked(developmentRequest).getMockImplementation()!;
  vi.mocked(developmentRequest).mockImplementation(async (path = "", body, signal) => {
    if (path === "/workspace/workflow") return await read() as never;
    if (path.startsWith("/workspace/workflow/")) return await action(body!) as never;
    return await fallback(path, body, signal) as never;
  });
}
async function chooseWorkflowAction(label: string) {
  await act(async () => container.querySelector('[aria-label="Workspace actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
  expect(entry.getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => entry.click());
}
const retryWorkflowAction = () => act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry action")!.click());

it.each([
  ["workspace_dirty", "Commit or resolve every repository's changes before completing or deleting the workspace."],
  ["workspace_unmerged", "Current commits are not merged in https://example.test/one.git."],
  ["workspace_in_use", "An agent still holds an activity lease. Stop it and verify its exit first."],
])("reconciles a definite %s refusal and permits a fresh action at the observed revision", async (code, message) => {
  const w = workspace(); w.owner = { kind: "external", label: "External QA", reference: "task" };
  const requests: Record<string, unknown>[] = [];
  workflowReplies(w, body => {
    requests.push(body);
    if (requests.length === 1) throw new DevelopmentRequestError(message, code, 409);
    return { state: "completed", revision: 4 };
  }, () => ({ state: "in-progress", revision: 3 }));
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Unwanted work" refresh={vi.fn()} />));
  await chooseWorkflowAction("Complete workspace");
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ expectedRevision: 0 });
  expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path === "/workspace/workflow")).toBe(true);
  expect(localStorage.getItem(workflowJournal)).toBeNull();
  expect(container.textContent).toContain(message); expect(container.textContent).not.toContain("Pending action:");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry action")).toBe(false);
  await chooseWorkflowAction("Complete workspace");
  expect(requests).toHaveLength(2); expect(requests[1]).toMatchObject({ expectedRevision: 3 });
  expect(requests[1].requestId).not.toBe(requests[0].requestId);
  expect(localStorage.getItem(workflowJournal)).toBeNull(); expect(container.textContent).not.toContain(message);
});

it("accepts an authoritative succeeded receipt after a rejected response without retaining its error", async () => {
  const w = workspace();
  let request: Record<string, unknown> = {};
  workflowReplies(w, body => {
    request = body; throw new DevelopmentRequestError("Workspace changed. Refresh before choosing an action.", "workspace_revision_conflict", 409);
  }, () => ({ state: "completed", revision: 1, operations: [{ id: String(request.requestId), kind: "complete", expectedRevision: 0, state: "succeeded" }] }));
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Confirmed completion" refresh={vi.fn()} />));
  await chooseWorkflowAction("Complete workspace");
  expect(container.textContent).toContain("completed");
  expect(container.textContent).not.toContain("Workspace changed. Refresh before choosing an action.");
  expect(container.textContent).not.toContain("Pending action:"); expect(localStorage.getItem(workflowJournal)).toBeNull();
});

it.each([
  { kind: "pause", receipt: "pending", observed: { state: "in-progress", closure: "closing", revision: 4 } },
  { kind: "delete", receipt: "pending", observed: { state: "deleting", revision: 4 } },
  { kind: "pause", receipt: "unknown", observed: { state: "in-progress", closure: "closing", revision: 4 } },
  { kind: "delete", receipt: "unknown", observed: { state: "deleting", revision: 4 } },
])("retains the original $kind request after a 409 with a matching $receipt receipt", async ({ kind, receipt, observed }) => {
  const w = workspace(), request = { kind, requestId: "3402bd15-80e9-43c3-b62e-ef0574232cd4", expectedRevision: 4 };
  w.workflow = { state: kind === "delete" ? "completed" : "in-progress", revision: 4 };
  localStorage.setItem(workflowJournal, JSON.stringify(request));
  const requests: Record<string, unknown>[] = [];
  workflowReplies(w, body => {
    requests.push(body);
    if (requests.length === 1) throw new DevelopmentRequestError("The action still requires recovery.", "workspace_in_use", 409);
    return { state: kind === "delete" ? "deleted" : "in-progress", ...(kind === "pause" ? { closure: "closed" } : {}), revision: 5 };
  }, () => ({ ...observed, operations: [{ id: request.requestId, kind, expectedRevision: 4, state: receipt }] }));
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Recovery" refresh={vi.fn()} />));
  await retryWorkflowAction();
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
  expect(container.textContent).toContain(`${receipt === "pending" ? "Pending action" : "Action outcome unconfirmed"}: ${kind}`);
  expect(container.textContent).not.toContain("Dismiss");
  await retryWorkflowAction();
  expect(requests).toEqual(Array.from({ length: 2 }, () => ({ requestId: request.requestId, expectedRevision: 4 })));
  expect(localStorage.getItem(workflowJournal)).toBeNull();
});

it.each([
  { state: "in-progress", closure: "closing", revision: 3 },
  { state: "deleting", revision: 3 },
])("retains an unconfirmed request when the authoritative workflow is protected: %j", async observed => {
  const w = workspace(), request = { kind: "complete", requestId: "ba9421be-e659-434f-a700-d5ef58d16b79", expectedRevision: 2 };
  w.workflow = { state: "in-progress", revision: 2 };
  localStorage.setItem(workflowJournal, JSON.stringify(request));
  workflowReplies(w, () => { throw new DevelopmentRequestError("Source cleanup or pause has started.", "workspace_workflow_closed", 409); }, () => observed);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Protected work" refresh={vi.fn()} />));
  await retryWorkflowAction();
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
  expect(container.textContent).toContain("Action outcome unconfirmed: complete"); expect(container.textContent).not.toContain("Dismiss");
});

it("retains a refused request when its authoritative workflow cannot be read", async () => {
  const w = workspace(), request = { kind: "complete", requestId: "e0a13488-f4f4-4db8-82ee-81a73c14449d", expectedRevision: 0 };
  localStorage.setItem(workflowJournal, JSON.stringify(request));
  workflowReplies(w, () => { throw new DevelopmentRequestError("Source is dirty.", "workspace_dirty", 409); }, () => { throw new Error("Workflow status is unavailable."); });
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Uncertain status" refresh={vi.fn()} />));
  await retryWorkflowAction();
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
  expect(container.textContent).toContain("Action outcome unconfirmed: complete");
  expect(container.textContent).toContain("Source is dirty.");
});

it.each([
  new Error("Connection lost before the outcome was received."),
  new DevelopmentRequestError("Core is temporarily unavailable.", "workspace_failed", 503),
  ...[408, 425, 429].map(status => new DevelopmentRequestError("Retryable request outcome is not confirmed.", "workspace_retry", status)),
])("keeps the original recovery identity after an uncertain action response: %s", async failure => {
  const w = workspace(), request = { kind: "complete", requestId: "616cb7c6-7079-41be-8b80-0ce5c16d9cd2", expectedRevision: 0 };
  localStorage.setItem(workflowJournal, JSON.stringify(request));
  const requests: Record<string, unknown>[] = [];
  workflowReplies(w, body => {
    requests.push(body);
    if (requests.length === 1) throw failure;
    return { state: "completed", revision: 1 };
  }, () => ({ state: "in-progress", revision: 0 }));
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Uncertain outcome" refresh={vi.fn()} />));
  await retryWorkflowAction();
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
  expect(container.textContent).toContain("Action outcome unconfirmed: complete");
  await retryWorkflowAction();
  expect(requests).toEqual(Array.from({ length: 2 }, () => ({ requestId: request.requestId, expectedRevision: 0 })));
  expect(localStorage.getItem(workflowJournal)).toBeNull();
});


it.each([
  { kind: "resume", expectedRevision: 0 },
  { kind: "complete", expectedRevision: 1 },
])("does not treat a same-ID succeeded receipt for different arguments as completion: %j", async receipt => {
  const w = workspace(), request = { kind: "complete", requestId: "40dcc32c-2044-4610-978f-b0c210555723", expectedRevision: 0 };
  localStorage.setItem(workflowJournal, JSON.stringify(request));
  workflowReplies(w, () => { throw new DevelopmentRequestError("Reuse the original workspace action and revision.", "workspace_request_conflict", 409); },
    () => ({ state: "in-progress", revision: 2, operations: [{ id: request.requestId, ...receipt, state: "succeeded" }] }));
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Conflicting receipt" refresh={vi.fn()} />));
  await retryWorkflowAction();
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
  expect(container.textContent).toContain("Action outcome unconfirmed: complete");
  expect(container.textContent).toContain("Reuse the original workspace action and revision.");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry action")?.disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/workflow/complete", { requestId: request.requestId, expectedRevision: 0 });
});

it("keeps discard recovery separate from generic lifecycle retry after browser storage loss", async () => {
  const w = workspace(); const requestId = "94fcd992-875a-46dd-a729-a4ae6b0f0b69";
  w.workflow = { state: "deleting", closure: "closed", revision: 4, operations: [{ id: requestId, kind: "discard", expectedRevision: 3, state: "pending" }] }; replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Remove" refresh={() => {}} />));
  expect(container.textContent).toContain("Workspace removal is pending");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry action")).toBe(false);
  vi.mocked(developmentRequest).mockImplementationOnce(async () => ({ workspaceId: "workspace", requestId, state: "pending", command: { requestId, expectedRevision: 3, digest: "same-review", confirmationName: "Remove" }, trees: [], resources: [] }));
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Recover removal")!.click());
  expect(developmentRequest).toHaveBeenLastCalledWith(`/workspace/delete/status?requestId=${requestId}`, undefined, expect.any(AbortSignal));
  expect(developmentRequest).not.toHaveBeenCalledWith("/workspace/workflow/discard", expect.anything());
});


it("shows completion progress through the action and refusal check without premature recovery controls", async () => {
  const w = workspace(); w.owner = { kind: "external", label: "External QA", reference: "task" };
  w.worktrees[0].leases = ["external-writer-lease"];
  let rejectAction!: (error: unknown) => void;
  let resolveRead!: (value: Workflow) => void;
  const action = new Promise<Workflow>((_, reject) => { rejectAction = reject; });
  const observed = new Promise<Workflow>(resolve => { resolveRead = resolve; });
  const requests: Record<string, unknown>[] = [];
  workflowReplies(w, body => { requests.push(body); return action; }, () => observed);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Leased work" refresh={vi.fn()} />));
  await chooseWorkflowAction("Complete workspace");
  const expectProgress = () => {
    expect([...container.querySelectorAll('[role="status"]')].some(status => status.textContent === "Completing workspace…")).toBe(true);
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry action" || button.textContent === "Dismiss")).toBe(false);
    expect(container.textContent).not.toContain("Pending action:");
    expect(container.textContent).not.toContain("Action outcome unconfirmed:");
  };
  expectProgress();
  expect(requests).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toMatchObject({ kind: "complete", ...requests[0] });
  const message = "An agent still holds an activity lease. Stop it and verify its exit first.";
  await act(async () => rejectAction(new DevelopmentRequestError(message, "workspace_in_use", 409)));
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/workflow");
  expectProgress();
  expect(localStorage.getItem(workflowJournal)).not.toBeNull();
  await act(async () => resolveRead({ state: "in-progress", revision: 3 }));
  expect(localStorage.getItem(workflowJournal)).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
  expect(container.textContent).not.toContain("Completing workspace…");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry action" || button.textContent === "Dismiss")).toBe(false);
  expect(container.textContent).toContain("Pause this workspace, then confirm that all agent executions and their commands have stopped.");
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Pause workspace")?.disabled).toBe(false);
  await act(async () => container.querySelector('[aria-label="Workspace actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  for (const label of ["Complete workspace", "Pause workspace", "Delete workspace…"]) {
    const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label);
    expect(entry).toBeDefined();
    expect(entry!.getAttribute("aria-disabled")).not.toBe("true");
  }
  expect(requests).toHaveLength(1);
});

it("lets a local-only uncertain journal open deletion details without replacing its recovery identity", async () => {
  const w = workspace(), request = { kind: "complete", requestId: "ba3c2cc8-b85b-4b12-8f64-fbec4bab51d3", expectedRevision: 0 };
  localStorage.setItem(workflowJournal, JSON.stringify(request));
  replies(w);
  const fallback = vi.mocked(developmentRequest).getMockImplementation()!;
  vi.mocked(developmentRequest).mockImplementation(async (path = "", body, signal) => path === "/workspace/delete/details"
    ? { workspaceId: w.id, name: "Unwanted work", revision: 0, digest: "read-only-review", expiresAt: new Date(Date.now() + 60000).toISOString(),
      trees: [], resources: [], warnings: ["An external writer may still be active."] } as never
    : await fallback(path, body, signal) as never);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Unwanted work" refresh={vi.fn()} />));
  expect(container.textContent).toContain("Action outcome unconfirmed: complete");
  await chooseWorkflowAction("Delete workspace…");
  expect(developmentRequest).toHaveBeenCalledWith("/workspace/delete/details", undefined, expect.any(AbortSignal));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete workspace?");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("An external writer may still be active.");
  expect(vi.mocked(developmentRequest).mock.calls.every(([, body]) => body === undefined)).toBe(true);
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === "Cancel")!.click());
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry action")?.disabled).toBe(false);
  expect(JSON.parse(localStorage.getItem(workflowJournal)!)).toEqual(request);
});

it.each(["pending", "unknown"])("keeps Delete enabled for a Core %s receipt without a local journal", async receipt => {
  const w = workspace(), requestId = "51229231-6b3b-4803-8728-904b7215b2a7";
  w.workflow = { state: "in-progress", revision: 0, operations: [{ id: requestId, kind: "complete", expectedRevision: 0, state: receipt }] };
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Core recovery" refresh={vi.fn()} />));
  expect(container.textContent).toContain(`${receipt === "pending" ? "Pending action" : "Action outcome unconfirmed"}: complete`);
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry action")?.disabled).toBe(false);
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Dismiss")).toBe(false);
  await act(async () => container.querySelector('[aria-label="Workspace actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Delete workspace…");
  expect(entry).toBeDefined();
  expect(entry?.getAttribute("aria-disabled")).not.toBe("true");
  expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path === "/workspace/delete/details")).toBe(false);
  expect(vi.mocked(developmentRequest).mock.calls.every(([, body]) => body === undefined)).toBe(true);
  expect(localStorage.getItem(workflowJournal)).toBeNull();
});


it.each(["clean", "dirty", "working", "paused", "completed", "failed"])("offers one destructive Delete for %s source", async state => {
  const w = workspace();
  if (state === "clean") for (const tree of w.worktrees) tree.sessionChanges = [];
  if (state === "working") w.worktrees[0]!.leases = ["active-agent"];
  if (state === "paused") w.workflow = { state: "in-progress", closure: "closed", revision: 1 };
  if (state === "completed") w.workflow = { state: "completed", revision: 1 };
  if (state === "failed") { w.state = "failed"; w.worktrees[0]!.state = "failed"; }
  replies(w);
  await act(async () => root.render(<WorkspaceDetails workspace={w} title="Delete states" refresh={vi.fn()} />));
  await act(async () => container.querySelector('[aria-label="Workspace actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const entries = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item => /Delete|Discard/.test(item.textContent ?? ""));
  expect(entries).toHaveLength(1);
  expect(entries[0]!.textContent).toBe("Delete workspace…");
  expect(entries[0]!.getAttribute("aria-disabled")).not.toBe("true");
  expect(entries[0]!.getAttribute("data-variant")).toBe("destructive");
});
