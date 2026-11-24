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
  listAppNames: vi.fn(), listAgentConnections: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn(), getMessageReceipt: vi.fn(), uploadAttachment: vi.fn(),
  getStorageRecovery: vi.fn(), getExecutionRecovery: vi.fn(), recoverExecution: vi.fn(), stopSession: vi.fn() }));
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), useDevelopmentInventory: () => ({ workspaces: [], loading: false, error: "", refresh: vi.fn() }) }));
vi.mock("./speech-input", () => ({ SpeechInput: () => null }));
vi.mock("./session-credentials", () => ({ SessionCredentials: () => null }));
vi.mock("./session-autonomy", () => ({ SessionAutonomy: () => null }));
vi.mock("./app-context-picker", () => ({ AppContextPicker: () => null }));
vi.mock("./ui/message-scroller", async original => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...await original<object>(), ...Object.fromEntries(["MessageScroller", "MessageScrollerProvider", "MessageScrollerViewport", "MessageScrollerContent", "MessageScrollerItem"].map(name => [name, Wrap])), MessageScrollerButton: () => null };
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
  delete session.storageRecovery; delete session.sourceAdmission; delete session.sourceAdmissionInFlight; delete session.stopUnconfirmed; session.status = "idle";
  vi.mocked(api.getStorageRecovery).mockResolvedValue({ issues: [] }); vi.mocked(api.getExecutionRecovery).mockResolvedValue(null);
  vi.mocked(api.recoverExecution).mockResolvedValue();
  vi.mocked(api.stopSession).mockResolvedValue();
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

it("retains a visible draft and attachments while a source storage fence blocks submission across reload", async () => {
  session.storageRecovery = { state: "required", code: "session_storage_unavailable", message: "This session needs storage recovery." };
  localStorage.setItem(draftKey, original.draftText); localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments));
  await mount();
  expect(message().value).toBe(original.draftText); expect(message().readOnly).toBe(true); expect(attachment()).not.toBeNull();
  const notice = container.querySelector('[aria-label="Session storage recovery"]');
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.closest<HTMLElement>('[role="region"][aria-label="Session notices"]')?.tabIndex).toBe(0);
  expect(notice?.querySelector('[data-slot="alert-description"]')?.textContent).toContain("Your draft is preserved");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true);
  await send(); await reload();
  expect(message().value).toBe(original.draftText); expect(localStorage.getItem(draftKey)).toBe(original.draftText);
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(api.recoverExecution).not.toHaveBeenCalled();
});

it("keeps both recovery notices hidden while a new turn is being admitted", async () => {
  session.status = "running";
  session.sourceAdmission = { state: "dispatching", runId: "normal-run" };
  session.sourceAdmissionInFlight = true;
  let finishReview!: (value: null) => void;
  vi.mocked(api.getExecutionRecovery).mockImplementationOnce(() => new Promise(resolve => { finishReview = resolve; }));
  localStorage.setItem(draftKey, original.draftText);
  await mount();
  expect(container.querySelector("header")?.textContent).toContain("running");
  expect(message().readOnly).toBe(true);
  expect(container.querySelector('[aria-label="Session storage recovery"]')).toBeNull();
  expect(container.querySelector('[aria-label="Interrupted execution recovery"]')).toBeNull();

  vi.mocked(api.getSession).mockResolvedValue({ ...session, sourceAdmission: undefined, sourceAdmissionInFlight: undefined });
  await act(async () => finishReview(null));
  expect(message().readOnly).toBe(false);
  expect(message().value).toBe(original.draftText);
  expect(container.querySelector('[aria-label="Session storage recovery"]')).toBeNull();
  expect(container.querySelector('[aria-label="Interrupted execution recovery"]')).toBeNull();
});

it("shows an interrupted run without a recovery button when the provider cannot reconcile it", async () => {
  session.sourceAdmission = { state: "dispatching", runId: "interrupted-run" };
  vi.mocked(api.getExecutionRecovery).mockResolvedValue({ recoverable: false, runId: "interrupted-run", generation: "provider", expectedRevision: "1" });
  await mount();
  const panel = container.querySelector('[aria-label="Interrupted execution recovery"]');
  expect(panel?.textContent).toContain("process exit is unconfirmed");
  expect(panel?.querySelector("button")?.textContent).toBe("Check status");
  expect(button("Recover stopped execution")).toBeUndefined();
  expect(container.querySelector('[aria-label="Stop"]')).not.toBeNull();
});

