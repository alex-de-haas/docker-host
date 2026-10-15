// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoreEnvironmentPanel, type EnvironmentRequest } from "./sandbox-react";

let root: Root, container: HTMLDivElement;
const id = "a".repeat(32);
const item = { id, label: "QA", state: "running", mode: "current", revision: 2, operations: [], context: { workspaceId: "workspace" }, previewUrl: "http://core.test:3000" };
const workspace = { id: "workspace", worktrees: [{ id: "tree", label: "Demo source", state: "active" }] };
const storageKey = "sandbox-test";
function button(label: string) { return [...container.querySelectorAll("button")].find(b => b.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function render(request: EnvironmentRequest, scoped = false) {
  await act(async () => root.render(<CoreEnvironmentPanel request={request} storageKey={storageKey} workspace={scoped ? workspace : undefined} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("shows observed app status and authenticated preview, and requires confirmation before Finish", async () => {
  let finished = false;
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body) { finished = true; return { ...item, state: "finished" }; }
    return path.endsWith("/apps") ? { state: "ready", apps: [{ id: "demo", displayName: "Demo App", runtimeState: "running", health: "healthy", previewUrl: "http://core.test:3000/api/apps/demo/open" }] }
      : { environments: finished ? [] : [item] };
  });
  await render(request as EnvironmentRequest);
  expect(container.textContent).toContain("running · healthy");
  expect(container.querySelector('a[href$="/api/apps/demo/open"]')).not.toBeNull();
  await click("Delete sandbox");
  expect(request.mock.calls.filter(([, body]) => body)).toHaveLength(0);
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("Workspace source and shared folders are preserved");
  await click("Delete permanently");
  expect(request.mock.calls.filter(([, body]) => body)).toHaveLength(1);
  expect(request).toHaveBeenCalledWith(`/${id}/operations/finish`, expect.objectContaining({ expectedRevision: 2, requestId: expect.any(String) }));
  expect(container.textContent).toContain("Sandbox deleted");
  expect(container.querySelector("article")).toBeNull();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});
it("keeps an uncertain mutation across remount and retries the identical request", async () => {
  let fail = true;
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body) { if (fail) throw new TypeError("Network lost"); return { ...item, state: "stopped" }; }
    return path.endsWith("/apps") ? { state: "ready", apps: [] } : { environments: [item] };
  });
  await render(request as EnvironmentRequest); await click("Stop");
  const saved = JSON.parse(sessionStorage.getItem(storageKey)!);
  expect(saved.body.requestId).toBeTruthy();
  await act(async () => root.render(null)); await render(request as EnvironmentRequest);
  expect(button("Stop").disabled).toBe(true);
  fail = false; await click("Retry same request");
  const mutations = request.mock.calls.filter(([, body]) => body);
  expect(mutations).toHaveLength(2); expect(mutations[1]).toEqual(mutations[0]);
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});
it("creates the selected workspace environment before starting it with another replay identity", async () => {
  const request = vi.fn(async (path: string, body?: unknown) => body ? { ...item, state: path === "/from-workspace" ? "stopped" : "running" } : { environments: [] });
  await render(request as EnvironmentRequest, true); await click("Create sandbox");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const mutations = request.mock.calls.filter(([, body]) => body);
  expect(mutations).toHaveLength(2);
  expect(mutations[0][0]).toBe("/from-workspace");
  expect(mutations[0][1]).toMatchObject({ workspaceId: "workspace", worktreeIds: ["tree"] });
  expect(mutations[1][0]).toBe(`/${id}/operations/start`);
  expect((mutations[1][1] as { requestId: string }).requestId).not.toBe((mutations[0][1] as { requestId: string }).requestId);
});
it("does not present an unavailable child as healthy or expose unsupported preview schemes", async () => {
  const request = vi.fn(async (path: string) => path.endsWith("/apps") ? { state: "unavailable", apps: [], error: "Child unavailable" } : { environments: [{ ...item, previewUrl: "javascript:alert(1)" }] });
  await render(request as EnvironmentRequest);
  expect(container.textContent).toContain("Child unavailable"); expect(container.textContent).not.toContain("healthy");
  expect(container.querySelector("a")).toBeNull();
});
it("submits ordinary child setup credentials without persisting them in replay storage", async () => {
  const request = vi.fn(async (path: string, body?: unknown) => body ? { status: 200, body: { ready: true } } : path.endsWith("/apps") ? { state: "setup-required", apps: [] } : { environments: [item] });
  await render(request as EnvironmentRequest);
  const form = container.querySelector('form[aria-label="Sandbox administrator"]') as HTMLFormElement;
  for (const [name, value] of Object.entries({ displayName: "QA", email: "qa@example.test", password: "Synthetic-password-123" })) (form.elements.namedItem(name) as HTMLInputElement).value = value;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledWith(`/${id}/setup`, { displayName: "QA", email: "qa@example.test", password: "Synthetic-password-123" });
  expect(sessionStorage.length).toBe(0);
  expect((form.elements.namedItem("password") as HTMLInputElement).value).toBe("");
});
it("retains a failed Finish across refresh and reuses its original request after Docker recovers", async () => {
  let savedBody: Record<string, unknown> | undefined, failed = false, finished = false;
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body) {
      if (!savedBody) { savedBody = body as Record<string, unknown>; failed = true; return { ...item, state: "cleanup-failed", error: "Docker unavailable" }; }
      finished = true; return { ...item, state: "finished" };
    }
    return path.endsWith("/apps") ? { state: "ready", apps: [] } : { environments: finished ? [] : [{ ...item,
      state: failed ? "cleanup-failed" : "running", error: failed ? "Docker unavailable" : undefined,
      operations: failed ? [{ id: savedBody!.requestId, kind: "finish", state: "failed" }] : [] }] };
  });
  await render(request as EnvironmentRequest); await click("Delete sandbox"); await click("Delete permanently");
  expect(JSON.parse(sessionStorage.getItem(storageKey)!).body).toEqual(savedBody);
  await click("Refresh sandboxes");
  await act(async () => root.render(null)); await render(request as EnvironmentRequest);
  await click("Retry same request");
  const mutations = request.mock.calls.filter(([, body]) => body);
  expect(mutations).toHaveLength(2); expect(mutations[1]).toEqual(mutations[0]);
  expect(sessionStorage.getItem(storageKey)).toBeNull(); expect(container.textContent).toContain("Sandbox deleted");
});

