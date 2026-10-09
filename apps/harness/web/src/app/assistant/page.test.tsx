// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AssistantPage from "./page";
import * as api from "@/lib/assistant-api";

vi.mock("@/lib/assistant-api", async original => ({
  ...await original<typeof api>(),
  getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(),
  listAppNames: vi.fn(), listContextApps: vi.fn(), setSessionApps: vi.fn(), postMessage: vi.fn(), stopSession: vi.fn(), streamEvents: vi.fn(),
}));
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
  vi.mocked(api.streamEvents).mockImplementation(async (_id, listener, _signal, onConnection) => {
    emit = listener; connection = onConnection!; connection("connected");
  });
  vi.mocked(api.postMessage).mockResolvedValue(undefined);
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
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(record.id, "Next message", [], 0, false);
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

it("restores Send and the draft when posting fails", async () => {
  vi.mocked(api.postMessage).mockRejectedValueOnce(new Error("Send failed"));
  await render(); await type("Try again");
  await act(async () => button("Send")!.click());
  expect(button("Send")?.disabled).toBe(false);
  expect(button("Stop")).toBeNull();
  expect(input().value).toBe("Try again");
});

it("accepts a fast completion before the send response without getting stuck on Stop", async () => {
  vi.mocked(api.postMessage).mockImplementation(async () => {
    emit({ type: "session_status", status: "idle", seq: 2, ts: "" });
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
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(record.id, "Compare @Media Server (media)", [], 1, false);
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
