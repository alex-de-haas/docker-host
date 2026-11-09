// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentNavigation } from "./development-navigation";
import type { AssistantSession } from "@/lib/assistant-api";
import { changeTotals, developmentRequest, type DevelopmentWorkspace } from "@/lib/development-api";
import type { DeleteDetails, DeleteProgress } from "./workspace-delete";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(developmentRequest).mockReset(); localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("lists each conversation once across app contexts in activity order without group headings", async () => {
  const multi = { id: "same", title: "Shared work", status: "running", appIds: ["one", "two"], createdAt: "2026-10-16" } as AssistantSession;
  const quick = { id: "quick", title: "Quick chat", status: "completed", appIds: [], createdAt: "2026-10-16" } as AssistantSession;
  const onPick = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[multi,quick]} activeId="same" workspaces={[]} onPick={onPick} onNew={() => {}} onDelete={vi.fn()} />));
  const rows = [...container.querySelectorAll('button[aria-current="page"]')]; expect(rows).toHaveLength(1);
  for (const row of rows) await act(async () => (row as HTMLButtonElement).click());
  expect(onPick.mock.calls).toEqual([[multi]]);
  expect([...container.querySelectorAll("h2")].map(n=>n.textContent)).toEqual([]);
  expect(container.querySelectorAll('[aria-label="Working"]')).toHaveLength(1);
});
it("does not invent line counts when evidence is missing or double count binary files", () => {
  expect(changeTotals([{ path: "missing", status: "M" }])).toBeNull();
  expect(changeTotals([{ path: "image", status: "M", binary: true }, { path: "code", status: "M", lineStats: { additions: 4, deletions: 2 } }])).toEqual({ additions: 4, deletions: 2 });
});

const disposable = { id: "delete-me", title: "Disposable chat", status: "idle", appIds: ["one", "two"], createdAt: "2026-10-18" } as AssistantSession;
const click = async (name: string) => act(async () => {
  const button = [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === name || b.textContent === name);
  expect(button).toBeDefined(); button!.click();
});
it("confirms deletion from the unique row without selecting the session, and allows cancellation", async () => {
  const onDelete = vi.fn().mockResolvedValue(undefined), onPick = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} activeId="other" workspaces={[]} onPick={onPick} onNew={() => {}} onDelete={onDelete} />));
  expect(container.querySelector("button button")).toBeNull();
  await click("Delete Disposable chat");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Disposable chat");
  expect(onDelete).not.toHaveBeenCalled(); expect(onPick).not.toHaveBeenCalled();
  await click("Keep session"); expect(document.querySelector('[role="dialog"]')).toBeNull();
  const triggers = container.querySelectorAll<HTMLButtonElement>('[aria-label="Delete Disposable chat"]');
  expect(triggers).toHaveLength(1);
  await act(async () => triggers[0].click()); await click("Delete session");
  expect(onDelete).toHaveBeenCalledExactlyOnceWith("delete-me"); expect(onPick).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("keeps a refused workspace deletion visible and retries once without losing navigation", async () => {
  const onDelete = vi.fn().mockRejectedValueOnce(new Error("Complete and delete the workspace first."));
  const onPick = vi.fn(); let finish!: () => void;
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} activeId="delete-me" workspaces={[]} onPick={onPick} onNew={() => {}} onDelete={onDelete} />));
  await click("Delete Disposable chat"); await click("Delete session");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Complete and delete");
  expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  onDelete.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await click("Delete session");
  const confirm = [...document.querySelectorAll("button")].find(b => b.textContent === "Deleting…")!;
  expect(confirm.disabled).toBe(true); await act(async () => confirm.click());
  expect(onDelete).toHaveBeenCalledTimes(2);
  await act(async () => finish()); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onPick).not.toHaveBeenCalled();
});

