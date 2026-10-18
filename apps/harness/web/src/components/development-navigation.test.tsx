// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentNavigation } from "./development-navigation";
import type { AssistantSession } from "@/lib/assistant-api";
import { changeTotals } from "@/lib/development-api";
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("groups a multi-app conversation without cloning identity and keeps unassigned chats last", async () => {
  const multi = { id: "same", title: "Shared work", status: "running", appIds: ["one", "two"], createdAt: "2026-10-16" } as AssistantSession;
  const quick = { id: "quick", title: "Quick chat", status: "completed", appIds: [], createdAt: "2026-10-16" } as AssistantSession;
  const onPick = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[multi,quick]} activeId="same" workspaces={[]} onPick={onPick} onNew={() => {}} onDelete={vi.fn()} />));
  const rows = [...container.querySelectorAll('button[aria-current="page"]')]; expect(rows).toHaveLength(2);
  for (const row of rows) await act(async () => (row as HTMLButtonElement).click());
  expect(onPick.mock.calls).toEqual([[multi],[multi]]);
  expect([...container.querySelectorAll("h2")].map(n=>n.textContent)).toEqual(["one","two","Unassigned chats"]);
  expect(container.querySelectorAll('[aria-label="Agent running"]')).toHaveLength(2);
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
it("confirms deletion from either app group without selecting the session, and allows cancellation", async () => {
  const onDelete = vi.fn().mockResolvedValue(undefined), onPick = vi.fn();
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} activeId="other" workspaces={[]} onPick={onPick} onNew={() => {}} onDelete={onDelete} />));
  expect(container.querySelector("button button")).toBeNull();
  await click("Delete Disposable chat");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Disposable chat");
  expect(onDelete).not.toHaveBeenCalled(); expect(onPick).not.toHaveBeenCalled();
  await click("Keep session"); expect(document.querySelector('[role="dialog"]')).toBeNull();
  const triggers = container.querySelectorAll<HTMLButtonElement>('[aria-label="Delete Disposable chat"]');
  expect(triggers).toHaveLength(2);
  await act(async () => triggers[1].click()); await click("Delete session");
  expect(onDelete).toHaveBeenCalledExactlyOnceWith("delete-me"); expect(onPick).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("keeps a refused workspace deletion visible and retries once without losing navigation", async () => {
  const onDelete = vi.fn().mockRejectedValueOnce(new Error("Complete and delete the workspace first."));
  const onPick = vi.fn(); let finish!: () => void;
  await act(async () => root.render(<DevelopmentNavigation sessions={[disposable]} activeId="delete-me" workspaces={[]} onPick={onPick} onNew={() => {}} onDelete={onDelete} />));
  await click("Delete Disposable chat"); await click("Delete session");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Complete and delete");
  expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(2);
  onDelete.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await click("Delete session");
  const confirm = [...document.querySelectorAll("button")].find(b => b.textContent === "Deleting…")!;
  expect(confirm.disabled).toBe(true); await act(async () => confirm.click());
  expect(onDelete).toHaveBeenCalledTimes(2);
  await act(async () => finish()); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onPick).not.toHaveBeenCalled();
});

it("shows remaining chats when deletion removes the last session in the filtered app", async () => {
  const quick = { ...disposable, id: "quick", title: "Quick chat", appIds: [] };
  const render = (sessions: AssistantSession[]) => act(async () => root.render(<DevelopmentNavigation sessions={sessions} workspaces={[]} onPick={vi.fn()} onNew={() => {}} onDelete={vi.fn()} />));
  await render([disposable, quick]);
  const filter = container.querySelector("select")!;
  await act(async () => { filter.value = "one"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).not.toContain("Quick chat");
  await render([quick]);
  expect(filter.value).toBe(""); expect(container.textContent).toContain("Quick chat");
});
