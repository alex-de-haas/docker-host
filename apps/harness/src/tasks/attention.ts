import type { TaskRecord } from "@hosty-sdk/app/tasks";
import { TaskStore } from "./store.js";
type Delivery = { delivered?: boolean; retryAt?: number; error?: string };
/** Retained attempt evidence is authoritative; notifications are deduplicated pointers. */
export class TaskAttention {
  constructor(private readonly store: TaskStore, private readonly publish: (owner: string, task: string, execution: string) => Promise<void>, private readonly now = Date.now) {}
  private needsAttention(task: TaskRecord) {
    const attempt = task.attempts.at(-1);
    return !task.removed && task.status === "Blocked" && attempt?.receipt && ["failed", "interrupted"].includes(attempt.receipt.state) ? attempt : undefined;
  }
  async reconcile() {
    for (const task of await this.store.all()) {
      const attempt = this.needsAttention(task); if (!attempt || !task.owner.userId) continue;
      const key = "task-attention:" + attempt.executionId, previous = await this.store.readJournal<Delivery>(key);
      if (previous?.delivered || (previous?.retryAt ?? 0) > this.now()) continue;
      await this.store.writeJournal(key, { ...previous, retryAt: this.now() + 30000 });
      try {
        await this.publish(task.owner.userId, task.ref.id, attempt.executionId);
        await this.store.writeJournal(key, { delivered: true });
      } catch {
        await this.store.writeJournal(key, { retryAt: this.now() + 30000, error: "The task is retained, but its attention notification could not be delivered. Delivery will be retried." });
      }
    }
  }
  async projections(owner: string) {
    const rows = [];
    for (const task of await this.store.all()) {
      const attempt = this.needsAttention(task); if (!attempt || task.owner.userId !== owner) continue;
      const delivery = await this.store.readJournal<Delivery>("task-attention:" + attempt.executionId);
      rows.push({ id: "task-failure:" + attempt.executionId, kind: "recovery" as const, taskId: task.ref.id,
        sessionId: attempt.receipt?.sessionRef?.id ?? "", title: `${task.number} · ${task.title}`, createdAt: task.updatedAt,
        available: true, error: [task.blocked?.message ?? attempt.receipt?.error?.message ?? "This attempt did not complete successfully.", delivery?.error].filter(Boolean).join(" ") });
    }
    return rows;
  }
}
