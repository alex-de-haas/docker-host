// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceActivation } from "./workspace-activation";
import { developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
const apps = [{ appId: "notes", name: "Notes" }, { appId: "shell", name: "Shell" }];
const refresh = vi.fn();
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(developmentRequest).mockImplementation(async (_path, body) => ({ requestId: body?.requestId, state: "completed", apps: apps.map(app => ({ appId: app.appId, state: "completed" })) }) as never);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<WorkspaceActivation workspaceId="workspace" apps={apps} refresh={refresh} />));
it("switches associated apps with one action and returns directly to packages", async () => {
  await render();
  expect(container.querySelector("select, input[type=checkbox]")).toBeNull();
  expect(container.textContent).toContain("Notes · Shell");
  expect(container.textContent).not.toMatch(/previous|activation|Review selection/);
  await act(async () => button("Use this workspace").click());
  const request = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(request).toMatchObject({ kind: "workspace", requestId: expect.any(String) });
  expect(vi.mocked(developmentRequest).mock.calls[0][0]).toBe("/workspace/execution-target");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Return to package").click());
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toMatchObject({ kind: "package" });
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).not.toHaveProperty("acceptDataChanges");
});
it("retries partial failures with the original ID so Core skips completed apps", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ requestId: "same", state: "failed", apps: [{ appId: "notes", state: "completed" }, { appId: "shell", state: "failed", error: "Build failed" }] });
  await render(); await act(async () => button("Use this workspace").click());
  expect(container.textContent).toContain("Shell: Build failed");
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  await act(async () => button("Retry runtime switch").click());
  expect(vi.mocked(developmentRequest).mock.calls[1][1]).toEqual(original);
  expect(button("Retry runtime switch")).toBeUndefined();
});
it("recovers a retained request after response loss and remount", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await act(async () => button("Return to package").click());
  const original = vi.mocked(developmentRequest).mock.calls[0][1];
  await act(async () => root.unmount()); root = createRoot(container);
  vi.mocked(developmentRequest).mockResolvedValueOnce({ requestId: original!.requestId, state: "failed", apps: [] });
  await render();
  expect(vi.mocked(developmentRequest).mock.calls[1][0]).toBe(`/workspace/execution-target/${original!.requestId}`);
  await act(async () => button("Retry runtime switch").click());
  expect(vi.mocked(developmentRequest).mock.calls[2][1]).toEqual(original);
});
it("keeps package return available after a failed workspace activation", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", apps: [{ appId: "shell", state: "failed", error: "Manifest invalid" }] });
  await render(); await act(async () => button("Use this workspace").click());
  const original = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(button("Return to package").disabled).toBe(false);
  await act(async () => button("Return to package").click());
  const request = vi.mocked(developmentRequest).mock.calls[1][1]!;
  expect(request.kind).toBe("package"); expect(request.requestId).not.toBe(original.requestId);
});
it("starts a fresh group intent only after Core definitively superseded the old one", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ state: "failed", apps: [{ appId: "shell", state: "failed", code: "dev_selection_changed", error: "A newer selection owns this app." }] });
  await render(); await act(async () => button("Use this workspace").click());
  const first = vi.mocked(developmentRequest).mock.calls[0][1]!;
  expect(button("Retry runtime switch")).toBeUndefined();
  await act(async () => button("Use this workspace").click());
  const second = vi.mocked(developmentRequest).mock.calls[1][1]!;
  expect(second.requestId).not.toBe(first.requestId);
});
