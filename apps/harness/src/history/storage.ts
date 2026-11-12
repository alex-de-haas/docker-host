import { readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { ProviderError } from "@hosty-sdk/app/providers";
import type { Conversation, HistoryEntry, HistoryShare, HistoryShareReceipt } from "@hosty-sdk/app/history";
import { durableCreateFile, durableMkdir, durableWriteFile, isUncertainWrite, syncDirectory } from "../persistence.js";

export const fail = (code: string, message: string, status = 400): never => { throw new ProviderError(code, message, status); };
export const missing = (): never => fail("not_found", "The requested history is unavailable.", 404);
export const id = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : fail("invalid_input", "A bounded resource ID is required.");
export function uuid(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : fail("invalid_input", "A stable request UUID is required.");
}
export function revision(value: unknown): string {
  return typeof value === "string" && /^[0-9]{1,40}$/.test(value) ? value : fail("invalid_input", "A decimal-string revision is required.");
}
export type SourceConversation = { metadata: Conversation; entries: HistoryEntry[]; fingerprint: string; acl: number };
export type Change = { sequence: string; at: string; owner: string; conversation: string; entry?: string; revision: string; type: "upsert" | "delete" | "access_reset"; reason?: string };
export type ShareReceipt = { principal: string; user: string; requestId: string; fingerprint: string; result: HistoryShareReceipt };
type Partition = { hash: string; owner: string; revision: string; acl: number };
export type HistoryState = { version: 1; sequence: number; floor: number; conversations: Record<string, SourceConversation>; shares: HistoryShare[]; receipts: ShareReceipt[]; changes: Change[];
  /** Read-local recovery evidence, never serialized as authority or sent to a client. */
  partitions?: Record<string, Partition>; unavailable?: string[] };
type ManifestData = Omit<HistoryState, "version" | "conversations" | "unavailable" | "partitions"> & { partitions: Record<string, Partition> };
type Manifest = { version: 2; checksum: string; data: ManifestData };
export type Snapshot = { id: string; user: string; principal: string; query: string; expires: number; highWater: string; acls: Record<string, number>; disclosures?: Record<string, string>;
  items: Array<{ conversation: string; entry?: HistoryEntry; metadata?: Conversation }>; offset: number };

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const decimal = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,40}$/.test(value);
const safeId = (value: string) => /^[a-zA-Z0-9-]{1,256}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const recovery = (): never => fail("history_recovery_required", "Conversation history storage requires recovery. Saved source and access evidence are retained.", 503);
function validSource(value: unknown, conversationId: string): value is SourceConversation {
  if (!object(value) || !object(value.metadata) || !object(value.metadata.ref) || value.metadata.ref.id !== conversationId
    || !text(value.metadata.ownerUserId) || !decimal(value.metadata.revision) || !counter(value.acl)
    || !digest(value.fingerprint) || !Array.isArray(value.entries)) return false;
  return value.entries.every(entry => object(entry) && object(entry.ref) && object(entry.ref.conversation)
    && entry.ref.conversation.id === conversationId && text(entry.ref.id) && decimal(entry.revision) && decimal(entry.sequence)
    && typeof entry.createdAt === "string" && typeof entry.updatedAt === "string" && object(entry.data));
}
function validShare(value: unknown): value is HistoryShare {
  return object(value) && text(value.id) && object(value.ref) && text(value.ref.id) && decimal(value.revision)
    && text(value.ownerUserId) && Array.isArray(value.recipientUserIds) && value.recipientUserIds.every(text)
    && object(value.selection) && typeof value.includeAttachments === "boolean" && Array.isArray(value.extensions)
    && value.extensions.every(text) && (value.state === "active" || value.state === "revoked");
}
function validManifest(value: unknown): value is Manifest {
  if (!object(value) || value.version !== 2 || !digest(value.checksum) || !object(value.data)
    || hash(JSON.stringify(value.data)) !== value.checksum) return false;
  const data = value.data;
  if (!counter(data.sequence) || !counter(data.floor) || data.floor > data.sequence || !object(data.partitions)
    || !Object.entries(data.partitions).every(([id, ref]) => safeId(id) && object(ref) && digest(ref.hash) && text(ref.owner) && decimal(ref.revision) && counter(ref.acl))
    || !Array.isArray(data.shares) || !data.shares.every(validShare) || !Array.isArray(data.receipts)
    || !data.receipts.every(receipt => object(receipt) && text(receipt.principal) && text(receipt.user) && text(receipt.requestId)
      && digest(receipt.fingerprint) && object(receipt.result) && receipt.result.requestId === receipt.requestId
      && decimal(receipt.result.conversationRevision) && validShare(receipt.result.grant)) || !Array.isArray(data.changes)) return false;
  let previous = data.floor;
  return data.changes.every(change => {
    if (!object(change) || !decimal(change.sequence) || !decimal(change.revision) || !text(change.owner)
      || !text(change.conversation) || typeof change.at !== "string" || !["upsert", "delete", "access_reset"].includes(String(change.type))) return false;
    const sequence = Number(change.sequence);
    if (!counter(sequence) || sequence <= previous || sequence > Number(data.sequence)) return false;
    previous = sequence; return true;
  });
}
function manifest(data: ManifestData): Manifest { return { version: 2, checksum: hash(JSON.stringify(data)), data }; }
const empty = (): ManifestData => ({ sequence: 0, floor: 0, partitions: {}, shares: [], receipts: [], changes: [] });

