// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
import { WorkspaceSessions } from "./workspace-sessions";
import { useTaskExecutionSummary, type TaskExecutionSummary } from "@/lib/task-execution-api";
vi.mock("@/lib/task-execution-api", () => ({ useTaskExecutionSummary: vi.fn() }));
import { AssistantApiError, createWorkspaceSession, listSessions, workspaceAction, type AssistantSession } from "@/lib/assistant-api";
import { type DevelopmentWorkspace } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(), createWorkspaceSession: vi.fn(), listSessions: vi.fn(), workspaceAction: vi.fn() }));
let root: Root, container: HTMLDivElement;
const workspace = (): DevelopmentWorkspace => ({ id: "workspace", state: "active", owner: { kind: "assistant", label: "Assistant", reference: "first" }, workflow: { state: "in-progress", revision: 0 }, worktrees: [], participation: {
  id: "workspace", revision: 4, role: "contributor", viewerUserId: "member", eligibleUsers: [],
  members: [{ userId: "owner", name: "Owner", role: "owner", worktreeIds: [], revoked: false }, { userId: "member", name: "Member", role: "contributor", worktreeIds: [], revoked: false }],
  sessions: [{ appId: "assistant", userId: "owner", sessionId: "first", title: "Private owner chat", attached: true, canOpen: false, viewerPath: null, status: "running", activityAt: null },
    { appId: "assistant", userId: "member", sessionId: "second", title: "My chat", attached: true, canOpen: true, viewerPath: "/assistant?session=second", status: "idle", activityAt: null }],
} });
function SessionList({ space, select, refresh = () => {} }: { space: DevelopmentWorkspace; select: (s: AssistantSession) => void; refresh?: () => void }) {
  const actions = useWorkspaceSessionActions(space, refresh, select);
  return <WorkspaceSessions workspace={space} refresh={refresh} actions={actions} onSelect={select} />;
}
const button = (text: string) => [...(document.querySelector('[role="dialog"]') ?? document).querySelectorAll("button")].find(b => b.textContent === text || b.getAttribute("aria-label") === text)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  vi.mocked(useTaskExecutionSummary).mockReturnValue({ summary: null, error: "" });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
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
  await act(async () => root.render(<SessionList space={workspace()} select={select} />));
  await act(async () => button("New session in workspace").click());
  const request = vi.mocked(createWorkspaceSession).mock.calls[0][0];
  expect(request).toMatchObject({ workspaceId: "workspace", expectedRevision: 4 }); expect(select).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await act(async () => root.render(<SessionList space={workspace()} select={select} />));
  vi.mocked(createWorkspaceSession).mockResolvedValueOnce({ id: "created" } as AssistantSession);
  await act(async () => button("Retry same request").click());
  expect(vi.mocked(createWorkspaceSession).mock.calls[1][0]).toEqual(request); expect(sessionStorage.length).toBe(0);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "created" }));
});
it("ignores a creation response after the user selected another workspace", async () => {
  let resolve!: (s: AssistantSession) => void;
  vi.mocked(createWorkspaceSession).mockReturnValue(new Promise(r => { resolve = r; }));
  const select = vi.fn(); const refresh = vi.fn();
  await act(async () => root.render(<SessionList space={workspace()} refresh={refresh} select={select} />));
  await act(async () => button("New session in workspace").click());
  const other = { ...workspace(), id: "different" };
  await act(async () => root.render(<SessionList space={other} refresh={refresh} select={select} />));
  await act(async () => resolve({ id: "created" } as AssistantSession));
  expect(select).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(button("New session in workspace").disabled).toBe(false);
});
it("refreshes stale membership instead of keeping an impossible detach retry", async () => {
  vi.mocked(workspaceAction).mockRejectedValueOnce(new AssistantApiError("workspace_revision_conflict", "Membership changed", 409));
  const refresh = vi.fn();
  await act(async () => root.render(<WorkspaceSessions workspace={workspace()} sessionId="second" refresh={refresh} />));
  await openSessionMenu("My chat");
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
  expect(refresh).toHaveBeenCalledOnce(); expect(button("Retry same request")).toBeUndefined(); expect(sessionStorage.length).toBe(0);
});

