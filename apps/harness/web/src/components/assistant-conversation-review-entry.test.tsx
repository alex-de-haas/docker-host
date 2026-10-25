// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantConversation } from "./assistant-conversation";
import type { ReviewChoice } from "./workspace-review";
import type { DevelopmentWorkspace, Worktree } from "@/lib/development-api";
import * as api from "@/lib/assistant-api";
const controls = vi.hoisted(() => ({ workspaces: [] as DevelopmentWorkspace[], loading: false, error: "", inventoryEnabled: [] as boolean[], events: [] as api.AssistantEvent[], capturedReviewAsk: undefined as ((reference: string) => void) | undefined, ui: { reportSurfaceState: vi.fn(), getNavigation: () => ({ entries: [] }), navigate: vi.fn() } }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => controls.ui }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(), getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(), listAppNames: vi.fn(), listAgentConnections: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn() }));
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), useDevelopmentInventory: (enabled: boolean) => { controls.inventoryEnabled.push(enabled); return { workspaces: controls.workspaces, loading: controls.loading, error: controls.error, refresh: vi.fn() }; } }));
vi.mock("./workspace-details", () => ({ WorkspaceDetails: ({ workspace, onReview }: { workspace: DevelopmentWorkspace; onReview: (tree: Worktree, choice?: ReviewChoice) => void }) => <div>
  <button onClick={() => onReview(workspace.worktrees[0], { view: `pr:${workspace.worktrees[0].pullRequests[0].url}`, path: "" })}>Review PR in {workspace.id}</button>
  <button onClick={() => onReview(workspace.worktrees[0])}>Resume review in {workspace.id}</button>
  <textarea aria-label={`Workspace draft ${workspace.id}`} defaultValue="workspace form" />
</div> }));
vi.mock("./workspace-review", () => ({ WorkspaceReview: ({ workspaceId, tree, choice, onChoice, onBack, onAsk }: { workspaceId: string; tree: Worktree; choice: ReviewChoice; onChoice: (value: ReviewChoice) => void; onBack: () => void; onAsk?: (reference: string) => void }) => { controls.capturedReviewAsk = onAsk; return <section aria-label="Mock workspace review">
  <p>{workspaceId} / {tree.id} / {choice.view} / {choice.path}</p>
  <button onClick={() => onChoice({ ...choice, path: "chosen.ts" })}>Choose review file</button>
  <button onClick={onBack}>Back to session</button>
  <button disabled={!onAsk} onClick={() => onAsk?.("Review reference")}>Ask from review</button>
</section>; } }));
vi.mock("./speech-input", () => ({ SpeechInput: () => null }));
vi.mock("./session-credentials", () => ({ SessionCredentials: () => null }));
vi.mock("./app-context-picker", () => ({ AppContextPicker: () => null }));
vi.mock("./ui/message-scroller", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...Object.fromEntries(["MessageScroller", "MessageScrollerProvider", "MessageScrollerViewport", "MessageScrollerContent", "MessageScrollerItem"].map(name => [name, Wrap])), MessageScrollerButton: () => null };
});
let root: Root, container: HTMLDivElement;
const button = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text)!;
function workspace(id: string, kind: "assistant" | "external"): DevelopmentWorkspace {
  return { id, name: id, state: "active", owner: { kind, appId: kind === "assistant" ? "hosty.harness" : undefined, reference: kind === "assistant" ? "session-one" : "external-task", label: kind }, workflow: { state: "in-progress", revision: 0 },
    worktrees: [{ id: `${id}-tree`, workspaceId: id, repository: `https://github.com/example/${id}`, branch: "feature", state: "active", apps: [], leases: [], pullRequests: [{ url: `https://github.com/example/${id}/pull/7` }] }] };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width: 1100px"), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const record = { id: "session-one", title: "Conversation", status: "idle", createdAt: "" };
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: true }); vi.mocked(api.listSessions).mockResolvedValue([record]);
  vi.mocked(api.getSession).mockResolvedValue(record); vi.mocked(api.createSession).mockResolvedValue(record); vi.mocked(api.listAppNames).mockResolvedValue({}); vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [], defaultId: null });
  controls.events = []; controls.loading = false; controls.error = ""; controls.inventoryEnabled = []; controls.capturedReviewAsk = undefined;
  vi.mocked(api.streamEvents).mockImplementation(async (_id, onEvent) => { controls.events.forEach(onEvent); });
  controls.workspaces = [workspace("session-workspace", "assistant"), workspace("external-workspace", "external")];
  localStorage.setItem("hosty.assistant.session", record.id); window.history.replaceState({}, "", "/development?session=session-one");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it.each([true, false])("retains drafts and returns Ask to the conversation from standalone review at wide=%s", async wide => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: wide && query.includes("min-width: 1100px"), addEventListener() {}, removeEventListener() {} }));
  await act(async () => root.render(<AssistantConversation fullPage />));
  const message = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  const form = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Workspace draft session-workspace"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Unsent message"); message.dispatchEvent(new Event("input", { bubbles: true })); });
  form.value = "Unsent workspace form";
  await act(async () => button("Review PR in session-workspace").click());
  const review = () => container.querySelector('[aria-label="Mock workspace review"]')!;
  expect(review().textContent).toContain("session-workspace / session-workspace-tree / pr:https://github.com/example/session-workspace/pull/7");
  expect(container.querySelector('textarea[aria-label="Message"]')).toBe(message); expect(message.value).toBe("Unsent message");
  expect(container.querySelector('textarea[aria-label="Workspace draft session-workspace"]')).toBe(form); expect(form.value).toBe("Unsent workspace form");
  await act(async () => button("Choose review file").click()); await act(async () => button("Back to session").click());
  await act(async () => button("Resume review in session-workspace").click()); expect(review().textContent).toContain("chosen.ts");
  await act(async () => button("Ask from review").click()); expect(message.value).toBe("Unsent message\n\nReview reference"); expect(api.postMessage).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Mock workspace review"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(message));
});
it("opens an external PR in its own workspace without enabling Ask in an unrelated session", async () => {
  await act(async () => root.render(<AssistantConversation fullPage />));
  await act(async () => button("external-workspace").click()); await act(async () => button("Review PR in external-workspace").click());
  expect(container.querySelector('[aria-label="Mock workspace review"]')?.textContent).toContain("external-workspace / external-workspace-tree / pr:https://github.com/example/external-workspace/pull/7");
  expect(button("Ask from review").disabled).toBe(true); expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => button("Back to session").click());
  expect(container.querySelector('[aria-label="Mock workspace review"]')).toBeNull();
  expect(container.querySelector('nav[aria-label="Workspaces and chats"] button[aria-current="page"]')?.textContent).toContain("external-workspace");
});