it.each(["refresh", "remount"])("discards a superseded Finish replay on %s and permits a new deletion", async mode => {
  const oldRequestId = crypto.randomUUID(), newerRequestId = crypto.randomUUID();
  const original = { path: `/${id}/operations/finish`, body: { requestId: oldRequestId, expectedRevision: 2 }, id, kind: "finish" };
  sessionStorage.setItem(storageKey, JSON.stringify(original));
  let superseded = false, finished = false;
  const request = vi.fn(async (_path: string, body?: unknown) => {
    if (body) { finished = true; return { ...item, state: "finished" }; }
    return { environments: finished ? [] : [{ ...item, state: "cleanup-failed", revision: superseded ? 6 : 4,
      error: "Docker unavailable", operations: [
        { id: oldRequestId.replaceAll("-", ""), kind: "finish", state: "failed" },
        ...(superseded ? [{ id: newerRequestId, kind: "finish", state: "failed" }] : []),
      ] }] };
  });
  await render(request as EnvironmentRequest, true);
  expect(button("Retry same request")).toBeDefined();
  expect(button("Create sandbox").disabled).toBe(true);
  superseded = true;
  if (mode === "remount") { await act(async () => root.render(null)); await render(request as EnvironmentRequest, true); }
  else await click("Refresh sandboxes");

  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(button("Retry same request")).toBeUndefined();
  expect(button("Create sandbox").disabled).toBe(false);
  expect(button("Retry deletion").disabled).toBe(false);
  expect(container.textContent).not.toContain("A previous request needs confirmation");
  await click("Retry deletion"); await click("Delete permanently");
  const mutations = request.mock.calls.filter(([, body]) => body);
  expect(mutations).toHaveLength(1);
  expect(mutations[0][1]).toMatchObject({ expectedRevision: 6, requestId: expect.any(String) });
  const requestId = (mutations[0][1] as { requestId: string }).requestId;
  expect([oldRequestId, newerRequestId]).not.toContain(requestId);
  expect(container.textContent).toContain("Sandbox deleted");
});

it("can revoke saved consent after all sandboxes are finished without creating or deleting a child", async () => {
  let revoked = false;
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body) revoked = true;
    return { environments: [], consents: revoked ? [] : [{ id, appId: "qa.client", mode: "current", target: "/reviewed/core", state: "active" }] };
  });
  await render(request as EnvironmentRequest);
  expect(container.textContent).toContain("Saved launch permissions (1)");
  expect(container.textContent).toContain("Running children and their own accounts remain");
  await click("Revoke permission for qa.client");
  expect(request).toHaveBeenCalledWith(`/consents/${id}/revoke`, {});
  expect(container.textContent).not.toContain("Saved launch permissions");
});
