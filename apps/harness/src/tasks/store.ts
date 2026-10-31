import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "@hosty-sdk/app/providers";
import { taskExecutionTerminal, taskStatuses, type TaskAction, type TaskActor, type TaskCreate, type TaskEdit,
  type TaskInput, type TaskRecord, type TaskProviderRef, type TaskExecutionReceipt, type TaskResult,
  type TaskResource, type TaskAssignee, type TaskStatus } from "@hosty-sdk/app/tasks";

export const taskError = (code: string, message: string, status = 409): never => { throw new ProviderError(code, message, status); };
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    return taskError("request_invalid", "A UUID is required.", 400);
  return value.toLowerCase();
}
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
function text(v: unknown, max: number, required = false): v is string {
  return typeof v === "string" && v.length <= max && (!required || !!v.trim()) && !v.includes("\0");
}
export function resources(value: unknown): TaskResource[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(v => !v || !["app", "workspace", "external"].includes(v.kind)
    || !text(v.owner, 200, true) || !text(v.id, 2000, true) || v.label !== undefined && !text(v.label, 200)
    || !v.version || !["live", "pinned"].includes(v.version.mode)
    || v.version.mode === "pinned" && !text(v.version.revision, 200, true))) return taskError("task_resources_invalid", "Use at most 32 owned, live or revision-pinned references.", 400);
  return value.map(v => ({ kind: v.kind, owner: v.owner, id: v.id, ...(v.label !== undefined ? { label: v.label } : {}),
    version: v.version.mode === "live" ? { mode: "live" } : { mode: "pinned", revision: v.version.revision } }));
}
export function providerRef(value: unknown): TaskProviderRef {
  const v = value as TaskProviderRef;
  if (!v || !text(v.appId, 200, true) || !text(v.installationId, 200, true) || !text(v.key, 100, true)) return taskError("executor_invalid", "Choose an installed executor and interface.", 400);
  return { appId: v.appId, installationId: v.installationId, key: v.key };
}
export function taskInput(value: unknown): TaskInput {
  const v = value as TaskInput;
  if (!v || !text(v.title, 200) || !text(v.markdown, 32000) || v.requiresReview !== undefined && typeof v.requiresReview !== "boolean"
    || v.workspaceId !== undefined && !text(v.workspaceId, 200, true)) return taskError("task_invalid", "Enter a title of at most 200 and a description of at most 32000 characters.", 400);
  let assignee: TaskAssignee | null = null;
  if (v.assignee !== null) {
    const a = v.assignee;
    if (!a || a.name !== undefined && !text(a.name, 200)) return taskError("assignee_invalid", "Choose a person or executor.", 400);
    const name = a.name === undefined ? {} : { name: a.name };
    if (a.kind === "human" && text(a.userId, 200, true)) assignee = { kind: "human", userId: a.userId, ...name };
    else if (a.kind === "app" && (a.optionId === undefined || text(a.optionId, 200, true)))
      assignee = { kind: "app", executor: providerRef(a.executor), ...(a.optionId ? { optionId: a.optionId } : {}), ...name };
    else return taskError("assignee_invalid", "Choose a person or executor.", 400);
  }
  return { title: v.title.trim(), markdown: v.markdown, assignee, requiresReview: v.requiresReview ?? false,
    resources: resources(v.resources), ...(v.workspaceId ? { workspaceId: v.workspaceId } : {}) };
}
export function taskResult(value: unknown): TaskResult {
  const v = value as TaskResult;
  if (!v || !text(v.markdown, 32000, true)) return taskError("result_invalid", "An explicit Markdown result is required (at most 32000 characters).", 400);
  return { markdown: v.markdown, resources: resources(v.resources) };
}
export function sameActor(a: TaskActor, b: TaskActor) {
  return !!a.userId && a.userId === b.userId || !a.userId && !b.userId && !!a.appId && a.appId === b.appId && a.installationId === b.installationId;
}
export function canRead(task: TaskRecord, actor: TaskActor) {
  return sameActor(task.owner, actor) || sameActor(task.createdBy, actor)
    || task.assignee?.kind === "human" && task.assignee.userId === actor.userId;
}
export function activeAttempt(task: TaskRecord) {
  const last = task.attempts.at(-1);
  return last && (!last.receipt || !taskExecutionTerminal(last.receipt.state) || !last.receipt.stopConfirmed) ? last : undefined;
}
type RequestReceipt = { principalId?: string; actor: TaskActor; requestId: string; hash: string; taskId: string; result: TaskRecord };
type State = { version: 1; next: number; tasks: TaskRecord[]; requests: RequestReceipt[]; dispatches?: Record<string, import("@hosty-sdk/app/providers").TaskDispatchRef> };

