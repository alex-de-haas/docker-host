// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantConversation } from "./assistant-conversation";
import * as api from "@/lib/assistant-api";
import { clearEditDraft, listPreservedDrafts, preserveDraft, readEditDraft, saveEditDraft, type EditDraft, type OutboxEntry, type PreservedDraft } from "@/lib/message-outbox";
import type { MessageQueue, QueueCommand, QueueCommandReply, QueueEntry } from "@/lib/message-queue-api";

const controls = vi.hoisted(() => ({ version: 0, listeners: new Set<() => void>(), hook: {} as Record<string, unknown>, stored: undefined as unknown, saved: [] as PreservedDraft[],
  suggestionHook: {} as Record<string, unknown>, ui: { reportSurfaceState: vi.fn(), getNavigation: () => ({ entries: [] }), navigate: vi.fn() }, interact: vi.fn() }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => controls.ui }));
vi.mock("@/lib/use-message-queue", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useMessageQueue: () => { useSyncExternalStore(listener => { controls.listeners.add(listener); return () => controls.listeners.delete(listener); }, () => controls.version); return controls.hook; } };
});
vi.mock("@/lib/prompt-suggestions", () => ({ usePromptSuggestions: () => controls.suggestionHook }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(), getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(),
  listAppNames: vi.fn(), listAgentConnections: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn(), getMessageReceipt: vi.fn(), uploadAttachment: vi.fn() }));