/** Immutable conversation payloads publish through one durable, payload-free authority manifest. */
export class HistoryStorage {
  readonly root: string;
  private pending: Promise<unknown> = Promise.resolve();
  private sealed = false;
  constructor(dataDir: string) { this.root = path.join(dataDir, "conversation-history-v2"); }
  private partitionPath(partition: Partition): string { return path.join(this.root, "partitions", `${partition.hash}.json`); }
  private async loadManifest(): Promise<Manifest> {
    const file = path.join(this.root, "manifest.json");
    let raw: Buffer;
    try { raw = await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return recovery();
      // An absent manifest is a new store only when no prior publication evidence exists.
      let names: string[];
      try { names = await readdir(this.root); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") return recovery(); names = []; }
      if (names.length) return recovery();
      const initial = manifest(empty());
      try { await durableMkdir(this.root); await durableCreateFile(file, JSON.stringify(initial)); return initial; }
      catch (createError) {
        if ((createError as NodeJS.ErrnoException).code === "EEXIST") return this.loadManifest();
        if (isUncertainWrite(createError)) this.sealed = true;
        return recovery();
      }
    }
    if (raw.length > MAX_FILE_BYTES) return recovery();
    try { const value: unknown = JSON.parse(raw.toString("utf8")); return validManifest(value) ? value : recovery(); }
    catch { return recovery(); }
  }
  async read(): Promise<HistoryState> {
    const { data } = await this.loadManifest();
    const state: HistoryState = { version: 1, ...data, conversations: {}, unavailable: [] };
    for (const [id, partition] of Object.entries(data.partitions)) {
      try {
        const raw = await readFile(this.partitionPath(partition));
        if (raw.length > MAX_FILE_BYTES || hash(raw) !== partition.hash) throw new Error("partition integrity");
        const value: unknown = JSON.parse(raw.toString("utf8"));
        if (!object(value) || value.version !== 1 || !validSource(value.conversation, id)
          || value.conversation.metadata.ownerUserId !== partition.owner || value.conversation.metadata.revision !== partition.revision || value.conversation.acl !== partition.acl) throw new Error("partition format");
        state.conversations[id] = value.conversation;
      } catch { state.unavailable!.push(id); }
    }
    return state;
  }
  async write(state: HistoryState): Promise<void> {
    if (this.sealed) return recovery();
    await durableMkdir(path.join(this.root, "partitions"));
    const partitions: Record<string, Partition> = {};
    // Preserve unreadable partitions and their authority until explicit recovery or deletion.
    for (const id of state.unavailable ?? []) if (state.partitions?.[id]) partitions[id] = state.partitions[id];
    for (const [id, conversation] of Object.entries(state.conversations)) {
      if (!safeId(id) || !validSource(conversation, id)) return recovery();
      const raw = JSON.stringify({ version: 1, conversation });
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return fail("budget_exceeded", "The conversation history partition exceeds its storage allowance.", 429);
      const ref = { hash: hash(raw), owner: conversation.metadata.ownerUserId, revision: conversation.metadata.revision, acl: conversation.acl }; partitions[id] = ref;
      if (state.partitions?.[id]?.hash !== ref.hash) await durableWriteFile(this.partitionPath(ref), raw);
    }
    const data: ManifestData = { sequence: state.sequence, floor: state.floor, partitions, shares: state.shares, receipts: state.receipts, changes: state.changes };
    const serialized = JSON.stringify(manifest(data));
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) return fail("budget_exceeded", "The history authority manifest exceeds its storage allowance.", 429);
    try { await durableWriteFile(path.join(this.root, "manifest.json"), serialized); }
    catch (error) { if (isUncertainWrite(error)) this.sealed = true; return recovery(); }
    state.partitions = partitions;
    // Unreferenced generations are no longer readable. Remove obsolete transcript copies after commit.
    const directory = path.join(this.root, "partitions"), retained = new Set(Object.values(partitions).map(ref => `${ref.hash}.json`));
    try {
      for (const name of await readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name)) await rm(path.join(directory, name));
      await syncDirectory(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[history] obsolete partition cleanup requires retry"); }
  }
  async writeFile(name: string, value: unknown): Promise<void> {
    if (!/^snapshot-[a-f0-9]{32}\.json$/.test(name)) throw new Error("Invalid history snapshot filename");
    await durableWriteFile(path.join(this.root, name), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(value)), data: value }));
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(action); this.pending = result;
    return result;
  }
}
