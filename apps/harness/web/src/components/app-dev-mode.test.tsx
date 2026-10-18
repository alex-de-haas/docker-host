// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppDevMode } from "./app-dev-mode";
import { AssistantApiError, workspaceAction } from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", async original => ({ ...await original<typeof import("@/lib/assistant-api")>(), workspaceAction: vi.fn() }));
let root: Root, container: HTMLDivElement;
const key = "hosty.dev-mode.session.example.app";
const status = { phase: "inactive", receipts: [], app: { system: false, selectedRuntime: "docker", runtimeState: "running", endpoints: [], runtimeProfiles: [{ key: "dev", type: "docker", development: true }] } };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); vi.mocked(workspaceAction).mockResolvedValue(status); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const render = () => act(async () => root.render(<AppDevMode sessionId="session" appId="example.app" worktreeId="tree" disabled={false} refresh={() => {}} />));
const click = (label: string) => act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === label)!.click());
async function enterReview() {
  await render();
  vi.mocked(workspaceAction).mockResolvedValueOnce({ planDigest: "review", changes: ["Live code on ordinary data"], outsideBackup: ["External data excluded"] });
  await click("Dev on ordinary data · dev");
}
it("retries an uncertain apply after remount with exactly the reviewed request", async () => {
  await enterReview();
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("response lost")); await click("Apply");
  const request = JSON.parse(localStorage.getItem(key)!);
  expect(request).toMatchObject({ action: "enter", worktreeId: "tree", planDigest: "review" });
  await act(async () => root.unmount()); root = createRoot(container); await render();
  vi.mocked(workspaceAction).mockResolvedValueOnce({ ...status, phase: "active", receipts: [{ requestId: request.requestId, state: "succeeded" }] });
  await click("Retry enter");
  const calls = vi.mocked(workspaceAction).mock.calls.filter(c => c[1] === "app-dev-apply");
  expect(calls[1]).toEqual(calls[0]); expect(localStorage.getItem(key)).toBeNull();
});
it("clears a definitively stale review so a fresh plan can be prepared", async () => {
  await enterReview();
  vi.mocked(workspaceAction).mockRejectedValueOnce(new AssistantApiError("dev_plan_changed", "Prepare again"));
  await click("Apply");
  expect(localStorage.getItem(key)).toBeNull(); expect(container.textContent).toContain("Prepare again");
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "Dev on ordinary data · dev")!.disabled).toBe(false);
});

it("clears a request superseded by another client's Return and permits a new entry", async () => {
  await enterReview();
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("response lost")); await click("Apply");
  const request = JSON.parse(localStorage.getItem(key)!);
  await act(async () => root.unmount()); root = createRoot(container); await render();
  vi.mocked(workspaceAction).mockResolvedValueOnce({ ...status, phase: "returned", receipts: [{ requestId: request.requestId, state: "superseded" }] });
  await click("Retry enter");
  expect(localStorage.getItem(key)).toBeNull();
  expect(container.textContent).toContain("Another operation superseded this request");
  await act(async () => root.render(<AppDevMode sessionId="session" appId="example.app" worktreeId="tree" observation="refreshed" disabled={false} refresh={() => {}} />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Another operation superseded this request");
  expect(container.textContent).not.toContain("Retry enter");
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "Dev on ordinary data · dev")!.disabled).toBe(false);
});
