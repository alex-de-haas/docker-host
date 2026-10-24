// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { developmentRequest } from "./development-api";
import { subscribeWorkspaceEvents } from "./workspace-events";
import { useWorkspaceApplications, workspaceApplicationIsCurrent, workspaceApplicationStatus, workspaceApplicationTargetLabel, type WorkspaceApplication } from "./workspace-applications";
vi.mock("./development-api", () => ({ developmentRequest: vi.fn() }));
vi.mock("./workspace-events", () => ({ subscribeWorkspaceEvents: vi.fn() }));

const application = (extra: Partial<WorkspaceApplication> = {}): WorkspaceApplication => ({ appId: "notes", name: "Notes", canSwitch: true, ...extra });
const choice = { kind: "workspace", workspaceId: "workspace-one", worktreeId: "tree-one", name: "Feature" };

describe("workspace application presentation", () => {
  it("labels authoritative workspace and package targets independently of lifecycle", () => {
    expect(workspaceApplicationTargetLabel(application({ current: choice, runtimeState: "stopped" }))).toBe("Workspace · Feature");
    expect(workspaceApplicationTargetLabel(application({ current: { kind: "package", runtime: "production-native" }, version: "1.2.3" }))).toBe("Package · 1.2.3 · production-native");
    expect(workspaceApplicationTargetLabel(application({ current: { kind: "package" } }))).toBe("Package");
    expect(workspaceApplicationTargetLabel(application({ current: { kind: "package", runtime: "custom" }, source: { path: "/old/source", branch: "old-branch" } }))).toBe("Package · custom");
  });

  it("describes legacy source without inferring a workspace or a package", () => {
    expect(workspaceApplicationTargetLabel(application({ current: { kind: "legacy", runtime: "dev" }, source: { branch: "feature/update", path: "/projects/source" } }))).toBe("Source · feature/update");
    expect(workspaceApplicationTargetLabel(application({ source: { path: "/projects/source/" } }))).toBe("Source · source");
    expect(workspaceApplicationTargetLabel(application({ source: { path: "C:\\projects\\source" } }))).toBe("Source · source");
    expect(workspaceApplicationTargetLabel(application({ current: { kind: "legacy" } }))).toBe("Target unavailable");
    expect(workspaceApplicationTargetLabel(application({ source: { branch: "feature" } }))).toBe("Source · feature");
    expect(workspaceApplicationTargetLabel(application({ version: "1.2.3", target: choice, source: { state: "unavailable" } }))).toBe("Target unavailable");
    expect(workspaceApplicationTargetLabel(application({ current: { kind: "workspace" } }))).toBe("Workspace · Name unavailable");
  });

  it("requires exact workspace and worktree identity for an already selected candidate", () => {
    expect(workspaceApplicationIsCurrent(application({ current: choice, target: choice }))).toBe(true);
    expect(workspaceApplicationIsCurrent(application({ current: choice, target: { ...choice, worktreeId: "tree-two" } }))).toBe(false);
    expect(workspaceApplicationIsCurrent(application({ current: choice, target: { ...choice, workspaceId: "workspace-two" } }))).toBe(false);
    expect(workspaceApplicationIsCurrent(application({ current: { ...choice, worktreeId: undefined }, target: { ...choice, worktreeId: undefined } }))).toBe(false);
    expect(workspaceApplicationIsCurrent(application({ current: { ...choice, workspaceId: undefined }, target: { ...choice, workspaceId: undefined } }))).toBe(false);
    expect(workspaceApplicationIsCurrent(application({ current: { kind: "package", name: "Feature" }, target: choice }))).toBe(false);
    expect(workspaceApplicationIsCurrent(application({ target: choice }))).toBe(false);
  });

  it("keeps lifecycle separate from update failure and composes known running health", () => {
    expect(workspaceApplicationStatus(application({ runtimeState: "running", operationStatus: "failed" }))).toEqual({ label: "Running", tone: "success", busy: false });
    expect(workspaceApplicationStatus(application({ runtimeState: "running", health: "degraded" }))).toEqual({ label: "Running · degraded", tone: "warning", busy: false });
    expect(workspaceApplicationStatus(application({ runtimeState: "running", health: "unhealthy" }))).toEqual({ label: "Running · unhealthy", tone: "destructive", busy: false });
    expect(workspaceApplicationStatus(application({ runtimeState: "running", health: "unknown" }))).toEqual({ label: "Running", tone: "success", busy: false });
    expect(workspaceApplicationStatus(application({ runtimeState: "stopping", health: "unhealthy", operationStatus: "updating" }))).toEqual({ label: "Stopping", tone: "info", busy: true });
    expect(workspaceApplicationStatus(application({ runtimeState: "stopped", operationStatus: "updating" }))).toEqual({ label: "Stopped", tone: "muted", busy: false });
    expect(workspaceApplicationStatus(application({ runtimeState: "failed" }))).toEqual({ label: "Failed", tone: "destructive", busy: false });
    expect(workspaceApplicationStatus(application())).toEqual({ label: "Unknown", tone: "warning", busy: false });
    expect(workspaceApplicationStatus(application({ runtimeState: "not-running" }))).toEqual({ label: "Unknown", tone: "warning", busy: false });
  });
});

