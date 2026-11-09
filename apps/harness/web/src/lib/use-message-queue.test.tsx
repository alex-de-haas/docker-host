// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantApiError, type AssistantSession, type StoredAttachment } from "./assistant-api";
import { useMessageQueue } from "./use-message-queue";
import { commandMessageQueue, getMessageQueue, uploadQueueAttachment, type MessageQueue, type QueueCommandInput, type QueueCommandReply } from "./message-queue-api";
import { listOutbox, outboxScope, saveOutbox, stageOutbox, type OutboxEntry } from "./message-outbox";

vi.mock("./message-queue-api", () => ({ commandMessageQueue: vi.fn(), getMessageQueue: vi.fn(), uploadQueueAttachment: vi.fn() }));
vi.mock("./message-outbox", () => ({
  OUTBOX_CHANGED: "hosty:test-outbox-changed", listOutbox: vi.fn(), saveOutbox: vi.fn(), stageOutbox: vi.fn(), removeOutbox: vi.fn(), withOutboxLock: vi.fn(),
  outboxScope: (installationId: string, ownerId: string, sessionId: string) => JSON.stringify([location.origin, installationId, ownerId, sessionId]),
  outboxFiles: (files: File[]) => files.map(file => ({ id: crypto.randomUUID(), name: file.name, type: file.type, bytes: file })),
}));
import { removeOutbox, withOutboxLock } from "./message-outbox";

const owner = "actor-a", installation = "installation-a";
const session = (id = "chat-a", createdBy = owner): AssistantSession => ({ id, createdBy, title: null, status: "idle", createdAt: "" });
const queue = (ownerId = owner, installationId = installation, revision = 0): MessageQueue => ({
  version: 1, revision, ownerId, installationId, entries: [], paused: false, updatedAt: "2026-11-09T12:00:00Z",
});
const draft = (text: string, files: File[] = []) => ({ text, draftText: text, files, attachments: [] as StoredAttachment[] });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
// The mocked persistence boundary returns independent snapshots, as IndexedDB structured cloning
// does. Bytes remain Blobs; their actual browser persistence is covered by the Chromium tests.
function copyEntry(row: OutboxEntry): OutboxEntry {
  return { ...row, files: row.files.map(file => ({ ...file, ...(file.stored ? { stored: { ...file.stored } } : {}) })),
    attachments: row.attachments.map(file => ({ ...file })), ...(row.command ? { command: structuredClone(row.command) } : {}) };
}
const key = (scope: string, id: string) => JSON.stringify([scope, id]);
const changed = (scope: string) => window.dispatchEvent(new CustomEvent("hosty:test-outbox-changed", { detail: scope }));
let root: Root, element: HTMLDivElement, hook: ReturnType<typeof useMessageQueue>;
let rows: Map<string, OutboxEntry>, servers: Map<string, MessageQueue>, locks: Map<string, Promise<void>>, sequence: number;
let receipts: Map<string, QueueCommandReply["result"]>;
function Probe({ value, ready }: { value: AssistantSession | null; ready: boolean }) {
  const observed = useMessageQueue(value, ready);
  useLayoutEffect(() => { hook = observed; });
  return null;
}
const render = (value: AssistantSession | null = session(), ready = true) => act(async () => { root.render(<Probe value={value} ready={ready} />); });
const drain = () => act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
async function until(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    await drain();
    try { assertion(); return; } catch (cause) { last = cause; }
  }
  throw last;
}
function seed(row: Partial<OutboxEntry> & Pick<OutboxEntry, "id">): OutboxEntry {
  const value: OutboxEntry = { scope: outboxScope(installation, owner, "chat-a"), sessionId: "chat-a", text: "Saved message", draftText: "Saved message",
    sequence: ++sequence, attachments: [], files: [], ...row };
  rows.set(key(value.scope, value.id), copyEntry(value)); return value;
}
function accepted(sessionId: string, input: QueueCommandInput): QueueCommandReply {
  const state = servers.get(sessionId)!;
  const receiptKey = key(sessionId, input.requestId), prior = receipts.get(receiptKey);
  if (prior) return { queue: structuredClone(state), result: prior };
  if (input.expectedRevision !== state.revision) throw new AssistantApiError("queue_revision_conflict", "Queue changed", 409);
  state.revision++;
  if (input.command.type === "enqueue") state.entries.push({ id: input.command.entryId, text: input.command.text,
    attachments: input.command.attachments.map(name => ({ id: name, name, size: 1 })), createdAt: "", state: "queued" });
  if (input.command.type === "pause") state.paused = true;
  const result = { revision: state.revision };
  receipts.set(receiptKey, result); return { queue: structuredClone(state), result };
}

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("indexedDB", {}); vi.stubGlobal("BroadcastChannel", undefined);
  rows = new Map(); servers = new Map([["chat-a", queue()], ["chat-b", queue("actor-b")]]); locks = new Map(); receipts = new Map(); sequence = 0;
  vi.mocked(listOutbox).mockImplementation(async scope => [...rows.values()].filter(row => row.scope === scope).map(copyEntry).sort((a, b) => a.sequence - b.sequence));
  vi.mocked(stageOutbox).mockImplementation(async value => {
    const previous = rows.get(key(value.scope, value.id)); if (previous) return copyEntry(previous);
    const row = copyEntry({ ...value, sequence: ++sequence }); rows.set(key(row.scope, row.id), row); changed(row.scope); return copyEntry(row);
  });
  vi.mocked(saveOutbox).mockImplementation(async row => { if (rows.has(key(row.scope, row.id))) rows.set(key(row.scope, row.id), copyEntry(row)); changed(row.scope); });
  vi.mocked(removeOutbox).mockImplementation(async (scope, id) => { rows.delete(key(scope, id)); changed(scope); });
  vi.mocked(withOutboxLock).mockImplementation((scope, action) => {
    const result = (locks.get(scope) ?? Promise.resolve()).then(action);
    locks.set(scope, result.then(() => {}, () => {})); return result;
  });
  vi.mocked(getMessageQueue).mockImplementation(async id => structuredClone(servers.get(id)!));
  vi.mocked(commandMessageQueue).mockImplementation(async (id, input) => accepted(id, input));
  vi.mocked(uploadQueueAttachment).mockImplementation(async (_id, uploadId, name, bytes) => ({ name: `q-${uploadId}-${name}`, size: bytes.size }));
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps FIFO when the first file upload is slow and another message is staged", async () => {
  const upload = deferred<StoredAttachment>(); vi.mocked(uploadQueueAttachment).mockReturnValueOnce(upload.promise);
  await render(); await drain();
  await act(async () => { await hook.enqueue(draft("First", [new File(["file bytes"], "notes.txt")])); });
  await until(() => expect(uploadQueueAttachment).toHaveBeenCalledOnce());
  await act(async () => { await hook.enqueue(draft("Second")); });
  expect(hook.outbox.map(row => row.text)).toEqual(["First", "Second"]); expect(commandMessageQueue).not.toHaveBeenCalled();
  await act(async () => upload.resolve({ name: "stored-notes.txt", size: 10 }));
  await until(() => expect(rows.size).toBe(0));
  const posts = vi.mocked(commandMessageQueue).mock.calls.map(([, value]) => value.command);
  expect(posts).toEqual([expect.objectContaining({ type: "enqueue", text: "First", attachments: ["stored-notes.txt"] }),
    expect.objectContaining({ type: "enqueue", text: "Second", attachments: [] })]);
  expect(uploadQueueAttachment).toHaveBeenCalledOnce();
});

