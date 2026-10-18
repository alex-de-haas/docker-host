// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContinueBuilding, type BuildingApp } from "./continue-building";
import { newBuildingSession } from "@/lib/assistant-api";
import { developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/assistant-api", () => ({ newBuildingSession: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
const pick = vi.fn();
const session = { id: "old", title: "Unfinished feature", status: "idle", createdAt: "", appIds: ["notes"] };
const app: BuildingApp = { appId: "notes", name: "Notes", acceptedHead: "b".repeat(40), unavailable: null,
  work: [{ workspaceId: "w", worktreeId: "t", sessionId: "old", assistantId: "hosty.harness", owned: true,
    state: "deferred", head: "c".repeat(40), accepted: false, unavailable: null }] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); pick.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(developmentRequest).mockResolvedValue([app]);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const click = (text: string) => act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === text)!.click());
const open = async () => { await act(async () => root.render(<ContinueBuilding sessions={[session]} onPick={pick} />)); await click("Continue building"); };
it("shows outstanding work and opens its original session without mutating it", async () => {
  await open(); expect(document.body.textContent).toContain("deferred · Outstanding work");
  await click("Open existing session"); expect(pick).toHaveBeenCalledWith(session); expect(newBuildingSession).not.toHaveBeenCalled();
});
it("recovers the same new-session request after a lost response and remount", async () => {
  vi.mocked(newBuildingSession).mockRejectedValueOnce(new Error("response lost"));
  await open(); await click("New building session");
  const first = vi.mocked(newBuildingSession).mock.calls[0]![0];
  expect(first.expectedLocalHead).toBe(app.acceptedHead);
  await act(async () => root.unmount()); root = createRoot(container);
  await open(); vi.mocked(newBuildingSession).mockResolvedValueOnce({ ...session, id: "new" });
  await click("Retry new session"); expect(vi.mocked(newBuildingSession).mock.calls.at(-1)![0]).toEqual(first);
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
  expect(localStorage.getItem("hosty.building.pending.v1")).toBeNull();
});
it("blocks new work on a changed source while keeping existing sessions accessible", async () => {
  vi.mocked(developmentRequest).mockResolvedValue([{ ...app, unavailable: "Another source folder is selected." }]);
  await open();
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "New building session")!.disabled).toBe(true);
  await click("Open existing session"); expect(pick).toHaveBeenCalledWith(session);
});
it("lists canonical applications even after all their chats and worktrees were removed", async () => {
  vi.mocked(developmentRequest).mockResolvedValue([{ ...app, work: [] }]);
  await act(async () => root.render(<ContinueBuilding sessions={[]} onPick={pick} />)); await click("Continue building");
  expect(document.body.textContent).toContain("Notes");
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "New building session")!.disabled).toBe(false);
});