vi.mock("@/lib/message-outbox", async original => ({ ...await original<object>(),
  readEditDraft: vi.fn(async () => controls.stored), saveEditDraft: vi.fn(async value => {
    const previous = controls.stored as EditDraft | undefined;
    if (previous && previous.reservationId !== value.reservationId && previous.reservationId !== "pending" && value.reservationId !== "pending") throw new Error("This edit moved to another view.");
    controls.stored = value;
  }),
  clearEditDraft: vi.fn(async (_scope, reservationId) => { if ((controls.stored as EditDraft | undefined)?.reservationId === reservationId) controls.stored = undefined; }),
  listPreservedDrafts: vi.fn(async () => [...controls.saved]),
  preserveDraft: vi.fn(async (_scope, value: PreservedDraft) => { if (!controls.saved.some(draft => draft.id === value.id)) controls.saved.push(value); }),
  removePreservedDraft: vi.fn(async (_scope, id: string) => { controls.saved = controls.saved.filter(draft => draft.id !== id); }),
}));
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), useDevelopmentInventory: () => ({ workspaces: [], loading: false, error: "", refresh: vi.fn() }) }));
vi.mock("./speech-input", () => ({ SpeechInput: () => null }));
vi.mock("./session-credentials", () => ({ SessionCredentials: () => null }));
vi.mock("./session-autonomy", () => ({ SessionAutonomy: () => null }));
vi.mock("./app-context-picker", () => ({ AppContextPicker: () => null }));
vi.mock("./ui/message-scroller", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...Object.fromEntries(["MessageScroller", "MessageScrollerProvider", "MessageScrollerViewport", "MessageScrollerContent", "MessageScrollerItem"].map(name => [name, Wrap])), MessageScrollerButton: () => null };
});
let root: Root, container: HTMLDivElement;
let emit: (event: api.AssistantEvent) => void;
const session: api.AssistantSession = { id: "queue-chat", createdBy: "owner", title: "Queue chat", status: "running", createdAt: "" };
const otherSession: api.AssistantSession = { ...session, id: "queue-chat-b", title: "Another queue chat" };
const blank = (): MessageQueue => ({ version: 1, installationId: "install", ownerId: "owner", revision: 1, paused: true, entries: [], updatedAt: "" });
const enqueue = vi.fn(), perform = vi.fn(), retryLocal = vi.fn();
const input = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === name || button.textContent === name)!;
const mount = () => act(async () => root.render(<AssistantConversation fullPage />));
const update = (queue: MessageQueue) => { controls.hook.queue = queue; controls.version++; controls.listeners.forEach(listener => listener()); };
const write = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const send = () => act(async () => { container.querySelector('form[aria-label="Message composer"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const click = (name: string) => act(async () => button(name).click());
const switchSession = (sessionId: string) => act(async () => window.dispatchEvent(new MessageEvent("message", {
  source: window.parent, data: { type: "hosty:open-assistant-session", sessionId },
})));
const chooseFile = (file: File) => act(async () => {
  const chooser = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(chooser, "files", { configurable: true, value: [file] });
  chooser.dispatchEvent(new Event("change", { bubbles: true }));
});
const entry = (): QueueEntry => ({ id: "queued-one", text: "Original queued message", attachments: [], state: "queued", createdAt: "" });
const reply = (queue: MessageQueue): QueueCommandReply => ({ queue, result: { revision: queue.revision } });
function reserve(command: Extract<QueueCommand, { type: "reserve_edit" }>) {
  const queue = controls.hook.queue as MessageQueue;
  const current = queue.entries[0]!;
  const next: MessageQueue = { ...queue, revision: queue.revision + 1, entries: [{ ...current, state: "editing", edit: {
    reservationId: "reservation", viewId: command.viewId, generation: 1, text: current.text, attachments: current.attachments,
    stashedDraft: { text: command.stashedDraft.text, attachments: [] },
  } }] };
  update(next); return reply(next);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
  controls.stored = undefined; controls.saved = []; controls.listeners.clear(); controls.version++;
  controls.suggestionHook = { cards: new Map(), receive: vi.fn(), interact: controls.interact,
    preference: { enabled: false, revision: 0 }, suggestion: null, select: vi.fn(), dismiss: vi.fn(), toggle: vi.fn(), retryInsertion: vi.fn() };
  controls.hook = { queue: blank(), scope: "scope", outbox: [], busy: false, operation: null, error: null, enqueue, perform, retryLocal,
    receive: vi.fn(), refresh: vi.fn() };
  enqueue.mockReset().mockResolvedValue(undefined); perform.mockReset().mockImplementation(async command => {
    if (command?.type === "reserve_edit") return reserve(command);
    const queue = controls.hook.queue as MessageQueue;
    const next = { ...queue, revision: queue.revision + 1, entries: queue.entries.map(row => ({ ...row, state: "queued" as const, edit: undefined })) };
    update(next); return reply(next);
  });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width: 1100px"), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fixture", available: true }); vi.mocked(api.listSessions).mockResolvedValue([session]);
  vi.mocked(api.getSession).mockImplementation(async id => id === otherSession.id ? otherSession : session); vi.mocked(api.createSession).mockResolvedValue(session); vi.mocked(api.listAppNames).mockResolvedValue({});
  vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [], defaultId: null });
  vi.mocked(api.streamEvents).mockImplementation(async (_id, event, _signal, state) => { emit = event; state?.("connected"); });
  localStorage.setItem("hosty.assistant.session", session.id); window.history.replaceState({}, "", "/assistant?session=queue-chat");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("accepts another message during a run and preserves a new draft while local staging finishes", async () => {
  let staged!: () => void; enqueue.mockImplementationOnce(() => new Promise<void>(resolve => { staged = resolve; }));
  await mount(); await write("First message"); await send();
  expect(input().disabled).toBe(false); expect(button("Stop")).toBeDefined();
  await write("Next draft"); await act(async () => staged());
  expect(input().value).toBe("Next draft"); expect(api.postMessage).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ text: "First message", draftText: "First message" }));
  await send(); expect(enqueue).toHaveBeenCalledTimes(2); expect(input().value).toBe("");
});
it("clears submitted uploaded references durably so reload cannot restore sent attachments", async () => {
  localStorage.setItem(`hosty.assistant.attachments.${session.id}`, JSON.stringify([{ name: "old-file.txt", size: 5 }]));
  await mount(); await write("Inspect attachment"); await send();
  expect(JSON.parse(localStorage.getItem(`hosty.assistant.attachments.${session.id}`)!)).toEqual([]);
  expect(container.querySelector('[aria-label="Attachments to send"]')).toBeNull();
});
it("retains the draft and file selection if durable staging fails", async () => {
  enqueue.mockRejectedValueOnce(new Error("Cannot save this snapshot")); await mount(); await write("Keep this text"); await send();
  expect(input().value).toBe("Keep this text"); expect(input().disabled).toBe(false);
  expect(container.textContent).toContain("Cannot save this snapshot"); expect(api.postMessage).not.toHaveBeenCalled();
});
it("locks only the edit transition, restores queue text and keeps ordinary drafts out of its edit buffer", async () => {
  update({ ...blank(), entries: [entry()] }); await mount(); await write("My unsent draft");
  let accepted!: (value: QueueCommandReply) => void;
  perform.mockImplementationOnce(() => new Promise(resolve => { accepted = resolve; }));
  await click("Edit queued message 1"); expect(input().disabled).toBe(true);
  const command = perform.mock.calls[0]![0] as Extract<QueueCommand, { type: "reserve_edit" }>;
  await act(async () => accepted(reserve(command)));
  expect(input().value).toBe("Original queued message"); expect(input().disabled).toBe(false);
  expect(localStorage.getItem(`hosty.assistant.draft.${session.id}`)).toBe("My unsent draft");
  await write("Edited queued text");
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: `hosty.assistant.draft.${session.id}`, newValue: "Another tab's ordinary draft" })));
  expect(input().value).toBe("Edited queued text");
  expect((controls.stored as EditDraft).buffer?.text).toBe("Edited queued text");
  await click("Cancel edit"); expect(input().value).toBe("My unsent draft"); expect(clearEditDraft).toHaveBeenCalledOnce();
});
it.each(["save_edit", "cancel_edit"] as const)("replays a lost %s reply and restores the stashed draft exactly once", async type => {
  update({ ...blank(), entries: [entry()] }); await mount(); await write("Stashed draft"); await click("Edit queued message 1");
  await write("Edited message");
  perform.mockImplementationOnce(async command => {
    controls.hook.operation = { scope: "scope", sessionId: session.id, input: { requestId: "original-operation", expectedRevision: 2, command } };
    controls.hook.error = "Reply lost"; controls.version++; controls.listeners.forEach(listener => listener());
    throw new TypeError("Reply lost");
  });
  if (type === "save_edit") await send(); else await click("Cancel edit");
  expect(input().disabled).toBe(true); expect(input().value).toBe("Edited message");
  perform.mockImplementationOnce(async command => {
    expect(command).toBeUndefined(); controls.hook.operation = null; controls.hook.error = null;
    const next = { ...blank(), entries: [entry()] }; update(next); return reply(next);
  });
  await click("Retry queue change"); expect(input().value).toBe("Stashed draft"); expect(input().disabled).toBe(false);
  expect(clearEditDraft).toHaveBeenCalledOnce();
});
it("recovers a persisted edit buffer after reload without reusing another document's view identity", async () => {
  const previous = entry(); previous.state = "editing"; previous.edit = { reservationId: "old-reservation", viewId: "old-document", generation: 1,
    text: "server buffer", attachments: [], stashedDraft: { text: "ordinary draft", attachments: [] } };
  controls.stored = { scope: "scope", entryId: previous.id, viewId: "old-document", reservationId: "old-reservation",
    stash: { text: "ordinary draft", attachments: [], files: [] }, buffer: { text: "latest local edit", attachments: [], files: [] } } satisfies EditDraft;
  update({ ...blank(), entries: [previous] }); localStorage.setItem(`hosty.assistant.draft.${session.id}`, "ordinary draft");
  await mount(); expect(input().value).toBe("ordinary draft"); expect(button("Recover edit")).toBeDefined();
  perform.mockImplementationOnce(async command => {
    expect(command.viewId).not.toBe("old-document");
    const next = { ...blank(), entries: [{ ...previous, edit: { ...previous.edit!, viewId: command.viewId, reservationId: "recovered-reservation" } }] };
    update(next); return reply(next);
  });
  await click("Recover edit"); expect(input().value).toBe("latest local edit");
  expect(readEditDraft).toHaveBeenCalled(); expect(saveEditDraft).toHaveBeenCalled();
});

