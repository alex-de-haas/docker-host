import type { ConnectionService } from "./service.js";
import { absentUsage, type ProviderUsage } from "../harness/provider-usage.js";

/** Samples worker-owned snapshots only; this never polls a provider or starts a model turn. */
export class UsageSubscriptions {
  private entries = new Map<string, { listeners: Set<(usage: ProviderUsage) => void>; timer: ReturnType<typeof setInterval>; stopped: boolean; reading: boolean; last?: string; value?: ProviderUsage }>();
  constructor(private readonly connections: Pick<ConnectionService, "usage">) {}
  subscribe(id: string, listener: (usage: ProviderUsage) => void) {
    let entry = this.entries.get(id);
    if (!entry) {
      const next = { listeners: new Set<(usage: ProviderUsage) => void>(), stopped: false, reading: false,
        timer: undefined as unknown as ReturnType<typeof setInterval>, last: undefined as string | undefined, value: undefined as ProviderUsage | undefined };
      const read = async () => {
        if (next.stopped || next.reading) return;
        next.reading = true;
        try {
          const value = await this.connections.usage(id, false).catch(() => absentUsage());
          if (next.stopped) return;
          const raw = JSON.stringify(value);
          if (raw !== next.last) { next.last = raw; next.value = value; for (const send of next.listeners) send(value); }
        } finally { next.reading = false; }
      };
      next.timer = setInterval(() => { void read(); }, 2000); next.timer.unref();
      entry = next; this.entries.set(id, entry); void read();
    }
    entry.listeners.add(listener);
    if (entry.value) listener(entry.value);
    return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entry.stopped = true; clearInterval(entry.timer); this.entries.delete(id); } };
  }
  close() { for (const entry of this.entries.values()) { entry.stopped = true; clearInterval(entry.timer); } this.entries.clear(); }
}