it("keeps remaining chats available and returns focus to New session when deletion removes its trigger", async () => {
  const quick = { ...disposable, id: "quick", title: "Quick chat", appIds: [] };
  const onNew = vi.fn();
  let sessions = [disposable, quick];
  const render = () => root.render(<DevelopmentNavigation sessions={sessions} workspaces={[]} onPick={vi.fn()} onNew={onNew} onDelete={onDelete} />);
  const onDelete = vi.fn(async () => { sessions = [quick]; render(); });
  await act(async () => render());
  await click("Delete Disposable chat");
  await click("Delete session");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(container.querySelector('[aria-label="New session"]'));
  expect([...container.querySelectorAll("h2")].map(node => node.textContent)).toEqual([]);
  expect(container.textContent).toContain("Quick chat");
  await click("New session");
  expect(onNew).toHaveBeenCalledOnce();
});

it("combines search and state filters without changing session identity or order", async () => {
  const older = { ...disposable, id: "older", title: "Older task", status: "awaiting_approval", appIds: [], createdAt: "2026-10-18" };
  const newer = { ...older, id: "newer", title: "Newer task", createdAt: "2026-10-20" };
  const running = { ...older, id: "working", title: "Working task", status: "running" };
  const pick = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[older, running, newer]} workspaces={[]} onPick={pick} onNew={vi.fn()} onDelete={vi.fn()} />));
  const waiting = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(button => button.textContent?.startsWith("Needs attention"))!;
  await act(async () => waiting.click());
  expect(container.textContent).not.toContain("Working task");
  const rows = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.includes("task") && !button.getAttribute("aria-label")?.startsWith("Delete"));
  expect(rows.map(button => button.querySelector("span.block")?.textContent)).toEqual(["Newer task", "Older task"]);
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Older"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).not.toContain("Newer task");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Older task"))!.click());
  expect(pick).toHaveBeenCalledWith(older);

});

