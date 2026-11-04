import { ProviderError } from "@hosty-sdk/app/providers";
import type { TaskExecutionReceipt, TaskProviderRef, TaskRecord, TaskRef } from "@hosty-sdk/app/tasks";
import type { TaskState } from "./store.js";
import { TaskStore, fingerprint, uuid } from "./store.js";

export type TaskLimits = {
  maxConcurrentExecutions: number; maxDelegationDepth: number; maxDescendants: number;
  maxRetriesPerTask: number; maxActiveSeconds: number | null;
  maxCost: { currency: "USD"; micros: number } | null;
};
export const defaultTaskLimits: TaskLimits = {
  maxConcurrentExecutions: 4, maxDelegationDepth: 3, maxDescendants: 50, maxRetriesPerTask: 2,
  maxActiveSeconds: null, maxCost: null,
};
export type TaskRootState = {
  rootTaskRef: TaskRef; owner: string; generation: number; revision: number;
  limits: TaskLimits; limitsRevision: number; descendantCount: number;
  modePaused?: boolean; paused: boolean; stopRequested: boolean;
  reservations: Record<string, { held: boolean; taskId: string; sequence: number; activeMs: number; usageUnknown?: boolean; segments?: Record<string, { sequence: number; activeMs: number; unknown: boolean }> }>;
};
type Defaults = { revision: number; values: TaskLimits };
type PolicyMutation = { requestId: string; expectedRevision: number; values: TaskLimits };
const error = (code: string, message: string, status = 409): never => { throw new ProviderError(code, message, status); };
const rootKey = (id: string) => "root:" + id;

export function taskLimits(value: unknown): TaskLimits {
  const v = value as TaskLimits;
  if (!v || typeof v !== "object" || Object.keys(v).length !== 6
    || !["maxConcurrentExecutions", "maxDelegationDepth", "maxDescendants", "maxRetriesPerTask"].every(key =>
      Number.isSafeInteger(v[key as keyof TaskLimits]) && Number(v[key as keyof TaskLimits]) >= (key === "maxConcurrentExecutions" ? 1 : 0))
    || v.maxActiveSeconds !== null && (!Number.isSafeInteger(v.maxActiveSeconds) || v.maxActiveSeconds < 1))
    return error("limits_invalid", "Supply nonnegative integer limits, concurrency at least one, and optional positive active seconds.", 400);
  if (v.maxCost !== null) return error("unsupported_budget", "The installed providers cannot enforce an exact monetary cap.", 422);
  return structuredClone(v);
}