it("persists and replays the exact POST UUID and payload after server acceptance with a lost reply", async () => {
  vi.mocked(commandMessageQueue).mockImplementationOnce(async (id, input) => { accepted(id, input); throw new Error("Reply lost"); });
  await render(); await drain();
  await act(async () => { await hook.enqueue({ ...draft("Keep this snapshot"), promptSuggestions: true, withoutAppDetails: true }); });
  await until(() => expect(hook.outbox[0]?.error).toBe("Reply lost"));
  const row = hook.outbox[0]!, original = structuredClone(vi.mocked(commandMessageQueue).mock.calls[0]![1]);
  expect(rows.get(key(row.scope, row.id))?.command).toEqual(original);
  expect(original.expectedRevision).toBe(0); expect(servers.get("chat-a")!.revision).toBe(1);
  await act(async () => { await hook.retryLocal(row.id); });
  expect(vi.mocked(commandMessageQueue).mock.calls[1]![1]).toEqual(original);
  expect(servers.get("chat-a")!.entries).toHaveLength(1); expect(rows.size).toBe(0);
});

it("does not let a later local message overtake a failed head", async () => {
  const head = seed({ id: crypto.randomUUID(), error: "Upload failed" });
  await render(); await drain();
  await act(async () => { await hook.enqueue(draft("Later")); });
  await drain(); expect(commandMessageQueue).not.toHaveBeenCalled(); expect(rows.size).toBe(2);
  expect(hook.outbox[0]?.id).toBe(head.id);
  await act(async () => { await hook.retryLocal(head.id); });
  expect(vi.mocked(commandMessageQueue).mock.calls.map(([, value]) => value.command.type === "enqueue" ? value.command.text : null)).toEqual(["Saved message", "Later"]);
});

