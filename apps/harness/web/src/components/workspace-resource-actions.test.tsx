// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceResourceActions } from "./workspace-resource-actions";
import { DevelopmentRequestError, developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
const render = async (state = "running", canStart = true, kind: "environments" | "sandboxes" = "environments") => act(async () => root.render(<WorkspaceResourceActions workspaceId="work" kind={kind} resource={{ id: "child", state, revision: 4 }} label="QA" canStart={canStart} disabled={false} refresh={() => {}} />));
it("keeps stop distinct from destructive deletion and requires confirmation for Finish", async () => {
  await render(); vi.mocked(developmentRequest).mockImplementation(async (_path, body) => ({ operations: [{ id: body?.requestId, state: "succeeded" }] }) as never);
  await act(async () => button("Stop sandbox").click()); expect(developmentRequest).toHaveBeenCalledWith("/work/environments/child/stop", expect.objectContaining({ expectedRevision: 4 }));
  await act(async () => button("Delete sandbox…").click()); expect(developmentRequest).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Workspace source files, commits and ordinary application data are preserved");
  await act(async () => button("Delete sandbox").click()); expect(developmentRequest).toHaveBeenLastCalledWith("/work/environments/child/finish", expect.any(Object));
});
it("keeps a lost deletion response and its revision across remount", async () => {
  await render(); await act(async () => button("Delete sandbox…").click()); vi.mocked(developmentRequest).mockRejectedValue(new Error("Disconnected"));
  await act(async () => button("Delete sandbox").click()); const first = vi.mocked(developmentRequest).mock.calls[0];
  await act(async () => root.unmount()); root = createRoot(container); await render("cleanup-failed");
  await act(async () => button("Retry sandbox action").click()); expect(vi.mocked(developmentRequest).mock.calls[1]).toEqual(first);
});
it("blocks starts after workspace closure but still allows disposal and stale revision requires renewed confirmation", async () => {
  await render("stopped", false, "sandboxes"); expect(button("Start sandbox").disabled).toBe(true);
  expect(container.textContent).toContain("Test data is retained");
  await act(async () => button("Delete sandbox…").click());
  vi.mocked(developmentRequest).mockRejectedValue(new DevelopmentRequestError("Refresh revision", "sandbox_revision_conflict"));
  await act(async () => button("Delete sandbox").click());
  expect(developmentRequest).toHaveBeenCalledWith("/work/sandboxes/child/dispose", expect.any(Object));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button("Delete sandbox…")).toBeDefined();
});
