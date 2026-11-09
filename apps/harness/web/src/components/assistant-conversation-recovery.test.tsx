// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantConversation } from "./assistant-conversation";
import * as api from "@/lib/assistant-api";
import * as queueApi from "@/lib/message-queue-api";
import * as outboxApi from "@/lib/message-outbox";
import type { OutboxEntry } from "@/lib/message-outbox";
import { readPendingSend, rememberPendingSend, type PendingSend } from "@/lib/pending-send";

const controls = vi.hoisted(() => ({ ui: { reportSurfaceState: vi.fn(), getNavigation: () => ({ entries: [] }), navigate: vi.fn() } }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => controls.ui }));
vi.mock("@/lib/message-queue-api", async original => ({ ...await original<object>(), getMessageQueue: vi.fn(), commandMessageQueue: vi.fn(), uploadQueueAttachment: vi.fn() }));
vi.mock("@/lib/message-outbox", async original => ({ ...await original<object>(), listOutbox: vi.fn(), stageOutbox: vi.fn(), saveOutbox: vi.fn(), removeOutbox: vi.fn(), readEditDraft: vi.fn(), recordOutboxAttempt: vi.fn() }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(), getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(),
  listAppNames: vi.fn(), listAgentConnections: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn(), getMessageReceipt: vi.fn(), uploadAttachment: vi.fn() }));
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
const session: api.AssistantSession = { id: "session-one", title: "Conversation", status: "idle", createdAt: "", createdBy: "owner", appContextRevision: 4, selectionRevision: 8 };
let localRows: OutboxEntry[], queue: queueApi.MessageQueue;
const acceptCommand = async (_id: string, input: queueApi.QueueCommandInput): Promise<queueApi.QueueCommandReply> => {
  const command = input.command;
  queue = { ...queue, revision: queue.revision + 1, entries: command.type === "enqueue" ? [...queue.entries, { id: command.entryId, text: command.text,
    attachments: command.attachments.map(name => ({ id: name, name, size: 13 })), state: "queued", createdAt: "" }] : queue.entries };
  return { queue, result: { revision: queue.revision, ...(command.type === "enqueue" ? { entryId: command.entryId } : {}) } };
};
const draftKey = "hosty.assistant.draft.session-one", attachmentsKey = "hosty.assistant.attachments.session-one";
const journalKey = "hosty.assistant.pending-send.session-one";
const original: PendingSend = { version: 1, clientRequestId: "18b2e622-85f5-4c1a-a847-b3b88561bc45", sessionId: session.id,
  text: "Original draft", draftText: "Original draft", attachments: [{ name: "stored-file.txt", size: 13 }], appContextRevision: 4, withoutAppDetails: false, selectionRevision: 8 };