it.each(["submitted", "newer"] as const)("keeps conversation B intact when conversation A's staging completes with a %s persisted draft", async draft => {
  const aDraft = `hosty.assistant.draft.${session.id}`, aFiles = `hosty.assistant.attachments.${session.id}`;
  const bDraft = `hosty.assistant.draft.${otherSession.id}`, bFiles = `hosty.assistant.attachments.${otherSession.id}`;
  const aStored = { name: "a-uploaded.txt", size: 5 }, bStored = { name: "b-uploaded.txt", size: 6 };
  vi.mocked(api.listSessions).mockResolvedValue([session, otherSession]);
  localStorage.setItem(aFiles, JSON.stringify([aStored]));
  localStorage.setItem(bFiles, JSON.stringify([bStored])); localStorage.setItem(bDraft, "B's saved draft");
  let staged!: () => void;
  enqueue.mockImplementationOnce(() => new Promise<void>(resolve => { staged = resolve; }));
  await mount(); await write("A's submitted draft");
  await chooseFile(new File(["A local bytes"], "a-local.txt", { type: "text/plain" }));
  await send();
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ attachments: [aStored], files: [expect.objectContaining({ name: "a-local.txt" })] }));
  await switchSession(otherSession.id); expect(input().value).toBe("B's saved draft");
  await write("B's current draft"); await chooseFile(new File(["B local bytes"], "b-local.txt", { type: "text/plain" }));
  const newerA = { name: "a-newer-upload.txt", size: 7 };
  if (draft === "newer") {
    localStorage.setItem(aDraft, "A's newer draft from another view");
    localStorage.setItem(aFiles, JSON.stringify([aStored, newerA]));
  }
  await act(async () => staged());
  expect(input().value).toBe("B's current draft"); expect(input().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("b-local.txt");
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("b-uploaded.txt");
  expect(localStorage.getItem(bDraft)).toBe("B's current draft"); expect(JSON.parse(localStorage.getItem(bFiles)!)).toEqual([bStored]);
  expect(localStorage.getItem(aDraft)).toBe(draft === "newer" ? "A's newer draft from another view" : "");
  expect(JSON.parse(localStorage.getItem(aFiles)!)).toEqual(draft === "newer" ? [newerA] : []);
  await switchSession(session.id);
  expect(input().value).toBe(draft === "newer" ? "A's newer draft from another view" : "");
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent ?? "").not.toContain("a-local.txt");
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent ?? "").not.toContain("a-uploaded.txt");
  if (draft === "newer") expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("a-newer-upload.txt");
});