it("opens persisted transcript edits in their exact tree and session scope while retaining the prior PR choice and composer", async () => {
  controls.workspaces.push(workspace("second-repo", "assistant"));
  controls.events = [
    { seq: 1, ts: "", type: "tool_use", toolName: "Edit", input: { file_path: "src/index.ts" }, fileEdits: [{ path: "src/index.ts", kind: "edit", additions: 2, deletions: 1, review: { sessionId: "session-one", workspaceId: "session-workspace", worktreeId: "session-workspace-tree", repository: "https://github.com/example/session-workspace", path: "src/index.ts" } }] },
    { seq: 2, ts: "", type: "tool_use", toolName: "FileChange", fileEdits: [{ path: "src/index.ts", kind: "update", review: { sessionId: "session-one", workspaceId: "second-repo", worktreeId: "second-repo-tree", repository: "https://github.com/example/second-repo", path: "src/index.ts" } }] },
  ];
  await act(async () => root.render(<AssistantConversation fullPage />));
  const message = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Unsent message"); message.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("Review PR in session-workspace").click());
  await act(async () => button("Choose review file").click()); await act(async () => button("Back to session").click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="transcript-changes"] > button[aria-expanded="false"]')!.click());
  const links = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Review src/index.ts"]')];
  expect(links()).toHaveLength(2);
  await act(async () => links()[1].click());
  expect(container.querySelector('[aria-label="Mock workspace review"]')?.textContent).toContain("second-repo / second-repo-tree / session / src/index.ts");
  expect(container.querySelector('textarea[aria-label="Message"]')).toBe(message); expect(message.value).toBe("Unsent message");
  await act(async () => button("Back to session").click()); await act(async () => links()[0].click());
  expect(container.querySelector('[aria-label="Mock workspace review"]')?.textContent).toContain("session-workspace / session-workspace-tree / session / src/index.ts");
  await act(async () => button("Back to session").click()); await act(async () => button("Resume review in session-workspace").click());
  expect(container.querySelector('[aria-label="Mock workspace review"]')?.textContent).toContain("pr:https://github.com/example/session-workspace/pull/7 / chosen.ts");
  expect(message.value).toBe("Unsent message"); expect(api.postMessage).not.toHaveBeenCalled();
});
it("keeps legacy and foreign-session file entries readable without opening another workspace", async () => {
  controls.events = [
    { seq: 1, ts: "", type: "tool_use", toolName: "Edit", input: { file_path: "legacy.ts", old_string: "a", new_string: "b" } },
    { seq: 2, ts: "", type: "tool_use", toolName: "Edit", fileEdits: [{ path: "foreign.ts", review: { sessionId: "other-session", workspaceId: "session-workspace", worktreeId: "session-workspace-tree", repository: "https://github.com/example/session-workspace", path: "foreign.ts" } }] },
  ];
  await act(async () => root.render(<AssistantConversation fullPage />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="transcript-changes"] > button[aria-expanded="false"]')!.click());
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Review legacy.ts"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Review foreign.ts"]')?.disabled).toBe(true);
  expect(container.textContent).toContain("older transcript has no recorded source binding");
  expect(container.textContent).toContain("recorded workspace is unavailable in this session");
  expect(container.querySelector('[aria-label="Mock workspace review"]')).toBeNull();
});

