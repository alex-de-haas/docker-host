// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalAppHandoff } from "./local-app-handoff";
import { workspaceAction } from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", () => ({ workspaceAction: vi.fn() }));
let root: Root, container: HTMLDivElement;
const status = { sourceHead: "b".repeat(40), targetHead: "a".repeat(40), sourceClean: true, targetClean: true, accepted: false, runtimeState: "stopped" };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); vi.mocked(workspaceAction).mockResolvedValue(status); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const render = (disabled = false) => act(async () => root.render(<LocalAppHandoff sessionId="session" appId="local.app" workspaceId="tree" disabled={disabled} refresh={() => {}} />));
it("reviews exact commits and recovers a lost response after remount with the same request", async () => {
  await render();
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Accept locally")!.click());
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("response lost"));
  await act(async () => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === "Accept locally")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const first = vi.mocked(workspaceAction).mock.calls.find(c => c[1] === "app-local-accept")!;
  expect(first[2]).toMatchObject({ expectedHead: status.sourceHead, expectedTargetHead: status.targetHead });
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.textContent).toContain("Pending acceptance");
  vi.mocked(workspaceAction).mockResolvedValueOnce({ ...status, accepted: true, targetHead: status.sourceHead, operation: { state: "succeeded" } });
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry local action")!.click());
  expect(vi.mocked(workspaceAction).mock.calls.at(-1)).toEqual(first);
  expect(localStorage.getItem("hosty.local-handoff.session.tree.local.app")).toBeNull();
  expect(container.textContent).toContain("Accepted in local main");
});
it("does not offer acceptance for dirty or running source and requires acceptance before use", async () => {
  vi.mocked(workspaceAction).mockResolvedValueOnce({ ...status, sourceClean: false }); await render();
  expect([...container.querySelectorAll("button")].filter(b => ["Accept locally", "Use locally"].includes(b.textContent!)).every(b => b.disabled)).toBe(true);
  expect(container.textContent).toContain("Nothing is committed automatically");
});
it("blocks both actions while an agent is active", async () => {
  await render(true);
  expect([...container.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
});
