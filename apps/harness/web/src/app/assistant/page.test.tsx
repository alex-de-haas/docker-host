// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AssistantPage from "./page";
import { AssistantConversation } from "@/components/assistant-conversation";
import * as api from "@/lib/assistant-api";

const ui = vi.hoisted(() => ({ reportSurfaceState: vi.fn(), getNavigation: vi.fn(), navigate: vi.fn() }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => ui }));

vi.mock("@/lib/assistant-api", async original => ({
  ...await original<typeof api>(),
  getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(), deleteSession: vi.fn(),
  listAppNames: vi.fn(), listContextApps: vi.fn(), setSessionApps: vi.fn(), postMessage: vi.fn(), stopSession: vi.fn(), streamEvents: vi.fn(), setSessionAutonomy: vi.fn(), listAgentConnections: vi.fn(), renameSession: vi.fn(),
}));
vi.mock("@/lib/development-api", async original => ({ ...await original<typeof import("@/lib/development-api")>(), useDevelopmentInventory: () => ({ workspaces: [], error: "", refresh: () => {} }) }));
vi.mock("@/components/speech-input", () => ({ SpeechInput: () => null }));
vi.mock("@/components/session-credentials", () => ({ SessionCredentials: () => null }));
vi.mock("@/components/app-context-picker", () => ({ AppContextPicker: () => <button aria-label="Select app context" /> }));
vi.mock("@/components/ui/message-scroller", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...Object.fromEntries(["MessageScroller", "MessageScrollerProvider", "MessageScrollerViewport", "MessageScrollerContent", "MessageScrollerItem"].map(name => [name, Wrap])), MessageScrollerButton: () => null };
});

