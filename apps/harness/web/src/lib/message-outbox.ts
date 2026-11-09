"use client";
import type { StoredAttachment } from "./assistant-api";
import type { QueueCommandInput, QueueDraft } from "./message-queue-api";

export type OutboxFile = { id: string; name: string; type: string; bytes: Blob; stored?: StoredAttachment };
export type OutboxEntry = {
  id: string; scope: string; sequence: number; sessionId: string; text: string; draftText: string;
  files: OutboxFile[]; attachments: StoredAttachment[]; promptSuggestions?: boolean; withoutAppDetails?: boolean;
  command?: QueueCommandInput; error?: string; durable?: boolean;
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
  const db = await database(); const tx = db.transaction("entries", "readwrite"); const done = committed(tx);
  tx.objectStore("entries").delete([scope, id]); await done; changed(scope);
}
export async function readEditDraft(scope: string): Promise<EditDraft | undefined> {
  return result((await database()).transaction("metadata", "readonly").objectStore("metadata").get(`edit:${scope}`));
}
export async function saveEditDraft(value: EditDraft): Promise<void> {
  const db = await database(); const tx = db.transaction("metadata", "readwrite"); const done = committed(tx);
  const metadata = tx.objectStore("metadata");
  const previous = await result(metadata.get(`edit:${value.scope}`)) as EditDraft | undefined;
  if (previous && previous.reservationId !== value.reservationId && previous.reservationId !== "pending" && value.reservationId !== "pending") {
    await done; throw new Error("This edit moved to another view. Its saved buffer was preserved.");
  }
  metadata.put(value, `edit:${value.scope}`); await done;
}
export async function clearEditDraft(scope: string, reservationId: string): Promise<void> {
  const db = await database(); const tx = db.transaction("metadata", "readwrite"); const done = committed(tx); const store = tx.objectStore("metadata");
  const value = await result(store.get(`edit:${scope}`)) as EditDraft | undefined;
  if (value?.reservationId === reservationId) store.delete(`edit:${scope}`); await done;
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