function Controls({ refresh }: { refresh: () => void }) {
  const space = workspace(); space.participation!.role = "owner";
  const actions = useWorkspaceSessionActions(space, refresh);
  return <>
    <button disabled={actions.busy || actions.retry} onClick={() => void actions.command("attach", {}, "bound")}>Attach candidate</button>
    <WorkspaceSessions workspace={space} sessionId="second" refresh={refresh} actions={actions} />
  </>;
}
it.each([
  new AssistantApiError("workspace_session_bound", "Already attached elsewhere", 409),
  new AssistantApiError("workspace_forbidden", "Access refused", 403),
])("clears a confirmed attach refusal and unlocks unrelated actions after reload", async failure => {
  const refresh = vi.fn(); vi.mocked(workspaceAction).mockRejectedValueOnce(failure);
  await act(async () => root.render(<Controls refresh={refresh} />));
  await act(async () => button("Attach candidate").click());
  expect(container.textContent).toContain(failure.message);
  expect(sessionStorage.length).toBe(0); expect(refresh).toHaveBeenCalledOnce();
  expect(button("Retry same request")).toBeUndefined();
  for (const name of ["Attach session", "Session actions for My chat", "New session in workspace"])
    expect(button(name).disabled).toBe(false);
  await act(async () => root.render(null));
  await act(async () => root.render(<Controls refresh={refresh} />));
  expect(button("Retry same request")).toBeUndefined(); expect(button("New session in workspace").disabled).toBe(false);
});
it("offers session association without a second per-workspace sharing permission", async () => {
  await act(async () => root.render(<Controls refresh={() => {}} />));
  expect(button("Manage sharing")).toBeUndefined();
  expect(button("Attach session").disabled).toBe(false);
  expect(button("Attach session")).toBeDefined();
  expect(container.textContent).toContain("Private chat");
});

it.each([
  new Error("Response lost"), new AssistantApiError("unavailable", "Core unavailable", 503),
  new AssistantApiError("timeout", "Request timed out", 408), new AssistantApiError("rate_limit", "Retry later", 429),
])("retains uncertain actions through reload and a later authorization refusal", async failure => {
  vi.mocked(createWorkspaceSession).mockRejectedValueOnce(failure);
  await act(async () => root.render(<SessionList space={workspace()} select={() => {}} />));
  await act(async () => button("New session in workspace").click());
  const original = vi.mocked(createWorkspaceSession).mock.calls[0][0];
  expect(sessionStorage.length).toBe(1);
  await act(async () => root.render(null));
  await act(async () => root.render(<SessionList space={workspace()} select={() => {}} />));
  vi.mocked(createWorkspaceSession).mockRejectedValueOnce(new AssistantApiError("forbidden", "Access changed", 403));
  await act(async () => button("Retry same request").click());
  expect(vi.mocked(createWorkspaceSession).mock.calls[1][0]).toEqual(original);
  expect(sessionStorage.length).toBe(1); expect(button("New session in workspace").disabled).toBe(true);
});
it("unlocks actions when a successful attach cannot refresh the conversation list", async () => {
  vi.mocked(workspaceAction).mockResolvedValueOnce({ workspace: { id: "workspace" } });
  vi.mocked(listSessions).mockRejectedValueOnce(new AssistantApiError("unavailable", "List unavailable", 503));
  const refresh = vi.fn();
  await act(async () => root.render(<Controls refresh={refresh} />));
  await act(async () => button("Attach candidate").click());
  expect(container.textContent).toContain("List unavailable"); expect(sessionStorage.length).toBe(0);
  expect(refresh).toHaveBeenCalledOnce(); expect(button("New session in workspace").disabled).toBe(false);
});

it("selects own sessions from the sidebar and highlights the current chat", async () => {
  const space = workspace(); space.owner = { kind: "external", label: "Codex", reference: "external-task" };
  const pick = vi.fn(), select = vi.fn(), refresh = vi.fn();
  space.participation!.sessions.push({ ...space.participation!.sessions[1], sessionId: "third", title: "Another chat" });
  await act(async () => root.render(<WorkspaceSessions workspace={space} sessionId="second" refresh={refresh} onPick={pick} onSelect={select} />));
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(button("Open session My chat").getAttribute("aria-current")).toBe("page");
  expect(button("Open session Private owner chat")).toBeUndefined();
  await act(async () => button("Open session Another chat").click());
  expect(pick).toHaveBeenCalledWith("third");
  vi.mocked(createWorkspaceSession).mockResolvedValue({ id: "new", status: "idle" } as AssistantSession);
  await act(async () => button("New session in workspace").click());
  expect(createWorkspaceSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: space.id, expectedRevision: 4 }));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ id: "new" }));
  expect(refresh).toHaveBeenCalledOnce();
});

