// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionList } from "./session-list";
import type { AssistantSession } from "@/lib/assistant-api";

it("shows each session's saved context with bounded icons and preserves row navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const onPick = vi.fn();
  const base = { title: "Chat", createdAt: "2026-09-30T10:00:00Z", status: "idle" };
  const selected: AssistantSession = { ...base, id: "selected", appIds: ["media", "removed", "third", "fourth"], contextApps: [
    { id: "media", displayName: "Media Server", available: true, iconUrl: "https://core.example/api/apps/media/assets/icon.svg" },
    { id: "removed", displayName: "Removed App", available: false },
    { id: "unselected", displayName: "Ignore stale metadata", available: true },
  ] };
  try {
    await act(async () => root.render(<SessionList sessions={[selected, { ...base, id: "general" }, { ...base, id: "outage", appIds: ["unresolved"] }]}
      activeId={null} onPick={onPick} onRename={vi.fn()} onDelete={vi.fn()} />));
    const stacks = container.querySelectorAll('[role="img"]');
    expect(stacks).toHaveLength(2);
    expect(stacks[0].getAttribute("aria-label")).toBe("App context: Media Server, Removed App · Unavailable, third, fourth");
    expect(stacks[0].querySelectorAll('[data-slot="context-app-preview"]')).toHaveLength(3);
    expect(stacks[0].textContent).toBe("+1");
    expect(stacks[0].querySelector("img")?.src).toContain("/apps/media/assets/icon.svg");
    expect(stacks[1].getAttribute("aria-label")).toBe("App context: unresolved");
    expect(container.querySelector("button button")).toBeNull();
    await act(async () => stacks[0].closest("button")!.click());
    expect(onPick).toHaveBeenCalledWith(selected);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it("keeps the embedded history waiting label and session action with a decorative decision shape", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const waiting = { id: "waiting", title: "Needs review", status: "awaiting_question", createdAt: "2026-10-23T12:00:00Z" } as AssistantSession;
  const unconfirmed: AssistantSession = { ...waiting, id: "lost", providerStatusContact: { reason: "unavailable", runId: "run", observedAt: waiting.createdAt } };
  const onPick = vi.fn();
  try {
    await act(async () => root.render(<SessionList sessions={[waiting, unconfirmed]} activeId={waiting.id} onPick={onPick} onRename={vi.fn()} onDelete={vi.fn()} />));
    const glyph = container.querySelector('.lucide-diamond')!;
    expect(glyph).not.toBeNull(); expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toContain("waiting for you");
    expect(container.textContent).toContain("activity unconfirmed");
    expect(container.querySelectorAll(".lucide-diamond")).toHaveLength(1);
    await act(async () => (glyph.closest("button") as HTMLButtonElement).click());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(waiting);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it("closes inline confirmation and hides actions for sessions being deleted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const first = { id: "first", title: "First chat", status: "idle", createdAt: "2026-10-23T12:00:00Z" } as AssistantSession;
  const second = { ...first, id: "second", title: "Second chat" };
  const third = { ...first, id: "third", title: "Third chat" };
  let rejectDelete!: (reason: Error) => void;
  const onDelete = vi.fn(() => new Promise<void>((_, reject) => { rejectDelete = reject; }));
  const onPick = vi.fn();
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  try {
    await act(async () => root.render(<SessionList sessions={[first, second, third]} activeId={null} onPick={onPick}
      onRename={vi.fn()} onDelete={onDelete} deletingSessionIds={new Set(["second"])} />));
    await act(async () => button("Delete First chat")!.click());
    await act(async () => button("Confirm delete")!.click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(first.id);
    expect(button("Confirm delete")).toBeNull();
    expect([...container.querySelectorAll('[role="status"]')].map(status => status.textContent)).toEqual(["Deleting…", "Deleting…"]);
    expect(button("Delete First chat")).toBeNull();
    expect(button("Delete Second chat")).toBeNull();
    expect(button("Rename First chat")).toBeNull();
    expect([...container.querySelectorAll("button")].some(control => control.textContent?.includes("First chat"))).toBe(false);
    await act(async () => [...container.querySelectorAll("button")].find(control => control.textContent?.includes(third.title))!.click());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(third);

    await act(async () => rejectDelete(new Error("Session remains")));
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(button("Delete First chat")).not.toBeNull();
    expect(button("Confirm delete")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
