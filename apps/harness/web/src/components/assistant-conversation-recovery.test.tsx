// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantConversation } from "./assistant-conversation";
import * as api from "@/lib/assistant-api";
import { readPendingSend, rememberPendingSend, type PendingSend } from "@/lib/pending-send";

const controls = vi.hoisted(() => ({ ui: { reportSurfaceState: vi.fn(), getNavigation: () => ({ entries: [] }), navigate: vi.fn() } }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => controls.ui }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<object>(), getHealth: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), createSession: vi.fn(),
  listAppNames: vi.fn(), listAgentConnections: vi.fn(), streamEvents: vi.fn(), postMessage: vi.fn(), getMessageReceipt: vi.fn(), uploadAttachment: vi.fn() }));
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), useDevelopmentInventory: () => ({ workspaces: [], loading: false, error: "", refresh: vi.fn() }) }));
vi.mock("./speech-input", () => ({ SpeechInput: () => null }));
vi.mock("./session-credentials", () => ({ SessionCredentials: () => null }));
vi.mock("./session-retention", () => ({ SessionRetention: () => null }));
vi.mock("./session-autonomy", () => ({ SessionAutonomy: () => null }));
vi.mock("./app-context-picker", () => ({ AppContextPicker: () => null }));
vi.mock("./ui/message-scroller", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...Object.fromEntries(["MessageScroller", "MessageScrollerProvider", "MessageScrollerViewport", "MessageScrollerContent", "MessageScrollerItem"].map(name => [name, Wrap])), MessageScrollerButton: () => null };
});

let root: Root, container: HTMLDivElement;
const session: api.AssistantSession = { id: "session-one", title: "Conversation", status: "idle", createdAt: "", appContextRevision: 4, selectionRevision: 8 };
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
function seedPending() {
  localStorage.setItem(draftKey, original.draftText); localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments)); rememberPendingSend(original);
}
async function reload() { await act(async () => root.unmount()); root = createRoot(container); await mount(); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks();
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

it("retains the exact draft and uploaded refs until the send is accepted", async () => {
  let accepted!: (value: api.MessageReceipt) => void;
  vi.mocked(api.postMessage).mockImplementation(() => new Promise(resolve => { accepted = resolve; }));
  localStorage.setItem(attachmentsKey, JSON.stringify(original.attachments)); await mount(); await write(original.draftText); const field = message();
  await send(); const pending = readPendingSend(session.id)!;
  expect(pending).toMatchObject({ draftText: original.draftText, attachments: original.attachments });
  expect(field.value).toBe(original.draftText); expect(field.disabled).toBe(true); expect(attachment()).not.toBeNull();
  expect(localStorage.getItem(draftKey)).toBe(original.draftText);
  await act(async () => accepted(receipt(pending, "accepted")));
  expect(message()).toBe(field); expect(field.value).toBe(""); expect(attachment()).toBeNull();
  expect(readPendingSend(session.id)).toBeNull(); expect(button("Retry send")).toBeUndefined(); expect(api.postMessage).toHaveBeenCalledOnce();
});

it("restores a lost-ack send with newly uploaded attachments after reload and checks GET without a second POST", async () => {
  vi.mocked(api.postMessage).mockRejectedValueOnce(new TypeError("Acknowledgement lost")); await mount(); await write(original.draftText);
  const file = new File(["uploaded data"], "local-file.txt", { type: "text/plain" });
  const chooser = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(chooser, "files", { configurable: true, value: [file] });
  await act(async () => chooser.dispatchEvent(new Event("change", { bubbles: true })));
  await send(); const pending = readPendingSend(session.id)!;
  expect(api.uploadAttachment).toHaveBeenCalledOnce(); expect(pending.attachments).toEqual(original.attachments); expect(attachment()).not.toBeNull();
  await reload(); expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull();
  expect(api.postMessage).toHaveBeenCalledOnce(); expect(api.getMessageReceipt).not.toHaveBeenCalled();
  vi.mocked(api.getMessageReceipt).mockResolvedValueOnce(receipt(pending, "accepted")); await retry();
  expect(api.getMessageReceipt).toHaveBeenCalledExactlyOnceWith(session.id, pending.clientRequestId);
  expect(api.postMessage).toHaveBeenCalledOnce(); expect(api.uploadAttachment).toHaveBeenCalledOnce();
  expect(message().value).toBe(""); expect(attachment()).toBeNull(); expect(readPendingSend(session.id)).toBeNull();
});

it.each([
  { status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, { status: 404, code: "session_not_found" },
])("retains draft, refs and original receipt on a $status Retry refusal without replay", async ({ status, code }) => {
  seedPending(); await mount(); vi.mocked(api.getMessageReceipt).mockRejectedValueOnce(new api.AssistantApiError(code, "Access refused", status));
  await retry(); expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(readPendingSend(session.id)).toEqual(original);
  expect(message().disabled).toBe(true); expect(api.postMessage).not.toHaveBeenCalled(); expect(container.textContent).toContain("Access refused");
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
  expect(message().value).toBe(original.draftText); expect(message().disabled).toBe(true); expect(container.textContent).toContain("recovery details are unavailable");
  await send(); expect(api.postMessage).not.toHaveBeenCalled(); expect(localStorage.getItem(journalKey)).toBe("{corrupt");
});

it("does not POST when browser storage refuses the recovery journal", async () => {
  await mount(); await write(original.draftText);
  const save = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === journalKey) throw new DOMException("Quota", "QuotaExceededError"); save.call(this, key, value);
  });
  await send(); expect(api.postMessage).not.toHaveBeenCalled(); expect(message().value).toBe(original.draftText); expect(message().disabled).toBe(false);
  expect(container.textContent).toContain("message was not sent");
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
  await retry(); expect(message().disabled).toBe(true); expect(readPendingSend(session.id)).toEqual(original);
  expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(api.postMessage).not.toHaveBeenCalled();
});