async function openAttach() {
  await act(async () => button("Attach session").click());
}

async function chooseSession(title: string) {
  await act(async () => document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === title)!;
  await act(async () => option.click());
}
it("keeps empty session controls visible and explains owner names on focus", async () => {
  const space = workspace();
  space.participation!.sessions = space.participation!.sessions.map(session => ({ ...session, attached: false }));
  await act(async () => root.render(<WorkspaceSessions workspace={space} refresh={() => {}} />));
  expect(container.querySelector('[aria-label="Workspace sessions"]')).not.toBeNull();
  expect(container.textContent).toContain("No sessions.");
  expect(button("New session in workspace")).toBeDefined();
  space.participation!.sessions[0].attached = true;
  await act(async () => root.render(<WorkspaceSessions workspace={space} refresh={() => {}} />));
  expect(container.querySelector("h3")?.textContent).toBe("Sessions");
  expect(container.textContent).toContain("Private owner chat");
  expect(container.textContent).not.toContain("My chat");
  expect(button("Attach session")).toBeDefined();
  await act(async () => button("About workspace sessions").focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("profile used for that attempt");
});
it("attaches only idle unbound chats from the sidebar without creating a new session", async () => {
  const select = vi.fn(), refresh = vi.fn();
  const free = { id: "free", title: "Available chat", status: "idle", workspaceAssociation: null } as AssistantSession;
  vi.mocked(listSessions).mockResolvedValue([
    free, { ...free, id: "elsewhere", title: "Bound elsewhere", workspaceAssociation: { id: "other", revision: 1 } },
    { ...free, id: "second", title: "Current chat" },
    ...["running", "suggesting", "awaiting_approval", "awaiting_question"].map(status => ({ ...free, id: status, title: status, status })),
    ...["cancelled", "abandoned", "failed"].map(status => ({ ...free, id: status, title: status, status })),
  ]);
  vi.mocked(workspaceAction).mockResolvedValueOnce({ workspace: { id: "workspace" } });
  await act(async () => root.render(<SessionList space={workspace()} select={select} refresh={refresh} />));
  await openAttach();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect([...document.querySelectorAll('[role="option"]')].map(node => node.textContent)).toEqual(["Available chat", "cancelled", "abandoned", "failed"]);
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  await act(async () => button("Attach session").click());
  expect(workspaceAction).toHaveBeenCalledWith("free", "attach", expect.objectContaining({ workspaceId: "workspace", expectedRevision: 4 }));
  expect(createWorkspaceSession).not.toHaveBeenCalled();
  expect(select).toHaveBeenCalledWith(free); expect(refresh).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Attach session")));
});
it("keeps the exact uncertain attachment request after dismissing the modal", async () => {
  vi.mocked(listSessions).mockResolvedValue([{ id: "free", title: "Available chat", status: "idle" } as AssistantSession]);
  vi.mocked(workspaceAction).mockRejectedValueOnce(new Error("Response lost"));
  const select = vi.fn();
  await act(async () => root.render(<SessionList space={workspace()} select={select} />));
  await openAttach(); await chooseSession("Available chat");
  await act(async () => button("Attach session").click());
  const original = vi.mocked(workspaceAction).mock.calls[0];
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Response lost");
  await act(async () => button("Cancel").click());
  expect(button("New session in workspace").disabled).toBe(true);
  vi.mocked(workspaceAction).mockResolvedValueOnce({ workspace: { id: "workspace" } });
  await act(async () => button("Retry same request").click());
  expect(vi.mocked(workspaceAction).mock.calls[1]).toEqual(original);
  expect(button("New session in workspace").disabled).toBe(false);
});
it("discards an attachment picker when its workspace changes, including a late candidate response", async () => {
  let resolve!: (sessions: AssistantSession[]) => void;
  vi.mocked(listSessions).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  await act(async () => root.render(<SessionList space={workspace()} select={() => {}} />));
  await openAttach(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Loading sessions");
  await act(async () => root.render(<SessionList space={{ ...workspace(), id: "other" }} select={() => {}} />));
  await act(async () => resolve([{ id: "late", title: "Old candidate", status: "idle" } as AssistantSession]));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await openAttach();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No unattached idle sessions");
  expect(document.body.textContent).not.toContain("Old candidate");
});

async function openSessionMenu(title: string) {
  await act(async () => button(`Session actions for ${title}`).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
it("detaches the selected own session even when another chat is open", async () => {
  vi.mocked(workspaceAction).mockResolvedValueOnce({});
  const refresh = vi.fn();
  await act(async () => root.render(<WorkspaceSessions workspace={workspace()} sessionId="another" refresh={refresh} />));
  expect(button("Session actions for Private owner chat")).toBeUndefined();
  expect(button("Detach this session")).toBeUndefined();
  await openSessionMenu("My chat");
  const item = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(item.textContent).toBe("Detach session");
  await act(async () => item.click());
  expect(workspaceAction).toHaveBeenCalledWith("second", "detach", expect.objectContaining({ workspaceId: "workspace", expectedRevision: 4 }));
  expect(refresh).toHaveBeenCalledOnce();
});
it.each(["running", "waiting", "unknown", "current-running"])("blocks detachment while session activity is %s", async status => {
  const space = workspace();
  space.participation!.sessions[1].status = status === "current-running" ? "idle" : status;
  await act(async () => root.render(<WorkspaceSessions workspace={space} sessionId="second" running={status === "current-running"} refresh={() => {}} />));
  await openSessionMenu("My chat");
  expect(document.querySelector('[role="menuitem"]')?.getAttribute("aria-disabled")).toBe("true");
});

it("confirms deletion of the chosen own session and preserves the dialog on refusal", async () => {
  const remove = vi.fn().mockRejectedValueOnce(new Error("Reconcile session resources")).mockResolvedValueOnce(undefined);
  const refresh = vi.fn();
  await act(async () => root.render(<WorkspaceSessions workspace={workspace()} sessionId="another" refresh={refresh} onDelete={remove} />));
  await openSessionMenu("My chat");
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === "Delete session…")!;
  await act(async () => item.click());
  expect(remove).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("workspace files and other conversations are retained");
  await act(async () => button("Delete session").click());
  expect(remove).toHaveBeenCalledWith("second");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("Reconcile session resources");
  await act(async () => button("Delete session").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("cancels deletion without removing or detaching a session", async () => {
  const remove = vi.fn();
  await act(async () => root.render(<WorkspaceSessions workspace={workspace()} refresh={() => {}} onDelete={remove} />));
  await openSessionMenu("My chat");
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === "Delete session…")!.click());
  await act(async () => button("Keep session").click());
  expect(remove).not.toHaveBeenCalled();
  expect(workspaceAction).not.toHaveBeenCalled();
});

it("shows immutable executor labels separately from owners and keeps every retained attempt", async () => {
  const space = workspace();
  const row = { appId: "assistant", installationId: "installed", ownerId: "member", sessionId: "second", executionId: "first-attempt", title: "My chat", status: "completed", associationState: "attached" as const, historyPath: "/assistant?session=second", executor: { kind: "option" as const, name: "Backend developer at admission" } };
  const summary: TaskExecutionSummary = { revision: "one", nextCursor: null,
    roots: [{ taskRef: { id: "root" }, number: "HRN-1", title: "Build calculator", status: "Running", path: "/tasks?task=root" }],
    sessions: [row, { ...row, sessionId: "retry", executionId: "retry-attempt", associationState: "pending", title: "Retry analysis", historyPath: "/assistant?session=retry" },
      { ...row, sessionId: "adopted", executionId: "chat-attempt", executor: { kind: "none", name: "Chat configuration" }, title: "Original chat", associationState: "detached", historyPath: "/assistant?session=adopted" },
      { ...row, sessionId: "missing", executionId: "deleted-history", executor: { kind: "configuration", name: "One-off QA" }, title: "Review", associationState: "unavailable", historyPath: null }] };
  vi.mocked(useTaskExecutionSummary).mockReturnValue({ summary, error: "" });
  await act(async () => root.render(<WorkspaceSessions workspace={space} onPick={() => {}} refresh={() => {}} />));
  expect(button("Open session My chat").textContent).toBe("Backend developer at admissionMy chatMember · idle");
  expect(container.querySelector('[aria-label="Workspace root tasks"] a')?.getAttribute("href")).toBe("/tasks?task=root");
  expect(container.textContent?.match(/Backend developer at admission/g)).toHaveLength(2);
  expect(container.textContent).toContain("Retry analysis · pending");
  expect(container.textContent).toContain("No profileOriginal chat · detached");
  expect(container.textContent).toContain("Task-specific executorReview · unavailable");
  expect([...container.querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual(["/tasks?task=root", "/assistant?session=retry", "/assistant?session=adopted"]);
  expect(button("Open session Private owner chat")).toBeUndefined();
  expect(container.textContent).toContain("Owner · running");
});
