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