const message = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
const attachment = (name = "stored-file.txt") => container.querySelector(`[aria-label="Attachments to send"] [aria-label="${name}"]`);
const receipt = (request: PendingSend, state: "accepted" | "unknown" | "rejected"): api.MessageReceipt => ({ clientRequestId: request.clientRequestId, state });
const mount = () => act(async () => root.render(<AssistantConversation fullPage />));
const write = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message(), value);
  message().dispatchEvent(new Event("input", { bubbles: true }));
});
const send = () => act(async () => { container.querySelector('form[aria-label="Message composer"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const retry = () => act(async () => { button("Retry send").click(); });
const retryQueued = () => act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Message saving to queue"] button')!.click(); });
function seedPending() {
  localStorage.setItem(draftKey, original.draftText); localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments)); rememberPendingSend(original);
}
async function reload() { await act(async () => root.unmount()); root = createRoot(container); await mount(); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks();
  localRows = []; queue = { version: 1, revision: 0, ownerId: "owner", installationId: "installation", entries: [], paused: false, updatedAt: "" };
  vi.mocked(queueApi.getMessageQueue).mockImplementation(async () => queue);
  vi.mocked(queueApi.commandMessageQueue).mockImplementation(acceptCommand);
  vi.mocked(queueApi.uploadQueueAttachment).mockResolvedValue({ name: "stored-file.txt", displayName: "local-file.txt", size: 13 });
  vi.mocked(outboxApi.listOutbox).mockImplementation(async scope => localRows.filter(row => row.scope === scope));
  vi.mocked(outboxApi.stageOutbox).mockImplementation(async value => { const row = { ...value, sequence: localRows.length + 1 }; localRows.push(row); return row; });
  vi.mocked(outboxApi.saveOutbox).mockImplementation(async value => { localRows = localRows.map(row => row.scope === value.scope && row.id === value.id ? value : row); });
  vi.mocked(outboxApi.removeOutbox).mockImplementation(async (scope, id) => { localRows = localRows.filter(row => row.scope !== scope || row.id !== id); });
  vi.mocked(outboxApi.readEditDraft).mockResolvedValue(undefined);
  vi.mocked(outboxApi.recordOutboxAttempt).mockResolvedValue(true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width: 1100px"), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(api.getHealth).mockResolvedValue({ name: "fake", available: true }); vi.mocked(api.listSessions).mockResolvedValue([session]);
  vi.mocked(api.getSession).mockResolvedValue(session); vi.mocked(api.createSession).mockResolvedValue(session); vi.mocked(api.listAppNames).mockResolvedValue({});
  vi.mocked(api.listAgentConnections).mockResolvedValue({ connections: [], defaultId: null }); vi.mocked(api.streamEvents).mockResolvedValue();
  vi.mocked(api.uploadAttachment).mockResolvedValue({ name: "stored-file.txt", size: 13 });
  localStorage.setItem("hosty.assistant.session", session.id); window.history.replaceState({}, "", "/development?session=session-one");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("moves the submitted snapshot to durable local staging and preserves a newer draft after acceptance", async () => {
  let accepted!: (value: queueApi.QueueCommandReply) => void;
  vi.mocked(queueApi.commandMessageQueue).mockImplementation(() => new Promise(resolve => { accepted = resolve; }));
  localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments)); await mount(); await write(original.draftText); const field = message();
  await send();
  expect(localRows[0]).toMatchObject({ draftText: original.draftText, attachments: original.attachments });
  expect(field.value).toBe(""); expect(field.disabled).toBe(false); expect(attachment()).toBeNull();
  await write("New draft while saving");
  const [id, request] = vi.mocked(queueApi.commandMessageQueue).mock.calls[0];
  await act(async () => accepted(await acceptCommand(id, request)));
  expect(message()).toBe(field); expect(field.value).toBe("New draft while saving");
  expect(readPendingSend(session.id)).toBeNull(); expect(button("Retry send")).toBeUndefined(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("restores an uncertain enqueue with uploaded files and retries its exact UUID without uploading twice", async () => {
  vi.mocked(queueApi.commandMessageQueue).mockRejectedValueOnce(new TypeError("Acknowledgement lost")); await mount(); await write(original.draftText);
  const file = new File(["uploaded data"], "local-file.txt", { type: "text/plain" });
  const chooser = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(chooser, "files", { configurable: true, value: [file] });
  await act(async () => chooser.dispatchEvent(new Event("change", { bubbles: true })));
  await send();
  expect(queueApi.uploadQueueAttachment).toHaveBeenCalledOnce(); expect(localRows[0].files[0].stored?.name).toBe("stored-file.txt");
  const request = vi.mocked(queueApi.commandMessageQueue).mock.calls[0][1];
  await reload(); expect(message().value).toBe(""); expect(container.querySelector('[aria-label="Message saving to queue"]')?.textContent).toContain(original.draftText);
  expect(queueApi.commandMessageQueue).toHaveBeenCalledOnce(); expect(api.getMessageReceipt).not.toHaveBeenCalled();
  await retryQueued();
  expect(vi.mocked(queueApi.commandMessageQueue).mock.calls[1][1]).toEqual(request);
  expect(queueApi.uploadQueueAttachment).toHaveBeenCalledOnce(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(localRows).toHaveLength(0); expect(readPendingSend(session.id)).toBeNull();
});

it.each([
  { status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, { status: 404, code: "session_not_found" },
])("retains draft, refs and original receipt on a $status Retry refusal without replay", async ({ status, code }) => {
  seedPending(); await mount(); vi.mocked(api.getMessageReceipt).mockRejectedValueOnce(new api.AssistantApiError(code, "Access refused", status));
  await retry(); expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(readPendingSend(session.id)).toEqual(original);
  expect(message().disabled).toBe(false); expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true); expect(api.postMessage).not.toHaveBeenCalled(); expect(container.textContent).toContain("Access refused");
  await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("hosty:app-session-restored")); });
  expect(api.getMessageReceipt).toHaveBeenCalledOnce(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("retains an unknown send for another explicit check and never automatically resubmits", async () => {
  seedPending(); await mount(); vi.mocked(api.getMessageReceipt).mockResolvedValueOnce(receipt(original, "unknown")); await retry();
  expect(container.textContent).toContain("may already have been sent"); expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull();
  expect(readPendingSend(session.id)).toEqual(original); expect(api.postMessage).not.toHaveBeenCalled();
});

it("retries the exact original UUID and payload only after an explicit missing-request result", async () => {
  seedPending(); await mount();
  vi.mocked(api.getMessageReceipt).mockRejectedValueOnce(new api.AssistantApiError("message_request_not_found", "Not admitted", 404));
  vi.mocked(api.postMessage).mockResolvedValueOnce(receipt(original, "accepted")); await retry();
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(session.id, original.text, ["stored-file.txt"], 4, false, 8, original.clientRequestId);
  expect(message().value).toBe(""); expect(attachment()).toBeNull(); expect(readPendingSend(session.id)).toBeNull();
});

it("keeps another view's newer draft and attachment refs when the original receipt is accepted", async () => {
  seedPending(); await mount(); let accepted!: (value: api.MessageReceipt) => void;
  vi.mocked(api.getMessageReceipt).mockImplementation(() => new Promise(resolve => { accepted = resolve; })); await retry();
  const next = "A new draft composed in another view", files = [...original.attachments, { name: "next-file.txt", size: 9 }];
  localStorage.setItem(draftKey, next); localStorage.setItem(attachmentsKey, JSON.stringify(files));
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: draftKey, newValue: next }));
    window.dispatchEvent(new StorageEvent("storage", { key: attachmentsKey, newValue: JSON.stringify(files) }));
  });
  expect(message().value).toBe(next); expect(attachment("next-file.txt")).not.toBeNull();
  await act(async () => accepted(receipt(original, "accepted")));
  expect(message().value).toBe(next); expect(localStorage.getItem(draftKey)).toBe(next); expect(attachment()).toBeNull(); expect(attachment("next-file.txt")).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(attachmentsKey)!)).toEqual([{ name: "next-file.txt", size: 9 }]);
  expect(readPendingSend(session.id)).toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("unlocks the retained editable draft only after an explicit rejected receipt", async () => {
  seedPending(); await mount(); vi.mocked(api.getMessageReceipt).mockResolvedValueOnce({ ...receipt(original, "rejected"), error: { code: "provider_required", message: "Choose a provider" } });
  await retry(); expect(message().value).toBe(original.draftText); expect(message().disabled).toBe(false); expect(attachment()).not.toBeNull();
  expect(container.textContent).toContain("Choose a provider"); expect(readPendingSend(session.id)).toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("blocks a new send when the saved recovery journal is corrupt while keeping its draft", async () => {
  localStorage.setItem(draftKey, original.draftText); localStorage.setItem(journalKey, "{corrupt"); await mount();
  expect(message().value).toBe(original.draftText); expect(message().disabled).toBe(false); expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true); expect(container.textContent).toContain("recovery details are unavailable");
  await send(); expect(api.postMessage).not.toHaveBeenCalled(); expect(localStorage.getItem(journalKey)).toBe("{corrupt");
});

it("retains the editable draft if local staging is unavailable and the server has not accepted it", async () => {
  await mount(); await write(original.draftText);
  vi.mocked(outboxApi.stageOutbox).mockRejectedValueOnce(new DOMException("Quota", "QuotaExceededError"));
  vi.mocked(queueApi.commandMessageQueue).mockRejectedValueOnce(new Error("Queue connection lost"));
  await send(); expect(api.postMessage).not.toHaveBeenCalled(); expect(message().value).toBe(original.draftText); expect(message().disabled).toBe(false);
  expect(container.textContent).toContain("Queue connection lost"); expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true);
});

