import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { coreWorkspaceSource, workspaceSource, useWorkspaceSources, type ActivationWorkspace } from "../src/app/shell/workspace-sources";
import type { CoreApp } from "../src/app/shell/types";

const read = vi.hoisted(() => vi.fn());
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: read }));
const app = { id: "a", selectedRuntime: "dev", sourceLivePath: "/work/tree", runtimeProfiles: [{ key: "dev", development: true }, { key: "docker" }] } as CoreApp;
const workspace: ActivationWorkspace = { id: "w", owner: { label: "Layout" }, state: "active", worktrees: [
  { id: "t", path: "/work/tree", state: "active", branch: "main", apps: [{ appId: "a", subpath: "apps/a" }] },
] };
it("requires both a selected development runtime and an exact bound source path", () => {
  expect(workspaceSource(app, [workspace])).toEqual({ id: "w", label: "Layout" });
  expect(workspaceSource({ ...app, sourceLivePath: "/work/tree/apps/a/" }, [workspace])?.id).toBe("w");
  expect(workspaceSource({ ...app, selectedRuntime: "docker" }, [workspace])).toBeUndefined();
  expect(workspaceSource({ ...app, sourceLivePath: "/work/tree-other" }, [workspace])).toBeUndefined();
  expect(workspaceSource({ ...app, id: "unbound" }, [workspace])).toBeUndefined();
  expect(workspaceSource(app, [{ ...workspace, state: "released" }])).toBeUndefined();
  expect(workspaceSource(app, [workspace, { ...workspace, id: "ambiguous" }])).toBeUndefined();
});
let root: Root; let container: HTMLDivElement;
function Probe({ apps, enabled = true }: { apps: CoreApp[]; enabled?: boolean }) {
  const rows = useWorkspaceSources("https://core.test", apps, enabled);
  return <div>{apps.map(a => workspaceSource(a, rows)?.label).join(",")}</div>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); read.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("shares one request and ignores status-only app refreshes", async () => {
  read.mockResolvedValue(Response.json({ workspaces: [workspace] }));
  await act(async () => root.render(<Probe apps={[app, { ...app, id: "b" }]} />));
  expect(container.textContent).toBe("Layout,");
  await act(async () => root.render(<Probe apps={[{ ...app, runtimeState: "running" }, { ...app, id: "b" }]} />));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Probe apps={[app]} enabled={false} />));
  expect(container.textContent).toBe("");
});
it("does not display an old inventory after the source changes while its request is pending", async () => {
  let finish!: (response: Response) => void;
  read.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  await act(async () => root.render(<Probe apps={[app]} />));
  const signal = read.mock.calls[0][1].signal;
  read.mockResolvedValue(Response.json({ workspaces: [] }));
  await act(async () => root.render(<Probe apps={[{ ...app, sourceLivePath: "/another" }]} />));
  await act(async () => finish(Response.json({ workspaces: [workspace] })));
  expect(signal.aborted).toBe(true);
  expect(container.textContent).toBe("");
});

const coreLaunch = { mode: "dev", projectPath: "/work/tree/apps/core/Core.csproj" };
it("identifies the factual Core project without requiring a runtime-app binding", () => {
  const coreOnly = { ...workspace, name: "Runtime selector", worktrees: [{ ...workspace.worktrees[0], apps: [] }] };
  expect(coreWorkspaceSource(coreLaunch, [coreOnly])).toEqual({ id: "w", label: "Runtime selector" });
  expect(coreWorkspaceSource({ ...coreLaunch, mode: "release" }, [coreOnly])).toBeUndefined();
  expect(coreWorkspaceSource({ ...coreLaunch, mode: "unmanaged" }, [coreOnly])).toBeUndefined();
  expect(coreWorkspaceSource({ ...coreLaunch, projectPath: null }, [coreOnly])).toBeUndefined();
  expect(coreWorkspaceSource(coreLaunch, [])).toBeUndefined();
  expect(coreWorkspaceSource(coreLaunch, [{ ...coreOnly, state: "released" }])).toBeUndefined();
  expect(coreWorkspaceSource(coreLaunch, [{ ...coreOnly, worktrees: [{ ...coreOnly.worktrees[0], state: "removed" }] }])).toBeUndefined();
  expect(coreWorkspaceSource(coreLaunch, [coreOnly, { ...coreOnly, id: "another" }])).toBeUndefined();
});
it("does not mistake adjacent, relative or traversing Core project paths for the workspace", () => {
  for (const projectPath of ["/work/tree-other/Core.csproj", "work/tree/Core.csproj", "/work/tree/../other/Core.csproj"]) {
    expect(coreWorkspaceSource({ mode: "dev", projectPath }, [workspace])).toBeUndefined();
  }
  expect(coreWorkspaceSource(coreLaunch, [{ ...workspace, worktrees: [{ ...workspace.worktrees[0], path: "/work/tree/" }] }])?.id).toBe("w");
  expect(coreWorkspaceSource({ mode: "dev", projectPath: "C:\\WORK\\TREE\\apps\\Core.csproj" }, [
    { ...workspace, worktrees: [{ ...workspace.worktrees[0], path: "c:/work/tree/" }] },
  ])?.id).toBe("w");
});
function CoreProbe({ launch = coreLaunch, apps = [], enabled = true }: { launch?: typeof coreLaunch; apps?: CoreApp[]; enabled?: boolean }) {
  const rows = useWorkspaceSources("https://core.test", apps, enabled, launch);
  return <>{coreWorkspaceSource(launch, rows)?.label}|{apps.map(a => workspaceSource(a, rows)?.label).join(",")}</>;
}
it("shares Core and app metadata, loads Core alone and ignores process-only refreshes", async () => {
  read.mockImplementation(async () => Response.json({ workspaces: [{ ...workspace, name: "Runtime selector" }] }));
  await act(async () => root.render(<CoreProbe />));
  expect(container.textContent).toBe("Runtime selector|");
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<CoreProbe launch={{ ...coreLaunch }} />));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<CoreProbe apps={[app]} />));
  expect(container.textContent).toBe("Runtime selector|Runtime selector");
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<CoreProbe enabled={false} />));
  expect(container.textContent).toBe("|");
});
it("drops the old Core workspace immediately after its factual launch changes", async () => {
  read.mockResolvedValue(Response.json({ workspaces: [workspace] }));
  await act(async () => root.render(<CoreProbe />));
  expect(container.textContent).toBe("Layout|");
  read.mockImplementationOnce(() => new Promise<Response>(() => {}));
  await act(async () => root.render(<CoreProbe launch={{ mode: "dev", projectPath: "/another/Core.csproj" }} />));
  expect(container.textContent).toBe("|");
});

it("loads workspace names for sandbox rows even when Core and apps use packages", async () => {
  read.mockResolvedValue(Response.json({ workspaces: [{ ...workspace, name: "Database migration" }] }));
  function SandboxNames({ enabled = true }: { enabled?: boolean }) {
    const rows = useWorkspaceSources("https://core.test", [], enabled, { mode: "release", projectPath: null });
    return <div>{rows.map(row => row.name).join(",")}</div>;
  }
  await act(async () => root.render(<SandboxNames />));
  expect(container.textContent).toBe("Database migration");
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<SandboxNames enabled={false} />));
  expect(container.textContent).toBe("");
});
