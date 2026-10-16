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
  await act(async () => root.render(<DevelopmentNavigation sessions={[multi,quick]} activeId="same" workspaces={[]} onPick={onPick} onNew={() => {}} />));
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
