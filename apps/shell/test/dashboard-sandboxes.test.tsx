import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardSandboxes } from "../src/app/shell/pages/dashboard-sandboxes";
import type { ActivationWorkspace } from "../src/app/shell/workspace-sources";

const transport = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ sendCsrfJson: transport.send }) }));

const origin = "https://core.test";
const childId = "1".repeat(32);
const workspaceId = "opaque-workspace-id-that-is-not-a-purpose";
const workspace: ActivationWorkspace = {
  id: workspaceId, name: "Improve playback", state: "active", owner: { label: "Playback work" }, worktrees: [],
};
const child = (value: Record<string, unknown> = {}) => ({
  id: childId, label: "Playback QA", state: "running", mode: "source", revision: 6, operations: [],
  previewUrl: "https://child.test", context: { workspaceId }, ...value,
});
let root: Root, container: HTMLDivElement;
let environments: ReturnType<typeof child>[];
let childFailure: Response | null;
let childApps: { state: string; apps: Record<string, unknown>[] };

const rows = () => [...container.querySelectorAll<HTMLElement>('article[aria-label^="Environment "]')];
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
  const toggle = button(`Environment Details for ${label}`, row(label));
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
}
async function refreshInventory() {
  await act(async () => {
    if (SandboxSource.latest.readyState !== 1) SandboxSource.latest.open();
    SandboxSource.latest.emit("sandbox.snapshot", null);
  });
}
async function render(workspaces = [workspace]) {
  await act(async () => root.render(<DashboardSandboxes coreOrigin={origin} connectedCore={<div data-testid="connected-core">Hosty Core</div>} workspaces={workspaces} />));
}
const appRequests = () => transport.read.mock.calls.filter(([url]) => /\/core-environments\/[^/]+\/apps$/.test(String(url)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("EventSource", SandboxSource);
  sessionStorage.clear();
  environments = []; childFailure = null;
  childApps = { state: "ready", apps: [{ id: "child.app", displayName: "Child application", runtimeState: "running", health: "healthy", previewUrl: "https://child.test/app" }] };
  transport.read.mockReset(); transport.send.mockReset();
  transport.read.mockImplementation(async (url: string) => {
    const path = new URL(String(url), origin).pathname;
    if (path === "/api/core-environments") return childFailure?.clone() ?? Response.json({ environments, consents: [] });
    if (/^\/api\/core-environments\/[^/]+\/apps$/.test(path)) return Response.json(childApps);
    if (path === `/api/core-environments/${childId}`) return Response.json(environments.find(item => item.id === childId) ?? child());
    throw new Error(`Unexpected read ${path}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();
});

it("keeps failed, cleanup-failed and stopped resources visible while excluding finished and disposed ones", async () => {
  environments = [child({ state: "failed", label: "Failed build" }), child({ id: "3".repeat(32), state: "cleanup-failed", label: "Cleanup needs retry" }),
    child({ id: "4".repeat(32), state: "stopped", label: "Stopped QA" }), child({ id: "5".repeat(32), state: "finished", label: "Finished QA" })];
  await render();
  expect(rows()).toHaveLength(3);
  for (const label of ["Failed build", "Cleanup needs retry", "Stopped QA"]) expect(row(label)).toBeDefined();
  expect(container.textContent).not.toContain("Finished QA");
  expect(container.textContent?.toLowerCase()).toContain("cleanup-failed");
  expect(container.textContent?.toLowerCase()).toContain("stopped");
  await expand("Stopped QA");
  expect(appRequests()).toHaveLength(0);
});

it("only offers credential-free HTTP preview links for a running child and its apps", async () => {
  environments = [child({ previewUrl: "javascript:alert(1)" })];
  childApps.apps.push({ id: "unsafe.app", displayName: "Unsafe application", runtimeState: "running", previewUrl: "https://user:secret@unsafe.test/app" });
  await render(); await expand("Playback QA");
  const hrefs = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(link => link.href);
  expect(hrefs).toContain("https://child.test/app");
  expect(hrefs.every(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; })).toBe(true);
  expect(hrefs.some(value => value.includes("unsafe.test"))).toBe(false);
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
  await refreshInventory();
  expect(coreReads).toBe(2);
  await click("Start", row("Playback QA"));
  expect(row("Playback QA").querySelector(".dashboard-sandbox-status")!.textContent?.toLowerCase()).toContain("running");
  await act(async () => resolveOld(Response.json({ environments: [child({ state: "stopped" })], consents: [] })));
  await vi.waitFor(() => expect(coreReads).toBe(3));
  // The newer read is deliberately unresolved: only the mutation receipt can supply this state.
  expect(row("Playback QA").querySelector(".dashboard-sandbox-status")!.textContent?.toLowerCase()).toContain("running");
  expect(row("Playback QA").querySelector(".dashboard-sandbox-status")!.textContent?.toLowerCase()).not.toContain("stopped");
  expect(sessionStorage.getItem(`hosty:core-environment:${origin}`)).toBeNull();
  await act(async () => resolveFresh(Response.json({ environments, consents: [] })));
  expect(row("Playback QA").querySelector(".dashboard-sandbox-status")!.textContent?.toLowerCase()).toContain("running");
});

it("does not expose an unavailable workspace ID as the sandbox's purpose", async () => {
  const unavailableId = "missing-private-workspace-id";
  environments = [child({ context: { workspaceId: unavailableId } })];
  await render();
  expect(row("Playback QA").textContent).not.toContain(unavailableId);
  expect(row("Playback QA").textContent).not.toContain("Improve playback");
});

it("updates the workspace name without closing Environment Details", async () => {
  environments = [child()];
  await render(); await expand("Playback QA");
  await render([{ ...workspace, name: "Playback fix verified" }]);
  expect(row("Playback QA").textContent).toContain("Playback fix verified");
  expect(row("Playback QA").textContent).not.toContain("Improve playback");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Environment Details");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Child application");
  expect(row("Playback QA").textContent).not.toContain("Child application");
});

it("closes Environment Details and restores focus to its row", async () => {
  environments = [child()];
  await render(); await expand("Playback QA");
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Environment Details");
  await click("Close", dialog);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Environment Details for Playback QA")));
});

it("retries an uncertain environment operation with its exact request", async () => {
  const requestId = "da08888a-6c32-423c-9a27-e37099a78224";

  const body = { requestId, expectedRevision: 6 };
  const pending = { path: `/${childId}/operations/start`, body, id: childId, kind: "start" };
  const key = `hosty:core-environment:${origin}`;
  const url = `${origin}/api/core-environments/${childId}/operations/start`;
  environments = [child({ state: "stopped" })];
  sessionStorage.setItem(key, JSON.stringify(pending));
  transport.send.mockRejectedValueOnce(new TypeError("Network response was lost"));
  await render();
  expect(transport.send).not.toHaveBeenCalled();
  const confirmation = [...row("Playback QA").querySelectorAll('.dashboard-sandbox-status [role="status"]')].find(node => node.textContent?.includes("Needs confirmation"))!;
  expect(confirmation.classList.contains("text-warning-foreground")).toBe(true);
  expect(confirmation.querySelector('.animate-spin')).toBeNull();
  await click("Retry same request");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(pending);
  expect(container.textContent).toContain("Network response was lost");
  transport.send.mockResolvedValueOnce(Response.json(child({ operations: [{ id: requestId, kind: "start", state: "succeeded" }] })));
  await click("Retry same request");
  expect(transport.send.mock.calls.map(([endpoint, request]) => [endpoint, request])).toEqual([[url, body], [url, body]]);
  expect(sessionStorage.getItem(key)).toBeNull();
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
  const confirmation = [...row("Recovered QA").querySelectorAll('.dashboard-sandbox-status [role="status"]')].find(node => node.textContent?.includes("Needs confirmation"))!;
  expect(confirmation.classList.contains("text-warning-foreground")).toBe(true);
  expect(confirmation.querySelector('.animate-spin')).toBeNull();
  await click("Retry same request");
  expect(transport.send.mock.calls.map(([url, request]) => [url, request])).toEqual([[`${origin}/api/core-environments/from-workspace`, body]]);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(row("Recovered QA").textContent?.toLowerCase()).toContain("stopped");
});

it.each([
  ["start", "Starting"],
  ["finish", "Deleting"],
  ["restart", "Restarting"],
  ["create", "Creating"],
] as const)("shows %s progress below the affected environment status without a disabled retry", async (kind, progress) => {
  const requestId = "ec5ff5aa-d638-4658-9c18-4605060d74be";
  const body = { requestId, label: "Playback QA", expectedRevision: 6 };
  const pending = kind === "create" ? { path: "", body, kind }
    : { path: `/${childId}/operations/${kind}`, body, id: childId, kind };
  sessionStorage.setItem(`hosty:core-environment:${origin}`, JSON.stringify(pending));
  environments = kind === "create" ? [] : [child()];
  let resolve!: (response: Response) => void;
  transport.send.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  await render();
  await click("Retry same request");
  expect(row("Playback QA").querySelector(".dashboard-sandbox-status")?.textContent).toContain(`${progress}…`);
  expect(container.textContent).not.toContain("Retry same request");
  expect(container.textContent).not.toContain("operation is in progress");
  if (kind === "create") {
    environments = [child({ operations: [{ id: requestId, kind, state: "running" }] })];
    await refreshInventory();
    expect(rows()).toHaveLength(1);
    expect(row("Playback QA").querySelector(".dashboard-sandbox-status")?.textContent).toContain("Creating…");
  }
  await act(async () => resolve(Response.json(child({ operations: [{ id: requestId, kind, state: "succeeded" }] }))));
  expect(sessionStorage.getItem(`hosty:core-environment:${origin}`)).toBeNull();
});

it.each([
  ["building", "text-info-foreground", "loader-circle"],
  ["finishing", "text-info-foreground", "loader-circle"],
  ["cleanup-failed", "text-destructive-foreground", "circle-alert"],
  ["quota-exceeded", "text-warning-foreground", "triangle-alert"],
] as const)("gives a %s sandbox a labelled state shape while retaining its observed label", async (state, tone, icon) => {
  environments = [child({ state })]; await render();
  const badge = row("Playback QA").querySelector(".dashboard-sandbox-status")!;
  expect(badge.textContent?.toLowerCase()).toBe(state);
  expect(badge.querySelector(`.${tone}`)).not.toBeNull();
  expect(badge.querySelector(`.lucide-${icon}[aria-hidden="true"]`)).not.toBeNull();
  expect(transport.send).not.toHaveBeenCalled();
});


it("does not turn a first-read failure into empty while retrying and only confirms an empty success", async () => {
  childFailure = Response.json({ message: "Inventory offline" }, { status: 503 });
  await render();
  expect(container.textContent).toContain("Inventory offline");
  expect(container.querySelector('.hosty-empty-slots')).toBeNull();
  let resolve!: (value: Response) => void;
  transport.read.mockImplementation((url: string) => url.endsWith("/core-environments")
    ? new Promise<Response>(done => { resolve = done; }) : Promise.resolve(Response.json({ environments: [] })));
  await refreshInventory();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading environments…");
  expect(container.textContent).not.toContain("No sandboxes yet");
  await act(async () => resolve(Response.json({ environments: [] })));
  expect(container.textContent).not.toContain("Inventory offline");
  expect(container.querySelector('[data-testid="connected-core"]')).not.toBeNull();
  expect(button("Create environment").disabled).toBe(false);
});

it("retains confirmed inventory after a malformed refresh instead of reporting empty", async () => {
  environments = [child()]; await render();
  transport.read.mockResolvedValue(Response.json({}));
  await refreshInventory();
  expect(rows()).toHaveLength(1);
  expect(container.textContent).toContain("Core did not return the sandbox inventory");
  expect(container.textContent).not.toContain("No sandboxes yet");
  expect(transport.send).not.toHaveBeenCalled();
});

class SandboxSource extends EventTarget {
  static OPEN = 1; static CLOSED = 2; static latest: SandboxSource;
  readyState = 0; onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { super(); SandboxSource.latest = this; }
  close() { this.readyState = 2; }
  emit(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
  open() { this.readyState = 1; this.onopen?.(); this.emit("stream.ready", { sandboxes: 1 }); }
}
it("renders external sandbox changes directly and avoids idle inventory requests", async () => {
  vi.useFakeTimers(); vi.stubGlobal("EventSource", SandboxSource);
  try {
    await render();
    const initialReads = transport.read.mock.calls.length;
    await act(async () => { SandboxSource.latest.open(); SandboxSource.latest.emit("sandbox.snapshot", { environments: [child()],  }); });
    expect(rows()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(transport.read).toHaveBeenCalledTimes(initialReads);
    await act(async () => SandboxSource.latest.emit("sandbox.snapshot", { environments: [child({ state: "finished" })] }));
    expect(rows()).toHaveLength(0); expect(transport.read).toHaveBeenCalledTimes(initialReads);
  } finally { vi.useRealTimers(); }
});
it("does not let a late initial GET overwrite a newer streamed state", async () => {
  vi.stubGlobal("EventSource", SandboxSource);
  let resolve!: (response: Response) => void;
  transport.read.mockImplementation((url: string) => String(url).endsWith("core-environments")
    ? new Promise<Response>(done => { resolve = done; }) : Promise.resolve(Response.json({ environments: [] })));
  await render();
  await act(async () => { SandboxSource.latest.open(); SandboxSource.latest.emit("sandbox.snapshot", { environments: [child()] }); });
  await act(async () => resolve(Response.json({ environments: [] })));
  expect(rows()).toHaveLength(1);
});


it("keeps the connected Core first and creation above one environment list", async () => {
  environments = [child()]; await render();
  const section = container.querySelector('section[aria-label="Core instances"]')!;
  expect(section.textContent!.indexOf("Create environment")).toBeLessThan(section.textContent!.indexOf("Hosty Core"));
  expect(section.textContent!.indexOf("Hosty Core")).toBeLessThan(section.textContent!.indexOf("Playback QA"));
  expect(container.textContent).not.toContain("Refresh sandboxes");
  expect(transport.read.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/core-environments"]);
});
it("shows the observed child version for copied builds even with an attached app workspace", async () => {
  environments = [child({ mode: "current", coreVersion: "0.150.1" }), child({ id: "3".repeat(32), mode: "release", label: "Other version", coreVersion: "0.160.0" })];
  await render();
  expect(row("Playback QA").textContent).toContain("0.150.1");
  expect(row("Playback QA").textContent).not.toContain("Improve playback");
  expect(row("Other version").textContent).toContain("0.160.0");
});
it("keeps the connected Core available when there are no children or their read fails", async () => {
  await render(); expect(rows()).toHaveLength(0); expect(container.textContent).toContain("Hosty Core");
  childFailure = Response.json({ message: "Environment inventory unavailable" }, { status: 503 });
  await refreshInventory();
  expect(container.textContent).toContain("Hosty Core");
  expect(container.textContent).toContain("Environment inventory unavailable");
  childFailure = null; await click("Retry environments");
  expect(container.textContent).not.toContain("Environment inventory unavailable");
});
