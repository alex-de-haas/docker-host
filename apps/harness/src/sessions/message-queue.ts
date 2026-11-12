import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { AppContextError } from "./app-context.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_SESSION, MAX_SESSION_ATTACHMENT_BYTES, sanitizeAttachmentName, fitToBytes, listAttachments } from "./attachments.js";
import { messageRequestId, type SessionRecord, type SessionStore, type MessageReceipt } from "./store.js";

export interface QueueAttachment { id: string; name: string; size: number; displayName?: string }
export interface StoredQueueAttachment extends QueueAttachment { digest: string }
export interface QueueDraft { text: string; attachments: QueueAttachment[] }
export interface QueueAttempt {
  clientRequestId: string; text: string; attachments: string[]; appContextRevision: number;
  selectionRevision: number; withoutAppDetails: boolean; promptSuggestions?: boolean;
  bindingKey?: string; payloadFingerprint?: string;
}
export interface QueueEntry {
  id: string; text: string; attachments: QueueAttachment[]; createdAt: string;
  state: "queued" | "editing" | "sending" | "failed" | "unknown";
  promptSuggestions?: boolean; withoutAppDetails?: boolean;
  error?: { code: string; message: string }; attempt?: QueueAttempt;
  edit?: { reservationId: string; viewId: string; generation: number; text: string; attachments: QueueAttachment[]; stashedDraft: QueueDraft };
}
type StoredEntry = Omit<QueueEntry, "attachments" | "edit"> & { attachments: StoredQueueAttachment[];
  edit?: Omit<NonNullable<QueueEntry["edit"]>, "attachments" | "stashedDraft"> & { attachments: StoredQueueAttachment[]; stashedDraft: { text: string; attachments: StoredQueueAttachment[] } } };
export interface QueueSnapshot {
  version: 1; installationId: string; ownerId: string; revision: number; entries: QueueEntry[];
  paused: boolean; reason?: string; waiting?: { code: string; message: string }; updatedAt: string;
}
export interface QueueResult { revision: number; entryId?: string; reservationId?: string }
export interface MessageQueueRecord {
  version: 1; revision: number; entries: StoredEntry[]; paused: boolean; reason?: string;
  waiting?: { code: string; message: string }; updatedAt: string;
  receipts: Record<string, { fingerprint: string; result: QueueResult }>;
  entryIdentities: Record<string, string>;
  claimedAttachments: Record<string, true>;
  draftAttachments: Record<string, StoredQueueAttachment[]>;
}
export type QueueCommand =
  | { type: "enqueue"; entryId: string; text: string; attachments: string[]; promptSuggestions?: boolean; withoutAppDetails?: boolean }
  | { type: "reserve_edit"; entryId: string; viewId: string; stashedDraft: { text: string; attachments: string[] } }
  | { type: "save_edit"; entryId: string; reservationId: string; viewId: string; text: string; attachments: string[] }
  | { type: "update_edit"; entryId: string; reservationId: string; viewId: string; text: string; attachments: string[] }
  | { type: "cancel_edit"; entryId: string; reservationId: string; viewId: string }
  | { type: "recover_edit"; entryId: string; viewId: string }
  | { type: "delete" | "retry"; entryId: string }
  | { type: "reorder"; entryIds: string[] }
  | { type: "pause" | "resume" };

const fail = (code: string, message: string, status = 409): never => { throw new AppContextError(status, code, message); };
const uuid = (value: unknown): string => { try { return messageRequestId(value); } catch { return fail("queue_request_invalid", "Use a UUID for queue and request identities.", 400); } };
const boundedText = (value: unknown): string => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 60_000
  ? value : fail("queue_text_invalid", "Message text must be at most 60,000 UTF-8 bytes.", 400);
const names = (value: unknown): string[] => Array.isArray(value) && value.length <= MAX_ATTACHMENTS_PER_SESSION
  && value.every(v => typeof v === "string" && !!v && !/[\\/]/.test(v) && v === path.basename(v) && !v.startsWith("."))
  ? [...new Set(value as string[])] : fail("queue_attachments_invalid", "Provide valid stored attachment names.", 400);
const view = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 256
  ? value : fail("queue_view_invalid", "Provide this editor's view identity.", 400);