it("observes a pending claim made by another mounted view and blocks a fresh Send", async () => {
  localStorage.setItem(draftKey, original.draftText); await mount(); expect(message().disabled).toBe(false);
  await act(async () => rememberPendingSend(original));
  expect(message().disabled).toBe(true); expect(button("Retry send")).toBeDefined();
  await send(); expect(api.postMessage).not.toHaveBeenCalled(); expect(readPendingSend(session.id)).toEqual(original);
});

it("keeps uploaded refs in the current draft when persistence fails, without re-uploading on an intentional retry", async () => {
  await mount(); await write(original.draftText);
  const file = new File(["uploaded data"], "local-file.txt", { type: "text/plain" });
  const chooser = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(chooser, "files", { configurable: true, value: [file] });
  await act(async () => chooser.dispatchEvent(new Event("change", { bubbles: true })));
  const save = Storage.prototype.setItem;
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === attachmentsKey) throw new DOMException("Quota", "QuotaExceededError"); save.call(this, key, value);
  });
  await send(); expect(api.uploadAttachment).toHaveBeenCalledOnce(); expect(api.postMessage).not.toHaveBeenCalled();
  expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(message().disabled).toBe(false);
  storage.mockRestore(); vi.mocked(api.postMessage).mockImplementation(async (...args) => ({ clientRequestId: args[6]!, state: "accepted" }));
  await send(); expect(api.uploadAttachment).toHaveBeenCalledOnce(); expect(api.postMessage).toHaveBeenCalledOnce();
  expect(vi.mocked(api.postMessage).mock.calls[0][2]).toEqual(["stored-file.txt"]);
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
  expect(message().value).toBe(original.draftText); expect(attachment()).not.toBeNull(); expect(message().disabled).toBe(true);
  expect(button("Retry send")).toBeDefined(); expect(api.postMessage).not.toHaveBeenCalled();
});
