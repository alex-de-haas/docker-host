import type { ProviderServerOptions } from "./providers-server.js";
import type { ToolActivity, ToolActivityState } from "./ui-types.js";

export type ToolActivityValue = { state: ToolActivityState; count?: number; label?: string; ttlSeconds?: number };
export type ToolActivityReporterOptions = ProviderServerOptions & {
  installationId?: string;
  onError?: (error: Error) => void;
  /** Acknowledges the current value; rejection keeps it queued for retry. */
  onReported?: (userId: string, panelId: string, value: ToolActivityValue) => void | Promise<void>;
};
type Entry = { userId: string; panelId: string; value: ToolActivityValue; due: number };

/** Server-only, current-state reporting. No transcript data or browser frame is required. */
export class ToolActivityReporter {
  private readonly appId: string;
  private readonly installation: string;
  private readonly core: URL;
  private readonly service: string;
  private readonly entries = new Map<string, Entry>();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private disposed = false;

  constructor(private readonly options: ToolActivityReporterOptions = {}) {
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.installation = options.installationId ?? process.env.HOSTY_APP_INSTALLATION_ID ?? "";
    this.core = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!this.appId || !this.installation || !this.service) throw new Error("Tool activity requires a Core-managed installation and app service identity.");
    this.timer = setInterval(() => { void this.flush(); }, 250);
    this.timer.unref?.();
  }

  set(userId: string, panelId: string, value: ToolActivityValue): void {
    if (this.disposed) return;
    if (!userId || !panelId || !["idle", "working", "needs-you", "failed"].includes(value.state)
      || value.count !== undefined && (!Number.isInteger(value.count) || value.count < 0 || value.count > 9999)
      || value.label !== undefined && (value.label.length > 120 || /[\x00-\x1f\x7f]/.test(value.label))
      || value.ttlSeconds !== undefined && (!Number.isInteger(value.ttlSeconds) || value.ttlSeconds < 1 || value.ttlSeconds > 300))
      throw new Error("Invalid tool activity.");
    const key = JSON.stringify([userId, panelId]), previous = this.entries.get(key);
    if (!previous && this.entries.size >= 10_000) throw new Error("Tool activity reporter capacity reached.");
    if (previous && JSON.stringify(previous.value) === JSON.stringify(value)) return;
    this.entries.set(key, { userId, panelId, value: { ...value }, due: 0 });
    void this.flush();
  }

  /** Serializes changes, retries failures and renews presence. After Core restarts every retained
   * state is re-reported within 20 seconds, without rebinding to another installation. */
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.disposed) return Promise.resolve();
    this.pending = this.sendDue().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async sendDue(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (this.disposed || entry.due > Date.now()) continue;
      try {
        const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.appId)}/ui/activity`, this.core), {
          method: "POST", redirect: "error", cache: "no-store",
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
          headers: { authorization: `Bearer ${this.service}`, "content-type": "application/json" },
          body: JSON.stringify({ userId: entry.userId, installationId: this.installation, panelId: entry.panelId, ...entry.value }),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Tool activity report failed (${response.status}).`);
        // A newer value may have arrived during this request; never acknowledge or delete it.
        if (this.entries.get(key) !== entry) continue;
        await this.options.onReported?.(entry.userId, entry.panelId, { ...entry.value });
        if (this.entries.get(key) !== entry) continue;
        if (entry.value.state === "idle") this.entries.delete(key);
        else entry.due = Date.now() + Math.min(20_000, (entry.value.ttlSeconds ?? 60) * 1000 / 3);
      } catch (error) {
        if (this.disposed) return;
        entry.due = Date.now() + 5000;
        try { this.options.onError?.(error instanceof Error ? error : new Error("Tool activity unavailable.")); } catch { /* Observers cannot stop reporting. */ }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    this.controller.abort();
    await this.pending;
    this.entries.clear();
  }
}

export type { ToolActivity };
