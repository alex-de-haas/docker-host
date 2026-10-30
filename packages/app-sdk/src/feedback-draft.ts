import type { FeedbackCapabilities, FeedbackNoteInput, FeedbackSubmit, FeedbackTarget } from "./feedback-types";
export type DraftNote = Omit<FeedbackNoteInput, "image"> & { image?: Blob };
export type FeedbackDraft = { key: string; revision: number; requestId: string; comment: string; annotations: DraftNote[]; submitting: boolean };
const database = "hosty-feedback-v1";
export function draftKey(capabilities: FeedbackCapabilities) {
  return JSON.stringify([capabilities.coreId, capabilities.appId, capabilities.installation, capabilities.userId]);
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("Local draft storage is unavailable.")); return; }
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("drafts", { keyPath: "key" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open draft storage."));
    request.onblocked = () => reject(new Error("Close older feedback tabs to update draft storage."));
  });
}
export async function readDraft(key: string): Promise<FeedbackDraft | null> {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readonly"); const request = tx.objectStore("drafts").get(key);
    let value: FeedbackDraft | null = null;
    request.onsuccess = () => { value = request.result ?? null; };
    tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
/** Read-check-write is one transaction: an older tab cannot overwrite a newer draft. */
export async function saveDraft(draft: FeedbackDraft, expectedRevision: number): Promise<void> {
  const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite"); const store = tx.objectStore("drafts");
    const read = store.get(draft.key); let conflict = false;
    read.onsuccess = () => {
      if ((read.result?.revision ?? 0) !== expectedRevision) { conflict = true; tx.abort(); return; }
      store.put(draft);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(conflict ? new Error("This draft changed in another tab. Reload to restore its latest saved version.") : tx.error ?? new Error("Draft could not be saved locally."));
  }); } finally { db.close(); }
}
export async function deleteDraft(key: string, requestId: string): Promise<void> {
  const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite"); const store = tx.objectStore("drafts"); const read = store.get(key);
    read.onsuccess = () => { if (read.result?.requestId === requestId) store.delete(key); };
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
export function blankDraft(key: string): FeedbackDraft {
  return { key, revision: 0, requestId: crypto.randomUUID(), comment: "", annotations: [], submitting: false };
}
export function makeNote(target: FeedbackTarget): DraftNote {
  return { id: crypto.randomUUID(), text: "", route: location.pathname, capturedAt: new Date().toISOString(), target };
}
export async function submission(draft: FeedbackDraft): Promise<FeedbackSubmit> {
  const [coreId, appId, installation, userId] = JSON.parse(draft.key) as string[];
  return { scope: { coreId: coreId!, appId: appId!, installation: installation!, userId: userId! }, requestId: draft.requestId, comment: draft.comment, annotations: await Promise.all(draft.annotations.map(async note => {
    const { image, ...data } = note;
    if (!image) return data;
    const bytes = new Uint8Array(await image.arrayBuffer());
    let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { ...data, image: { mediaType: image.type, data: btoa(binary) } };
  })) };
}