type Subscription = { sync: () => Promise<void | boolean>; unavailable: () => void; dispose: ReturnType<typeof vi.fn> };
let root: Root, container: HTMLDivElement, latest: ReturnType<typeof useWorkspaceApplications>;
const subscriptions: Subscription[] = [];
function Probe({ id = "workspace-one", enabled = true }: { id?: string; enabled?: boolean }) {
  const observation = useWorkspaceApplications(id, enabled);
  useEffect(() => { latest = observation; }, [observation]);
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const render = (id = "workspace-one", enabled = true) => act(async () => root.render(<Probe id={id} enabled={enabled} />));
const sync = (index = subscriptions.length - 1) => act(async () => { await subscriptions[index].sync(); });

beforeEach(() => {
  vi.clearAllMocks(); subscriptions.length = 0; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(developmentRequest).mockResolvedValue({ apps: [application()] });
  vi.mocked(subscribeWorkspaceEvents).mockImplementation((_url, callback, unavailable) => {
    const dispose = vi.fn(); subscriptions.push({ sync: callback, unavailable, dispose }); return dispose;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("workspace application observations", () => {
  it("subscribes only when enabled and loads the requested workspace on stream synchronization", async () => {
    await render("workspace-one", false);
    expect(subscribeWorkspaceEvents).not.toHaveBeenCalled(); expect(developmentRequest).not.toHaveBeenCalled();
    expect(latest.applications).toEqual([]); expect(latest.loading).toBe(false);
    await render(); expect(latest.loading).toBe(true); expect(latest.applications).toEqual([]);
    expect(subscribeWorkspaceEvents).toHaveBeenCalledWith("/api/development-workspaces/events", expect.any(Function), expect.any(Function));
    await sync();
    expect(developmentRequest).toHaveBeenCalledWith("/workspace-one/applications", undefined, expect.any(AbortSignal));
    expect(latest.applications).toEqual([application()]); expect(latest.loading).toBe(false); expect(latest.error).toBe("");
  });

  it("hides the previous workspace immediately, aborts its read and ignores a late response", async () => {
    const old = deferred<{ apps: WorkspaceApplication[] }>();
    vi.mocked(developmentRequest).mockReturnValueOnce(old.promise);
    await render(); await act(async () => { void subscriptions[0].sync(); });
    const oldSignal = vi.mocked(developmentRequest).mock.calls[0][2]!;
    await render("workspace-two");
    expect(latest.applications).toEqual([]); expect(latest.loading).toBe(true);
    expect(oldSignal.aborted).toBe(true); expect(subscriptions[0].dispose).toHaveBeenCalledTimes(1);
    const fresh = application({ appId: "different", name: "Different" });
    vi.mocked(developmentRequest).mockResolvedValueOnce({ apps: [fresh] }); await sync();
    await act(async () => old.resolve({ apps: [application({ name: "Old workspace" })] }));
    expect(latest.applications).toEqual([fresh]); expect(latest.error).toBe("");
    await render("workspace-two", false);
    expect(latest.applications).toEqual([]); expect(latest.loading).toBe(false);
    expect(subscriptions[1].dispose).toHaveBeenCalledTimes(1);
  });

  it("does not expose a previous observation when the same workspace is reopened", async () => {
    await render(); await sync(); expect(latest.applications).toHaveLength(1);
    await render("workspace-one", false); expect(latest.applications).toEqual([]);
    await render(); expect(latest.applications).toEqual([]); expect(latest.loading).toBe(true);
    await sync(); expect(latest.applications).toEqual([application()]);
  });

  it("drops disconnected source and prevents an in-flight response from restoring it", async () => {
    await render(); await sync();
    const stale = deferred<{ apps: WorkspaceApplication[] }>();
    vi.mocked(developmentRequest).mockReturnValueOnce(stale.promise);
    await act(async () => { void subscriptions[0].sync(); });
    const signal = vi.mocked(developmentRequest).mock.calls[1][2]!;
    await act(async () => subscriptions[0].unavailable());
    expect(signal.aborted).toBe(true); expect(latest.applications).toEqual([]); expect(latest.loading).toBe(false);
    expect(latest.error).toContain("disconnected");
    await act(async () => stale.resolve({ apps: [application({ name: "Stale" })] }));
    expect(latest.applications).toEqual([]);
    vi.mocked(developmentRequest).mockResolvedValueOnce({ apps: [application({ name: "Resynchronized" })] }); await sync();
    expect(latest.applications[0].name).toBe("Resynchronized"); expect(latest.error).toBe("");
  });

  it.each([{ unexpected: [] }, { apps: null }, { apps: [{ appId: "notes", name: "Notes", canSwitch: "yes" }] }])(
    "clears stale status when Core returns an invalid snapshot %#", async invalid => {
      await render(); await sync();
      vi.mocked(developmentRequest).mockResolvedValueOnce(invalid);
      let result: void | boolean;
      await act(async () => { result = await subscriptions[0].sync(); });
      expect(result!).toBe(false); expect(latest.applications).toEqual([]); expect(latest.loading).toBe(false);
      expect(latest.error).toContain("invalid application snapshot");
    },
  );

  it("clears revoked observations, preserves the failure reason and recovers on a fresh authorized read", async () => {
    await render(); await sync();
    vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Workspace access revoked.")); await sync();
    await act(async () => subscriptions[0].unavailable());
    expect(latest.applications).toEqual([]); expect(latest.error).toBe("Workspace access revoked.");
    await sync(); expect(latest.applications).toEqual([application()]); expect(latest.error).toBe("");
  });

  it("keeps a verified frame available during background reads and applies the next response", async () => {
    await render(); await sync();
    const before = latest.applications;
    const next = deferred<{ apps: WorkspaceApplication[] }>();
    vi.mocked(developmentRequest).mockReturnValueOnce(next.promise);
    await act(async () => { void subscriptions[0].sync(); });
    expect(latest.applications).toBe(before); expect(latest.loading).toBe(false); expect(latest.error).toBe("");
    const updated = application({ runtimeState: "stopping" });
    await act(async () => next.resolve({ apps: [updated] }));
    expect(latest.applications).toEqual([updated]); expect(latest.loading).toBe(false);
  });

  it("treats a verified empty inventory as loaded while refreshing it", async () => {
    vi.mocked(developmentRequest).mockResolvedValueOnce({ apps: [] });
    await render(); await sync();
    const next = deferred<{ apps: WorkspaceApplication[] }>();
    vi.mocked(developmentRequest).mockReturnValueOnce(next.promise);
    await act(async () => { latest.refresh(); });
    expect(latest.applications).toEqual([]); expect(latest.loading).toBe(false);
    await act(async () => next.resolve({ apps: [application()] }));
    expect(latest.applications).toEqual([application()]); expect(latest.loading).toBe(false);
  });

  it("refreshes after an explicit action without polling or opening another event subscription", async () => {
    vi.useFakeTimers(); await render(); await sync();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(developmentRequest).toHaveBeenCalledTimes(1);
    vi.mocked(developmentRequest).mockResolvedValueOnce({ apps: [application({ runtimeState: "starting" })] });
    await act(async () => latest.refresh());
    expect(developmentRequest).toHaveBeenCalledTimes(2); expect(subscribeWorkspaceEvents).toHaveBeenCalledTimes(1);
    expect(latest.applications[0].runtimeState).toBe("starting");
  });
});