let root: Root;
let container: HTMLDivElement;
let record: api.AssistantSession;
let emit: (event: api.AssistantEvent) => void;
let connection: (state: api.StreamConnection) => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  window.history.replaceState({}, "", "/assistant");
  record = { id: "session-one", title: "Conversation", status: "idle", createdAt: "" };
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: true });
  vi.mocked(api.listSessions).mockResolvedValue([record]);
  vi.mocked(api.getSession).mockImplementation(async () => ({ ...record }));
  vi.mocked(api.createSession).mockResolvedValue(record);
  vi.mocked(api.listAppNames).mockResolvedValue({});
  vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [], defaultId: null });
  vi.mocked(api.streamEvents).mockImplementation(async (_id, listener, _signal, onConnection) => {
    emit = listener; connection = onConnection!; connection("connected");
  });
  vi.mocked(api.postMessage).mockImplementation(async (...args) => ({ clientRequestId: args[6]!, state: "accepted" as const }));
  vi.mocked(api.stopSession).mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<AssistantPage />));
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const input = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const status = (value: string) => act(async () => {
  record.status = value;
  emit({ type: "session_status", status: value, seq: 1, ts: "" });
});
const submit = () => act(async () => {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

const openSession = (sessionId: string) => act(async () => window.dispatchEvent(new MessageEvent("message", {
  source: window.parent, data: { type: "hosty:open-assistant-session", sessionId },
})));

it("reports the mounted default route only after its message-selected session attaches", async () => {
  window.history.replaceState({}, "", "/assistant?hosty_launch=embedded&hosty_theme=dark&hosty_theme_preference=system");
  await render(); ui.reportSurfaceState.mockClear();
  let finish!: (value: api.AssistantSession) => void;
  vi.mocked(api.getSession).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await openSession("requested");
  expect(ui.reportSurfaceState).not.toHaveBeenCalled();
  await act(async () => finish({ ...record, id: "requested" }));
  expect(ui.reportSurfaceState).toHaveBeenCalledExactlyOnceWith({ route: "/assistant", state: "ready" });
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("waits for a message-selected session received before initial authentication completes", async () => {
  let healthReady!: (value: api.HarnessHealth) => void;
  vi.mocked(api.getHealth).mockImplementationOnce(() => new Promise(resolve => { healthReady = resolve; }));
  let finish!: (value: api.AssistantSession) => void;
  vi.mocked(api.getSession).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await openSession("requested");
  await act(async () => healthReady({ name: "fake", available: true }));
  expect(api.getSession).toHaveBeenCalledWith("requested");
  expect(ui.reportSurfaceState).not.toHaveBeenCalled();
  await act(async () => finish({ ...record, id: "requested" }));
  expect(ui.reportSurfaceState).toHaveBeenCalledExactlyOnceWith({ route: "/assistant", state: "ready" });
  expect(api.createSession).not.toHaveBeenCalled();
});

it.each(["failure", "mismatch"])("does not report an old or different session ready after requested-session %s", async outcome => {
  await render(); ui.reportSurfaceState.mockClear();
  if (outcome === "failure") vi.mocked(api.getSession).mockRejectedValueOnce(new Error("Unavailable"));
  else vi.mocked(api.getSession).mockResolvedValueOnce({ ...record, id: "different" });
  await openSession("requested");
  expect(ui.reportSurfaceState).not.toHaveBeenCalled();
});

it("preserves exact URL-session readiness when a different session is requested by message", async () => {
  window.history.replaceState({}, "", "/assistant?session=session-one");
  await render();
  expect(ui.reportSurfaceState).toHaveBeenCalledWith({ route: "/assistant?session=session-one", state: "ready" });
  ui.reportSurfaceState.mockClear();
  vi.mocked(api.getSession).mockResolvedValueOnce({ ...record, id: "other" });
  await openSession("other");
  expect(ui.reportSurfaceState).not.toHaveBeenCalled();
});

it.each(["running", "awaiting_approval", "awaiting_question"])("keeps a draft unsent and shows only composer Stop while %s", async value => {
  record.status = value;
  await render();
  await type("Next message");
  expect(input().disabled).toBe(false);
  expect(button("Send")).toBeNull();
  expect(container.querySelectorAll('button[aria-label="Stop"]')).toHaveLength(1);
  expect(button("Stop")?.closest("form")).not.toBeNull();
  await submit();
  expect(api.postMessage).not.toHaveBeenCalled();
  expect(api.stopSession).not.toHaveBeenCalled();
  await act(async () => button("Stop")!.click());
  expect(api.stopSession).toHaveBeenCalledExactlyOnceWith(record.id);
  await status("cancelled");
  expect(input().value).toBe("Next message");
  expect(button("Stop")).toBeNull();
  expect(button("Send")?.disabled).toBe(false);
  // Completion never automatically sends the draft.
  expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => button("Send")!.click());
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(record.id, "Next message", [], 0, false, 0, expect.stringMatching(/^[0-9a-f-]{36}$/));
});

it("locks immediately after sending, including before SSE, and unlocks on completion", async () => {
  await render();
  expect(button("Stop")).toBeNull();
  await type("First message");
  await submit();
  expect(api.postMessage).toHaveBeenCalledTimes(1);
  expect(button("Stop")?.disabled).toBe(false);
  await type("Draft for later");
  await submit();
  expect(api.postMessage).toHaveBeenCalledTimes(1);
  await status("idle");
  expect(button("Send")?.disabled).toBe(false);
  expect(input().value).toBe("Draft for later");
});

it("preserves the draft after a failed stop and permits retry", async () => {
  record.status = "running";
  vi.mocked(api.stopSession).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await type("Keep this draft");
  await act(async () => button("Stop")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(input().value).toBe("Keep this draft");
  expect(button("Stop")?.disabled).toBe(false);
  await act(async () => button("Stop")!.click());
  expect(api.stopSession).toHaveBeenCalledTimes(2);
});

it("retains the draft and offers receipt Retry when posting has an uncertain outcome", async () => {
  vi.mocked(api.postMessage).mockRejectedValueOnce(new Error("Send failed"));
  await render(); await type("Try again");
  await act(async () => button("Send")!.click());
  expect(button("Send")?.disabled).toBe(true);
  expect(button("Stop")).toBeNull();
  expect(input().value).toBe("Try again");
  expect([...container.querySelectorAll("button")].some(item => item.textContent === "Retry send")).toBe(true);
  expect(api.postMessage).toHaveBeenCalledOnce();
});

it("accepts a fast completion before the send response without getting stuck on Stop", async () => {
  vi.mocked(api.postMessage).mockImplementation(async (...args) => {
    emit({ type: "session_status", status: "idle", seq: 2, ts: "" });
    return { clientRequestId: args[6]!, state: "accepted" as const };
  });
  await render(); await type("Quick request");
  await act(async () => button("Send")!.click());
  expect(button("Stop")).toBeNull();
  expect(button("Send")).not.toBeNull();
});

it("keeps Stop pending through a status change and prevents duplicate requests", async () => {
  record.status = "running";
  let finish!: () => void;
  vi.mocked(api.stopSession).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await type("Draft");
  await act(async () => { button("Stop")!.click(); button("Stop")!.click(); });
  expect(api.stopSession).toHaveBeenCalledTimes(1);
  expect(button("Stop")?.disabled).toBe(true);
  await status("cancelled");
  await submit();
  expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(button("Send")?.disabled).toBe(false);
  expect(input().value).toBe("Draft");
});

it("opens an error in a fresh session draft without sending or replacing the old draft", async () => {
  await render();
  await type("My existing draft");
  const fresh = { ...record, id: "error-session", appIds: ["demo.app"] };
  vi.mocked(api.getSession).mockResolvedValue(fresh);
  const handoff = () => act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: {
      type: "hosty:open-assistant-session", sessionId: fresh.id, draft: "Port 8080 is in use", sourceAppId: "demo.app",
    } }));
  });
  await handoff();
  expect(input().value).toBe("From demo.app: Port 8080 is in use");
  expect(api.postMessage).not.toHaveBeenCalled();
  await type("Edited error draft");
  await handoff();
  expect(input().value).toBe("Edited error draft");
  vi.mocked(api.getSession).mockResolvedValue(record);
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "hosty:open-assistant-session", sessionId: record.id } })));
  expect(input().value).toBe("My existing draft");
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("does not accept an error-session handoff from another frame", async () => {
  await render(); await type("Keep this");
  vi.mocked(api.getSession).mockClear();
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: null, data: {
    type: "hosty:open-assistant-session", sessionId: "untrusted", draft: "Injected text",
  } })));
  expect(api.getSession).not.toHaveBeenCalled();
  expect(input().value).toBe("Keep this");
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("opens a finalized handoff with its prompt and files without submitting it", async () => {
  record.handoffDraft = { text: "Inspect the attached image", attachments: [{ name: "image.png", size: 8 }] };
  window.history.replaceState({}, "", "/assistant?session=session-one");
  await render();
  expect(api.getSession).toHaveBeenCalledWith("session-one");
  expect(input().value).toBe("Inspect the attached image");
  expect(container.textContent).toContain("image.png");
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("preserves a deliberately cleared local handoff draft on reopening", async () => {
  record.handoffDraft = { text: "Old handoff prompt", attachments: [] };
  localStorage.setItem("hosty.assistant.draft.session-one", "");
  await render();
  expect(input().value).toBe("");
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("shows unknown execution instead of automatically sending an accepted handoff", async () => {
  record.status = "failed";
  record.handoffDispatch = { id: "dispatch", state: "unknown" };
  await render();
  expect(container.textContent).toContain("unknown");
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("sends mention text only after the app association commits, with the returned revision", async () => {
  const app = { id: "media", displayName: "Media Server", available: true };
  vi.mocked(api.listContextApps).mockResolvedValue({ apps: [app], nextOffset: null });
  let resolve!: (session: api.AssistantSession) => void;
  vi.mocked(api.setSessionApps).mockReturnValue(new Promise(done => { resolve = done; }));
  await render();
  await act(async () => input().focus());
  await type("Compare @media");
  await act(async () => { await new Promise(done => setTimeout(done, 180)); });
  await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(api.postMessage).not.toHaveBeenCalled();
  expect(button("Send")?.disabled).toBe(true);
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.postMessage).not.toHaveBeenCalled();
  await act(async () => resolve({ ...record, appIds: ["media"], appContextRevision: 1 }));
  expect(input().value).toBe("Compare @Media Server ");
  await act(async () => button("Send")!.click());
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(record.id, "Compare @Media Server (media)", [], 1, false, 0, expect.stringMatching(/^[0-9a-f-]{36}$/));
});


it("places session context in the chat header outside the composer", async () => {
  await render();
  const picker = button("Select app context");
  expect(picker?.closest("header")).not.toBeNull();
  expect(picker?.closest("form")).toBeNull();
});

const activityRow = () => container.querySelector('[data-slot="assistant-activity"]');
const activityEvent = (revision: number, activity: unknown) => ({
  type: "session_activity", seq: -1, ts: "", epoch: "instance", revision, activity,
});

it("keeps current activity below commentary and streamed text, reconciles revisions, and hides it when finished", async () => {
  record.status = "running";
  await render();
  expect(activityRow()?.textContent).toBe("Working…");
  await act(async () => {
    emit({ type: "assistant_text", text: "I will inspect the logs", seq: 1, ts: "" });
    emit(activityEvent(2, { phase: "working", tool: { toolName: "Command" }, toolCount: 2 }));
    emit(activityEvent(1, { phase: "thinking", tool: null, toolCount: 0 }));
  });
  expect(activityRow()?.textContent).toBe("Running command… (+1 active)");
  expect(container.textContent).toContain("I will inspect the logs");
  await status("awaiting_approval");
  expect(activityRow()?.textContent).toBe("Waiting for approval…");
  expect(activityRow()?.querySelector('.motion-safe\\:animate-spin')).toBeNull();
  await status("awaiting_question");
  expect(activityRow()?.textContent).toBe("Waiting for your answer…");
  await status("running");
  await act(async () => {
    emit(activityEvent(3, { phase: "responding", tool: null, toolCount: 0 }));
    emit({ type: "assistant_delta", text: "Here are the results", seq: 2, ts: "" });
  });
  expect(activityRow()?.textContent).toBe("Writing response…");
  expect(activityRow()?.getAttribute("aria-atomic")).toBe("true");
  await status("idle");
  expect(activityRow()).toBeNull();
  await status("running");
  expect(activityRow()?.textContent).toBe("Working…");
});

it("replaces stale tools on disconnect, accepts a restarted server snapshot, and hides execution after access failure", async () => {
  record.status = "running";
  await render();
  await act(async () => emit(activityEvent(9, { phase: "working", tool: { toolName: "Read", detail: "/file" }, toolCount: 1 })));
  await act(async () => connection("reconnecting"));
  expect(activityRow()?.textContent).toBe("Reconnecting…");
  expect(activityRow()?.textContent).not.toContain("/file");
  await act(async () => {
    emit({ ...activityEvent(0, { phase: "thinking", tool: null, toolCount: 0 }), epoch: "new-instance" });
    connection("connected");
  });
  expect(activityRow()?.textContent).toBe("Thinking…");
  await act(async () => connection("disconnected"));
  expect(activityRow()).toBeNull();
});

it("shows stopping while cancellation is pending and restores observed activity after a failed stop", async () => {
  record.status = "running";
  let reject!: (error: Error) => void;
  vi.mocked(api.stopSession).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  await render();
  await act(async () => emit(activityEvent(1, { phase: "thinking", tool: null, toolCount: 0 })));
  await act(async () => button("Stop")!.click());
  expect(activityRow()?.textContent).toBe("Stopping…");
  await act(async () => reject(new Error("Stop failed")));
  expect(activityRow()?.textContent).toBe("Thinking…");
});

it("clears the previous activity when opening a different session", async () => {
  record.status = "running";
  await render();
  await act(async () => emit(activityEvent(2, { phase: "working", tool: { toolName: "Command" }, toolCount: 1 })));
  const previousEmit = emit;
  vi.mocked(api.createSession).mockResolvedValue({ ...record, id: "new-session", status: "idle" });
  await act(async () => button("New session")!.click());
  await act(async () => previousEmit(activityEvent(3, { phase: "thinking", tool: null, toolCount: 0 })));
  expect(activityRow()).toBeNull();
});


it("promotes the exact session to the host main area without sending or creating a conversation", async () => {
  await render(); await type("Keep my draft");
  ui.getNavigation.mockReturnValue({ entries: [{ key: "development", route: "/development" }] });
  ui.navigate.mockResolvedValue({ status: "accepted" });
  vi.mocked(api.createSession).mockClear();
  const open = [...container.querySelectorAll("button")].find(b => b.textContent === "Open in Harness")!;
  await act(async () => open.click());
  expect(ui.navigate).toHaveBeenCalledWith("development", { requestId: expect.any(String), placement: "main", search: "?session=session-one" });
  expect(localStorage.getItem("hosty.assistant.draft.session-one")).toBe("Keep my draft");
  expect(api.postMessage).not.toHaveBeenCalled(); expect(api.createSession).not.toHaveBeenCalled();
});

it("updates the host destination when selecting another full-page session and preserves its draft", async () => {
  const next = { ...record, id: "next-session", title: "Other conversation" };
  window.history.replaceState({}, "", "/development?session=session-one");
  localStorage.setItem("hosty.assistant.draft.next-session", "Keep next draft");
  vi.mocked(api.listSessions).mockResolvedValue([record, next]);
  vi.mocked(api.getSession).mockImplementation(async id => id === next.id ? next : record);
  ui.getNavigation.mockReturnValue({ entries: [{ key: "development", route: "/development" }] });
  ui.navigate.mockResolvedValue({ status: "accepted" });
  await act(async () => root.render(<AssistantConversation fullPage />));
  const pick = [...container.querySelectorAll("button")].find(b => b.textContent?.startsWith("Other conversation"))!;
  await act(async () => pick.click());
  expect(ui.navigate).not.toHaveBeenCalled();
  expect(ui.reportSurfaceState).toHaveBeenCalledWith({ route: "/development?session=next-session", state: "ready" });
  expect(input().value).toBe("Keep next draft");
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
});
it("updates standalone selection URLs when the host has no main destination", async () => {
  const next = { ...record, id: "standalone-next", title: "Standalone next" };
  window.history.replaceState({}, "", "/development?session=session-one");
  vi.mocked(api.listSessions).mockResolvedValue([record, next]);
  vi.mocked(api.getSession).mockImplementation(async id => id === next.id ? next : record);
  ui.getNavigation.mockReturnValue({ entries: [] });
  await act(async () => root.render(<AssistantConversation fullPage />));
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.startsWith("Standalone next"))!.click());
  expect(window.location.search).toBe("?session=standalone-next");
  expect(localStorage.getItem("hosty.assistant.session")).toBe(next.id);
});

it("synchronizes uploaded draft references with an already open second surface without sending", async () => {
  await render();
  const key = "hosty.assistant.attachments.session-one";
  await act(async () => {
    localStorage.setItem(key, JSON.stringify([{ name: "reference.txt", size: 44 }]));
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key), storageArea: localStorage }));
  });
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("reference.txt");
  await act(async () => {
    localStorage.setItem(key, "[]"); window.dispatchEvent(new StorageEvent("storage", { key, newValue: "[]", storageArea: localStorage }));
  });
  expect(container.querySelector('[aria-label="Attachments to send"]')).toBeNull();
  expect(api.postMessage).not.toHaveBeenCalled();
});

