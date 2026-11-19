import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentHistoryObservation, AgentProviderRef } from "@hosty-sdk/app/agent";
import { durableMkdir, durableWriteFile, syncDirectory } from "../persistence.js";
import type { SessionStore } from "../sessions/store.js";

type Fact = AgentHistoryObservation & { replayed?: boolean };
type Pending = { files: string[]; next: number; worker?: Promise<void> };
const entry = /^([0-9]{16})-([a-f0-9]{64})\.json$/;

/** Durably isolate a failed destination before allowing another chat's cursor to advance. */
export class ProviderHistoryInbox {
  private readonly queues = new Map<string, Promise<Pending>>();
  private readonly workers = new Set<Promise<void>>();
  private readonly blocked = new Set<string>();

  constructor(private readonly store: SessionStore, private readonly signal: AbortSignal,
    private readonly apply: (id: string, provider: AgentProviderRef, fact: Fact) => Promise<void>,
    private readonly report: (id: string, failed: boolean) => Promise<void>) {}

  private queue(id: string): Promise<Pending> {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = this.store.withHistoryInbox(id, async folder => {
        let files: string[];
        try { files = (await readdir(folder)).filter(file => entry.test(file)).sort(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
        return { files, next: Number(files.at(-1)?.slice(0, 16) ?? "0") + 1 };
      }).then(value => value ?? { files: [], next: 1 }).catch(error => { this.queues.delete(id); throw error; });
      this.queues.set(id, queue);
    }
    return queue;
  }

  /** SessionStore has committed the deletion tombstone and removed the on-disk inbox. */
  forget(id: string): void {
    this.queues.delete(id);
    this.blocked.delete(id);
  }

  isBlocked(id: string): boolean { return this.blocked.has(id); }

  async resume(id: string): Promise<void> {
    const pending = await this.queue(id);
    if (pending.files.length) this.repair(id, pending);
  }

  async deliver(id: string, provider: AgentProviderRef, fact: Fact): Promise<void> {
    const pending = await this.queue(id);
    if (!pending.files.length) {
      try { await this.apply(id, provider, fact); return; }
      catch (error) { if (this.signal.aborted) throw error; }
    }
    if (fact.item.kind === "event" && ["message.delta", "tool.output"].includes(fact.item.event.type)) return;
    const identity = createHash("sha256").update(fact.cursor).digest("hex");
    if (!pending.files.at(-1)?.endsWith(identity + ".json")) {
      if (!Number.isSafeInteger(pending.next)) throw new Error("Deferred history exceeded its sequence range.");
      const filename = String(pending.next++).padStart(16, "0") + "-" + identity + ".json";
      const saved = await this.store.withHistoryInbox(id, async folder => {
        await durableMkdir(folder);
        await durableWriteFile(path.join(folder, filename), JSON.stringify({ provider, fact }));
        return true;
      });
      if (!saved) return; // The chat was deleted during delivery.
      pending.files.push(filename);
    }
    this.repair(id, pending);
  }

  private repair(id: string, pending: Pending): void {
    this.blocked.add(id);
    if (pending.worker || this.signal.aborted) return;
    const work = this.drain(id, pending).finally(() => {
      pending.worker = undefined; this.workers.delete(work);
      if (pending.files.length && !this.signal.aborted) this.repair(id, pending);
    });
    pending.worker = work; this.workers.add(work);
  }

  private async drain(id: string, pending: Pending): Promise<void> {
    let failures = 0, applied: string | undefined;
    while (pending.files.length && !this.signal.aborted) {
      const filename = pending.files[0]!;
      try {
        if (applied !== filename) {
          const row = await this.store.withHistoryInbox(id, async folder =>
            JSON.parse(await readFile(path.join(folder, filename), "utf8")) as { provider: AgentProviderRef; fact: Fact });
          if (!row) { pending.files.length = 0; break; }
          if (createHash("sha256").update(row.fact.cursor).digest("hex") !== entry.exec(filename)![2])
            throw new Error("Deferred provider history cursor changed.");
          // Retrying a stored receipt never resumes a control or uses an operator credential.
          await this.apply(id, row.provider, { ...row.fact, replayed: true });
          applied = filename;
        }
        await this.store.withHistoryInbox(id, async folder => {
          try { await unlink(path.join(folder, filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await syncDirectory(folder);
        });
        pending.files.shift(); failures = 0;
      } catch {
        if (this.signal.aborted) return;
        if (failures === 0) await this.report(id, true).catch(() => {});
        await delay(Math.min(30000, 250 * 2 ** Math.min(failures++, 7)), undefined, { signal: this.signal, ref: false }).catch(() => {});
      }
    }
    if (!pending.files.length) this.blocked.delete(id);
    if (!this.signal.aborted) await this.report(id, false).catch(() => {});
  }

  async wait(): Promise<void> { await Promise.all(this.workers); }
}