it("preserves another tab's ordinary draft on Cancel and restores the original stash through Saved drafts", async () => {
  const draftKey = `hosty.assistant.draft.${session.id}`, attachmentKey = `hosty.assistant.attachments.${session.id}`;
  update({ ...blank(), entries: [entry()] }); await mount(); await write("Original ordinary draft");
  await chooseFile(new File(["original local bytes"], "original-local.txt", { type: "text/plain" }));
  await click("Edit queued message 1"); await write("Updated queue edit");
  const newerFiles = [{ name: "other-tab.txt", size: 8 }];
  localStorage.setItem(draftKey, "New ordinary draft from another tab"); localStorage.setItem(attachmentKey, JSON.stringify(newerFiles));
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: draftKey, newValue: "New ordinary draft from another tab" }));
    window.dispatchEvent(new StorageEvent("storage", { key: attachmentKey, newValue: JSON.stringify(newerFiles) }));
  });
  expect(input().value).toBe("Updated queue edit");
  await click("Cancel edit");
  expect(input().value).toBe("New ordinary draft from another tab"); expect(localStorage.getItem(draftKey)).toBe("New ordinary draft from another tab");
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("other-tab.txt");
  expect(container.querySelector('[aria-label="Saved drafts"]')?.textContent).toContain("Original ordinary draft");
  expect(controls.saved[0].draft.files[0].name).toBe("original-local.txt");
  await click("Restore draft");
  expect(input().value).toBe("Original ordinary draft"); expect(localStorage.getItem(draftKey)).toBe("Original ordinary draft");
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("original-local.txt");
  expect(container.querySelector('[aria-label="Saved drafts"]')?.textContent).toContain("New ordinary draft from another tab");
  expect(controls.saved).toEqual([expect.objectContaining({ draft: expect.objectContaining({ text: "New ordinary draft from another tab", attachments: newerFiles }) })]);
  expect(api.postMessage).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
});