it("settles exact missing-request replay's pre-admission refusal and keeps the editable draft", async () => {
  seedPending(); await mount();
  vi.mocked(api.getMessageReceipt).mockRejectedValueOnce(new api.AssistantApiError("message_request_not_found", "Not admitted", 404));
  vi.mocked(api.postMessage).mockRejectedValueOnce(new api.AssistantApiError("selection_conflict", "Selection changed", 409));
  await retry(); expect(message().disabled).toBe(false); expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull();
  expect(readPendingSend(session.id)).toBeNull(); expect(container.textContent).toContain("Selection changed");
  expect(api.postMessage).toHaveBeenCalledExactlyOnceWith(session.id, original.text, ["stored-file.txt"], 4, false, 8, original.clientRequestId);
});

it("keeps an uncertain request locked when only the receipt GET reports a selection conflict", async () => {
  seedPending(); await mount(); vi.mocked(api.getMessageReceipt).mockRejectedValueOnce(new api.AssistantApiError("selection_conflict", "Could not inspect receipt", 409));
  await retry(); expect(message().disabled).toBe(false); expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true); expect(readPendingSend(session.id)).toEqual(original);
  expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("observes a pending claim made by another mounted view and blocks a fresh Send", async () => {
  localStorage.setItem(draftKey, original.draftText); await mount(); expect(message().disabled).toBe(false);
  await act(async () => rememberPendingSend(original));
  expect(message().disabled).toBe(false); expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true); expect(button("Retry send")).toBeDefined();
  await send(); expect(api.postMessage).not.toHaveBeenCalled(); expect(readPendingSend(session.id)).toEqual(original);
});

