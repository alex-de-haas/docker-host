import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useExecutionTargets } from "../src/app/shell/execution-targets";
import type { CoreApp } from "../src/app/shell/types";
import { CoreEventNames, subscribeToCoreEvents } from "../src/app/shell/events/core-event-stream";
import { coreWorkspaceSource, useWorkspaceSources } from "../src/app/shell/workspace-sources";

const transport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
// Exercise the real shared stream's synchronization queue, rather than mocking onSync delivery.
class Source extends EventTarget {
  static OPEN = 1; static CLOSED = 2;
  static instances: Source[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { super(); Source.instances.push(this); }
  open() { this.readyState = Source.OPEN; this.onopen?.(); this.dispatchEvent(new MessageEvent("stream.ready", { data: JSON.stringify({ ...(this.url.includes("workspaces") ? { workspaces: 1 } : {}), ...(this.url.includes("resources") ? { resources: 1 } : {}) }) })); }
  emit(name: string) { this.dispatchEvent(new MessageEvent(name, { data: "{}" })); }
  close() { this.readyState = Source.CLOSED; }
}
const app = { id: "notes", selectedRuntime: "dev", sourceLivePath: "/unchanged/worktree" } as CoreApp;
const response = (name: string) => Response.json({ apps: [{ appId: app.id, packageRuntime: "docker", choices: [],
  current: { kind: "workspace", workspaceId: "workspace", worktreeId: "tree", name } }] });
function Probe() { const targets = useExecutionTargets("https://rename-stream.test", [app], true); return <>{targets[0]?.current.name}</>; }
let root: Root, container: HTMLDivElement, mounted: boolean;
let disposers: (() => void)[];
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("EventSource", Source);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Source.instances = []; disposers = []; transport.read.mockReset().mockImplementation(async () => response("Small fix"));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); disposers.forEach(dispose => dispose()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount() {
  await act(async () => root.render(<Probe />));
  await act(async () => Source.instances.at(-1)!.open());
  return Source.instances.at(-1)!;
}
it("coalesces rename events received during an old inventory read into one followup without changing source", async () => {
  const stream = await mount();
  expect(stream.url).toContain("topics=workspaces");
  const baseline = transport.read.mock.calls.length;
  let finishOld!: (response: Response) => void;
  transport.read.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(response("Simplify runtime selection"));
  await act(async () => { stream.emit("app.changed"); await vi.advanceTimersByTimeAsync(300); });
  expect(transport.read).toHaveBeenCalledTimes(baseline + 1);
  await act(async () => {
    stream.emit("workspace.changed"); stream.emit("workspace.changed"); stream.emit("workspace.changed");
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(transport.read).toHaveBeenCalledTimes(baseline + 1);
  await act(async () => finishOld(response("Small fix")));
  expect(transport.read).toHaveBeenCalledTimes(baseline + 2);
  expect(container.textContent).toBe("Simplify runtime selection");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(transport.read).toHaveBeenCalledTimes(baseline + 2);
});
it("aborts cleanup and suppresses the queued rename reread when its consumer unmounts", async () => {
  const stream = await mount();
  const baseline = transport.read.mock.calls.length;
  let finishOld!: (response: Response) => void;
  transport.read.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }));
  await act(async () => { stream.emit("app.changed"); await vi.advanceTimersByTimeAsync(300); });
  const signal = transport.read.mock.calls.at(-1)![1].signal as AbortSignal;
  await act(async () => { stream.emit("workspace.changed"); await vi.advanceTimersByTimeAsync(300); });
  await act(async () => { root.unmount(); mounted = false; });
  expect(signal.aborted).toBe(true); expect(stream.readyState).toBe(Source.CLOSED);
  await act(async () => finishOld(response("Old name")));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(transport.read).toHaveBeenCalledTimes(baseline + 1);
});

function WorkspaceSourceProbe() {
  useWorkspaceSources("https://rename-stream.test", [{ ...app, runtimeProfiles: [{ key: "dev", type: "localCommand", development: true }] } as CoreApp], true);
  return null;
}
const coreLaunch = { mode: "dev", projectPath: "/work/core/apps/core/Core.csproj" };
function CoreSourceProbe() {
  const workspaces = useWorkspaceSources("https://rename-stream.test", [], true, coreLaunch);
  return <>{coreWorkspaceSource(coreLaunch, workspaces)?.label}</>;
}
const coreResponse = (name: string) => Response.json({ workspaces: [{ id: "workspace", name, state: "active", owner: { label: "Core changes" },
  worktrees: [{ id: "tree", path: "/work/core", state: "active", branch: "hosty/session/id", apps: [] }] }] });
