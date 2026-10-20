import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardSandboxes } from "../src/app/shell/pages/dashboard-sandboxes";
import type { CoreApp } from "../src/app/shell/types";
import type { ActivationWorkspace } from "../src/app/shell/workspace-sources";

const transport = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ sendCsrfJson: transport.send }) }));

const origin = "https://core.test";
const childId = "1".repeat(32), instanceId = "2".repeat(32);
const workspaceId = "opaque-workspace-id-that-is-not-a-purpose";
const appId = "example.movie-studio";
const apps = [{ id: appId, displayName: "Movie Studio" }] as CoreApp[];
const workspace: ActivationWorkspace = {
  id: workspaceId, name: "Improve playback", state: "active", owner: { label: "Playback work" }, worktrees: [],
};
const child = (value: Record<string, unknown> = {}) => ({
  id: childId, label: "Playback QA", state: "running", mode: "release", revision: 6, operations: [],
  previewUrl: "https://child.test", context: { workspaceId }, ...value,
});
const instance = (value: Record<string, unknown> = {}) => ({
  id: instanceId, appId, state: "ready", revision: 7, operations: [], users: [],
  source: { kind: "worktree" }, previewUrl: "https://preview.test/app", ...value,
});
let root: Root, container: HTMLDivElement;
let environments: ReturnType<typeof child>[], instances: ReturnType<typeof instance>[];
let childFailure: Response | null, instanceFailure: Response | null;
let childApps: { state: string; apps: Record<string, unknown>[] };