it("opens source-only recovery and preserves the draft after an explicitly confirmed recovery without sending it", async () => {
  session.sourceAdmission = { state: "preparing", clientRequestId: original.clientRequestId, runId: "interrupted-run" };
  vi.mocked(api.getExecutionRecovery).mockResolvedValue({ sourceOnly: true, recoverable: true, runId: "interrupted-run", generation: "worker", expectedRevision: 1 });
  localStorage.setItem(draftKey, original.draftText); await mount();
  const field = message(); expect(field.readOnly).toBe(true);
  const panel = container.querySelector('[aria-label="Interrupted execution recovery"]')!;
  expect(panel.getAttribute("role")).toBe("status");
  expect(panel.querySelector('[data-slot="alert-description"]')?.textContent).toContain("before a Worker execution receipt was recorded");
  expect(panel.querySelector('[data-slot="alert-action"] button')?.textContent).toBe("Recover stopped execution");
  expect(api.recoverExecution).not.toHaveBeenCalled();
  vi.mocked(api.getSession).mockResolvedValue({ ...session, sourceAdmission: undefined });
  await act(async () => panel.querySelector<HTMLButtonElement>("button")!.click());
  expect(api.recoverExecution).toHaveBeenCalledExactlyOnceWith(session.id, expect.objectContaining({ runId: "interrupted-run", consumerExitConfirmed: true }));
  expect(message()).toBe(field); expect(message().value).toBe(original.draftText); expect(message().readOnly).toBe(false);
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("keeps Stop available when a failed admission still needs native exit confirmation", async () => {
  session.status = "failed";
  session.sourceAdmission = { state: "dispatching", runId: "retained-native-run" };
  vi.mocked(api.getExecutionRecovery).mockRejectedValue(new api.AssistantApiError("recovery_active", "Retry Stop before recovery.", 409));
  localStorage.setItem(draftKey, original.draftText); await mount();
  const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop"]');
  expect(stop).not.toBeNull(); expect(stop!.disabled).toBe(false);
  await act(async () => stop!.click());
  expect(api.stopSession).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(message().value).toBe(original.draftText);
  expect(api.recoverExecution).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
});


it.each(["preparing", "dispatching"] as const)("refreshes a settled %s admission after a null recovery review without reopening the chat", async state => {
  session.sourceAdmission = { state, clientRequestId: original.clientRequestId, runId: "normal-run" };
  const initial = { ...session };
  vi.mocked(api.getSession).mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, sourceAdmission: undefined });
  localStorage.setItem(draftKey, original.draftText);
  await mount();
  expect(api.getExecutionRecovery).toHaveBeenCalledWith(session.id);
  expect(vi.mocked(api.getSession).mock.calls.length).toBeGreaterThan(1);
  expect(message().value).toBe(original.draftText); expect(message().readOnly).toBe(false);
  expect(container.querySelector('[aria-label="Session storage recovery"]')).toBeNull();
  expect(localStorage.getItem(draftKey)).toBe(original.draftText);
  expect(api.recoverExecution).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
});