it("does not append a late review completion reference after Shell opens another session", async () => {
  await act(async () => root.render(<AssistantConversation fullPage />));
  await act(async () => button("Review PR in session-workspace").click()); const lateAsk = controls.capturedReviewAsk!; expect(lateAsk).toBeDefined();
  vi.mocked(api.getSession).mockResolvedValue({ id: "session-two", title: "Other conversation", status: "idle", createdAt: "" });
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "hosty:open-assistant-session", sessionId: "session-two" } })));
  expect(container.querySelector('[aria-label="Mock workspace review"]')).toBeNull();
  const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Other conversation draft"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => lateAsk("Late old PR reference"));
  expect(field.value).toBe("Other conversation draft"); expect(api.postMessage).not.toHaveBeenCalled();
});

const composer = () => container.querySelector('form[aria-label="Message composer"]');
const messageField = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
const writeDraft = async (text: string) => {
  const field = messageField()!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
};
const blockedWorkflows = [
  { state: "completed", revision: 1 },
  { state: "deferred", revision: 1 },
  { state: "deleting", revision: 1 },
  { state: "deleted", revision: 1 },
  { state: "in-progress", closure: "closing", revision: 1 },
  { state: "in-progress", closure: "closed", revision: 1 },
];
it.each([true, false].flatMap(fullPage => blockedWorkflows.map(workflow => ({ fullPage, workflow }))))(
  "hides the composer for workspace $workflow.state/$workflow.closure in fullPage=$fullPage", async ({ fullPage, workflow }) => {
    controls.workspaces = [{ ...workspace("session-workspace", "assistant"), workflow }];
    await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
    expect(controls.inventoryEnabled).toContain(true);
    expect(composer()).toBeNull(); expect(messageField()).toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
  });
it.each([true, false])("retains an unsent draft while closed or disconnected, and restores it after verified Resume in fullPage=%s", async fullPage => {
  await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
  await writeDraft("Retained unsent draft");
  controls.workspaces = [{ ...workspace("session-workspace", "assistant"), workflow: { state: "completed", revision: 1 } }];
  await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
  expect(composer()).toBeNull();
  controls.workspaces = []; controls.error = "Workspace updates disconnected. Reconnecting…";
  await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
  expect(composer()).toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
  for (const workflow of [{ state: "unavailable", revision: 2 }, { revision: 3 } as DevelopmentWorkspace["workflow"]]) {
    controls.workspaces = [{ ...workspace("session-workspace", "assistant"), workflow }]; controls.error = "";
    await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
    expect(composer()).toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
  }
  controls.workspaces = [{ ...workspace("session-workspace", "assistant"), workflow: { state: "in-progress", revision: 4, closure: null } }]; controls.error = "";
  await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
  expect(composer()).not.toBeNull(); expect(messageField()?.value).toBe("Retained unsent draft");
});
it.each(["idle", "completed"])("keeps an ordinary %s conversation usable without a workspace", async status => {
  controls.workspaces = [];
  const record = { id: "session-one", title: "Conversation", status, createdAt: "" };
  vi.mocked(api.getSession).mockResolvedValue(record); vi.mocked(api.createSession).mockResolvedValue(record); vi.mocked(api.listSessions).mockResolvedValue([record]);
  await act(async () => root.render(<AssistantConversation fullPage />));
  expect(composer()).not.toBeNull(); expect(messageField()?.disabled).toBe(false);
});
it.each([true, false])("waits for the first workspace observation before showing the composer in fullPage=%s", async fullPage => {
  controls.workspaces = []; controls.loading = true;
  await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
  expect(composer()).toBeNull(); expect(messageField()).toBeNull();
  controls.loading = false;
  await act(async () => root.render(<AssistantConversation fullPage={fullPage} />));
  expect(composer()).not.toBeNull(); expect(messageField()?.disabled).toBe(false);
});
it("disables Ask from an already open review when its workspace closes", async () => {
  await act(async () => root.render(<AssistantConversation fullPage />));
  await writeDraft("Keep this draft");
  await act(async () => button("Review PR in session-workspace").click());
  expect(button("Ask from review").disabled).toBe(false);
  const previouslyEnabledAsk = controls.capturedReviewAsk!;
  expect(previouslyEnabledAsk).toBeDefined();
  controls.workspaces = [{ ...workspace("session-workspace", "assistant"), workflow: { state: "in-progress", closure: "closed", revision: 1 } }];
  await act(async () => root.render(<AssistantConversation fullPage />));
  expect(button("Ask from review").disabled).toBe(true); expect(composer()).toBeNull();
  await act(async () => button("Ask from review").click()); expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => previouslyEnabledAsk("Late reference after closure"));
  expect(container.querySelector('[aria-label="Mock workspace review"]')).not.toBeNull();
  expect(api.postMessage).not.toHaveBeenCalled();
  controls.workspaces = [{ ...workspace("session-workspace", "assistant"), workflow: { state: "in-progress", closure: null, revision: 2 } }];
  await act(async () => root.render(<AssistantConversation fullPage />));
  await act(async () => button("Back to session").click());
  expect(messageField()?.value).toBe("Keep this draft");
});