/** Queue state shares record.json's atomic boundary and the manager's session mutation lock. */
export class MessageQueue {
  constructor(private readonly store: SessionStore) {}
  state(record: SessionRecord): MessageQueueRecord {
    const current = record.messageQueue;
    if (current && (current.version !== 1 || !Number.isSafeInteger(current.revision) || !Array.isArray(current.entries) || !current.receipts || !current.entryIdentities))
      return fail("queue_corrupt", "The retained message queue needs recovery.", 503);
    if (current) return { ...current, claimedAttachments: current.claimedAttachments ?? {}, draftAttachments: current.draftAttachments ?? {} };
    return { version: 1, revision: 0, entries: [], paused: false, updatedAt: record.updatedAt, receipts: {}, entryIdentities: {}, claimedAttachments: {}, draftAttachments: {} };
  }
  snapshot(record: SessionRecord): QueueSnapshot {
    if (process.env.NODE_ENV === "production" && process.env.HOSTY_CORE_ORIGIN && !process.env.HOSTY_APP_INSTALLATION_ID)
      return fail("queue_installation_unavailable", "Core has not supplied this Harness installation identity.", 503);
    const { receipts: _receipts, entryIdentities: _identities, claimedAttachments: _claimed, draftAttachments: _drafts, ...state } = this.state(record);
    const attachment = (file: StoredQueueAttachment): QueueAttachment => ({ id: file.id, name: file.name, size: file.size, ...(file.displayName ? { displayName: file.displayName } : {}) });
    return { ...state, installationId: process.env.HOSTY_APP_INSTALLATION_ID ?? "standalone", ownerId: record.createdBy,
      entries: state.entries.map(entry => ({ ...entry, attachments: entry.attachments.map(attachment),
        ...(entry.edit ? { edit: { ...entry.edit, attachments: entry.edit.attachments.map(attachment),
          stashedDraft: { ...entry.edit.stashedDraft, attachments: entry.edit.stashedDraft.attachments.map(attachment) } } } : {}) })) };
  }
  async save(record: SessionRecord, next: MessageQueueRecord): Promise<void> {
    next.revision++; next.updatedAt = new Date().toISOString();
    await this.store.saveRecord({ ...record, messageQueue: next }); record.messageQueue = next;
    // Removal is conservative housekeeping after the durable ownership change. An IO failure
    // retains bytes; it never rolls back accepted work or permits another execution.
    await this.collect(record).catch(() => undefined);
  }
  async change(record: SessionRecord, action: (next: MessageQueueRecord) => void): Promise<void> {
    const next = structuredClone(this.state(record)); action(next); await this.save(record, next);
  }
  private root(id: string): string { return this.store.messageQueueDirectory(id); }
  private async attachmentCapacity(record: SessionRecord, attachmentId: string): Promise<void> {
    const state = this.state(record), active = new Set<string>();
    for (const entry of state.entries) for (const file of [...entry.attachments, ...entry.edit?.attachments ?? [], ...entry.edit?.stashedDraft.attachments ?? []]) active.add(file.id);
    for (const draft of Object.values(state.draftAttachments)) for (const file of draft) active.add(file.id);
    const root = path.join(this.root(record.id), "uploads");
    const files = await readdir(root).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const name of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const upload = JSON.parse(await readFile(path.join(root, name), "utf8")) as StoredQueueAttachment;
      if (!state.claimedAttachments[upload.id]) active.add(upload.id);
    }
    if (!active.has(attachmentId) && active.size >= MAX_ATTACHMENTS_PER_SESSION)
      return fail("queue_attachment_capacity", "This conversation already has 20 retained queue attachments.", 413);
  }
  private async collect(record: SessionRecord): Promise<void> {
    const state = this.state(record), referenced = new Set<string>((record.sourceAttachments ?? []).map(file => file.digest));
    for (const entry of state.entries) for (const file of [...entry.attachments, ...entry.edit?.attachments ?? [], ...entry.edit?.stashedDraft.attachments ?? []]) referenced.add(file.digest);
    for (const draft of Object.values(state.draftAttachments)) for (const file of draft) referenced.add(file.digest);
    const uploadRoot = path.join(this.root(record.id), "uploads");
    const uploads = await readdir(uploadRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const name of uploads) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const upload = JSON.parse(await readFile(path.join(uploadRoot, name), "utf8")) as StoredQueueAttachment;
      if (!state.claimedAttachments[upload.id]) referenced.add(upload.digest);
    }
    const fileRoot = path.join(this.root(record.id), "files");
    const files = await readdir(fileRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const name of files) if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) await rm(path.join(fileRoot, name));
  }
  private filePath(id: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) return fail("queue_attachment_invalid", "Invalid retained attachment identity.", 503);
    return path.join(this.root(id), "files", digest);
  }
  private async retain(id: string, bytes: Buffer): Promise<string> {
    const digest = createHash("sha256").update(bytes).digest("hex"), target = this.filePath(id, digest);
    try {
      const existing = await readFile(target);
      if (existing.length === bytes.length && createHash("sha256").update(existing).digest("hex") === digest) {
        await this.store.settleSourcePublication(id, target); return digest;
      }
      return fail("queue_attachment_changed", "A retained attachment failed verification. Preserve the queue for recovery.", 503);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // saveSourceFile creates the missing chain durably, preserving its highest new parent entry.
    const files = await readdir(path.dirname(target)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const sizes = await Promise.all(files.filter(f => /^[a-f0-9]{64}$/.test(f)).map(f => stat(path.join(path.dirname(target), f))));
    if (sizes.length >= MAX_ATTACHMENTS_PER_SESSION || sizes.reduce((sum, f) => sum + f.size, 0) + bytes.length > MAX_SESSION_ATTACHMENT_BYTES)
      return fail("queue_attachment_capacity", "This conversation's durable attachment allowance is full.", 413);
    await this.store.saveSourceFile(id, target, bytes, true);
    return digest;
  }
  /** Raw uploads have their own stable identity; a lost reply never creates another filename. */
  async upload(record: SessionRecord, uploadId: string, originalName: string, body: Readable): Promise<QueueAttachment> {
    const id = uuid(uploadId), safe = sanitizeAttachmentName(originalName);
    if (!safe) return fail("attachment_name_invalid", "Provide an attachment name.", 400);
    const parts: Buffer[] = []; let size = 0;
    for await (const part of body) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); size += bytes.length;
      if (size > MAX_ATTACHMENT_BYTES) return fail("attachment_too_large", "The attachment exceeds 25 MiB.", 413);
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts), digest = createHash("sha256").update(bytes).digest("hex");
    const receiptPath = path.join(this.root(record.id), "uploads", id + ".json");
    let prior: (StoredQueueAttachment & { originalName: string }) | undefined;
    try { prior = JSON.parse(await readFile(receiptPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior) {
      if (prior.originalName !== originalName || prior.digest !== digest) return fail("queue_upload_conflict", "This upload UUID already refers to different file bytes or a different name.");
      await this.attachmentCapacity(record, id);
      // Reopening an exact upload pins it until the next accepted reference, including after
      // an earlier queued entry was retired and its queue-only bytes were collected.
      if (this.state(record).claimedAttachments[id]) await this.change(record, next => { delete next.claimedAttachments[id]; });
      await this.retain(record.id, bytes); await this.attachmentBytes(record.id, prior);
      await this.store.settleSourcePublication(record.id, receiptPath);
      return { id: prior.id, name: prior.name, size: prior.size, displayName: prior.displayName };
    }
    await this.attachmentCapacity(record, id);
    await this.retain(record.id, bytes);
    const attachment = { id, name: fitToBytes(`q-${id}-${safe}`, 200), displayName: safe, size, digest, originalName };
    await this.store.saveSourceFile(record.id, receiptPath, JSON.stringify(attachment));
    return { id, name: attachment.name, size, displayName: safe };
  }
  private async attachmentBytes(id: string, file: StoredQueueAttachment): Promise<Buffer> {
    const bytes = await readFile(this.filePath(id, file.digest)).catch(() => fail("queue_attachment_missing", `The saved attachment ${file.name} is unavailable. Reattach it before sending.`, 409));
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest)
      return fail("queue_attachment_changed", `The saved attachment ${file.name} failed verification.`, 409);
    return bytes;
  }
  private async attachments(record: SessionRecord, input: unknown, previous: StoredQueueAttachment[] = []): Promise<StoredQueueAttachment[]> {
    const result: StoredQueueAttachment[] = [];
    for (const name of names(input)) {
      const existing = previous.find(file => file.name === name);
      if (existing) { await this.attachmentBytes(record.id, existing); result.push(existing); continue; }
      const uploadId = /^q-([a-f0-9-]{36})-/.exec(name)?.[1];
      if (uploadId) {
        const upload = JSON.parse(await readFile(path.join(this.root(record.id), "uploads", uuid(uploadId) + ".json"), "utf8").catch(() => fail("queue_attachment_missing", `The uploaded attachment ${name} is unavailable.`, 400))) as StoredQueueAttachment;
        if (upload.name !== name) return fail("queue_attachment_invalid", "The uploaded attachment name does not match its identity.", 400);
        await this.attachmentBytes(record.id, upload); result.push({ id: upload.id, name, size: upload.size, digest: upload.digest, displayName: upload.displayName }); continue;
      }
      const source = this.store.attachmentPath(record.id, name);
      if (!source) return fail("attachments_unavailable", "Attachments need a conversation workspace.", 503);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail("queue_attachment_missing", `The uploaded attachment ${name} is unavailable.`, 400));
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return fail("queue_attachment_missing", `The uploaded attachment ${name} is unavailable.`, 400);
        bytes = await handle.readFile();
        if (bytes.length > MAX_ATTACHMENT_BYTES) return fail("attachment_too_large", "The attachment exceeds 25 MiB.", 413);
      } finally { await handle.close(); }
      const id = randomUUID(); await this.attachmentCapacity(record, id);
      const digest = await this.retain(record.id, bytes);
      // A saved edit can restore its stashed attachments after releasing the reservation. Give
      // cache snapshots reusable durable names too, so a later enqueue never rereads mutable cwd.
      const snapshot = { id, name: fitToBytes(`q-${id}-${name}`, 200), displayName: name,
        size: bytes.length, digest, originalName: name };
      const receiptPath = path.join(this.root(record.id), "uploads", id + ".json");
      await this.store.saveSourceFile(record.id, receiptPath, JSON.stringify(snapshot));
      result.push(snapshot);
    }
    return result;
  }
  /** Preserve the exact admitted input independently of mutable/cache working files. */
  async retainAcceptedAttachments(record: SessionRecord, input: string[]): Promise<void> {
    if (!input.length) return;
    const admittedNames = names(input), retained = await this.attachments(record, admittedNames);
    const next = [...record.sourceAttachments ?? []];
    for (const [index, file] of retained.entries()) {
      const admitted = { ...file, name: admittedNames[index]! };
      const previous = next.findIndex(candidate => candidate.name === admitted.name && candidate.digest === admitted.digest);
      // Keep each immutable version's identity while making the latest admission the name lookup target.
      next.push(previous < 0 ? admitted : next.splice(previous, 1)[0]!);
    }
    const messageQueue = structuredClone(this.state(record));
    for (const file of retained) messageQueue.claimedAttachments[file.id] = true;
    // Publish ownership with the admitted snapshot so accepted files no longer count as pending uploads.
    await this.store.saveRecord({ ...record, sourceAttachments: next, messageQueue });
    record.sourceAttachments = next; record.messageQueue = messageQueue;
  }
  async acceptedAttachment(record: SessionRecord, name: string): Promise<Buffer | null> {
    const file = record.sourceAttachments?.findLast(candidate => candidate.name === name);
    return file ? this.attachmentBytes(record.id, file) : null;
  }
  async attachment(record: SessionRecord, attachmentId: string): Promise<{ attachment: QueueAttachment; bytes: Buffer }> {
    const retained = this.state(record).entries.flatMap(entry => [...entry.attachments, ...entry.edit?.attachments ?? [], ...entry.edit?.stashedDraft.attachments ?? []]);
    let file = retained.find(candidate => candidate.id === attachmentId);
    if (!file) {
      try { file = JSON.parse(await readFile(path.join(this.root(record.id), "uploads", uuid(attachmentId) + ".json"), "utf8")) as StoredQueueAttachment; }
      catch (error) { if (error instanceof AppContextError) throw error; return fail("queue_attachment_missing", "This queued attachment is unavailable.", 404); }
    }
    const attachment: QueueAttachment = { id: file.id, name: file.name, size: file.size, ...(file.displayName ? { displayName: file.displayName } : {}) };
    return { attachment, bytes: await this.attachmentBytes(record.id, file) };
  }
  async materialize(record: SessionRecord, entry: StoredEntry): Promise<string[]> {
    const workspace = await this.store.ensureWorkspace(record.id);
    if (!workspace && entry.attachments.length) return fail("attachments_unavailable", "Attachments need a conversation workspace.", 503);
    const result: string[] = [];
    for (const [index, file] of entry.attachments.entries()) {
      const bytes = await this.attachmentBytes(record.id, file);
      const name = entry.attempt!.attachments[index] ?? file.name;
      const target = this.store.attachmentPath(record.id, name)!;
      const existing = await listAttachments(workspace!);
      const previous = existing.find(candidate => candidate.name === name);
      if (!previous && existing.length >= MAX_ATTACHMENTS_PER_SESSION
        || existing.reduce((sum, candidate) => sum + candidate.size, 0) - (previous?.size ?? 0) + bytes.length > MAX_SESSION_ATTACHMENT_BYTES)
        return fail("queue_attachment_capacity", "The conversation workspace attachment allowance is full.", 413);
      await this.store.saveSourceFile(record.id, target, bytes); result.push(name);
    }
    return result;
  }
  async command(record: SessionRecord, input: Record<string, unknown>): Promise<{ queue: QueueSnapshot; result: QueueResult }> {
    const requestId = uuid(input.requestId), fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const next = structuredClone(this.state(record)), prior = next.receipts[requestId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) return fail("queue_request_conflict", "Reuse the original queue request unchanged.");
      return { queue: this.snapshot(record), result: prior.result };
    }
    if (input.expectedRevision !== next.revision) return fail("queue_revision_conflict", "The message queue changed. Refresh it and retry your change.");
    const command = input.command as QueueCommand | null;
    if (!command || typeof command !== "object") return fail("queue_command_invalid", "Provide a queue command.", 400);
    let entry: StoredEntry | undefined, result: QueueResult = { revision: next.revision + 1 };
    const claimFiles = (files: StoredQueueAttachment[]) => { for (const file of files) next.claimedAttachments[file.id] = true; };
    const draftKey = (viewId: string) => createHash("sha256").update(viewId).digest("hex");
    const pinDraft = (viewId: string, files: StoredQueueAttachment[]) => {
      const key = draftKey(viewId);
      next.draftAttachments[key] = [...new Map([...(next.draftAttachments[key] ?? []), ...files].map(file => [file.id, file])).values()];
    };
    if ("entryId" in command) { const entryId = uuid(command.entryId); result.entryId = entryId; entry = next.entries.find(e => e.id === entryId); }
    const editable = (): StoredEntry => {
      if (!entry) return fail("queue_entry_missing", "This queued message is no longer available.", 404);
      if (!["queued", "failed"].includes(entry.state)) return fail("queue_entry_locked", "This message is being edited, sent or reconciled.");
      return entry;
    };
    const editor = (): NonNullable<StoredEntry["edit"]> => {
      if (!entry?.edit || entry.state !== "editing" || !("reservationId" in command) || entry.edit.reservationId !== command.reservationId || entry.edit.viewId !== view(command.viewId))
        return fail("queue_edit_conflict", "This editor reservation changed. Recover it before saving.");
      return entry.edit;
    };
    switch (command.type) {
      case "enqueue": {
        const entryFingerprint = createHash("sha256").update(JSON.stringify({ id: uuid(command.entryId), text: command.text,
          attachments: command.attachments, promptSuggestions: command.promptSuggestions === true, withoutAppDetails: command.withoutAppDetails === true })).digest("hex");
        if (next.entryIdentities[uuid(command.entryId)]) return fail(next.entryIdentities[uuid(command.entryId)] === entryFingerprint ? "queue_entry_exists" : "queue_entry_conflict", "This message identity was already accepted. Refresh its original queue result.");
        if (entry) return fail("queue_entry_conflict", "This message identity is already queued.");
        if (next.entries.length >= 100) return fail("queue_capacity", "The message queue already holds 100 messages.", 413);
        const text = boundedText(command.text), attached = await this.attachments(record, command.attachments);
        if (!text.trim() && !attached.length) return fail("text_required", "Provide text or an attachment.", 400);
        claimFiles(attached);
        next.entries.push({ id: uuid(command.entryId), text, attachments: attached, createdAt: new Date().toISOString(), state: "queued",
          ...(command.promptSuggestions === true ? { promptSuggestions: true } : {}), ...(command.withoutAppDetails === true ? { withoutAppDetails: true } : {}) });
        next.entryIdentities[uuid(command.entryId)] = entryFingerprint; break;
      }
      case "reserve_edit": {
        const current = editable();
        const stash = command.stashedDraft;
        if (!stash || typeof stash !== "object") return fail("queue_draft_invalid", "Retain the current draft before editing.", 400);
        current.edit = { reservationId: randomUUID(), generation: (current.edit?.generation ?? 0) + 1, viewId: view(command.viewId),
          text: current.text, attachments: current.attachments, stashedDraft: { text: boundedText(stash.text), attachments: await this.attachments(record, stash.attachments) } };
        claimFiles(current.edit.stashedDraft.attachments); pinDraft(current.edit.viewId, current.edit.stashedDraft.attachments);
        current.state = "editing"; delete current.attempt; delete current.error; result.reservationId = current.edit.reservationId; break;
      }
      case "save_edit": case "update_edit": {
        const edit = editor(), text = boundedText(command.text), attached = await this.attachments(record, command.attachments, edit.attachments);
        if (command.type === "save_edit" && !text.trim() && !attached.length) return fail("text_required", "Provide text or an attachment.", 400);
        claimFiles(attached); edit.text = text; edit.attachments = attached;
        if (command.type === "save_edit") { entry!.text = text; entry!.attachments = attached; entry!.state = "queued"; delete entry!.edit; }
        break;
      }
      case "cancel_edit": editor(); entry!.state = "queued"; delete entry!.edit; break;
      case "recover_edit": {
        if (!entry?.edit || entry.state !== "editing") return fail("queue_edit_missing", "This message has no retained editor.");
        entry.edit.viewId = view(command.viewId); entry.edit.reservationId = randomUUID(); entry.edit.generation++;
        pinDraft(entry.edit.viewId, entry.edit.stashedDraft.attachments);
        result.reservationId = entry.edit.reservationId; break;
      }
      case "delete": editable(); next.entries = next.entries.filter(e => e.id !== entry!.id); break;
      case "reorder": {
        if (!Array.isArray(command.entryIds) || command.entryIds.length !== next.entries.length || new Set(command.entryIds).size !== next.entries.length
          || command.entryIds.some(id => typeof id !== "string" || !next.entries.some(e => e.id === id))) return fail("queue_order_invalid", "Reorder the current complete queue.", 400);
        for (let i = 0; i < next.entries.length; i++) if (["sending", "unknown", "editing"].includes(next.entries[i]!.state) && command.entryIds[i] !== next.entries[i]!.id)
          return fail("queue_entry_locked", "A locked message cannot be moved.");
        next.entries = command.entryIds.map(id => next.entries.find(e => e.id === id)!); break;
      }
      case "pause": next.paused = true; next.reason = "Queue paused"; break;
      case "resume": next.paused = false; delete next.reason; delete next.waiting; break;
      case "retry": {
        if (!entry || !["failed", "unknown", "sending"].includes(entry.state)) return fail("queue_retry_invalid", "This message does not need a retry.");
        if (entry.state === "failed") { entry.state = "queued"; delete entry.attempt; delete entry.error; }
        next.paused = false; delete next.reason; delete next.waiting; break;
      }
      default: return fail("queue_command_invalid", "Unknown message queue command.", 400);
    }
    next.receipts[requestId] = { fingerprint, result };
    const handoffDraft = record.handoffDraft;
    if (command.type === "enqueue") record.handoffDraft = undefined;
    try { await this.save(record, next); }
    catch (error) { record.handoffDraft = handoffDraft; throw error; }
    return { queue: this.snapshot(record), result };
  }
  async settle(record: SessionRecord, entryId: string, receipt: MessageReceipt): Promise<void> {
    await this.change(record, next => {
      const entry = next.entries.find(e => e.id === entryId);
      if (!entry || entry.attempt?.clientRequestId !== receipt.clientRequestId) return;
      if (receipt.state === "accepted") { next.entries = next.entries.filter(e => e.id !== entryId); delete next.waiting; }
      else { entry.state = receipt.state === "unknown" ? "unknown" : "failed"; entry.error = receipt.error ?? { code: "message_outcome_unknown", message: "The send outcome is unknown. Retry checks its original receipt." }; next.paused = true; next.reason = entry.error.message; }
    });
  }
}