/** One writer and one fsynced atomic state replacement cover numbering, lifecycle and dispatch intent. */
export class TaskStore {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private readonly file: string;
  constructor(directory: string, readonly provider: TaskProviderRef, readonly prefix = "HRN") {
    this.file = path.join(directory, "tasks", "tasks.json");
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(prefix)) throw new Error("Invalid task prefix.");
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  private async load(): Promise<State> {
    try {
      const s = JSON.parse(await readFile(this.file, "utf8")) as State;
      if (s.version !== 1 || !Number.isSafeInteger(s.next) || s.next < 1 || !Array.isArray(s.tasks) || !Array.isArray(s.requests)) throw new Error("Invalid task store; refusing to reset it.");
      return s;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, next: 1, tasks: [], requests: [] }; throw e; }
  }
  private async save(s: State) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const h = await open(temp, "wx", 0o600);
      try { await h.writeFile(JSON.stringify(s)); await h.sync(); } finally { await h.close(); }
      await rename(temp, this.file);
      const dir = await open(path.dirname(this.file), "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
    for (const listener of this.listeners) listener();
  }
  private find(s: State, id: string, actor?: TaskActor) {
    const t = s.tasks.find(t => t.ref.id === uuid(id));
    if (!t || actor && !canRead(t, actor)) return taskError("task_not_found", "Task not found.", 404);
    return t;
  }
  private replay(s: State, actor: TaskActor, requestId: string, input: unknown, taskId?: string, principalId?: string) {
    const r = s.requests.find(r => sameActor(r.actor, actor) && r.requestId === requestId && r.principalId === principalId);
    if (r && (r.hash !== fingerprint(input) || taskId !== undefined && r.taskId !== taskId)) return taskError("request_conflict", "This request ID already has different input.");
    return r?.result;
  }
  private remember(s: State, actor: TaskActor, id: string, input: unknown, result: TaskRecord, principalId?: string) {
    s.requests.push({ actor, principalId, requestId: id, hash: fingerprint(input), taskId: result.ref.id, result: structuredClone(result) });
  }
  private touch(t: TaskRecord) { t.revision++; t.updatedAt = new Date().toISOString(); }
  all(): Promise<TaskRecord[]> { return this.serial(async () => (await this.load()).tasks); }
  get(id: string, actor: TaskActor) { return this.serial(async () => this.find(await this.load(), id, actor)); }
  list(actor: TaskActor, cursor = "", limit = 50, status?: TaskStatus) {
    return this.serial(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor && !/^\d+$/.test(cursor) || status && !taskStatuses.includes(status)) return taskError("query_invalid", "Use a valid cursor, status and page size (1–100).", 400);
      const rows = (await this.load()).tasks.filter(t => canRead(t, actor) && (!status || t.status === status));
      const start = Number(cursor || 0); return { tasks: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null };
    });
  }
  dispatch(id: string) { return this.serial(async () => (await this.load()).dispatches?.[uuid(id)]); }
  create(actor: TaskActor, input: TaskCreate, principalId?: string) {
    return this.serial(async () => {
      const id = uuid(input.requestId), s = await this.load(); const replay = this.replay(s, actor, id, { operation: "create", ...input }, undefined, principalId);
      if (replay) { this.find(s, replay.ref.id, actor); return replay; }
      const value = taskInput(input.input), now = new Date().toISOString();
      if (!Number.isSafeInteger(s.next + 1)) return taskError("numbers_exhausted", "Task number range exhausted.");
      const task: TaskRecord = { ...value, ref: { ...this.provider, id: randomUUID() }, number: `${this.prefix}-${s.next++}`,
        revision: 1, inputRevision: 1, status: "Draft", createdBy: actor, owner: actor.userId ? { userId: actor.userId, appId: null } : actor,
        createdAt: now, updatedAt: now, cancelRequested: false, attempts: [], outcomes: [] };
      s.tasks.push(task); this.remember(s, actor, id, { operation: "create", ...input }, task, principalId); await this.save(s); return task;
    });
  }
  edit(id: string, actor: TaskActor, input: TaskEdit, principalId?: string) {
    return this.mutate(id, actor, input, "edit", t => {
      if (t.status !== "Draft" || activeAttempt(t)) return taskError("task_not_editable", "Return stopped work to Draft before editing.");
      const value = taskInput(input.input);
      Object.assign(t, value);
      if (!value.workspaceId) delete t.workspaceId;
      t.inputRevision++;
    }, principalId);
  }
  private mutate(id: string, actor: TaskActor, input: TaskAction | TaskEdit, operation: string, fn: (t: TaskRecord) => void | Promise<void>, principalId?: string, dispatch?: import("@hosty-sdk/app/providers").TaskDispatchRef) {
    return this.serial(async () => {
      const requestId = uuid(input.requestId), s = await this.load(), t = this.find(s, id, actor);
      const payload = { operation, id, ...input }; const replay = this.replay(s, actor, requestId, payload, id, principalId); if (replay) return replay;
      if (input.expectedRevision !== t.revision) return taskError("task_changed", "Task changed. Reload before applying this action.");
      await fn(t); if (dispatch) (s.dispatches ??= {})[t.ref.id] = dispatch; this.touch(t); this.remember(s, actor, requestId, payload, t, principalId); await this.save(s); return t;
    });
  }
  action(id: string, actor: TaskActor, input: TaskAction, prepare?: (t: TaskRecord) => Promise<TaskAssignee>, principalId?: string, dispatch?: import("@hosty-sdk/app/providers").TaskDispatchRef, guard?: (t: TaskRecord) => void) {
    return this.mutate(id, actor, input, "action", async t => {
      guard?.(t);
      const active = activeAttempt(t);
      if (t.cancelRequested && input.action !== "cancel") return taskError("cancellation_pending", "Wait for confirmed cancellation.");
      switch (input.action) {
        case "ready":
          if (["Ready", "InProgress"].includes(t.status)) return;
          if (t.status !== "Draft" || active) return taskError("task_not_ready", "Return stopped work to Draft before starting a new attempt.");
          if (!t.title || !t.markdown.trim() || !t.assignee) return taskError("task_incomplete", "A title, description and assignee are required.");
          if (prepare) t.assignee = await prepare(t);
          t.status = "Ready"; delete t.blocked; delete t.result; delete t.resultInputRevision;
          if (t.assignee.kind === "app") {
            const { assignee, ...snapshot } = taskInput(t);
            t.attempts.push({ executionId: randomUUID(), executor: t.assignee.executor,
              request: { taskRef: t.ref, taskRevision: t.inputRevision, ...(t.assignee.optionId ? { executorOptionId: t.assignee.optionId } : {}), input: snapshot },
              cancelRequested: false, createdAt: new Date().toISOString() });
          }
          return;
        case "draft":
          if (active) return taskError("execution_active", "The previous execution must be confirmed stopped.");
          t.status = "Draft"; t.cancelRequested = false; delete t.blocked; return;
        case "start":
          if (t.status !== "Ready" || t.assignee?.kind !== "human") return taskError("task_transition_invalid", "Only human-assigned Ready work can be started manually.");
          t.status = "InProgress"; return;
        case "complete":
          if (t.status !== "InProgress" || t.assignee?.kind !== "human") return taskError("task_transition_invalid", "Only active human work can be completed manually.");
          t.result = taskResult(input.result); t.resultInputRevision = t.inputRevision;
          (t.outcomes ??= []).push({ inputRevision: t.inputRevision, result: t.result, recordedAt: new Date().toISOString() });
          t.status = t.requiresReview ? "Blocked" : "Done";
          if (t.requiresReview) t.blocked = { reason: "needs_review", message: "Review the submitted result." }; return;
        case "accept": case "request_changes":
          if (!sameActor(t.owner, actor)) return taskError("review_forbidden", "Only the task owner can review the result.", 403);
          if (t.blocked?.reason !== "needs_review" || active || !t.result || input.resultInputRevision !== t.resultInputRevision || t.resultInputRevision !== t.inputRevision)
            return taskError("review_changed", "Review the current result and input revision.");
          if (input.action === "accept") t.status = "Done";
          else { if (!text(input.feedback, 4000, true)) return taskError("feedback_required", "Describe the requested changes (at most 4000 characters).", 400);
            t.markdown += `\n\n## Requested changes\n${input.feedback}`; if (t.markdown.length > 32000) return taskError("task_invalid", "Shorten the description before adding feedback.", 400);
            t.inputRevision++; t.status = "Draft"; }
          delete t.blocked; return;
        case "cancel":
          if (t.status === "Cancelled") return;
          if (t.status === "Done") return taskError("task_transition_invalid", "Reopen completed work before cancelling.");
          if (active) { active.cancelRequested = true; t.cancelRequested = true; }
          else { t.status = "Cancelled"; t.cancelRequested = false; delete t.blocked; } return;
        default: return taskError("action_invalid", "Unknown task action.", 400);
      }
    }, principalId, dispatch);
  }
  observe(id: string, executionId: string, receipt: TaskExecutionReceipt) {
    return this.serial(async () => {
      const s = await this.load(), t = this.find(s, id), a = t.attempts.at(-1);
      if (!a || a.executionId !== executionId || receipt.executionId !== executionId) return t;
      const recoveringAvailability = t.blocked?.reason === "executor_unavailable";
      if (a.receipt && (receipt.revision < a.receipt.revision || receipt.revision === a.receipt.revision
        && (!recoveringAvailability || fingerprint(receipt) !== fingerprint(a.receipt)))) return t;
      if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || typeof receipt.stopConfirmed !== "boolean"
        || !["accepted", "running", "awaiting_input", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(receipt.state)) return taskError("receipt_invalid", "Executor returned an invalid receipt.", 502);
      if (a.receipt?.stopConfirmed && taskExecutionTerminal(a.receipt.state)) return t;
      a.receipt = structuredClone(receipt);
      if (t.status !== "Cancelled") {
        // Availability is a local projection, not a new execution revision. An identical current
        // receipt restores it once; older or changed same-revision evidence remains ignored.
        if (recoveringAvailability) {
          t.status = receipt.state === "running" ? "InProgress" : "Ready";
          delete t.blocked;
        }
        if (t.cancelRequested) {
          if (receipt.stopConfirmed && taskExecutionTerminal(receipt.state)) { t.status = "Cancelled"; t.cancelRequested = false; delete t.blocked; }
        } else if (receipt.state === "completed" && receipt.stopConfirmed && receipt.result) {
          t.result = taskResult(receipt.result); t.resultInputRevision = a.request.taskRevision;
          (t.outcomes ??= []).push({ inputRevision: a.request.taskRevision, executionId, result: t.result, recordedAt: new Date().toISOString() });
          t.status = t.requiresReview ? "Blocked" : "Done";
          if (t.requiresReview) t.blocked = { reason: "needs_review", message: "Review the submitted result." }; else delete t.blocked;
        } else if (taskExecutionTerminal(receipt.state)) {
          t.status = "Blocked"; t.blocked = { reason: "execution_failed", message: receipt.error?.message ?? "The execution ended without an explicit task result." };
        } else if (receipt.state === "awaiting_input") {
          t.status = "Blocked"; t.blocked = { reason: "needs_input", message: "Respond in the execution's conversation." };
        } else if (receipt.state === "running") { t.status = "InProgress"; delete t.blocked; }
      }
      this.touch(t); await this.save(s); return t;
    });
  }
  unavailable(id: string, message: string) {
    return this.serial(async () => {
      const s = await this.load(), t = this.find(s, id); if (!activeAttempt(t) || t.cancelRequested) return;
      if (t.blocked?.reason === "executor_unavailable" && t.blocked.message === message) return;
      t.status = "Blocked"; t.blocked = { reason: "executor_unavailable", message }; this.touch(t); await this.save(s);
    });
  }
}