it("rebases only a definite revision conflict, preserving the entry identity and content", async () => {
  vi.mocked(commandMessageQueue).mockImplementationOnce(async () => {
    servers.get("chat-a")!.revision = 4;
    throw new AssistantApiError("queue_revision_conflict", "Queue changed", 409);
  });
  await render(); await drain(); await act(async () => { await hook.enqueue(draft("Same message")); });
  await until(() => expect(rows.size).toBe(0));
  const [first, next] = vi.mocked(commandMessageQueue).mock.calls.map(([, input]) => input);
  expect(first!.requestId).not.toBe(next!.requestId); expect(first!.expectedRevision).toBe(0); expect(next!.expectedRevision).toBe(4);
  expect(next!.command).toEqual(first!.command); expect(servers.get("chat-a")!.entries).toHaveLength(1);
});

it.each([
  new Error("Connection reset"), new AssistantApiError("queue_request_conflict", "Receipt input changed", 409),
  new AssistantApiError("forbidden", "Sign in again", 403),
])("retains the original command and stops after an uncertain/refused response ($message)", async failure => {
  vi.mocked(commandMessageQueue).mockRejectedValue(failure);
  await render(); await drain(); await act(async () => { await hook.enqueue(draft("Do not duplicate")); });
  await until(() => expect(hook.outbox[0]?.error).toBe(failure.message));
  const first = structuredClone(vi.mocked(commandMessageQueue).mock.calls[0]![1]);
  expect(commandMessageQueue).toHaveBeenCalledOnce(); expect(hook.outbox[0]?.command).toEqual(first);
  await act(async () => { await hook.retryLocal(hook.outbox[0]!.id); });
  expect(vi.mocked(commandMessageQueue).mock.calls[1]![1]).toEqual(first); expect(rows.size).toBe(1);
});

it("acknowledges queue_entry_exists using the saved row identity without creating another message", async () => {
  const saved = seed({ id: crypto.randomUUID() });
  vi.mocked(commandMessageQueue).mockRejectedValue(new AssistantApiError("queue_entry_exists", "Already accepted", 409));
  await render(); await until(() => expect(rows.size).toBe(0));
  expect(commandMessageQueue).toHaveBeenCalledOnce();
  expect(vi.mocked(commandMessageQueue).mock.calls[0]![1].command).toMatchObject({ type: "enqueue", entryId: saved.id, text: saved.text });
  expect(hook.outbox).toEqual([]); expect(hook.error).toBeNull();
});

it.each(["actor", "installation"])("does not replay rows or operation journals from another %s namespace", async change => {
  const original = seed({ id: crypto.randomUUID() });
  localStorage.setItem(`hosty.message-queue.operation.${original.scope}`, JSON.stringify({ scope: original.scope, sessionId: "chat-a",
    input: { requestId: crypto.randomUUID(), expectedRevision: 0, command: { type: "pause" } } }));
  const newOwner = change === "actor" ? "actor-b" : owner, newInstallation = change === "installation" ? "installation-b" : installation;
  servers.set("chat-a", queue(newOwner, newInstallation));
  await render(session("chat-a", newOwner)); await drain();
  expect(hook.scope).toBe(outboxScope(newInstallation, newOwner, "chat-a")); expect(hook.outbox).toEqual([]); expect(hook.operation).toBeNull();
  await act(async () => { expect(await hook.perform()).toBeNull(); });
  expect(commandMessageQueue).not.toHaveBeenCalled(); expect(rows.has(key(original.scope, original.id))).toBe(true);
  expect(localStorage.getItem(`hosty.message-queue.operation.${original.scope}`)).not.toBeNull();
});

it("checks the server owner again before uploading or posting a retained row", async () => {
  const saved = seed({ id: crypto.randomUUID(), files: [{ id: crypto.randomUUID(), name: "private.txt", type: "text/plain", bytes: new Blob(["private"]) }] });
  vi.mocked(getMessageQueue).mockResolvedValueOnce(queue()).mockResolvedValue(queue("actor-b"));
  await render(); await until(() => expect(hook.outbox[0]?.error).toContain("queue owner"));
  expect(uploadQueueAttachment).not.toHaveBeenCalled(); expect(commandMessageQueue).not.toHaveBeenCalled();
  expect(rows.has(key(saved.scope, saved.id))).toBe(true);
});