it("keeps a newer shared draft if another tab changes it during an asynchronous Restore transaction", async () => {
  const draftKey = `hosty.assistant.draft.${session.id}`, attachmentKey = `hosty.assistant.attachments.${session.id}`;
  controls.saved = [{ id: "older-stash", draft: { text: "Saved draft to restore", attachments: [], files: [] } }];
  await mount(); await write("Ordinary draft before restore");
  let preserved!: () => void;
  vi.mocked(preserveDraft).mockImplementationOnce(async (_scope, value) => new Promise<void>(resolve => {
    preserved = () => { controls.saved.push(value); resolve(); };
  }));
  await click("Restore draft"); expect(input().disabled).toBe(true);
  const newestFiles = [{ name: "newest-other-tab.txt", size: 12 }];
  localStorage.setItem(draftKey, "Newest draft from the other tab"); localStorage.setItem(attachmentKey, JSON.stringify(newestFiles));
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: draftKey, newValue: "Newest draft from the other tab" }));
    window.dispatchEvent(new StorageEvent("storage", { key: attachmentKey, newValue: JSON.stringify(newestFiles) }));
  });
  await act(async () => preserved());
  expect(input().value).toBe("Newest draft from the other tab"); expect(input().disabled).toBe(false);
  expect(localStorage.getItem(draftKey)).toBe("Newest draft from the other tab"); expect(JSON.parse(localStorage.getItem(attachmentKey)!)).toEqual(newestFiles);
  expect(container.querySelector('[aria-label="Attachments to send"]')?.textContent).toContain("newest-other-tab.txt");
  expect(container.querySelector('[aria-label="Saved drafts"]')?.textContent).toContain("Saved draft to restore");
  expect(controls.saved.some(draft => draft.id === "older-stash")).toBe(true);
  expect(controls.saved.some(draft => draft.draft.text === "Ordinary draft before restore")).toBe(true);
  expect(container.textContent).toContain("Its latest text was kept");
  expect(enqueue).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("freezes a stale editor during another tab's Recover and preserves its buffer before returning to the normal draft", async () => {
  update({ ...blank(), entries: [entry()] }); await mount(); await write("Ordinary draft");
  await click("Edit queued message 1"); await write("Unsaved text in the first editor");
  const original = controls.stored as EditDraft, before = controls.hook.queue as MessageQueue;
  const otherRow: QueueEntry = { ...before.entries[0], edit: { ...before.entries[0].edit!, viewId: "another-document", reservationId: "new-reservation", generation: 2 } };
  controls.stored = { ...original, viewId: "another-document", reservationId: "new-reservation", buffer: { text: "The new editor's buffer", attachments: [], files: [] } };
  let preserved!: () => void;
  vi.mocked(preserveDraft).mockImplementationOnce(async (_scope, value) => new Promise<void>(resolve => {
    preserved = () => { controls.saved.push(value); resolve(); };
  }));
  await act(async () => update({ ...before, revision: before.revision + 1, entries: [otherRow] }));
  expect(input().disabled).toBe(true); expect(input().value).toBe("Unsaved text in the first editor");
  expect(preserveDraft).toHaveBeenCalledWith("scope", expect.objectContaining({ draft: expect.objectContaining({ text: "Unsaved text in the first editor" }) }));
  await act(async () => preserved());
  expect(input().value).toBe("Ordinary draft"); expect(input().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Saved drafts"]')?.textContent).toContain("Unsaved text in the first editor");
  expect((controls.stored as EditDraft).reservationId).toBe("new-reservation");
  expect((controls.stored as EditDraft).buffer?.text).toBe("The new editor's buffer");
  expect(perform.mock.calls.every(([command]) => command.type === "reserve_edit")).toBe(true);
  expect(listPreservedDrafts).toHaveBeenCalled();
});

it("renders one queue row when the local journal and accepted server entry share an identity", async () => {
  const current = entry();
  const local: OutboxEntry = { id: current.id, sessionId: session.id, scope: "scope", sequence: 1,
    text: current.text, draftText: current.text, files: [], attachments: [], error: "Enqueue response lost" };
  controls.hook.outbox = [local]; update({ ...blank(), entries: [current] });
  await mount();
  expect(container.querySelectorAll('[aria-label="Queued messages"] > li')).toHaveLength(1);
  expect(container.querySelector('[aria-label="Message saving to queue"]')).toBeNull();
  expect(container.querySelector('[aria-label="Message queue"]')?.textContent?.split(current.text)).toHaveLength(2);
  expect(button("Edit queued message 1")).toBeDefined();
});

it("compacts a sending row after its correlated transcript message arrives and keeps full reorder identities", async () => {
  const current: QueueEntry = { ...entry(), state: "sending", attempt: { clientRequestId: "attempt-one" }, attachments: [{ id: "file", name: "queued.txt", size: 5 }] };
  const second = { ...entry(), id: "second", text: "Second message" }, third = { ...entry(), id: "third", text: "Third message" };
  update({ ...blank(), entries: [current, second, third] }); await mount();
  await act(async () => {
    emit({ type: "user_message", seq: 2, ts: "", clientRequestId: current.attempt!.clientRequestId, text: current.text });
    emit({ type: "session_status", seq: 3, ts: "", status: "running" });
  });
  const row = container.querySelector('[aria-label="Queued message 1"]');
  expect(row?.textContent).toContain("Message in conversation"); expect(row?.textContent).not.toContain(current.text);
  expect(row?.textContent).not.toContain("queued.txt"); expect(row?.querySelector('[aria-label="Sending message"]')).not.toBeNull();
  expect(button("Edit queued message 1")).toBeUndefined(); expect(container.textContent?.split(current.text)).toHaveLength(2);
  await click("Move queued message 3 up");
  expect(perform).toHaveBeenCalledWith({ type: "reorder", entryIds: [current.id, third.id, second.id] });
  await act(async () => update({ ...blank(), entries: [second, third] }));
  expect(container.querySelector('[aria-label="Message queue"]')?.textContent).not.toContain("Message in conversation");
  expect(container.textContent?.split(current.text)).toHaveLength(2);
});
