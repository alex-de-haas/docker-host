import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "@hosty-sdk/app/providers";
import type { Conversation, HistoryEntry, HistoryShare, HistoryShareReceipt } from "@hosty-sdk/app/history";

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
export type HistoryState = { version: 1; sequence: number; floor: number; conversations: Record<string, SourceConversation>; shares: HistoryShare[]; receipts: ShareReceipt[]; changes: Change[] };
export type Snapshot = { id: string; user: string; principal: string; query: string; expires: number; highWater: string; acls: Record<string, number>; disclosures?: Record<string, string>;
  items: Array<{ conversation: string; entry?: HistoryEntry; metadata?: Conversation }>; offset: number };

export class HistoryStorage {
  readonly root: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.root = path.join(dataDir, "conversation-history"); }
  async read(): Promise<HistoryState> {
    // All callers hold the provider gate. These are only interrupted writes owned by this store.
    try {
      for (const name of await readdir(this.root)) if (/^(?:state\.json|snapshot-[a-f0-9]{32}\.json)\.tmp$/.test(name)) await rm(path.join(this.root, name));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { return JSON.parse(await readFile(path.join(this.root, "state.json"), "utf8")) as HistoryState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { version: 1, sequence: 0, floor: 0, conversations: {}, shares: [], receipts: [], changes: [] };
  }
  async write(state: HistoryState): Promise<void> { await this.writeFile("state.json", state); }
  async writeFile(name: string, value: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = path.join(this.root, name), temporary = target + ".tmp";
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, target);
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(action); this.pending = result;
    return result;
  }
}