it.each(["success", "forbidden", "missing"])("ignores a stale A refresh %s after B is selected", async outcome => {
  const old = deferred<MessageQueue>(); vi.mocked(getMessageQueue).mockReturnValueOnce(old.promise);
  await render(); expect(hook.queue).toBeNull();
  await render(session("chat-b", "actor-b")); await drain();
  const expectedScope = outboxScope(installation, "actor-b", "chat-b"); expect(hook.scope).toBe(expectedScope);
  await act(async () => {
    if (outcome === "success") old.resolve(queue());
    else old.reject(new AssistantApiError(outcome, "Old request failed", outcome === "forbidden" ? 403 : 404));
  });
  await drain(); expect(hook.scope).toBe(expectedScope); expect(hook.queue?.ownerId).toBe("actor-b"); expect(hook.error).toBeNull();
});

it("preserves visible saved rows and reports IndexedDB read failures", async () => {
  const saved = seed({ id: crypto.randomUUID(), error: "Offline" });
  await render(); await until(() => expect(hook.outbox).toHaveLength(1));
  vi.mocked(listOutbox).mockRejectedValue(new Error("Transaction aborted"));
  await act(async () => { await expect(hook.refresh()).rejects.toThrow("Transaction aborted"); });
  expect(hook.outbox[0]?.id).toBe(saved.id); expect(hook.error).toContain("Could not read saved local messages");
  expect(commandMessageQueue).not.toHaveBeenCalled(); expect(rows.size).toBe(1);
});

it("refuses a queue mutation before POST when its localStorage recovery journal cannot be written", async () => {
  await render(); await drain();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
  await act(async () => { await expect(hook.perform({ type: "pause" })).rejects.toThrow("Storage denied"); });
  expect(commandMessageQueue).not.toHaveBeenCalled(); expect(hook.error).toBe("Storage denied"); expect(hook.busy).toBe(false);
});

it("retains a nondurable draft snapshot until server acceptance when browser storage is unavailable", async () => {
  vi.stubGlobal("indexedDB", undefined); vi.mocked(stageOutbox).mockRejectedValue(new Error("Storage denied"));
  vi.mocked(listOutbox).mockRejectedValue(new Error("Storage denied")); vi.mocked(commandMessageQueue).mockRejectedValueOnce(new Error("Offline"));
  await render(); await drain();
  await act(async () => { await expect(hook.enqueue(draft("Keep my composer"))).rejects.toThrow("Offline"); });
  expect(hook.outbox[0]).toMatchObject({ draftText: "Keep my composer", durable: false, error: "Offline" });
  await act(async () => { await expect(hook.enqueue(draft("Do not overtake"))).rejects.toThrow("Retry the previous unsaved message"); });
  const original = structuredClone(vi.mocked(commandMessageQueue).mock.calls[0]![1]);
  await act(async () => { expect(await hook.retryLocal(hook.outbox[0]!.id)).toMatchObject({ draftText: "Keep my composer", durable: false }); });
  expect(vi.mocked(commandMessageQueue).mock.calls[1]![1]).toEqual(original); expect(hook.outbox).toEqual([]);
});

it("keeps staged text, flags and attachments fixed while the next draft changes", async () => {
  const upload = deferred<StoredAttachment>(); vi.mocked(uploadQueueAttachment).mockReturnValueOnce(upload.promise);
  await render(); await drain();
  const input = { ...draft("Serialized original", [new File(["first file"], "first.txt")]), draftText: "Original draft", attachments: [{ name: "existing.txt", size: 3 }],
    promptSuggestions: true, withoutAppDetails: true };
  await act(async () => { await hook.enqueue(input); }); await until(() => expect(uploadQueueAttachment).toHaveBeenCalledOnce());
  input.text = "New draft"; input.draftText = "New draft"; input.files.push(new File(["new"], "next.txt")); input.attachments.push({ name: "new.txt", size: 3 });
  await act(async () => upload.resolve({ name: "stored-first.txt", size: 10 })); await until(() => expect(rows.size).toBe(0));
  expect(vi.mocked(commandMessageQueue).mock.calls[0]![1].command).toMatchObject({ text: "Serialized original", attachments: ["existing.txt", "stored-first.txt"],
    promptSuggestions: true, withoutAppDetails: true });
  expect(uploadQueueAttachment).toHaveBeenCalledOnce();
});

