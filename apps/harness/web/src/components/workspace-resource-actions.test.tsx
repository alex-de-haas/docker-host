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
const render = async (state = "running", canStart = true, kind: "environments" = "environments") => act(async () => root.render(<WorkspaceResourceActions workspaceId="work" kind={kind} resource={{ id: "child", state, revision: 4 }} label="QA" canStart={canStart} disabled={false} refresh={() => {}} />));
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
  await render("stopped", false); expect(button("Start sandbox").disabled).toBe(true);
  expect(container.textContent).toContain("Test data is retained");
  await act(async () => button("Delete sandbox…").click());
  vi.mocked(developmentRequest).mockRejectedValue(new DevelopmentRequestError("Refresh revision", "environment_revision_conflict"));
  await act(async () => button("Delete sandbox").click());
  expect(developmentRequest).toHaveBeenCalledWith("/work/environments/child/finish", expect.any(Object));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button("Delete sandbox…")).toBeDefined();
});

it.each(["environments"] as const)("retains the accepted %s deletion request after a failed operation", async kind => {
  await render("running", true, kind);
  await act(async () => button("Delete sandbox…").click());
  vi.mocked(developmentRequest).mockImplementation(async (_path, body) => ({ operations: [{ id: body?.requestId, state: "failed" }] }) as never);
  await act(async () => button("Delete sandbox").click());
  const first = vi.mocked(developmentRequest).mock.calls[0];
  await act(async () => button("Retry sandbox action").click());
  expect(vi.mocked(developmentRequest).mock.calls[1]).toEqual(first);
});


it("keeps compact sandbox deletion behind its menu and confirmation, then recovers the exact request", async () => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.scrollIntoView = vi.fn();
  const mount = () => act(async () => root.render(<WorkspaceResourceActions compact workspaceId="work" kind="environments" resource={{ id: "child", state: "running", revision: 4 }} label="QA" canStart disabled={false} refresh={() => {}} />));
  await mount();
  expect(developmentRequest).not.toHaveBeenCalled();
  await act(async () => container.querySelector('[aria-label="QA sandbox actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const entries = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(entries.map(item => item.textContent)).toEqual(["Stop sandbox", "Delete sandbox…"]);
  await act(async () => entries.find(item => item.textContent === "Delete sandbox…")!.click());
  expect(developmentRequest).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ordinary application data are preserved");
  vi.mocked(developmentRequest).mockRejectedValue(new Error("Response lost"));
  await act(async () => button("Delete sandbox").click());
  const original = vi.mocked(developmentRequest).mock.calls[0];
  expect(original).toEqual(["/work/environments/child/finish", { requestId: expect.any(String), expectedRevision: 4 }]);
  await act(async () => root.unmount()); root = createRoot(container); await mount();
  expect(container.querySelector('[aria-label="QA sandbox actions"]')).toBeNull();
  await act(async () => button("Retry sandbox action").click());
  expect(vi.mocked(developmentRequest).mock.calls[1]).toEqual(original);
});

it("shows stop progress without duplicating an admitted request or treating a lost reply as running", async () => {
  let rejectStop!: (cause: Error) => void;
  vi.mocked(developmentRequest).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStop = reject; }));
  await render();
  const stop = button("Stop sandbox");
  await act(async () => { stop.click(); stop.click(); });
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  const original = vi.mocked(developmentRequest).mock.calls[0];
  expect(original).toEqual(["/work/environments/child/stop", { requestId: expect.any(String), expectedRevision: 4 }]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Sandbox operation in progress…");
  expect(button("Retry sandbox action").disabled).toBe(true);
  await act(async () => rejectStop(new Error("Response lost")));
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.textContent).toContain("An action is unfinished or its response was lost.");
  expect(button("Retry sandbox action").disabled).toBe(false);
  vi.mocked(developmentRequest).mockImplementationOnce(async (_path, body) => ({ operations: [{ id: body?.requestId, state: "succeeded" }] }) as never);
  await act(async () => button("Retry sandbox action").click());
  expect(vi.mocked(developmentRequest).mock.calls[1]).toEqual(original);
});

it("keeps deletion progress inside its locked confirmation while preserving the original request", async () => {
  let completeDelete!: (value: unknown) => void;
  vi.mocked(developmentRequest).mockImplementationOnce(() => new Promise(resolve => { completeDelete = resolve; }));
  await render(); await act(async () => button("Delete sandbox…").click());
  const remove = button("Delete sandbox");
  await act(async () => { remove.click(); remove.click(); });
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  const original = vi.mocked(developmentRequest).mock.calls[0];
  expect(original).toEqual(["/work/environments/child/finish", { requestId: expect.any(String), expectedRevision: 4 }]);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("Sandbox operation in progress…");
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(button("Cancel").disabled).toBe(true);
  expect(button("Deleting…").disabled).toBe(true);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => completeDelete({ operations: [{ id: original[1]?.requestId, state: "succeeded" }] }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(localStorage.getItem("hosty.workspace.resource.work.environments.child")).toBeNull();
});