it("preserves queue-owned uploads when incidental legacy draft attachment storage is unavailable", async () => {
  await mount(); await write(original.draftText);
  const file = new File(["uploaded data"], "local-file.txt", { type: "text/plain" });
  const chooser = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(chooser, "files", { configurable: true, value: [file] });
  await act(async () => chooser.dispatchEvent(new Event("change", { bubbles: true })));
  const save = Storage.prototype.setItem;
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === attachmentsKey) throw new DOMException("Quota", "QuotaExceededError"); save.call(this, key, value);
  });
  await send(); expect(queueApi.uploadQueueAttachment).toHaveBeenCalledOnce(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(queueApi.commandMessageQueue).toHaveBeenCalledOnce();
  expect(vi.mocked(queueApi.commandMessageQueue).mock.calls[0][1].command).toMatchObject({ type: "enqueue", attachments: ["stored-file.txt"] });
  storage.mockRestore();
  expect(message().value).toBe(""); expect(attachment()).toBeNull();
});

it("does not let a late accepted receipt clear another view's newer UUID with identical text and refs", async () => {
  seedPending(); await mount(); let accepted!: (value: api.MessageReceipt) => void;
  vi.mocked(api.getMessageReceipt).mockImplementation(() => new Promise(resolve => { accepted = resolve; })); await retry();
  const newer = { ...original, clientRequestId: "40297a84-3183-4dce-a42a-487efb9ed5a6" };
  localStorage.removeItem(journalKey);
  await act(async () => rememberPendingSend(newer));
  await act(async () => accepted(receipt(original, "accepted")));
  expect(readPendingSend(session.id)).toEqual(newer); expect(localStorage.getItem(draftKey)).toBe(original.draftText);
  expect(JSON.parse(localStorage.getItem(attachmentsKey)!)).toEqual(original.attachments);
  expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(message().disabled).toBe(false); expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true);
  expect(button("Retry send")).toBeDefined(); expect(api.postMessage).not.toHaveBeenCalled();
});


it("settles a legacy replay's known workspace refusal and queues an intentional new message", async () => {
  const refusal = new api.AssistantApiError("workspace_in_use", "Return or recover the pending app transition before starting writers.", 409);
  localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments));
  seedPending();
  await mount();
  vi.mocked(api.getMessageReceipt).mockRejectedValueOnce(new api.AssistantApiError("message_request_not_found", "Not admitted", 404));
  vi.mocked(api.postMessage).mockRejectedValueOnce(refusal);
  await retry();
  const refusedId = vi.mocked(api.postMessage).mock.calls[0][6];
  expect(refusedId).toBe(original.clientRequestId);
  expect(readPendingSend(session.id)).toBeNull();
  expect(button("Retry send")).toBeUndefined();
  expect(message().disabled).toBe(false);
  expect(message().value).toBe(original.draftText);
  expect(attachment()).not.toBeNull();
  expect(container.textContent).toContain(refusal.message);
  // The operator has completed Return and intentionally sends the retained draft again.
  await send();
  expect(api.postMessage).toHaveBeenCalledOnce();
  expect(queueApi.commandMessageQueue).toHaveBeenCalledOnce();
  expect(vi.mocked(queueApi.commandMessageQueue).mock.calls[0][1].requestId).not.toBe(refusedId);
  expect(api.uploadAttachment).not.toHaveBeenCalled();
  expect(message().value).toBe("");
  expect(attachment()).toBeNull();
});

it("retains a refused enqueue on its row and retries the identical command after workspace recovery", async () => {
  const refusal = new api.AssistantApiError("workspace_in_use", "Recover the workspace before submitting this message.", 409);
  localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments));
  await mount(); await write(original.draftText);
  vi.mocked(queueApi.commandMessageQueue).mockRejectedValueOnce(refusal);
  await send();
  const request = vi.mocked(queueApi.commandMessageQueue).mock.calls[0][1];
  expect(message().value).toBe(""); expect(message().disabled).toBe(false);
  expect(container.querySelector('[aria-label="Message saving to queue"]')?.textContent).toContain(refusal.message);
  expect(readPendingSend(session.id)).toBeNull();
  await retryQueued();
  expect(vi.mocked(queueApi.commandMessageQueue).mock.calls[1][1]).toEqual(request);
  expect(api.postMessage).not.toHaveBeenCalled(); expect(queueApi.uploadQueueAttachment).not.toHaveBeenCalled();
  expect(localRows).toHaveLength(0);
});