it("recovers an uncertain queue command after remount using the exact saved operation", async () => {
  vi.mocked(commandMessageQueue).mockImplementationOnce(async (id, input) => { accepted(id, input); throw new Error("Reply lost"); });
  await render(); await drain();
  await act(async () => { await expect(hook.perform({ type: "pause" })).rejects.toThrow("Reply lost"); });
  const original = structuredClone(vi.mocked(commandMessageQueue).mock.calls[0]![1]);
  expect(hook.operation?.input).toEqual(original);
  await act(async () => root.unmount()); root = createRoot(element); await render(); await until(() => expect(hook.operation?.input).toEqual(original));
  expect(commandMessageQueue).toHaveBeenCalledOnce();
  await act(async () => { await hook.perform(); });
  expect(vi.mocked(commandMessageQueue).mock.calls[1]![1]).toEqual(original); expect(hook.operation).toBeNull(); expect(hook.queue?.paused).toBe(true);
});

it.each(["success", "failure"])("keeps B's pending mutation isolated while A completes with %s", async outcome => {
  const observedA = deferred<MessageQueue>(), postedA = deferred<QueueCommandReply>(), postedB = deferred<QueueCommandReply>();
  await render(); await drain();
  vi.mocked(getMessageQueue).mockImplementationOnce(() => observedA.promise);
  vi.mocked(commandMessageQueue).mockImplementation(id => id === "chat-a" ? postedA.promise : postedB.promise);
  let completionA!: Promise<unknown>, completionB!: Promise<unknown>;
  await act(async () => { completionA = hook.perform({ type: "pause" }).then(value => value, cause => cause); });
  await until(() => expect(hook.busy).toBe(true)); expect(commandMessageQueue).not.toHaveBeenCalled();
  await render(session("chat-b", "actor-b")); await drain(); expect(hook.busy).toBe(false);
  await act(async () => { completionB = hook.perform({ type: "pause" }); });
  await until(() => expect(hook.operation?.sessionId).toBe("chat-b"));
  const operationB = structuredClone(hook.operation!);
  expect(hook.busy).toBe(true); expect(hook.error).toBeNull();
  await act(async () => observedA.resolve(queue()));
  await until(() => expect(vi.mocked(commandMessageQueue).mock.calls.some(([id]) => id === "chat-a")).toBe(true));
  const inputA = vi.mocked(commandMessageQueue).mock.calls.find(([id]) => id === "chat-a")![1];
  const scopeA = outboxScope(installation, owner, "chat-a");
  expect(JSON.parse(localStorage.getItem(`hosty.message-queue.operation.${scopeA}`)!).input).toEqual(inputA);
  expect(hook.operation).toEqual(operationB); expect(hook.busy).toBe(true); expect(hook.error).toBeNull();
  await act(async () => {
    if (outcome === "success") postedA.resolve(accepted("chat-a", inputA));
    else postedA.reject(new Error("A's old request failed"));
    await completionA;
  });
  expect(hook.operation).toEqual(operationB); expect(hook.busy).toBe(true); expect(hook.error).toBeNull();
  expect(hook.queue?.ownerId).toBe("actor-b"); expect(hook.queue?.paused).toBe(false);
  expect(JSON.parse(localStorage.getItem(`hosty.message-queue.operation.${operationB.scope}`)!).input).toEqual(operationB.input);
  if (outcome === "failure") expect(JSON.parse(localStorage.getItem(`hosty.message-queue.operation.${scopeA}`)!).input).toEqual(inputA);
  else expect(localStorage.getItem(`hosty.message-queue.operation.${scopeA}`)).toBeNull();
  await act(async () => { postedB.resolve(accepted("chat-b", operationB.input)); await completionB; });
  expect(hook.operation).toBeNull(); expect(hook.busy).toBe(false); expect(hook.error).toBeNull(); expect(hook.queue?.paused).toBe(true);
});

it("does not expose A's late background storage failure after switching to B", async () => {
  const pending = deferred<OutboxEntry[]>(), scopeA = outboxScope(installation, owner, "chat-a");
  vi.mocked(listOutbox).mockImplementation(scope => scope === scopeA ? pending.promise : Promise.resolve([]));
  await render(); await until(() => expect(hook.scope).toBe(scopeA));
  await render(session("chat-b", "actor-b")); await drain();
  const scopeB = outboxScope(installation, "actor-b", "chat-b"); expect(hook.scope).toBe(scopeB);
  await act(async () => pending.reject(new Error("A storage unavailable")));
  await drain(); expect(hook.scope).toBe(scopeB); expect(hook.error).toBeNull(); expect(hook.operation).toBeNull(); expect(hook.busy).toBe(false);
});