it("lists workspaces and independent chats, matching attached chat titles without duplicating them", async () => {
  const session = { ...disposable, id: "attached", title: "Implementation" };
  const workspace = { id: "workspace", name: "Shared project", state: "active", owner: { kind: "assistant", appId: "hosty.harness", reference: session.id, label: "Owned" }, workflow: { state: "in-progress", revision: 0 }, worktrees: [] } as DevelopmentWorkspace;
  const external = { ...workspace, id: "external", name: "External checkout", owner: { kind: "external", reference: "task", label: "Codex" } };
  const empty = { ...workspace, id: "empty", name: "Retained source", owner: { ...workspace.owner, reference: "deleted" } };
  const pick = vi.fn();
  const render = (spaces = [workspace, external, empty]) => act(async () => root.render(<DevelopmentNavigation sessions={[session, disposable]} workspaces={spaces} activeId={session.id} onWorkspace={pick} onPick={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  await render();
  expect(container.textContent).toContain("Shared project"); expect(container.textContent).toContain("External checkout"); expect(container.textContent).toContain("Retained source");
  expect(container.textContent).toContain("Disposable chat");
  expect(container.textContent).not.toContain("Implementation");
  expect(container.querySelector('[aria-label="Delete Implementation"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-current="page"]')!.click());
  expect(pick).toHaveBeenCalledWith(workspace, undefined);
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Implementation"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-current="page"]')!.click());
  expect(pick).toHaveBeenLastCalledWith(workspace, session);
  await render([{ ...workspace, workflow: { state: "deleted", revision: 1 } }]);
  expect(container.textContent).toContain("Implementation");
  expect(container.querySelector('[aria-label="Delete Implementation"]')).not.toBeNull();
});

it("keeps decorative status shapes, factual chip counts and each filter's existing session projection", async () => {
  const statuses = ["idle", "completed", "running", "awaiting_approval", "awaiting_question", "failed"];
  const sessions = statuses.map((status, index) => ({ ...disposable, id: `session-${index}`, title: `Session ${index}`, status }));
  const pick = vi.fn();
  const render = (records = sessions) => act(async () => root.render(<DevelopmentNavigation sessions={records} workspaces={[]} onPick={pick} onNew={vi.fn()} onDelete={vi.fn()} />));
  await render();
  const filters = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
  expect(filters().map(node => node.textContent)).toEqual(["All6", "Needs attention2", "Working1", "Failed1"]);
  for (const filter of filters()) {
    const glyph = filter.querySelector("svg")!;
    expect(glyph).not.toBeNull();
    expect(glyph.closest('[aria-hidden="true"]')).not.toBeNull();
  }
  const expected = [["Session 0", "Session 1", "Session 2", "Session 3", "Session 4", "Session 5"], ["Session 3", "Session 4"], ["Session 2"], ["Session 5"]];
  for (const [index, filter] of filters().entries()) {
    await act(async () => filter.click());
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(pick).not.toHaveBeenCalled();
    const visible = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(node => /^Session \d$/.test(node.querySelector("span.block")?.textContent ?? ""));
    expect(visible.map(node => node.querySelector("span.block")?.textContent).sort()).toEqual(expected[index]);
  }
  await render(sessions.slice(0, -1));
  expect(filters().map(node => node.textContent)).toEqual(["All5", "Needs attention2", "Working1", "Failed0"]);
  expect(filters()[3].getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("No sessions match this search and filter.");
  expect(pick).not.toHaveBeenCalled();
});


it("offers all three creation actions beside one mixed Sessions list", async () => {
  const session = { ...disposable, id: "attached", title: "Implementation" };
  const workspace = { id: "workspace", name: "Shared project", state: "active", owner: { kind: "assistant", appId: "hosty.harness", reference: session.id, label: "Owned" }, workflow: { state: "in-progress", revision: 0 }, worktrees: [] } as DevelopmentWorkspace;
  await act(async () => root.render(<DevelopmentNavigation sessions={[session, disposable]} workspaces={[workspace]} activeId={session.id} onPick={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} createAppAction={<button>Create app</button>} />));
  expect(container.querySelector('nav[aria-label="Sessions"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Implementation"); expect(container.textContent).toContain("Disposable chat");
  expect(container.textContent).toContain("Shared project"); expect(container.textContent).toContain("Create app");
  expect(container.querySelector('[aria-label="Continue building"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="New session"]')).not.toBeNull();
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("Shared project");
});

it("adds workspace-only lifecycle and source/PR summaries without per-row fetches", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const onWorkspace = vi.fn();
  const workspaces: DevelopmentWorkspace[] = [{ id: "completed", name: "Finished feature", state: "active", owner: { kind: "external", reference: "task", label: "Agent" },
    workflow: { state: "completed", revision: 1 }, worktrees: [], pullRequestSummary: { count: 2, state: "merged", checks: "none", observedAt: "2026-11-01T10:00:00Z", partial: false } }];
  await act(async () => root.render(<DevelopmentNavigation sessions={[]} workspaces={workspaces} onPick={vi.fn()} onWorkspace={onWorkspace} onNew={vi.fn()} onDelete={vi.fn()} />));
  expect(container.textContent).toContain("Completed"); expect(container.textContent).toContain("Merged");
  const row = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Finished feature"))!;
  expect(row.querySelector("[title*='Workspace: Completed']")).not.toBeNull();
  await act(async () => row.click()); expect(onWorkspace).toHaveBeenCalledWith(workspaces[0], undefined);
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} workspaces={workspaces} onPick={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  const ordinary = [...container.querySelectorAll("button")].find(b => b.querySelector("span.block")?.textContent === disposable.title)!;
  expect(ordinary.textContent).not.toContain("Completed"); expect(ordinary.textContent).not.toContain("Merged");
  expect(ordinary.textContent).toContain("Idle");
  expect(ordinary.querySelector("time")?.dateTime).toBe("2026-10-18T00:00:00.000Z");
});

it("shows active unmerged PRs beside clean source and successful CI without fetching row details", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const workspace: DevelopmentWorkspace = { id: "clean-with-pr", name: "Awaiting merge", state: "active", owner: { kind: "external", reference: "task", label: "Agent" },
    workflow: { state: "in-progress", revision: 1 }, worktrees: [{ id: "tree", workspaceId: "clean-with-pr", repository: "repo", branch: "work/review", state: "active", apps: [], leases: [], pullRequests: [], observationHealth: "watching",
      observation: { at: "2026-11-04T10:00:00Z", state: "ok", local: { files: [], truncated: false } } }],
    pullRequestSummary: { count: 5, openCount: 2, draftCount: 1, state: "open", checks: "passed", observedAt: new Date().toISOString(), partial: false } };
  await act(async () => root.render(<DevelopmentNavigation sessions={[]} workspaces={[workspace]} onPick={vi.fn()} onWorkspace={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  const summary = container.querySelector('[title*="2 observed open pull requests"]')!;
  expect(summary.textContent).toContain("Clean");
  expect(summary.textContent).toContain("2 open PRs");
  expect(summary.textContent).toContain("CI passed");
  expect(summary.textContent).not.toContain("Merged");
  expect(summary.getAttribute("title")).toContain("including 1 draft");
  expect(summary.getAttribute("title")).toContain("5 linked pull requests");
  expect(summary.querySelector(".sr-only")?.textContent).toContain("2 observed open pull requests");
  expect(fetch).not.toHaveBeenCalled();
});

it("shows observed added and deleted line counts alongside the workspace file count", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const workspace: DevelopmentWorkspace = { id: "dirty", name: "Current changes", state: "active", owner: { kind: "external", reference: "task", label: "Agent" },
    workflow: { state: "in-progress", revision: 1 }, worktrees: [{ id: "tree", workspaceId: "dirty", repository: "repo", branch: "work/changes", state: "active", apps: [], leases: [], pullRequests: [], observationHealth: "watching",
      observation: { at: "2026-11-04T10:00:00Z", state: "ok", local: { files: [{ path: "code", status: "M" }, { path: "tests", status: "A" }], truncated: false, lineStats: { additions: 12, deletions: 4 } } } }] };
  const render = (value = workspace) => act(async () => root.render(<DevelopmentNavigation sessions={[]} workspaces={[value]} onPick={vi.fn()} onWorkspace={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  await render();
  const summary = container.querySelector('[title*="2 uncommitted files"]')!;
  expect(summary.textContent).toContain("2 files");
  expect(summary.querySelector(".text-success-foreground")?.textContent).toBe("+12");
  expect(summary.querySelector(".text-destructive-foreground")?.textContent).toBe("−4");
  expect(summary.getAttribute("title")).toContain("12 added and 4 deleted lines in uncommitted changes");
  expect(fetch).not.toHaveBeenCalled();
  await render({ ...workspace, worktrees: [{ ...workspace.worktrees[0], observationHealth: "pending" }] });
  expect(summary.textContent).toContain("2 files");
  expect(summary.querySelector(".text-success-foreground")?.textContent).toBe("+12");
  expect(summary.querySelector(".text-destructive-foreground")?.textContent).toBe("−4");
  expect(summary.textContent).not.toContain("Changes unknown");
  expect(summary.querySelectorAll(".animate-spin, .motion-safe\\:animate-spin")).toHaveLength(1);
  expect(summary.getAttribute("title")).toContain("last successful source observation while checking for updates");
  expect(summary.querySelector(".sr-only")?.textContent).toContain("while checking for updates");
  await render();
  expect(summary.querySelector("svg")).toBeNull();
  expect(summary.textContent).toContain("2 files");
  await render({ ...workspace, worktrees: [{ ...workspace.worktrees[0], observation: { ...workspace.worktrees[0].observation!, local: { ...workspace.worktrees[0].observation!.local!, truncated: true } } }] });
  expect(container.textContent).toContain("2+ files");
  const partialSummary = container.querySelector('[title*="At least 2 uncommitted files"]')!;
  expect(partialSummary.querySelector(".text-success-foreground")).toBeNull();
  expect(partialSummary.querySelector(".text-destructive-foreground")).toBeNull();
});

it("keeps represented chats grouped before search and activity filtering", async () => {
  const session = { ...disposable, id: "attached", title: "Implementation", status: "idle" };
  const workspace: DevelopmentWorkspace = { id: "workspace", name: "Shared project", state: "active",
    owner: { kind: "assistant", appId: "hosty.harness", reference: session.id, label: "Owned" },
    workflow: { state: "in-progress", revision: 0 }, worktrees: [] };
  const independent = { ...disposable, id: "independent", title: "Independent task", status: "running" };
  await act(async () => root.render(<DevelopmentNavigation sessions={[session, independent]} workspaces={[workspace]} onPick={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  await click("Working1");
  expect(container.textContent).toContain("Independent task");
  expect(container.textContent).not.toContain("Shared project");
  expect(container.textContent).not.toContain("Implementation");
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Implementation"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).toContain("No sessions match this search and filter.");
  expect(container.querySelector('[aria-label="Delete Implementation"]')).toBeNull();
});

it("gives ordinary sessions a secondary status and activity time without aggregate counts", async () => {
  const sessions = [
    { ...disposable, id: "working", title: "Background run", status: "running", updatedAt: "2026-11-06T12:00:00Z" },
    { ...disposable, id: "idle", title: "Quick question", updatedAt: "invalid" },
    { ...disposable, id: "unknown", title: "Unknown time", createdAt: "invalid" },
  ];
  await act(async () => root.render(<DevelopmentNavigation sessions={sessions} workspaces={[]} onPick={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  const rows = [...container.querySelectorAll("button")].filter(b => b.querySelector("span.block"));
  const working = rows.find(b => b.querySelector("span.block")?.textContent === "Background run")!;
  expect(working.querySelector('[aria-label="Working"]')).not.toBeNull();
  expect(working.querySelector('[aria-label="Working: 1"]')).toBeNull();
  expect(working.querySelector("time")?.dateTime).toBe("2026-11-06T12:00:00.000Z");
  expect(rows.find(b => b.querySelector("span.block")?.textContent === "Quick question")?.textContent).toContain("Idle");
  expect(rows.find(b => b.querySelector("span.block")?.textContent === "Quick question")?.querySelector("time")?.dateTime).toBe("2026-10-18T00:00:00.000Z");
  expect(rows.find(b => b.querySelector("span.block")?.textContent === "Unknown time")?.textContent).toContain("Activity time unavailable");
});

const deletableWorkspace = (extra: Partial<DevelopmentWorkspace> = {}): DevelopmentWorkspace => ({
  id: "target", name: "Target workspace", state: "active", owner: { kind: "external", reference: "task", label: "Agent" },
  workflow: { state: "in-progress", revision: 1 }, worktrees: [], ...extra,
});
const deletionDetails = (): DeleteDetails => ({ name: "Target workspace", trees: [{ id: "tree", repository: "https://example.test/repo.git",
  path: "/test/source", branch: "work/target", head: "head", fingerprint: "known", changedFiles: ["local.txt"], untrackedFiles: [], ignoredFiles: [], unmergedCommits: 2 }],
  resources: [{ id: "sandbox", kind: "sandbox", state: "running", name: "Test preview" }], warnings: ["External agent exit is unknown."] });
const deletionProgress = (requestId: string, state: DeleteProgress["state"] = "pending"): DeleteProgress => ({ workspaceId: "target", requestId, state, trees: [], resources: [] });

it.each(["in-progress", "completed"])("opens the existing workspace dialog from a %s row without selecting or deleting a chat", async state => {
  const workspace = deletableWorkspace({ workflow: { state, revision: 1 },
    ...(state === "completed" ? { pullRequestSummary: { count: 1, state: "merged", checks: "none", partial: false } } : {}) });
  vi.mocked(developmentRequest).mockResolvedValue(deletionDetails());
  const onDelete = vi.fn(), onPick = vi.fn(), onWorkspace = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} activeId={disposable.id} workspaces={[workspace]} onPick={onPick} onWorkspace={onWorkspace} onNew={vi.fn()} onDelete={onDelete} />));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Delete workspace Target workspace"]')!;
  expect(trigger.className).toContain("[@media(hover:hover)]:opacity-0");
  expect(trigger.className).toContain("group-focus-within:opacity-100");
  expect(container.querySelector("button button")).toBeNull();
  await act(async () => { trigger.focus(); trigger.click(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Delete workspace?");
  expect(dialog.textContent).toContain("Target workspace");
  expect(dialog.textContent).toContain("1 changed · 0 untracked · 0 ignored · 2 unmerged commits");
  expect(dialog.textContent).toContain("Test preview");
  expect(dialog.textContent).toContain("External agent exit is unknown.");
  expect(dialog.querySelector('[role="checkbox"]')).toBeNull();
  expect(developmentRequest).toHaveBeenCalledExactlyOnceWith("/target/delete/details", undefined, expect.any(AbortSignal));
  expect(onPick).not.toHaveBeenCalled(); expect(onWorkspace).not.toHaveBeenCalled(); expect(onDelete).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain(disposable.title);
  await click("Cancel");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  expect(onPick).not.toHaveBeenCalled(); expect(onWorkspace).not.toHaveBeenCalled(); expect(onDelete).not.toHaveBeenCalled();
});

it("respects workspace manage permissions without making completion or merge a prerequisite", async () => {
  const readonly = deletableWorkspace({ id: "readonly", name: "Read only", permissions: { read: true, manage: false } });
  await act(async () => root.render(<DevelopmentNavigation sessions={[]} workspaces={[readonly, deletableWorkspace()]} onPick={vi.fn()} onWorkspace={vi.fn()} onNew={vi.fn()} onDelete={vi.fn()} />));
  expect(container.textContent).toContain("Read only");
  expect(container.querySelector('[aria-label="Delete workspace Read only"]')).toBeNull();
  expect(container.querySelector('[aria-label="Delete workspace Target workspace"]')).not.toBeNull();
  expect(developmentRequest).not.toHaveBeenCalled();
});

it("recovers a pending workspace removal with its original request id", async () => {
  const requestId = "f38e8580-2e35-40b1-917a-83cedc5a9bf0";
  const workspace = deletableWorkspace({ workflow: { state: "deleting", revision: 3,
    operations: [{ id: requestId, kind: "discard", state: "unknown", expectedRevision: 2 }] } });
  vi.mocked(developmentRequest).mockResolvedValueOnce(deletionProgress(requestId)).mockResolvedValueOnce(deletionProgress(requestId, "removed"));
  const onDelete = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} activeId={disposable.id} workspaces={[workspace]} onPick={vi.fn()} onWorkspace={vi.fn()} onNew={vi.fn()} onDelete={onDelete} />));
  await click("Delete workspace Target workspace");
  expect(developmentRequest).toHaveBeenCalledExactlyOnceWith(`/target/delete/status?requestId=${requestId}`, undefined, expect.any(AbortSignal));
  await click("Retry deletion");
  expect(developmentRequest).toHaveBeenLastCalledWith("/target/delete", { requestId });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Workspace deleted");
  expect(onDelete).not.toHaveBeenCalled();
});

it("retains deletion results across inventory removal and brings retained chats back into the list", async () => {
  const retained = { ...disposable, id: "retained", title: "Retained conversation" };
  const workspace = deletableWorkspace({ owner: { kind: "assistant", appId: "hosty.harness", reference: retained.id, label: "Target" } });
  let workspaces = [workspace];
  const onDelete = vi.fn();
  const refresh = vi.fn(() => { workspaces = []; render(); });
  const render = () => root.render(<DevelopmentNavigation sessions={[retained, disposable]} activeId={disposable.id} workspaces={workspaces} onPick={vi.fn()} onNew={vi.fn()} onDelete={onDelete} onRefresh={refresh} />);
  vi.mocked(developmentRequest).mockResolvedValueOnce(deletionDetails()).mockImplementationOnce(async (_path, body) => deletionProgress(body!.requestId as string, "removed") as never);
  await act(async () => render());
  expect(container.textContent).not.toContain(retained.title);
  await click("Delete workspace Target workspace");
  await click("Delete");
  expect(refresh).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Target workspace");
  expect(container.textContent).toContain(retained.title);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Workspace deleted");
  expect(onDelete).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain(disposable.title);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Close")!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(container.querySelector('[aria-label="New session"]'));
});