it("refreshes the admission fence on a live completion even when recovery review is still unavailable", async () => {
  session.status = "running";
  session.sourceAdmission = { state: "dispatching", runId: "normal-run" };
  vi.mocked(api.getExecutionRecovery).mockRejectedValue(new api.AssistantApiError("recovery_active", "The execution is active.", 409));
  localStorage.setItem(draftKey, original.draftText); await mount();
  const field = message(); expect(field.readOnly).toBe(true);
  const emit = vi.mocked(api.streamEvents).mock.calls.at(-1)![1];
  const completed = { ...session, status: "idle", sourceAdmission: undefined, lastEventSeq: 4, updatedAt: "2026-11-12T12:00:00Z" };
  vi.mocked(api.getSession).mockResolvedValue(completed);
  await act(async () => emit({ type: "session_status", status: "idle", seq: 4, ts: completed.updatedAt }));
  expect(message()).toBe(field); expect(field.value).toBe(original.draftText); expect(field.readOnly).toBe(false);
  expect(container.querySelector('[aria-label="Session storage recovery"]')).toBeNull();
  expect(api.recoverExecution).not.toHaveBeenCalled(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
});


it("keeps the admission fence when the authoritative refresh still reports it", async () => {
  session.sourceAdmission = { state: "preparing", runId: "unresolved-run" };
  localStorage.setItem(draftKey, original.draftText); await mount();
  expect(vi.mocked(api.getSession).mock.calls.length).toBeGreaterThan(1);
  expect(message().readOnly).toBe(true); expect(message().value).toBe(original.draftText);
  expect(container.querySelector('[aria-label="Session storage recovery"]')).not.toBeNull();
  expect(api.recoverExecution).not.toHaveBeenCalled(); expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
});

it("does not let a delayed null-review refresh roll back a newer live status", async () => {
  session.sourceAdmission = { state: "preparing", runId: "normal-run" };
  let finish!: (value: api.AssistantSession) => void;
  const initial = { ...session };
  vi.mocked(api.getSession).mockResolvedValueOnce(initial).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  localStorage.setItem(draftKey, original.draftText); await mount();
  const current = { ...session, status: "running", sourceAdmission: undefined, lastEventSeq: 4, updatedAt: "2026-11-12T12:00:00Z" };
  vi.mocked(api.getSession).mockResolvedValue(current);
  const emit = vi.mocked(api.streamEvents).mock.calls.at(-1)![1];
  await act(async () => {
    emit({ type: "session_status", status: "running", seq: 4, ts: current.updatedAt });
    finish({ ...initial, sourceAdmission: undefined, lastEventSeq: 2, updatedAt: "2026-11-12T11:59:00Z" });
  });
  expect(container.querySelector("header")?.textContent).toContain("running");
  expect(message().value).toBe(original.draftText); expect(message().readOnly).toBe(false);
  expect(api.recoverExecution).not.toHaveBeenCalled(); expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
});

it("shows one current recovery notice, checks the original send without replay and exposes Retry only after the provider fences it", async () => {
  const providerMessage = "Retained provider state requires recovery.";
  const stopReason = "Stop was not confirmed. Check status before resuming.";
  const unconfirmed = "The provider has no record of this send. Retry Stop to prevent the original request from starting.";
  const queued: queueApi.QueueEntry = { id: "affected-entry", text: "Earlier send", attachments: [], state: "unknown", createdAt: "",
    attempt: { clientRequestId: original.clientRequestId }, error: { code: "storage_uncertain", message: providerMessage } };
  session.status = "running";
  session.sourceAdmission = { state: "dispatching", runId: "unconfirmed-run", clientRequestId: original.clientRequestId };
  queue = { ...queue, entries: [queued], paused: true, reason: stopReason };
  vi.mocked(api.getExecutionRecovery).mockRejectedValue(new api.AssistantApiError("storage_uncertain", providerMessage, 503));
  vi.mocked(api.stopSession).mockRejectedValueOnce(new api.AssistantApiError("storage_uncertain", providerMessage, 503));
  localStorage.setItem(draftKey, original.draftText);
  localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments));
  await mount();
  const [, emit, , connect] = vi.mocked(api.streamEvents).mock.calls.at(-1)!;
  await act(async () => {
    const ts = "2026-11-24T11:59:00Z";
    emit({ type: "user_message", seq: 1, ts, text: "Historic turn" });
    emit({ type: "notice", seq: 2, ts, code: "storage_uncertain", message: "Earlier storage incident" });
    emit({ type: "user_message", seq: 3, ts, text: queued.text, clientRequestId: original.clientRequestId });
    emit({ type: "notice", seq: 4, ts, code: "storage_uncertain", message: providerMessage });
    emit({ type: "notice", seq: 5, ts, message: providerMessage });
    connect?.("connected");
    container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!.click();
  });

  const noticeRegion = container.querySelector('[aria-label="Session notices"]')!;
  expect(noticeRegion.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
  expect(container.textContent!.split(providerMessage)).toHaveLength(2);
  expect(container.textContent).toContain("Earlier storage incident");
  expect(container.textContent).not.toContain(stopReason);
  expect(container.textContent).not.toContain("Working…");
  expect(container.querySelector("header")?.textContent).toContain("unknown");
  expect(button("Retry")).toBeUndefined();
  expect(button("Recover stopped execution")).toBeUndefined();

  vi.mocked(api.getExecutionRecovery).mockRejectedValue(new api.AssistantApiError("provider_admission_unconfirmed", unconfirmed, 409));
  const queueReads = vi.mocked(queueApi.getMessageQueue).mock.calls.length;
  await act(async () => button("Check status").click());
  expect(noticeRegion.textContent).toContain(unconfirmed);
  expect(vi.mocked(queueApi.getMessageQueue).mock.calls.length).toBe(queueReads + 1);
  expect(api.stopSession).toHaveBeenCalledTimes(1);
  expect(api.recoverExecution).not.toHaveBeenCalled();
  expect(api.postMessage).not.toHaveBeenCalled();
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
  expect(message().value).toBe(original.draftText);
  expect(attachment()).not.toBeNull();

  const settled = { ...session, status: "cancelled", sourceAdmission: undefined };
  queue = { ...queue, revision: 2, reason: "Response stopped. Resume the queue when ready.",
    entries: [{ ...queued, state: "failed", error: { code: "run_not_admitted", message: "The original send did not run. Retry when ready." } }] };
  vi.mocked(api.getSession).mockResolvedValue(settled);
  vi.mocked(api.getExecutionRecovery).mockResolvedValue(null);
  await act(async () => button("Retry Stop").click());
  expect(api.stopSession).toHaveBeenCalledTimes(2);
  expect(noticeRegion.textContent).toBe("");
  expect(button("Retry")?.disabled).toBe(false);
  expect(container.textContent).toContain("The original send did not run.");
  expect(message().readOnly).toBe(false);
  expect(message().value).toBe(original.draftText);
  expect(attachment()).not.toBeNull();
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
});

