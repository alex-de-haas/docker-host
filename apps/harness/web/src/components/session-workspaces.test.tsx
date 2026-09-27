// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionWorkspaces } from "./session-workspaces";
import { workspaceAction, type AssistantSession } from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", () => ({ workspaceAction: vi.fn() }));
let root: Root; let container: HTMLDivElement;
const session = { id: "one", appIds: ["notes"] } as AssistantSession;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(workspaceAction).mockResolvedValue({ workspaces: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = (running = false) => act(async () => root.render(<SessionWorkspaces session={session} running={running} />));
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
const open = async () => act(async () => { const details = container.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
it("allocates only on request and reuses the request identity after a lost response", async () => {
  await render(); await open();
  expect(vi.mocked(workspaceAction).mock.calls.every(call => call[1] === "list")).toBe(true);
  await act(async () => { const select = container.querySelector<HTMLSelectElement>('[aria-label="Source app"]')!; select.value = "notes"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("Lost response"));
  await act(async () => button("Prepare worktree").click());
  const first = vi.mocked(workspaceAction).mock.calls.find(call => call[1] === "prepare")!;
  expect(first[2]).toMatchObject({ appId: "notes", requestId: expect.any(String) });
  vi.mocked(workspaceAction).mockResolvedValueOnce({ operations: [] }).mockResolvedValue({ workspaces: [] });
  await act(async () => button("Retry same request").click());
  expect(vi.mocked(workspaceAction).mock.calls.filter(call => call[1] === "prepare")).toEqual([first, first]);
  await render(true);
  expect(button("Prepare worktree").disabled).toBe(true);
});

it("shows non-Error failures during initial load and manual refresh", async () => {
  vi.mocked(workspaceAction).mockRejectedValue("List unavailable");
  await render(); await open();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("List unavailable");
  vi.mocked(workspaceAction).mockRejectedValue(null);
  await act(async () => button("Refresh").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("null");
});