it("updates the Core-only workspace name through the shared workspace stream", async () => {
  transport.read.mockImplementation(async () => coreResponse("Small Core fix"));
  await act(async () => root.render(<CoreSourceProbe />));
  const stream = Source.instances.at(-1)!;
  await act(async () => stream.open());
  expect(container.textContent).toBe("Small Core fix");
  const baseline = transport.read.mock.calls.length;
  transport.read.mockImplementation(async () => coreResponse("Simplify Core source display"));
  await act(async () => { stream.emit("workspace.changed"); await vi.advanceTimersByTimeAsync(300); });
  expect(container.textContent).toBe("Simplify Core source display");
  expect(transport.read).toHaveBeenCalledTimes(baseline + 1);
  expect(transport.read.mock.calls.every(([url]) => url.endsWith("/activation-workspaces"))).toBe(true);
});
for (const inventory of ["execution targets", "workspace sources", "Core workspace source"] as const) {
  it(`keeps notifications and resource delivery when ${inventory} metadata is forbidden`, async () => {
    transport.read.mockResolvedValue(new Response(null, { status: 403 }));
    const notification = vi.fn(), resource = vi.fn();
    disposers.push(subscribeToCoreEvents("https://rename-stream.test", { names: [CoreEventNames.notification], onSync: vi.fn(), onEvent: notification }));
    disposers.push(subscribeToCoreEvents("https://rename-stream.test", { names: [CoreEventNames.resourcesSample], topic: "resources", onSync: vi.fn(), onEvent: resource }));
    await act(async () => root.render(inventory === "execution targets" ? <Probe /> : inventory === "workspace sources" ? <WorkspaceSourceProbe /> : <CoreSourceProbe />));
    expect(Source.instances.some(source => source.url.includes("workspaces"))).toBe(false);
    const stream = Source.instances.at(-1)!;
    await act(async () => stream.open());
    expect(stream.url).toContain("topics=resources");
    stream.emit("notification"); stream.emit("resources.sample");
    expect(notification).toHaveBeenCalledTimes(1); expect(resource).toHaveBeenCalledTimes(1);
    expect(stream.readyState).toBe(Source.OPEN);
  });
  it(`drops revoked ${inventory} interest without stranding the shared resource and notification stream`, async () => {
    transport.read.mockImplementation(async () => inventory === "execution targets" ? response("Small fix") : inventory === "workspace sources" ? Response.json({ workspaces: [] }) : coreResponse("Small Core fix"));
    const notification = vi.fn(), resource = vi.fn();
    disposers.push(subscribeToCoreEvents("https://rename-stream.test", { names: [CoreEventNames.notification], onSync: vi.fn(), onEvent: notification }));
    disposers.push(subscribeToCoreEvents("https://rename-stream.test", { names: [CoreEventNames.resourcesSample], topic: "resources", onSync: vi.fn(), onEvent: resource }));
    await act(async () => root.render(inventory === "execution targets" ? <Probe /> : inventory === "workspace sources" ? <WorkspaceSourceProbe /> : <CoreSourceProbe />));
    const workspaceStream = Source.instances.at(-1)!;
    expect(workspaceStream.url).toContain("topics=resources,workspaces");
    await act(async () => workspaceStream.open());
    transport.read.mockResolvedValue(new Response(null, { status: 403 }));
    await act(async () => { workspaceStream.readyState = Source.CLOSED; workspaceStream.onerror?.(); });
    const ordinaryStream = Source.instances.at(-1)!;
    expect(workspaceStream.readyState).toBe(Source.CLOSED);
    expect(ordinaryStream).not.toBe(workspaceStream);
    expect(ordinaryStream.url).toContain("topics=resources");
    expect(ordinaryStream.url).not.toContain("workspaces");
    await act(async () => ordinaryStream.open());
    expect(Source.instances.at(-1)).toBe(ordinaryStream);
    ordinaryStream.emit("notification"); ordinaryStream.emit("resources.sample");
    expect(notification).toHaveBeenCalledTimes(1); expect(resource).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(Source.instances.at(-1)).toBe(ordinaryStream);
    // Removing the optional consumer during onerror must not leave a stale retry timer
    // that blocks recovery if the replacement ordinary connection also fails.
    await act(async () => { ordinaryStream.readyState = Source.CLOSED; ordinaryStream.onerror?.(); });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(Source.instances.at(-1)).not.toBe(ordinaryStream);
    expect(Source.instances.at(-1)!.url).not.toContain("workspaces");
  });
}