it("refreshes unavailable worker health after a recovered stop without losing the draft", async () => {
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: false, reason: "Worker recovery required" });
  await render(); await type("Retained draft");
  expect(container.textContent).toContain("Worker recovery required");
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: true });
  await status("cancelled");
  expect(container.textContent).not.toContain("Worker recovery required");
  expect(input().value).toBe("Retained draft");
  expect(button("Send")?.disabled).toBe(false);
});

const openDelete = async (title = "Conversation") => {
  await act(async () => button(`Delete ${title}`)!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Delete session")!.click());
};
const renderDeletion = async () => {
  window.history.replaceState({}, "", "/development?session=session-one");
  ui.getNavigation.mockReturnValue({ entries: [] });
  await act(async () => root.render(<AssistantConversation fullPage />));
  await type("My retained draft");
};
it("detaches on a local deletion event even if the HTTP response is lost", async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(api.deleteSession).mockImplementation(() => new Promise((_, no) => { reject = no; }));
  await renderDeletion(); await openDelete();
  await act(async () => emit({ type: "session_deleted", seq: 2, ts: "" }));
  expect(localStorage.getItem("hosty.assistant.session")).toBeNull();
  expect(localStorage.getItem("hosty.assistant.draft.session-one")).toBeNull();
  expect(window.location.search).toBe("");
  expect(button("Delete Conversation")).toBeNull();
  await act(async () => reject(new Error("Lost HTTP response")));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("Lost HTTP response");
  expect(container.textContent).not.toContain("deleted in another window");
  expect(api.createSession).not.toHaveBeenCalled();
});
it("preserves an active conversation and draft when deletion is not confirmed", async () => {
  vi.mocked(api.deleteSession).mockRejectedValue(new Error("Workspace is unfinished"));
  await renderDeletion(); await openDelete();
  expect(input().value).toBe("My retained draft");
  expect(localStorage.getItem("hosty.assistant.session")).toBe(record.id);
  expect(localStorage.getItem("hosty.assistant.draft.session-one")).toBe("My retained draft");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Workspace is unfinished");
  expect(window.location.search).toBe("?session=session-one");
});
it("ignores a late terminal event after HTTP deletion has already detached the session", async () => {
  vi.mocked(api.deleteSession).mockResolvedValue(undefined);
  await renderDeletion(); const previousEmit = emit; await openDelete();
  await act(async () => previousEmit({ type: "session_deleted", seq: 2, ts: "" }));
  expect(localStorage.getItem("hosty.assistant.session")).toBeNull();
  expect(window.location.search).toBe("");
  expect(container.textContent).not.toContain("deleted in another window");
  expect(api.createSession).not.toHaveBeenCalled();
});
it("reports deletion from another window while detaching the active session", async () => {
  await renderDeletion();
  await act(async () => emit({ type: "session_deleted", seq: 2, ts: "" }));
  expect(localStorage.getItem("hosty.assistant.session")).toBeNull();
  expect(localStorage.getItem("hosty.assistant.draft.session-one")).toBeNull();
  expect(container.textContent).toContain("deleted in another window");
  expect(api.deleteSession).not.toHaveBeenCalled();
});