it("switches workspace tabs with independent drafts and excludes other users' chats", async () => {
  const records = [{ id: "session-one", title: "Implementation", status: "idle", createdAt: "2026-10-25" }, { id: "session-two", title: "Review", status: "idle", createdAt: "2026-10-25" }, { id: "solo", title: "Standalone", status: "idle", createdAt: "2026-10-25" }];
  vi.mocked(api.listSessions).mockResolvedValue(records);
  vi.mocked(api.getSession).mockImplementation(async id => records.find(r => r.id === id)!);
  const shared = workspace("shared", "assistant");
  shared.participation = { id: "shared", revision: 1, role: "owner", viewerUserId: "me", members: [], eligibleUsers: [], sessions: [
    ...records.slice(0, 2).map(r => ({ appId: "hosty.harness", userId: "me", sessionId: r.id, title: r.title, attached: true, canOpen: true, viewerPath: `/development?session=${r.id}`, status: "idle", activityAt: null })),
    { appId: "hosty.harness", userId: "someone-else", sessionId: "private", title: "Private review", attached: true, canOpen: false, viewerPath: null, status: "failed", activityAt: null },
  ] };
  controls.workspaces = [shared, workspace("external", "external")];
  await act(async () => root.render(<AssistantConversation fullPage />));
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs().map(t => t.textContent)).toEqual(["Implementation", "Review"]);
  expect(container.querySelectorAll('nav button[aria-current="page"]')).toHaveLength(1);
  const input = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
  const draft = async (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text); input().dispatchEvent(new Event("input", { bubbles: true })); });
  await draft("Implementation draft");
  await act(async () => tabs()[1].click()); await draft("Review draft");
  expect(window.location.search).toBe("?session=session-two");
  await act(async () => tabs()[0].click()); expect(input().value).toBe("Implementation draft");
  await act(async () => button("external").click());
  expect(container.querySelector('[aria-label="Message composer"]')).toBeNull(); expect(tabs()).toHaveLength(0);
  expect(window.location.search).toBe("?workspace=external");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(b => b.textContent?.startsWith("shared"))!.click());
  expect(input().value).toBe("Implementation draft");
  await act(async () => tabs()[1].click()); expect(input().value).toBe("Review draft");
  await act(async () => button("Standalone").click());
  expect(tabs()).toHaveLength(0); expect(container.querySelector('[aria-label="Workspace draft shared"]')).toBeNull();
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
});
it.each(["external", "empty"])("restores a %s workspace route without creating or reopening an unrelated conversation", async kind => {
  const target = workspace(kind, kind === "external" ? "external" : "assistant"); target.owner.reference = "missing";
  controls.workspaces = [target];
  window.history.replaceState({}, "", `/development?workspace=${kind}`);
  await act(async () => root.render(<AssistantConversation fullPage />));
  expect(container.querySelector('[aria-label="Message composer"]')).toBeNull();
  expect(container.querySelector('[role="tab"]')).toBeNull();
  expect(container.querySelector('[aria-label="New session in workspace"]')).toBeNull();
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(controls.ui.reportSurfaceState).toHaveBeenCalledWith(expect.objectContaining({ route: `/development?workspace=${kind}`, state: "ready" }));
});