/** All budget reservations share the task aggregate transaction; user settings never reset usage. */
export class TaskPolicies {
  constructor(private readonly store: TaskStore) {}
  defaultsIn(s: TaskState): Defaults { return s.journal?.["task-settings"] as Defaults | undefined ?? { revision: 1, values: { ...defaultTaskLimits } }; }
  defaults(): Promise<Defaults> { return this.store.transaction(s => this.defaultsIn(s)); }
  rootIn(s: TaskState, id: string): TaskRootState | undefined { return s.journal?.[rootKey(id)] as TaskRootState | undefined; }
  ensure(s: TaskState, task: TaskRecord, executor: TaskProviderRef): TaskRootState | undefined {
    const root = this.store.find(s, task.rootTaskRef.id);
    const existing = this.rootIn(s, root.ref.id); if (existing) return existing;
    // Independent execution apps own their own admission policy.
    if (fingerprint(executor) !== fingerprint(this.store.provider) || !root.owner.userId) return undefined;
    const value: TaskRootState = {
      rootTaskRef: root.ref, owner: root.owner.userId, generation: 1, revision: 1,
      limits: structuredClone(this.defaultsIn(s).values), limitsRevision: 1,
      descendantCount: s.tasks.filter(t => t.rootTaskRef.id === root.ref.id && t.ref.id !== root.ref.id).length,
      paused: false, stopRequested: false, reservations: {},
    };
    (s.journal ??= {})[rootKey(root.ref.id)] = value; return value;
  }
  reopen(s: TaskState, task: TaskRecord): void {
    const root = this.rootIn(s, task.ref.id);
    if (!root || task.parentTaskRef || task.status === "Draft" || !task.attempts.length) return;
    if (s.tasks.filter(t => t.rootTaskRef.id === task.ref.id).some(t => t.attempts.some(a => !a.receipt?.stopConfirmed)))
      return error("execution_active", "Confirm all retained native attempts stopped before reopening this root.");
    root.generation++; root.revision++; root.stopRequested = false; root.paused = false;
  }
  setMode(taskId: string, executionId: string, mode: "normal" | "autonomous"): Promise<void> {
    return this.store.transaction(s => {
      const task = s.tasks.find(t => t.ref.id === taskId);
      if (!task || task.coordination?.executionId !== executionId) return;
      if (s.journal?.["mode:" + executionId] === mode) return;
      (s.journal ??= {})["mode:" + executionId] = mode;
      const root = this.rootIn(s, task.rootTaskRef.id);
      if (root && !task.parentTaskRef) { root.modePaused = mode === "normal"; root.revision++; }
    });
  }
  child(s: TaskState, parent: TaskRecord): void {
    const root = this.rootIn(s, parent.rootTaskRef.id); if (!root) return;
    this.open(root);
    if (parent.depth + 1 > root.limits.maxDelegationDepth || root.descendantCount >= root.limits.maxDescendants)
      return error("limit_exceeded", "This root's delegation depth or descendant limit is exhausted.");
    root.descendantCount++; root.revision++;
  }
  attempt(s: TaskState, task: TaskRecord): void {
    if (task.assignee?.kind !== "app") return;
    const root = this.ensure(s, task, task.assignee.executor); if (!root) return;
    this.open(root);
    if (task.depth > root.limits.maxDelegationDepth || root.descendantCount > root.limits.maxDescendants)
      return error("limit_exceeded", "The current tree exceeds this root's limits.");
    if (task.attempts.length > root.limits.maxRetriesPerTask)
      return error("limit_exceeded", "This task's retry allowance is exhausted. Its attempt history is retained.");
  }
  private open(root: TaskRootState) {
    if (root.stopRequested) return error("root_stopped", "This root has been stopped.");
    if (root.modePaused) return error("root_paused", "The root coordinator is in Normal mode.");
    if (root.paused) return error("root_paused", "This root is paused by its owner.");
  }
  async get(id: string, owner: string): Promise<TaskRootState> {
    return this.store.transaction(s => this.owned(s, id, owner));
  }
  private owned(s: TaskState, id: string, owner: string) {
    const root = this.rootIn(s, uuid(id));
    if (!root || root.owner !== owner) return error("task_not_found", "No execution root is visible with this ID.", 404);
    return root;
  }
  private replay<T>(s: TaskState, owner: string, input: unknown, requestId: string, operation: () => T): T {
    const key = "policy-request:" + owner + ":" + uuid(requestId), hash = fingerprint(input);
    const prior = s.journal?.[key] as { hash: string; result: T } | undefined;
    if (prior) { if (prior.hash !== hash) return error("request_conflict", "Recover the original policy request without changing its input."); return prior.result; }
    const result = operation(); (s.journal ??= {})[key] = { hash, result: structuredClone(result) }; return result;
  }
  updateDefaults(owner: string, input: PolicyMutation): Promise<Defaults> {
    return this.store.transaction(s => this.replay(s, owner, { operation: "defaults", input }, input.requestId, () => {
      const current = this.defaultsIn(s);
      if (input.expectedRevision !== current.revision) return error("revision_conflict", "Task defaults changed. Reload before saving.");
      const next = { revision: current.revision + 1, values: taskLimits(input.values) };
      (s.journal ??= {})["task-settings"] = next; return next;
    }));
  }
  updateRoot(id: string, owner: string, input: PolicyMutation): Promise<TaskRootState> {
    return this.store.transaction(s => {
      const root = this.owned(s, id, owner);
      return this.replay(s, owner, { operation: "limits", id, input }, input.requestId, () => {
        if (root.limitsRevision !== input.expectedRevision) return error("revision_conflict", "Root limits changed. Reload before saving.");
        root.limits = taskLimits(input.values); root.limitsRevision++; root.revision++; return root;
      });
    });
  }
  async control(id: string, owner: string, input: { requestId: string; expectedRevision: number; action: "pause" | "resume" | "stop" }, validateResume?: () => Promise<void>): Promise<TaskRootState> {
    await this.get(id, owner);
    const key = "policy-request:" + owner + ":" + uuid(input.requestId);
    if (input.action === "resume" && validateResume && !await this.store.readJournal(key)) {
      try { await validateResume(); }
      catch (error) { if (!await this.store.readJournal(key)) throw error; }
    }
    return this.store.transaction(s => {
      const root = this.owned(s, id, owner);
      return this.replay(s, owner, { operation: "control", id, input }, input.requestId, () => {
        if (root.revision !== input.expectedRevision) return error("revision_conflict", "Root execution changed. Reload before applying this control.");
        if (!["pause", "resume", "stop"].includes(input.action)) return error("invalid_input", "Choose pause, resume or stop.", 400);
        if (input.action === "resume" && root.stopRequested) return error("root_stopped", "Resume cannot undo a stopped root.");
        root.paused = input.action !== "resume";
        if (input.action === "stop") {
          root.stopRequested = true;
          for (const task of s.tasks.filter(t => t.rootTaskRef.id === id && t.status !== "Done")) {
            task.armed = false; const attempt = task.attempts.at(-1);
            if (attempt && (!attempt.receipt?.stopConfirmed || !["completed", "failed", "cancelled", "interrupted"].includes(attempt.receipt.state))) {
              attempt.cancelRequested = true; task.cancelRequested = true;
            } else { task.status = "Cancelled"; task.cancelRequested = false; delete task.blocked; }
            this.store.touch(task);
          }
        }
        root.revision++; return root;
      });
    });
  }
  reserve(taskId: string, executionId: string): Promise<boolean> {
    return this.store.transaction(s => this.reserveIn(s, taskId, executionId));
  }
  reserveIn(s: TaskState, taskId: string, executionId: string): boolean {
      const task = s.tasks.find(t => t.ref.id === taskId); if (!task) return true;
      const root = this.rootIn(s, task.rootTaskRef.id); if (!root) return true;
      if (root.paused || root.modePaused || root.stopRequested || s.journal?.["mode:" + executionId] === "normal" || this.budgetReason(root)) return false;
      if (root.reservations[executionId]?.held) return true;
      if (Object.values(root.reservations).filter(r => r.held).length >= root.limits.maxConcurrentExecutions) return false;
      const attempt = task.attempts.at(-1);
      if (attempt?.executionId !== executionId || attempt.cancelRequested || task.cancelRequested) return false;
      const previous = root.reservations[executionId];
      root.reservations[executionId] = { ...previous, held: true, taskId, sequence: previous?.sequence ?? 0, activeMs: previous?.activeMs ?? 0 };
      root.revision++; return true;
  }
  observe(taskId: string, executionId: string, receipt: TaskExecutionReceipt): Promise<void> {
    return this.store.transaction(s => {
      const task = s.tasks.find(t => t.ref.id === taskId); if (!task) return;
      const root = this.rootIn(s, task.rootTaskRef.id), reservation = root?.reservations[executionId];
      if (!root || !reservation) return;
      if (reservation.held && (receipt.stopConfirmed || receipt.nativeStopConfirmed)) { reservation.held = false; root.revision++; }
    });
  }
  usage(taskId: string, executionId: string, sequence: number, activeMs: number, unknown = false): Promise<void> {
    return this.store.transaction(s => {
      const task = s.tasks.find(t => t.ref.id === taskId); if (!task) return;
      const root = this.rootIn(s, task.rootTaskRef.id), reservation = root?.reservations[executionId];
      if (!root || !reservation || sequence <= reservation.sequence) return;
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(activeMs) || activeMs < reservation.activeMs) return error("usage_invalid", "Usage counters must be monotonic.");
      reservation.sequence = sequence; reservation.activeMs = activeMs; reservation.usageUnknown = unknown; root.revision++;
    });
  }
  segmentUsage(taskId: string, executionId: string, runId: string, usage: { sequence: number; activeMs: number; unknown: boolean }): Promise<void> {
    return this.store.transaction(s => {
      const task = s.tasks.find(t => t.ref.id === taskId); if (!task) return;
      const root = this.rootIn(s, task.rootTaskRef.id), reservation = root?.reservations[executionId];
      if (!root || !reservation) return;
      const previous = reservation.segments?.[runId];
      if (previous && previous.sequence >= usage.sequence) return;
      if (previous && usage.activeMs < previous.activeMs) return error("usage_invalid", "A native segment's usage cannot decrease.");
      (reservation.segments ??= {})[runId] = usage;
      reservation.sequence++; reservation.activeMs = Object.values(reservation.segments).reduce((sum, segment) => sum + segment.activeMs, 0);
      reservation.usageUnknown = Object.values(reservation.segments).some(segment => segment.unknown); root.revision++;
    });
  }
  budgetReason(root: TaskRootState): "usage_unknown" | "time_budget" | null {
    if (root.limits.maxActiveSeconds === null) return null;
    if (Object.values(root.reservations).some(r => r.usageUnknown)) return "usage_unknown";
    return Object.values(root.reservations).reduce((sum, r) => sum + r.activeMs, 0) >= root.limits.maxActiveSeconds * 1000 ? "time_budget" : null;
  }
}
