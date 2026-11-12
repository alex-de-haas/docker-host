"use client";
import type { StoredAttachment } from "./assistant-api";
import type { QueueCommandInput, QueueDraft } from "./message-queue-api";

export type OutboxFile = { id: string; name: string; type: string; bytes: Blob; stored?: StoredAttachment };
export type OutboxEntry = {
  id: string; scope: string; sequence: number; sessionId: string; text: string; draftText: string;
  files: OutboxFile[]; attachments: StoredAttachment[]; promptSuggestions?: boolean; withoutAppDetails?: boolean;
  command?: QueueCommandInput; error?: string; durable?: boolean; recoverable?: boolean;
};
export type EditDraft = { scope: string; entryId: string; viewId: string; reservationId: string;
  stash: QueueDraft & { files: OutboxFile[] }; buffer?: QueueDraft & { files: OutboxFile[] }; originalDraft?: QueueDraft };
export type PreservedDraft = { id: string; draft: QueueDraft & { files: OutboxFile[] } };
export const OUTBOX_CHANGED = "hosty:message-outbox-changed";
const DATABASE = "hosty.message-outbox.v1";
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Browser storage is unavailable.")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("entries", { keyPath: ["scope", "id"] });
      db.createObjectStore("metadata");
    };
    request.onerror = () => reject(request.error ?? new Error("Cannot open message storage."));
    request.onblocked = () => reject(new Error("Close an older Harness tab to open message storage."));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("Message storage was interrupted.")); });
}
export function outboxScope(installationId: string, ownerId: string, sessionId: string): string {
  return JSON.stringify([window.location.origin, installationId, ownerId, sessionId]);
}
export function outboxFiles(files: File[]): OutboxFile[] {
  return files.map(file => ({ id: crypto.randomUUID(), name: file.name, type: file.type, bytes: file }));
}
export function restoredFiles(files: OutboxFile[]): File[] {
  return files.map(file => new File([file.bytes], file.name, { type: file.type }));
}
export async function listOutbox(scope: string): Promise<OutboxEntry[]> {
  const db = await database(); const tx = db.transaction("entries", "readonly");
  const rows = await result(tx.objectStore("entries").getAll(IDBKeyRange.bound([scope, ""], [scope, "\uffff"])));
  return (rows as OutboxEntry[]).filter(row => row.scope === scope).sort((a, b) => a.sequence - b.sequence);
}
export async function stageOutbox(entry: Omit<OutboxEntry, "sequence">): Promise<OutboxEntry> {
  const db = await database(); const tx = db.transaction(["entries", "metadata"], "readwrite"); const done = committed(tx);
  const rows = tx.objectStore("entries");
  const previous = await result(rows.get([entry.scope, entry.id])) as OutboxEntry | undefined;
  if (previous) { await done; return previous; }
  const pending = (await result(rows.getAll(IDBKeyRange.bound([entry.scope, ""], [entry.scope, "\uffff"]))) as OutboxEntry[]).filter(row => row.scope === entry.scope);
  if (pending.length >= 100) { tx.abort(); await done.catch(() => {}); throw new Error("The local queue has 100 pending messages. Send or remove one first."); }
  const metadata = tx.objectStore("metadata");
  const sequence = ((await result(metadata.get(`sequence:${entry.scope}`))) as number | undefined ?? 0) + 1;
  const row = { ...entry, sequence }; metadata.put(sequence, `sequence:${entry.scope}`); rows.put(row);
  await done; changed(entry.scope); return row;
}
export async function saveOutbox(entry: OutboxEntry): Promise<void> {
  const db = await database(); const tx = db.transaction("entries", "readwrite"); const done = committed(tx);
  // A late competing uploader cannot resurrect an entry already acknowledged by another tab.
  if (await result(tx.objectStore("entries").get([entry.scope, entry.id]))) tx.objectStore("entries").put(entry);
  await done; changed(entry.scope);
}
export async function removeOutbox(scope: string, id: string): Promise<void> {
  const db = await database(); const tx = db.transaction(["entries", "metadata"], "readwrite"); const done = committed(tx);
  tx.objectStore("entries").delete([scope, id]); tx.objectStore("metadata").delete(attemptKey(scope, id)); await done; changed(scope);
}
const attemptKey = (scope: string, id: string) => `admission:${JSON.stringify([scope, id])}`;
/** A separate journal cannot be erased by a stale uploader in a browser without Web Locks. */
export async function recordOutboxAttempt(scope: string, id: string, transportAttemptId: string, rejected = false): Promise<boolean> {
  const db = await database(), tx = db.transaction(["entries", "metadata"], "readwrite"), done = committed(tx);
  if (!await result(tx.objectStore("entries").get([scope, id]))) { await done; return false; }
  const metadata = tx.objectStore("metadata"), key = attemptKey(scope, id);
  const attempts = await result(metadata.get(key)) as Record<string, "pending" | "rejected"> | undefined ?? {};
  attempts[transportAttemptId] = rejected ? "rejected" : "pending";
  metadata.put(attempts, key); await done; return true;
}
const editKey = (scope: string, entryId: string, reservationId: string) => `edit-record:${JSON.stringify([scope, entryId, reservationId])}`;
const editPointer = (scope: string, entryId: string) => `edit-current:${JSON.stringify([scope, entryId])}`;
const pendingEdit = (reservationId: string) => reservationId === "pending" || reservationId.startsWith("pending:");
async function migrateEdit(store: IDBObjectStore, scope: string): Promise<void> {
  const legacy = await result(store.get(`edit:${scope}`)) as EditDraft | undefined;
  if (!legacy) return;
  const key = editKey(scope, legacy.entryId, legacy.reservationId), pointer = editPointer(scope, legacy.entryId);
  if (!await result(store.get(key))) store.put(legacy, key);
  if (!await result(store.get(pointer))) store.put(legacy.reservationId, pointer);
  store.delete(`edit:${scope}`);
}
export async function readEditDraft(scope: string, entryId: string, reservationId?: string): Promise<EditDraft | undefined> {
  const db = await database(), tx = db.transaction("metadata", "readwrite"), done = committed(tx), store = tx.objectStore("metadata");
  await migrateEdit(store, scope);
  const current = reservationId ?? await result(store.get(editPointer(scope, entryId))) as string | undefined;
  const value = current ? await result(store.get(editKey(scope, entryId, current))) as EditDraft | undefined : undefined;
  await done; return value;
}
export async function saveEditDraft(value: EditDraft): Promise<void> {
  const db = await database(); const tx = db.transaction("metadata", "readwrite"); const done = committed(tx);
  const metadata = tx.objectStore("metadata");
  await migrateEdit(metadata, value.scope);
  const pointer = editPointer(value.scope, value.entryId), current = await result(metadata.get(pointer)) as string | undefined;
  const previous = current ? await result(metadata.get(editKey(value.scope, value.entryId, current))) as EditDraft | undefined : undefined;
  if (previous && previous.reservationId !== value.reservationId && !pendingEdit(value.reservationId)
    && !(pendingEdit(previous.reservationId) && previous.viewId === value.viewId)) {
    await done; throw new Error("This edit moved to another view. Its saved buffer was preserved.");
  }
  metadata.put(value, editKey(value.scope, value.entryId, value.reservationId)); metadata.put(value.reservationId, pointer); await done;
}
export async function clearEditDraft(scope: string, entryId: string, reservationId: string): Promise<void> {
  const db = await database(); const tx = db.transaction("metadata", "readwrite"); const done = committed(tx); const store = tx.objectStore("metadata");
  await migrateEdit(store, scope);
  store.delete(editKey(scope, entryId, reservationId));
  if (await result(store.get(editPointer(scope, entryId))) === reservationId) store.delete(editPointer(scope, entryId)); await done;
}
function preservedDrafts(value: unknown): PreservedDraft[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Saved drafts need recovery. Their stored data was preserved.");
  return value as PreservedDraft[];
}
export async function listPreservedDrafts(scope: string): Promise<PreservedDraft[]> {
  const db = await database();
  return preservedDrafts(await result(db.transaction("metadata", "readonly").objectStore("metadata").get(`preserved:${scope}`)));
}
export async function preserveDraft(scope: string, value: PreservedDraft): Promise<void> {
  const db = await database(); const tx = db.transaction("metadata", "readwrite"); const done = committed(tx);
  const store = tx.objectStore("metadata"), storageKey = `preserved:${scope}`;
  const drafts = preservedDrafts(await result(store.get(storageKey)));
  if (drafts.some(draft => draft.id === value.id)) { await done; return; }
  if (drafts.length >= 100) {
    tx.abort(); await done.catch(() => {});
    throw new Error("There are 100 saved drafts. Restore or remove one before preserving another; existing drafts were kept.");
  }
  store.put([...drafts, value], storageKey); await done; changed(scope);
}
/** Keep the only copy of a rejected message and retire it at the same commit boundary. */
export async function recoverOutbox(scope: string, id: string): Promise<void> {
  const db = await database(), tx = db.transaction(["entries", "metadata"], "readwrite"), done = committed(tx);
  const entries = tx.objectStore("entries"), metadata = tx.objectStore("metadata");
  const row = await result(entries.get([scope, id])) as OutboxEntry | undefined;
  if (!row) { await done; return; }
  const attempts = await result(metadata.get(attemptKey(scope, id))) as Record<string, string> | undefined;
  if (!row.error || row.command && row.recoverable !== true || attempts && Object.values(attempts).some(state => state !== "rejected")) {
    await done; throw new Error("Retry this message's original request before recovering its draft; server acceptance is not confirmed.");
  }
  const storageKey = `preserved:${scope}`, drafts = preservedDrafts(await result(metadata.get(storageKey))), draftId = `outbox:${id}`;
  if (!drafts.some(draft => draft.id === draftId)) {
    if (drafts.length >= 100) { tx.abort(); await done.catch(() => {}); throw new Error("There are 100 saved drafts. Restore one before recovering this message; its original snapshot was kept."); }
    metadata.put([...drafts, { id: draftId, draft: { text: row.draftText, attachments: row.attachments, files: row.files } }], storageKey);
  }
  entries.delete([scope, id]); metadata.delete(attemptKey(scope, id)); await done; changed(scope);
}
export async function removePreservedDraft(scope: string, id: string): Promise<void> {
  const db = await database(); const tx = db.transaction("metadata", "readwrite"); const done = committed(tx);
  const store = tx.objectStore("metadata"), storageKey = `preserved:${scope}`;
  const drafts = preservedDrafts(await result(store.get(storageKey)));
  if (drafts.some(draft => draft.id === id)) store.put(drafts.filter(draft => draft.id !== id), storageKey);
  await done; changed(scope);
}
export async function withOutboxLock<T>(scope: string, action: () => Promise<T>): Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks?.request ? navigator.locks.request(`hosty.message-outbox:${scope}`, action) : action();
}
function changed(scope: string) { window.dispatchEvent(new CustomEvent(OUTBOX_CHANGED, { detail: scope })); }
