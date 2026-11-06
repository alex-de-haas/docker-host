import type { TaskRecord } from "@hosty-sdk/app/tasks";
import { randomUUID } from "node:crypto";
import type { SessionManager } from "../sessions/manager.js";
import { TaskStore, fingerprint, taskError } from "./store.js";
import { TaskPolicies } from "./policy.js";
import type { TaskOrchestrator } from "./orchestrator.js";

type Control = { id: string; taskId: string; executionId: string; sessionId: string; owner: string;
  state: "boundary" | "parked" | "resuming" | "resumed"; reason: string; error?: string };

/** Owner pause and measured budgets use the same native checkpoint, never a replacement attempt. */
export class TaskControls {
  constructor(private readonly store: TaskStore, private readonly manager: SessionManager,
    private readonly policies: TaskPolicies, private readonly orchestration: TaskOrchestrator) {}
  async projections(owner: string) {
    const rows = [];
    for (const [, control] of await this.store.journalEntries<Control>("runtime-control:")) {
      if (control.owner !== owner || control.state === "resumed" || !["time_budget", "usage_unknown"].includes(control.reason)) continue;
      const task = await this.store.get(control.taskId, { userId: owner, appId: null });
      if (task.coordination?.executionId !== control.executionId || ["Done", "Cancelled"].includes(task.status)) continue;
      rows.push({ id: "task-limit:" + control.id, kind: "recovery" as const, sessionId: control.sessionId, title: task.title,
        createdAt: task.updatedAt, available: true, error: control.error ?? (control.reason === "time_budget"
          ? "The root's active-time budget is exhausted. Review its execution limits in Tasks before resuming."
          : "Native usage is uncertain. Inspect the original run before recovering this root's budget.") });
    }
    return rows;
  }
  async validateResume(rootId: string, owner: string): Promise<void> {
    await this.policies.get(rootId, owner);
    for (const task of (await this.store.all()).filter(t => t.rootTaskRef.id === rootId && t.owner.userId === owner)) {
      const attempt = task.attempts.at(-1), id = attempt?.receipt?.sessionRef?.id;
      if (!attempt || !id || attempt.receipt?.stopConfirmed || fingerprint(attempt.executor) !== fingerprint(this.store.provider)) continue;
      const session = await this.manager.getSession(id);
      if (!session || session.taskExecutionId !== attempt.executionId) return taskError("checkpoint_unavailable", "The original execution session is unavailable; the root remains paused.");
      if (!session.taskRun?.started && !session.workerRun) continue;
      const barrier = session.taskBarrier;
      if (session.workerRun || !session.taskRun?.exitConfirmed || barrier?.state !== "parked" || !barrier.nativeSessionId)
        return taskError("boundary_pending", "Wait for every original execution to confirm its retained checkpoint before resuming.");
      await this.orchestration.context(id);
      if (this.manager.worker) {
        const receipt = await this.manager.worker.request<import("../worker/contracts.js").WorkerReceipt>(`/v1/runs/${barrier.runId}`);
        if (receipt.state !== "parked" || !receipt.exitConfirmed || receipt.snapshot?.nativeSessionId !== barrier.nativeSessionId)
          return taskError("checkpoint_unavailable", "The original native checkpoint cannot be confirmed; the root remains paused.");
      }
    }
  }
  async reconcile(): Promise<void> {
    for (const task of await this.store.all()) {
      try { await this.reconcileTask(task); }
      catch (error) { console.error("[tasks] control recovery failed", task.ref.id, error); }
    }
  }
  private async reconcileTask(task: TaskRecord): Promise<void> {
      const attempt = task.attempts.at(-1), sessionId = attempt?.receipt?.sessionRef?.id;
      if (!attempt || !sessionId || attempt.receipt?.stopConfirmed || attempt.cancelRequested || task.cancelRequested
        || fingerprint(attempt.executor) !== fingerprint(this.store.provider)) return;
      const session = await this.manager.getSession(sessionId);
      if (!session || session.taskExecutionId !== attempt.executionId || !session.taskContext) return;
      await this.policies.setMode(task.ref.id, attempt.executionId, session.autonomy ?? "normal");
      const root = await this.policies.get(task.rootTaskRef.id, session.createdBy);
      if (root.stopRequested) return;
      const reason = this.policies.budgetReason(root) ?? (root.paused ? "owner_pause" : root.modePaused || session.autonomy === "normal" ? "mode" : null);
      const key = "runtime-control:" + attempt.executionId;
      let control = await this.store.readJournal<Control>(key);
      if (reason && (!control || control.state === "resumed")) {
        if (!session.workerRun || session.taskBarrier && session.taskBarrier.state !== "resuming") return;
        control = { id: randomUUID(), taskId: task.ref.id, executionId: attempt.executionId, sessionId, owner: session.createdBy, state: "boundary", reason };
        await this.store.writeJournal(key, control);
      }
      if (!control || control.state === "resumed") return;
      const before = fingerprint(control);
      try {
        await this.orchestration.context(sessionId);
        if (control.state === "boundary") {
          await this.manager.armTaskBarrier(sessionId, control.owner, control.id, "limits", 1, "coordinator");
          await this.manager.advanceTaskBarrier(sessionId);
          const parked = await this.manager.getSession(sessionId);
          if (parked?.taskBarrier?.id !== control.id || parked.taskBarrier.state !== "parked") return;
          control.state = "parked";
        }
        if (!reason && ["parked", "resuming"].includes(control.state)) {
          if (this.orchestration.beforeResume && !await this.orchestration.beforeResume(sessionId)) return;
          if (!await this.orchestration.reserveContinuation(sessionId)) return;
          control.state = "resuming"; await this.store.writeJournal(key, control);
          await this.manager.resumeTaskBarrier(sessionId, control.owner, "Continue the same task from its retained checkpoint. The owner pause or execution limit has been resolved; inspect task_execution_get before proceeding.");
          control.state = "resumed";
        }
        delete control.error;
      } catch (error) { control.error = error instanceof Error ? error.message : "The original task checkpoint needs recovery."; }
      finally { if (fingerprint(control) !== before) await this.store.writeJournal(key, control); }
  }
}