const rows = () => [...container.querySelectorAll<HTMLElement>('article[aria-label^="Sandbox "]')];
function row(label: string) {
  const result = rows().find(item => item.getAttribute("aria-label")?.includes(label));
  expect(result, `Missing sandbox row ${label}`).toBeDefined();
  return result!;
}
function button(label: string, scope: ParentNode = container) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  expect(result, `Missing button ${label}`).toBeDefined();
  return result!;
}
async function click(label: string, scope: ParentNode = container) {
  await act(async () => button(label, scope).click());
}
async function expand(label: string) {
  const toggle = row(label).querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
}
async function render(workspaces = [workspace]) {
  await act(async () => root.render(<DashboardSandboxes coreOrigin={origin} apps={apps} workspaces={workspaces} />));
}
const appRequests = () => transport.read.mock.calls.filter(([url]) => /\/core-environments\/[^/]+\/apps$/.test(String(url)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  sessionStorage.clear();
  environments = []; instances = []; childFailure = null; instanceFailure = null;
  childApps = { state: "ready", apps: [{ id: "child.app", displayName: "Child application", runtimeState: "running", health: "healthy", previewUrl: "https://child.test/app" }] };
  transport.read.mockReset(); transport.send.mockReset();
  transport.read.mockImplementation(async (url: string) => {
    const path = new URL(String(url), origin).pathname;
    if (path === "/api/core-environments") return childFailure?.clone() ?? Response.json({ environments, consents: [] });
    if (path === "/api/sandbox-instances") return instanceFailure?.clone() ?? Response.json({ instances });
    if (/^\/api\/core-environments\/[^/]+\/apps$/.test(path)) return Response.json(childApps);
    if (path === `/api/core-environments/${childId}`) return Response.json(environments.find(item => item.id === childId) ?? child());
    if (path === `/api/sandbox-instances/${instanceId}`) return Response.json(instances.find(item => item.id === instanceId) ?? instance());
    throw new Error(`Unexpected read ${path}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();
});

it("hides the entire section after both inventories successfully report no sandboxes", async () => {
  await render();
  expect(container.textContent).toBe("");
  expect(transport.read.mock.calls.map(([url]) => new URL(String(url)).pathname).sort())
    .toEqual(["/api/core-environments", "/api/sandbox-instances"]);
});

it.each(["Core", "application", "both"])("shows %s sandboxes in one section with collapsed rows and no eager child app reads", async kind => {
  if (kind !== "application") environments = [child()];
  if (kind !== "Core") instances = [instance()];
  await render();
  expect(container.querySelectorAll('[role="region"][aria-label="Sandboxes"]')).toHaveLength(1);
  expect([...container.querySelectorAll("h2,h3")].filter(item => item.textContent === "Sandboxes")).toHaveLength(1);
  expect(rows()).toHaveLength(kind === "both" ? 2 : 1);
  expect([...container.querySelectorAll('button[aria-expanded]')].every(item => item.getAttribute("aria-expanded") === "false")).toBe(true);
  expect(appRequests()).toHaveLength(0);
  expect(container.textContent).not.toContain("Child application");
  if (kind !== "application") {
    await expand("Playback QA");
    expect(appRequests()).toHaveLength(1);
    expect(row("Playback QA").textContent).toContain("Child application");
    expect(row("Playback QA").textContent).toContain("healthy");
  }
});

it("uses workspace purposes, legacy owner labels and independent runs without opaque IDs", async () => {
  environments = [child(), child({ id: "3".repeat(32), label: "Legacy QA", context: { workspaceId: "legacy" } })];
  instances = [instance()];
  await render([workspace, { ...workspace, id: "legacy", name: undefined, owner: { label: "Fix the player" } }]);
  expect(row("Playback QA").textContent).toContain("Improve playback");
  expect(row("Legacy QA").textContent).toContain("Fix the player");
  expect(row("Movie Studio").textContent).toContain("Independent run");
  expect(container.textContent).not.toContain(workspaceId);
  expect(container.textContent).not.toContain(appId);
});

it("keeps failed, cleanup-failed and stopped resources visible while excluding finished and disposed ones", async () => {
  environments = [child({ state: "failed", label: "Failed build" }), child({ id: "3".repeat(32), state: "cleanup-failed", label: "Cleanup needs retry" }),
    child({ id: "4".repeat(32), state: "stopped", label: "Stopped QA" }), child({ id: "5".repeat(32), state: "finished", label: "Finished QA" })];
  instances = [instance({ state: "failed" }), instance({ id: "6".repeat(32), appId: "cleanup.app", state: "cleanup-failed" }),
    instance({ id: "7".repeat(32), appId: "stopped.app", state: "stopped" }), instance({ id: "8".repeat(32), appId: "disposed.app", state: "disposed" })];
  await render();
  expect(rows()).toHaveLength(6);
  for (const label of ["Failed build", "Cleanup needs retry", "Stopped QA", "Movie Studio", "cleanup.app", "stopped.app"]) expect(row(label)).toBeDefined();
  expect(container.textContent).not.toContain("Finished QA");
  expect(container.textContent).not.toContain("disposed.app");
  expect(container.textContent?.toLowerCase()).toContain("cleanup-failed");
  expect(container.textContent?.toLowerCase()).toContain("stopped");
  await expand("Stopped QA");
  expect(appRequests()).toHaveLength(0);
});

it("only offers credential-free HTTP preview links for a running child and its apps", async () => {
  environments = [child({ previewUrl: "javascript:alert(1)" })];
  instances = [instance({ previewUrl: "data:text/html,not-a-preview" })];
  childApps.apps.push({ id: "unsafe.app", displayName: "Unsafe application", runtimeState: "running", previewUrl: "https://user:secret@unsafe.test/app" });
  await render(); await expand("Playback QA"); await expand("Movie Studio");
  const hrefs = [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].map(link => link.href);
  expect(hrefs).toContain("https://child.test/app");
  expect(hrefs.every(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; })).toBe(true);
  expect(hrefs.some(value => value.includes("unsafe.test"))).toBe(false);
});

it.each(["Core", "application"])("keeps the other inventory when the %s inventory fails", async failed => {
  if (failed === "Core") { childFailure = Response.json({ message: "Core inventory unavailable" }, { status: 503 }); instances = [instance()]; }
  else { instanceFailure = Response.json({ message: "App inventory unavailable" }, { status: 503 }); environments = [child()]; }
  await render();
  expect(row(failed === "Core" ? "Movie Studio" : "Playback QA")).toBeDefined();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(failed === "Core" ? "Core inventory unavailable" : "App inventory unavailable");
});

it("retains both successful inventories and expanded details when a later refresh fails", async () => {
  environments = [child()]; instances = [instance()];
  await render(); await expand("Playback QA"); await expand("Movie Studio");
  childFailure = Response.json({ message: "Core refresh is temporarily unavailable" }, { status: 500 });
  instanceFailure = Response.json({ message: "Application refresh is temporarily unavailable" }, { status: 500 });
  await click("Refresh sandboxes");
  expect(rows()).toHaveLength(2);
  expect(row("Playback QA").querySelector('button[aria-expanded="true"]')).not.toBeNull();
  expect(row("Movie Studio").querySelector('button[aria-expanded="true"]')).not.toBeNull();
  expect(row("Playback QA").textContent).toContain("Child application");
  const errors = [...container.querySelectorAll('[role="alert"]')].map(item => item.textContent).join(" ");
  expect(errors).toContain("Core refresh is temporarily unavailable");
  expect(errors).toContain("Application refresh is temporarily unavailable");
});

it("does not let an overlapping old inventory undo a confirmed mutation while revalidation is pending", async () => {
  environments = [child({ state: "stopped" })];
  const originalRead = transport.read.getMockImplementation()!;
  let coreReads = 0;
  let resolveOld!: (response: Response) => void, resolveFresh!: (response: Response) => void;
  transport.read.mockImplementation(async (url: string) => {
    if (new URL(String(url), origin).pathname === "/api/core-environments") {
      coreReads++;
      if (coreReads === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
      if (coreReads === 3) return new Promise<Response>(resolve => { resolveFresh = resolve; });
    }
    return originalRead(url);
  });
  transport.send.mockImplementationOnce(async (_url: string, body: { requestId: string }) => {
    environments = [child({ state: "running", revision: 7, operations: [{ id: body.requestId, kind: "start", state: "succeeded" }] })];
    return Response.json(environments[0]);
  });
  await render(); await expand("Playback QA");
  await click("Refresh sandboxes");
  expect(coreReads).toBe(2);
  await click("Start", row("Playback QA"));
  expect(button("Hide details for Playback QA").textContent).toContain("running");
  await act(async () => resolveOld(Response.json({ environments: [child({ state: "stopped" })], consents: [] })));
  await vi.waitFor(() => expect(coreReads).toBe(3));
  // The newer read is deliberately unresolved: only the mutation receipt can supply this state.
  expect(button("Hide details for Playback QA").textContent).toContain("running");
  expect(button("Hide details for Playback QA").textContent).not.toContain("stopped");
  expect(sessionStorage.getItem(`hosty:core-environment:${origin}`)).toBeNull();
  await act(async () => resolveFresh(Response.json({ environments, consents: [] })));
  expect(button("Hide details for Playback QA").textContent).toContain("running");
});

it.each(["Core", "application"])("does not hide a forbidden %s inventory behind the other successful empty list", async kind => {
  const failure = Response.json({ message: "Sandbox inspection permission is required" }, { status: 403 });
  if (kind === "Core") childFailure = failure; else instanceFailure = failure;
  await render();
  expect(container.querySelector('[role="region"][aria-label="Sandboxes"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Sandbox inspection permission is required");
});

it("does not expose an unavailable workspace ID as the sandbox's purpose", async () => {
  const unavailableId = "missing-private-workspace-id";
  environments = [child({ context: { workspaceId: unavailableId } })];
  await render();
  expect(row("Playback QA").textContent).not.toContain(unavailableId);
  expect(row("Playback QA").textContent).not.toContain("Improve playback");
});

it("keeps Core and application sandboxes distinct when their IDs happen to match", async () => {
  environments = [child()]; instances = [instance({ id: childId })];
  await render();
  expect(rows()).toHaveLength(2);
  await expand("Playback QA");
  expect(row("Playback QA").querySelector('button[aria-expanded="true"]')).not.toBeNull();
  expect(row("Movie Studio").querySelector('button[aria-expanded="false"]')).not.toBeNull();
  await expand("Movie Studio");
  expect(rows().every(item => item.querySelector('button[aria-expanded="true"]'))).toBe(true);
});

it("updates the workspace name without resetting an expanded sandbox", async () => {
  environments = [child()];
  await render(); await expand("Playback QA");
  await render([{ ...workspace, name: "Playback fix verified" }]);
  expect(row("Playback QA").textContent).toContain("Playback fix verified");
  expect(row("Playback QA").textContent).not.toContain("Improve playback");
  expect(row("Playback QA").querySelector('button[aria-expanded="true"]')).not.toBeNull();
  expect(row("Playback QA").textContent).toContain("Child application");
});

it.each(["Core", "application"])("recovers the legacy %s journal and retries a network-unknown operation with its exact request", async kind => {
  const requestId = "da08888a-6c32-423c-9a27-e37099a78224";
  const isCore = kind === "Core";
  const body = { requestId, expectedRevision: isCore ? 6 : 7 };
  const pending = isCore ? { path: `/${childId}/operations/start`, body, id: childId, kind: "start" }
    : { id: instanceId, action: "start", ...body };
  const key = `hosty:${isCore ? "core-environment" : "sandbox-operation"}:${origin}`;
  const url = `${origin}/api/${isCore ? `core-environments/${childId}` : `sandbox-instances/${instanceId}`}/operations/start`;
  if (isCore) environments = [child({ state: "stopped" })]; else instances = [instance({ state: "stopped" })];
  sessionStorage.setItem(key, JSON.stringify(pending));
  transport.send.mockRejectedValueOnce(new TypeError("Network response was lost"));
  await render();
  expect(transport.send).not.toHaveBeenCalled();
  await click("Retry same request");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(pending);
  expect(container.textContent).toContain("Network response was lost");
  transport.send.mockResolvedValueOnce(Response.json(isCore
    ? child({ operations: [{ id: requestId, kind: "start", state: "succeeded" }] })
    : instance({ operations: [{ id: requestId, kind: "start", state: "succeeded" }] })));
  await click("Retry same request");
  expect(transport.send.mock.calls.map(([endpoint, request]) => [endpoint, request])).toEqual([[url, body], [url, body]]);
  expect(sessionStorage.getItem(key)).toBeNull();
});

it("retains the latest failed disposal request while cleanup is still disposing", async () => {
  const requestId = "d8b9c9a0-220a-41db-ae34-ccadf2f51377";
  const pending = { id: instanceId, action: "dispose", requestId, expectedRevision: 7 };
  const key = `hosty:sandbox-operation:${origin}`;
  instances = [instance({ state: "disposing", operations: [{ id: requestId, kind: "dispose", state: "failed", message: "Container cleanup needs recovery" }] })];
  sessionStorage.setItem(key, JSON.stringify(pending));
  await render();
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(pending);
  expect(container.textContent).toContain("Container cleanup needs recovery");
  expect(button("Retry same request").disabled).toBe(false);
  transport.send.mockImplementationOnce(async () => {
    instances = [instance({ state: "disposed", operations: [{ id: requestId, kind: "dispose", state: "succeeded" }] })];
    return Response.json(instances[0]);
  });
  await click("Retry same request");
  expect(transport.send.mock.calls.map(([url, body]) => [url, body])).toEqual([
    [`${origin}/api/sandbox-instances/${instanceId}/operations/dispose`, { requestId, expectedRevision: 7 }],
  ]);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(rows()).toHaveLength(0);
});

it("clears a recovered legacy workspace-create journal after the original request succeeds", async () => {
  const requestId = "fe77c909-034d-4a74-a910-aec70e2f3a75";
  const body = { requestId, label: "Recovered QA", workspaceId, worktreeIds: ["registered-worktree"] };
  const pending = { path: "/from-workspace", body, kind: "create" };
  const key = `hosty:core-environment:${origin}`;
  sessionStorage.setItem(key, JSON.stringify(pending));
  transport.send.mockImplementationOnce(async () => {
    environments = [child({ label: "Recovered QA", state: "stopped", operations: [{ id: requestId, kind: "create", state: "succeeded" }] })];
    return Response.json(environments[0]);
  });
  await render();
  expect(transport.send).not.toHaveBeenCalled();
  await click("Retry same request");
  expect(transport.send.mock.calls.map(([url, request]) => [url, request])).toEqual([[`${origin}/api/core-environments/from-workspace`, body]]);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(row("Recovered QA").textContent).toContain("stopped");
});

it("keeps Restart available to recover an unhealthy application sandbox", async () => {
  instances = [instance({ state: "unhealthy" })];
  await render(); await expand("Movie Studio");
  expect(button("Restart", row("Movie Studio")).disabled).toBe(false);
  transport.send.mockImplementationOnce(async (_url: string, body: { requestId: string }) => {
    instances = [instance({ operations: [{ id: body.requestId, kind: "restart", state: "succeeded" }] })];
    return Response.json(instances[0]);
  });
  await click("Restart", row("Movie Studio"));
  expect(transport.send.mock.calls[0][0]).toBe(`${origin}/api/sandbox-instances/${instanceId}/operations/restart`);
  expect(transport.send.mock.calls[0][1]).toMatchObject({ expectedRevision: 7 });
  expect(transport.send.mock.calls[0][1].requestId).toMatch(/^[\da-f-]{36}$/i);
});