it("clears a standalone Stop warning when a later live session observation confirms cancellation", async () => {
  session.status = "running";
  vi.mocked(api.stopSession).mockRejectedValueOnce(new Error("Could not confirm Stop"));
  await mount();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click());
  expect(container.querySelector('[aria-label="Session recovery"]')?.textContent).toContain("Could not confirm Stop");

  const emit = vi.mocked(api.streamEvents).mock.calls.at(-1)![1];
  vi.mocked(api.getSession).mockResolvedValue({ ...session, status: "cancelled", lastEventSeq: 1, updatedAt: "2026-11-24T12:00:00Z" });
  await act(async () => emit({ type: "session_status", status: "cancelled", seq: 1, ts: "2026-11-24T12:00:00Z" }));
  expect(container.querySelector('[aria-label="Session recovery"]')).toBeNull();
  expect(container.querySelector("header")?.textContent).toContain("cancelled");
});

it("restores the Stop notice from the retained session after reload without any queued messages", async () => {
  session.status = "running";
  session.stopUnconfirmed = true;
  localStorage.setItem(draftKey, original.draftText);
  localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments));
  await mount();
  await reload();

  const notice = () => container.querySelector('[aria-label="Session recovery"]');
  expect(notice()?.textContent).toContain("Stop not confirmed");
  expect(container.querySelector('[aria-label="Message queue"]')).toBeNull();
  queue = { ...queue, revision: 1, paused: true, reason: "Stop was not confirmed. Check status before resuming.",
    entries: [{ id: "queued", text: "Another message", attachments: [], state: "queued", createdAt: "" }] };
  await act(async () => button("Check status").click());
  expect(notice()?.textContent).toContain("Waiting for the provider to confirm");
  expect(button("Resume queue")?.disabled).toBe(true);
  expect(api.stopSession).not.toHaveBeenCalled();
  expect(api.recoverExecution).not.toHaveBeenCalled();

  vi.mocked(api.getSession).mockResolvedValue({ ...session, status: "cancelled", stopUnconfirmed: undefined });
  queue = { ...queue, revision: 2, reason: "Response stopped. Resume the queue when ready." };
  await act(async () => button("Check status").click());
  expect(notice()).toBeNull();
  expect(button("Resume queue")?.disabled).toBe(false);
  expect(container.querySelector("header")?.textContent).toContain("cancelled");
  expect(message().value).toBe(original.draftText);
  expect(attachment()).not.toBeNull();
  expect(queueApi.commandMessageQueue).not.toHaveBeenCalled();
  expect(api.postMessage).not.toHaveBeenCalled();
});