it.each(["deleted", "retained", "unavailable"])("reconciles a lost non-active deletion response with %s inventory", async outcome => {
  const other = { ...record, id: "other-session", title: "Other conversation" };
  vi.mocked(api.listSessions).mockResolvedValue([record, other]);
  vi.mocked(api.deleteSession).mockRejectedValue(new Error("Lost deletion response"));
  localStorage.setItem("hosty.assistant.draft.other-session", "Other retained draft");
  await renderDeletion();
  expect(api.streamEvents).toHaveBeenCalledTimes(1);
  expect(api.streamEvents).toHaveBeenCalledWith(record.id, expect.any(Function), expect.any(AbortSignal), expect.any(Function));
  if (outcome === "deleted") vi.mocked(api.listSessions).mockResolvedValue([record]);
  if (outcome === "unavailable") vi.mocked(api.listSessions).mockRejectedValue(new Error("Inventory unavailable"));
  await openDelete("Other conversation");
  expect(api.listSessions).toHaveBeenCalledTimes(2);
  expect(input().value).toBe("My retained draft");
  expect(localStorage.getItem("hosty.assistant.session")).toBe(record.id);
  expect(window.location.search).toBe("?session=session-one");
  if (outcome === "deleted") {
    expect(button("Delete Other conversation")).toBeNull();
    expect(localStorage.getItem("hosty.assistant.draft.other-session")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("Lost deletion response");
  } else {
    expect(button("Delete Other conversation")).not.toBeNull();
    expect(localStorage.getItem("hosty.assistant.draft.other-session")).toBe("Other retained draft");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Lost deletion response");
    vi.mocked(api.deleteSession).mockRejectedValue(new Error("Request failed (404)."));
    vi.mocked(api.listSessions).mockResolvedValue([record]);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Delete session")!.click());
    expect(button("Delete Other conversation")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(input().value).toBe("My retained draft");
  }
});

const navigationTitles = () => [...container.querySelectorAll('nav[aria-label="Workspaces and chats"] button span.block[title]')].map(node => node.textContent);
const renderActivityOrder = async () => {
  record = { ...record, appIds: ["one"], appContextRevision: 1, updatedAt: "2026-10-18T10:00:00Z" };
  const newer = { ...record, id: "newer", title: "Newer conversation", updatedAt: "2026-10-18T11:00:00Z" };
  vi.mocked(api.listSessions).mockResolvedValue([record, newer]);
  vi.mocked(api.getSession).mockImplementation(async id => id === newer.id ? newer : record);
  await renderDeletion();
  expect(navigationTitles()).toEqual(["Newer conversation", "Conversation"]);
};
it("orders a locally changed autonomy immediately and retains its activity after switching chats", async () => {
  await renderActivityOrder();
  vi.mocked(api.setSessionAutonomy).mockResolvedValue({ ...record, autonomy: "autonomous", updatedAt: "2026-10-18T12:00:00Z" });
  await act(async () => button("Autonomy: Normal")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.startsWith("Autonomous"))!.click());
  expect(navigationTitles()).toEqual(["Conversation", "Newer conversation"]);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('nav button')].find(item => item.textContent?.startsWith("Newer conversation"))!.click());
  expect(navigationTitles()).toEqual(["Conversation", "Newer conversation"]);
});
it.each(["session_autonomy_changed", "session_provider_changed", "app_context_changed"])("orders %s activity without allowing replay or late responses to move it backwards", async type => {
  await renderActivityOrder();
  vi.mocked(api.getSession).mockResolvedValue({ ...record, autonomy: "autonomous", updatedAt: "2026-10-18T12:00:00Z" });
  await act(async () => emit({ type, seq: 3, ts: "2026-10-18T12:00:00Z", appIds: ["one"], appContextRevision: 2 }));
  expect(navigationTitles()).toEqual(["Conversation", "Newer conversation"]);
  vi.mocked(api.getSession).mockResolvedValue({ ...record, updatedAt: "2026-10-18T10:30:00Z" });
  await act(async () => emit({ type, seq: 1, ts: "2026-10-18T10:30:00Z", appIds: ["one"], appContextRevision: 1 }));
  expect(navigationTitles()).toEqual(["Conversation", "Newer conversation"]);
  if (type !== "app_context_changed") expect(button("Autonomy: Autonomous")).not.toBeNull();
});

