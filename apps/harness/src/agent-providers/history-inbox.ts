import type { AgentProviderRef } from "@hosty-sdk/app/agent";
import type { HistoryReceipt } from "./history-coverage.js";
import type { SessionStore } from "../sessions/store.js";

/** The persisted inbox and its delivery cursor belong to the chat's canonical transcript. */
export class ProviderHistoryInbox {
  private readonly blocked = new Set<string>();
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly store: SessionStore, private readonly signal: AbortSignal,
    private readonly apply: (id: string, provider: AgentProviderRef, fact: HistoryReceipt) => Promise<void>,
    private readonly report: (id: string, failed: boolean) => Promise<void>) {}

  forget(id: string): void { this.blocked.delete(id); }
  isBlocked(id: string): boolean { return this.blocked.has(id); }

  async resume(id: string): Promise<void> {
    await this.serialize(id, async () => {
      while (!this.signal.aborted) {
        const pending = await this.store.withTranscript(id, db => db.pending());
        if (!pending?.length) break;
        for (const item of pending) {
          if (this.signal.aborted) return;
          if (!await this.project(id, item, true)) return;
        }
      }
    });
  }

  async deliver(id: string, provider: AgentProviderRef, fact: HistoryReceipt): Promise<void> {
    if (!fact.epoch || !fact.sessionPosition) {
      // A transient delta has no provider receipt or retention obligation.
      await this.apply(id, provider, fact);
      return;
    }
    await this.serialize(id, async () => {
      const item = await this.store.withTranscript(id, db => db.receive(provider, fact));
      if (item) await this.project(id, item, fact.replayed === true);
    });
  }

  private async project(id: string, item: { key: string; ordinal: number; provider: AgentProviderRef; fact: HistoryReceipt }, replayed: boolean) {
    try {
      await this.apply(id, item.provider, { ...item.fact, replayed });
      await this.store.withTranscript(id, db => db.projected(item));
      if (this.blocked.delete(id)) await this.report(id, false);
      return true;
    } catch (error) {
      if (this.signal.aborted) throw error;
      if (!this.blocked.has(id)) {
        this.blocked.add(id);
        await this.report(id, true);
      }
      return false; // The complete input is retained for the next repair pass.
    }
  }

  private async serialize(id: string, work: () => Promise<void>) {
    const task = (this.lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.lanes.set(id, task);
    try { await task; } finally { if (this.lanes.get(id) === task) this.lanes.delete(id); }
  }

  async wait(): Promise<void> { await Promise.allSettled(this.lanes.values()); }
}
