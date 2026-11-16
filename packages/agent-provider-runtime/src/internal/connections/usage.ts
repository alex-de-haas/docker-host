import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { absentUsage, mergeUsage, type ProviderUsage } from "../harness/provider-usage.js";

/** Latest account snapshots, separate from chat transcripts and replay journals. */
export class ConnectionUsage {
  private invalidated = new Set<string>();
  private entries = new Map<string, { key: string; usage: ProviderUsage; nextRead: number }>();
  private pending = new Map<string, Promise<ProviderUsage>>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private file(id: string) { return path.join(this.directory, createHash("sha256").update(id).digest("hex") + ".json"); }
  async cached(id: string, key: string): Promise<ProviderUsage> {
    let entry = this.entries.get(id);
    if (!entry && !this.invalidated.has(id)) {
      try {
        const raw = await readFile(this.file(id), "utf8");
        if (raw.length <= 128000) {
          const saved = JSON.parse(raw) as { key: string; usage: ProviderUsage };
          if (!this.entries.has(id) && saved.key === key && Array.isArray(saved.usage?.rows)) {
            entry = { ...saved, usage: { ...saved.usage, stale: true }, nextRead: 0 };
            this.entries.set(id, entry);
          }
        }
      } catch { /* Missing or damaged diagnostic state never affects a conversation. */ }
    }
    entry = this.entries.get(id) ?? entry;
    if (entry?.key !== key) return absentUsage();
    const expired = entry.usage.observedAt !== null && Date.now() - Date.parse(entry.usage.observedAt) > 120000
      || entry.usage.rows.some(row => row.resetsAt && Date.parse(row.resetsAt) <= Date.now());
    return expired ? { ...entry.usage, stale: true } : entry.usage;
  }
  accept(id: string, key: string, usage: ProviderUsage) {
    this.invalidated.delete(id);
    const previous = this.entries.get(id);
    const value = { ...mergeUsage(previous?.key === key ? previous.usage : undefined, usage), sequence: Math.max(Date.now(), (previous?.usage.sequence ?? 0) + 1) };
    this.entries.set(id, { key, usage: value, nextRead: Date.now() + 60000 });
    const content = JSON.stringify({ key, usage: value });
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = this.file(id) + "." + randomUUID() + ".tmp";
      await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, this.file(id));
    }).catch(() => {});
    return value;
  }
  async read(id: string, key: string, refresh: boolean, fetch: () => Promise<ProviderUsage>, valid: () => Promise<boolean>) {
    if (!refresh) return this.cached(id, key);
    const pendingKey = id + ":" + key;
    const current = this.pending.get(pendingKey); if (current) return current;
    const pending = (async () => {
      await this.cached(id, key);
      const entry = this.entries.get(id);
      if (entry?.key === key && entry.nextRead > Date.now()) return this.cached(id, key);
      let value: ProviderUsage;
      try { value = await fetch(); } catch { value = absentUsage("unavailable", "temporarily_unavailable"); }
      if (!await valid().catch(() => false)) return absentUsage();
      if (this.entries.get(id) !== entry && this.entries.get(id)?.key === key) return this.cached(id, key);
      return this.accept(id, key, value);
    })().finally(() => { this.pending.delete(pendingKey); });
    this.pending.set(pendingKey, pending); return pending;
  }
  invalidate(id: string) {
    this.entries.delete(id); this.invalidated.add(id);
    this.writes = this.writes.catch(() => {}).then(() => rm(this.file(id), { force: true })).catch(() => {});
  }
  async close() { await Promise.allSettled([...this.pending.values()]); await this.writes; }
}