it.each(["session_autonomy_changed", "session_provider_changed"])("uses %s activity when the record refresh fails", async type => {
  await renderActivityOrder();
  vi.mocked(api.getSession).mockRejectedValue(new Error("Record refresh unavailable"));
  const settings = type === "session_autonomy_changed" ? { autonomy: "autonomous" }
    : { connectionId: "new-provider", connectionRevision: 2, harnessKind: "claude", providerLocked: false };
  await act(async () => emit({ type, seq: 3, ts: "2026-10-18T12:00:00Z", ...settings }));
  expect(navigationTitles()).toEqual(["Conversation", "Newer conversation"]);
  expect(button(type === "session_autonomy_changed" ? "Autonomy: Autonomous" : "Provider: claude")).not.toBeNull();
  await act(async () => emit({ type, seq: 1, ts: "2026-10-18T10:30:00Z", autonomy: "normal", connectionId: "old-provider", connectionRevision: 1, harnessKind: "codex", providerLocked: false }));
  expect(button(type === "session_autonomy_changed" ? "Autonomy: Autonomous" : "Provider: claude")).not.toBeNull();
  expect(input().value).toBe("My retained draft");
});

it("refreshes non-selected running sessions through waiting and completion without losing the selected draft", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  try {
    record = { ...record, appIds: ["one"], updatedAt: "2026-10-18T11:00:00Z" };
    const other = { ...record, id: "background", title: "Background work", status: "running", updatedAt: "2026-10-18T10:00:00Z" };
    vi.mocked(api.listSessions).mockResolvedValue([record, other]);
    await renderDeletion();
    expect(navigationTitles()).toEqual(["Conversation", "Background work"]);
    let refresh!: (rows: api.AssistantSession[]) => void;
    vi.mocked(api.listSessions).mockImplementationOnce(() => new Promise(resolve => { refresh = resolve; }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => emit({ type: "session_status", seq: 2, ts: "2026-10-18T11:30:00Z", status: "running" }));
    await act(async () => refresh([record, { ...other, status: "awaiting_approval", updatedAt: "2026-10-18T12:00:00Z" }]));
    expect(navigationTitles()).toEqual(["Background work", "Conversation"]);
    expect(container.querySelector('[aria-label="Needs attention: 1"]')).not.toBeNull();
    vi.mocked(api.listSessions).mockResolvedValue([record, { ...other, status: "idle", updatedAt: "2026-10-18T13:00:00Z" }]);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(container.querySelector('[aria-label="Needs attention: 1"]')).toBeNull();
    const calls = vi.mocked(api.listSessions).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(api.listSessions).toHaveBeenCalledTimes(calls);
    vi.mocked(api.listSessions).mockResolvedValue([record, { ...other, status: "running", updatedAt: "2026-10-18T14:00:00Z" }]);
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(api.listSessions).toHaveBeenCalledTimes(calls + 1);
    expect(container.querySelector('[aria-label="Working: 1"]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(api.listSessions).toHaveBeenCalledTimes(calls + 2);
    expect(input().value).toBe("My retained draft");
    expect(window.location.search).toBe("?session=session-one");
  } finally { visible.mockRestore(); vi.useRealTimers(); }
});

it("pauses hidden list refreshes and rejects a snapshot overtaken by session deletion", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    const other = { ...record, id: "background", title: "Background work", status: "running" };
    vi.mocked(api.listSessions).mockResolvedValue([record, other]);
    await renderDeletion();
    await act(async () => { vi.advanceTimersByTime(15000); window.dispatchEvent(new Event("focus")); });
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    let finish!: (sessions: api.AssistantSession[]) => void;
    vi.mocked(api.listSessions).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    visible.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { vi.advanceTimersByTime(10000); window.dispatchEvent(new Event("focus")); });
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    vi.mocked(api.deleteSession).mockResolvedValue(undefined);
    await openDelete("Background work");
    await act(async () => finish([record, other]));
    expect(button("Delete Background work")).toBeNull();
    expect(input().value).toBe("My retained draft");
    vi.mocked(api.listSessions).mockRejectedValue(new Error("Temporary outage"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(input().value).toBe("My retained draft");
    vi.mocked(api.listSessions).mockResolvedValue([record, { ...other, status: "idle" }]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button("Delete Background work")).not.toBeNull();
  } finally { visible.mockRestore(); vi.useRealTimers(); }
});

it("ignores a settings fetch overtaken by a later event even when both share a timestamp", async () => {
  await renderActivityOrder();
  let oldReply!: (value: api.AssistantSession) => void;
  vi.mocked(api.getSession).mockImplementationOnce(() => new Promise(resolve => { oldReply = resolve; }));
  await act(async () => emit({ type: "session_autonomy_changed", seq: 2, ts: "2026-10-18T12:00:00Z", autonomy: "normal" }));
  vi.mocked(api.getSession).mockResolvedValue({ ...record, updatedAt: "2026-10-18T12:00:00Z", autonomy: "autonomous" });
  await act(async () => emit({ type: "session_autonomy_changed", seq: 3, ts: "2026-10-18T12:00:00Z", autonomy: "autonomous" }));
  await act(async () => oldReply({ ...record, updatedAt: "2026-10-18T12:00:00Z", autonomy: "normal" }));
  expect(button("Autonomy: Autonomous")).not.toBeNull();
});

it("does not let a late rename response overwrite settings at the same timestamp", async () => {
  record = { ...record, lastEventSeq: 1, updatedAt: "2026-10-18T10:00:00Z" };
  await render();
  await act(async () => button("Session history")!.click());
  await act(async () => button("Rename Conversation")!.click());
  let renameReply!: (value: api.AssistantSession) => void;
  vi.mocked(api.renameSession).mockImplementation(() => new Promise(resolve => { renameReply = resolve; }));
  await act(async () => container.querySelector<HTMLInputElement>('input[placeholder="Name this session…"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  vi.mocked(api.getSession).mockRejectedValue(new Error("Refresh unavailable"));
  await act(async () => emit({ type: "session_autonomy_changed", seq: 3, ts: "2026-10-18T12:00:00Z", autonomy: "autonomous" }));
  await act(async () => renameReply({ ...record, title: "Renamed", lastEventSeq: 2, updatedAt: "2026-10-18T12:00:00Z", autonomy: "normal" }));
  await act(async () => button("Back to conversation")!.click());
  expect(button("Autonomy: Autonomous")).not.toBeNull();
  await act(async () => emit({ type: "session_autonomy_changed", seq: 2, ts: "2026-10-18T12:00:00Z", autonomy: "normal" }));
  expect(button("Autonomy: Autonomous")).not.toBeNull();
});

it("retains a status event sequence against a late same-time rename after switching away", async () => {
  record = { ...record, lastEventSeq: 1, updatedAt: "2026-10-18T10:00:00Z" };
  const other = { ...record, id: "other", title: "Other conversation" };
  vi.mocked(api.listSessions).mockResolvedValue([record, other]);
  vi.mocked(api.getSession).mockImplementation(async id => id === other.id ? other : record);
  await render();
  await act(async () => button("Session history")!.click());
  await act(async () => button("Rename Conversation")!.click());
  let renameReply!: (value: api.AssistantSession) => void;
  vi.mocked(api.renameSession).mockImplementation(() => new Promise(resolve => { renameReply = resolve; }));
  await act(async () => container.querySelector<HTMLInputElement>('input[placeholder="Name this session…"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(async () => emit({ type: "session_status", seq: 3, ts: "2026-10-18T12:00:00Z", status: "awaiting_question" }));
  await act(async () => renameReply({ ...record, lastEventSeq: 2, updatedAt: "2026-10-18T12:00:00Z", status: "idle" }));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith("Other conversation"))!.click());
  vi.mocked(api.listSessions).mockRejectedValue(new Error("Offline"));
  await act(async () => button("Session history")!.click());
  const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith("Conversation"));
  expect(row?.textContent).toContain("waiting for you");
});

it("keeps current busy controls while historical status chunks replay", async () => {
  record.status = "awaiting_approval";
  record.lastEventSeq = 10;
  await render();
  await type("keep this draft");
  await act(async () => connection("reconnecting"));
  for (const value of ["idle", "running", "cancelled"]) {
    await act(async () => emit({ type: "session_status", seq: 2, ts: "", status: value, historical: true }));
    expect(button("Stop")).not.toBeNull();
    await submit();
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(input().value).toBe("keep this draft");
  }
  await act(async () => {
    emit({ type: "session_status", seq: 10, ts: "", status: "awaiting_approval" });
    connection("connected");
  });
  expect(button("Stop")).not.toBeNull();
});
