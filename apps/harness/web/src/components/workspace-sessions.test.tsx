// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceSessionTabs } from "./workspace-session-tabs";
import { useWorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
import { WorkspaceSessions } from "./workspace-sessions";
import { AssistantApiError, createWorkspaceSession, listSessions, workspaceAction, type AssistantSession } from "@/lib/assistant-api";
import { type DevelopmentWorkspace } from "@/lib/development-api";
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(), createWorkspaceSession: vi.fn(), listSessions: vi.fn(), workspaceAction: vi.fn() }));
let root: Root, container: HTMLDivElement;
const workspace = (): DevelopmentWorkspace => ({ id: "workspace", state: "active", owner: { kind: "assistant", label: "Assistant", reference: "first" }, workflow: { state: "in-progress", revision: 0 }, worktrees: [], participation: {
  id: "workspace", revision: 4, role: "contributor", viewerUserId: "member", eligibleUsers: [],
  members: [{ userId: "owner", name: "Owner", role: "owner", worktreeIds: [], revoked: false }, { userId: "member", name: "Member", role: "contributor", worktreeIds: [], revoked: false }],
  sessions: [{ appId: "assistant", userId: "owner", sessionId: "first", title: "Private owner chat", attached: true, canOpen: false, viewerPath: null, status: "running", activityAt: null },
    { appId: "assistant", userId: "member", sessionId: "second", title: "My chat", attached: true, canOpen: true, viewerPath: "/assistant?session=second", status: "idle", activityAt: null }],
} });
function Tabs({ space, select, refresh = () => {} }: { space: DevelopmentWorkspace; select: (s: AssistantSession) => void; refresh?: () => void }) {
  const actions = useWorkspaceSessionActions(space, refresh, select);
  return <WorkspaceSessionTabs workspace={space} sessions={[]} onPick={select} actions={actions} />;
}
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text || b.getAttribute("aria-label") === text)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("shows activity but cannot open another participant's conversation or manage sharing", async () => {
  const select = vi.fn(); vi.mocked(listSessions).mockResolvedValue([{ id: "second" } as AssistantSession]);
  await act(async () => root.render(<WorkspaceSessions workspace={workspace()} sessionId="second" refresh={() => {}} onSelect={select} />));
  expect(container.textContent).toContain("Owner · running");
  expect(container.textContent).toContain("Private chat"); expect(button("Private owner chat")).toBeUndefined(); expect(button("Manage sharing")).toBeUndefined();
  expect(button("My chat")).toBeUndefined(); expect(select).not.toHaveBeenCalled();
});
it("persists uncertain new-session requests and retries the exact ID after remount", async () => {
  const select = vi.fn(); vi.mocked(createWorkspaceSession).mockRejectedValueOnce(new Error("response lost"));
  await act(async () => root.render(<Tabs space={workspace()} select={select} />));
  await act(async () => button("New session in workspace").click());
  const request = vi.mocked(createWorkspaceSession).mock.calls[0][0];
  expect(request).toMatchObject({ workspaceId: "workspace", expectedRevision: 4 }); expect(select).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await act(async () => root.render(<Tabs space={workspace()} select={select} />));
  vi.mocked(createWorkspaceSession).mockResolvedValueOnce({ id: "created" } as AssistantSession);
  await act(async () => button("Retry same request").click());
  expect(vi.mocked(createWorkspaceSession).mock.calls[1][0]).toEqual(request); expect(sessionStorage.length).toBe(0);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "created" }));
});
it("ignores a creation response after the user selected another workspace", async () => {
  let resolve!: (s: AssistantSession) => void;
  vi.mocked(createWorkspaceSession).mockReturnValue(new Promise(r => { resolve = r; }));
  const select = vi.fn(); const refresh = vi.fn();
  await act(async () => root.render(<Tabs space={workspace()} refresh={refresh} select={select} />));
  await act(async () => button("New session in workspace").click());
  const other = { ...workspace(), id: "different" };
  await act(async () => root.render(<Tabs space={other} refresh={refresh} select={select} />));
  await act(async () => resolve({ id: "created" } as AssistantSession));
  expect(select).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(button("New session in workspace").disabled).toBe(false);
});
it("refreshes stale membership instead of keeping an impossible detach retry", async () => {
  vi.mocked(workspaceAction).mockRejectedValueOnce(new AssistantApiError("workspace_revision_conflict", "Membership changed", 409));
  const refresh = vi.fn();
  await act(async () => root.render(<WorkspaceSessions workspace={workspace()} sessionId="second" refresh={refresh} />));
  await act(async () => button("Detach this session").click());
  expect(refresh).toHaveBeenCalledOnce(); expect(button("Retry same request")).toBeUndefined(); expect(sessionStorage.length).toBe(0);
});
