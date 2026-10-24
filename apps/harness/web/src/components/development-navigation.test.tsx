// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentNavigation } from "./development-navigation";
import type { AssistantSession } from "@/lib/assistant-api";
import { changeTotals, type DevelopmentWorkspace } from "@/lib/development-api";
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
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
  expect(container.querySelectorAll('[aria-label="Agent running"]')).toHaveLength(1);
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
  const pick = vi.fn(), external = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[older, running, newer]} workspaces={[]} onPick={pick} onNew={vi.fn()} onDelete={vi.fn()} externalCount={3} onExternal={external} />));
  const waiting = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(button => button.textContent?.startsWith("Needs you"))!;
  await act(async () => waiting.click());
  expect(container.textContent).not.toContain("Working task");
  const rows = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.includes("task") && !button.getAttribute("aria-label")?.startsWith("Delete"));
  expect(rows.map(button => button.textContent?.split("Needs you")[0])).toEqual(["Newer task", "Older task"]);
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Older"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).not.toContain("Newer task");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Older task"))!.click());
  expect(pick).toHaveBeenCalledWith(older);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("External workspaces"))!.click());
  expect(external).toHaveBeenCalledOnce();
});

it("uses the owned workspace name while retaining original-title and application search, identity and deletion", async () => {
  const session = { id: "work", title: "Original conversation", status: "idle", appIds: ["notes.app", "other.app"],
    contextApps: [{ id: "notes.app", displayName: "Notebook", available: true }], createdAt: "2026-10-22" } as AssistantSession;
  const workspace = { id: "workspace", name: "Review changes", owner: { kind: "assistant", appId: "hosty.harness", reference: session.id, label: "Owned work" }, workflow: { state: "in-progress", revision: 0 }, worktrees: [] } as unknown as DevelopmentWorkspace;
  const onPick = vi.fn();
  const render = (workspaces = [workspace]) => act(async () => root.render(<DevelopmentNavigation sessions={[session]} activeId={session.id} workspaces={workspaces} onPick={onPick} onNew={vi.fn()} onDelete={vi.fn()} />));
  await render();
  const row = () => container.querySelector<HTMLButtonElement>('[aria-current="page"]')!;
  expect(row().textContent).toBe("Review changes");
  expect(container.querySelector('[aria-label="Delete Review changes"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Idle");
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')!;
  for (const query of ["Review changes", "Original conversation", "Notebook", "other.app"]) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, query); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(row().textContent).toBe("Review changes");
  }
  await act(async () => row().click()); expect(onPick).toHaveBeenCalledWith(session);
  await render([{ ...workspace, name: "Renamed workspace" }]);
  expect(row().textContent).toBe("Renamed workspace");
  await click("Delete Renamed workspace");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete the session “Renamed workspace”');
  await click("Keep session");
  await render([{ ...workspace, name: " " }]); expect(row().textContent).toBe("Owned work");
  await render([{ ...workspace, name: "", owner: { ...workspace.owner, label: "" } }]); expect(row().textContent).toBe("Original conversation");
  await render([{ ...workspace, owner: { ...workspace.owner, reference: "another-session" } }]); expect(row().textContent).toBe("Original conversation");
  await render([{ ...workspace, owner: { ...workspace.owner, appId: "another-owner" } }]); expect(row().textContent).toBe("Original conversation");
  await render([{ ...workspace, workflow: { ...workspace.workflow, state: "deleted" } }]); expect(row().textContent).toBe("Original conversation");
});

it("keeps decorative status shapes, factual chip counts and each filter's existing session projection", async () => {
  const statuses = ["idle", "completed", "running", "awaiting_approval", "awaiting_question", "failed"];
  const sessions = statuses.map((status, index) => ({ ...disposable, id: `session-${index}`, title: `Session ${index}`, status }));
  const pick = vi.fn();
  const render = (records = sessions) => act(async () => root.render(<DevelopmentNavigation sessions={records} workspaces={[]} onPick={pick} onNew={vi.fn()} onDelete={vi.fn()} />));
  await render();
  const filters = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
  expect(filters().map(node => node.textContent)).toEqual(["All6", "Needs you2", "Working1", "Failed1"]);
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
    const visible = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(node => /^Session \d$/.test(node.textContent ?? ""));
    expect(visible.map(node => node.textContent).sort()).toEqual(expected[index]);
  }
  await render(sessions.slice(0, -1));
  expect(filters().map(node => node.textContent)).toEqual(["All5", "Needs you2", "Working1", "Failed0"]);
  expect(filters()[3].getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("No sessions match this search and filter.");
  expect(pick).not.toHaveBeenCalled();
});
