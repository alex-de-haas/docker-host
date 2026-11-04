import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "@hosty-sdk/app/providers";
import { taskExecutionTerminal, taskStatuses, taskReferenceKey, type TaskAction, type TaskActor,
  type TaskCreate, type TaskEdit, type TaskInput, type TaskRecord, type TaskProviderRef,
  type TaskExecutionReceipt, type TaskResult, type TaskResource, type TaskAssignee, type TaskStatus,
  type TaskRef, type TaskSelection, type TaskOutcomeRef, type TaskExecutionInput } from "@hosty-sdk/app/tasks";

export const taskError = (code: string, message: string, status = 409): never => { throw new ProviderError(code, message, status); };
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    return taskError("request_invalid", "A UUID is required.", 400);
  return value.toLowerCase();
}
/** Ordinal UTF-16 key ordering matches Core; locale-sensitive ordering is never a wire digest. */
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash("sha256").update(JSON.stringify(normalize(value)) ?? "undefined").digest("hex");
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
export function taskRef(value: unknown): TaskRef {
  return { ...providerRef(value), id: uuid((value as TaskRef)?.id) };
}
export function selection(value: unknown): TaskSelection {
  const v = value as TaskSelection;
  if (!v || !["option", "configuration"].includes(v.kind) || !text(v.id, 200, true)
    || !Number.isSafeInteger(v.revision) || v.revision < 1) return taskError("selection_invalid", "Select an executor option or configuration at its current revision.", 400);
  return { kind: v.kind, id: v.id, revision: v.revision };
}
export function taskInput(value: unknown): TaskInput {
  const v = value as TaskInput;
  if (!v || !text(v.title, 200) || !text(v.markdown, 32000)
    || "requiresReview" in v || "workspaceId" in v
    || v.review !== undefined && (!v.review || !["none", "owner", "delegator"].includes(v.review.mode)))
    return taskError("task_invalid", "Use the current v1 task fields, a title up to 200 and a description up to 32000 characters.", 400);
  let assignee: TaskAssignee | null = null;
  if (v.assignee !== null) {
    const a = v.assignee;
    if (!a || a.name !== undefined && !text(a.name, 200) || "optionId" in a) return taskError("assignee_invalid", "Choose a person or a revision-qualified executor selection.", 400);
    const name = a.name === undefined ? {} : { name: a.name };
    if (a.kind === "human" && text(a.userId, 200, true)) assignee = { kind: "human", userId: a.userId, ...name };
    else if (a.kind === "app") assignee = { kind: "app", executor: providerRef(a.executor), ...(a.selection ? { selection: selection(a.selection) } : {}), ...name };
    else return taskError("assignee_invalid", "Choose a person or executor.", 400);
  }
  if (v.dependsOn !== undefined && (!Array.isArray(v.dependsOn) || v.dependsOn.length > 100)) return taskError("relations_invalid", "Use at most 100 prerequisite references.", 400);
  const dependsOn = (v.dependsOn ?? []).map(taskRef);
  if (new Set(dependsOn.map(taskReferenceKey)).size !== dependsOn.length) return taskError("relations_invalid", "Prerequisites must be unique.", 400);
  return { title: v.title.trim(), markdown: v.markdown, assignee, review: { mode: v.review?.mode ?? "none" },
    resources: resources(v.resources), parentTaskRef: v.parentTaskRef == null ? null : taskRef(v.parentTaskRef), dependsOn };
}
export function executionInput(value: unknown): TaskExecutionInput {
  const v = value as TaskExecutionInput;
  if (!v || v.version !== 1 || !Number.isSafeInteger(v.inputRevision) || v.inputRevision < 1
    || !v.relations || !Number.isSafeInteger(v.relations.relationRevision) || v.relations.relationRevision < 1
    || !Array.isArray(v.prerequisiteOutcomes) || v.prerequisiteOutcomes.length > 100)
    return taskError("execution_invalid", "Supply the complete immutable v1 execution input.", 400);
  const content = taskInput({ ...v.content, assignee: null });
  if (!content.title || !content.markdown.trim()) return taskError("execution_invalid", "Task content must be nonempty.", 400);
  return { version: 1, taskRef: taskRef(v.taskRef), inputRevision: v.inputRevision,
    ...(v.selection ? { selection: selection(v.selection) } : {}),
    content: { title: content.title, markdown: content.markdown, resources: content.resources, review: content.review },
    relations: { rootTaskRef: taskRef(v.relations.rootTaskRef), parentTaskRef: v.relations.parentTaskRef === null ? null : taskRef(v.relations.parentTaskRef), relationRevision: v.relations.relationRevision },
    prerequisiteOutcomes: v.prerequisiteOutcomes.map(outcomeRef) };
}
function outcomeRef(value: unknown): TaskOutcomeRef {
  const v = value as TaskOutcomeRef;
  if (!v || !Number.isSafeInteger(v.inputRevision) || v.inputRevision < 1 || !Number.isSafeInteger(v.resultRevision) || v.resultRevision < 1)
    return taskError("outcome_invalid", "Select the exact result and input revision.", 400);
  return { taskRef: taskRef(v.taskRef), inputRevision: v.inputRevision, resultRevision: v.resultRevision,
    executionId: v.executionId === null ? null : uuid(v.executionId) };
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
  return sameActor(task.owner, actor) || sameActor(task.createdBy, actor) || task.assignee?.kind === "human" && task.assignee.userId === actor.userId;
}
export function activeAttempt(task: TaskRecord) {
  const last = task.attempts.at(-1);
  return last && (!last.receipt || !taskExecutionTerminal(last.receipt.state) || !last.receipt.stopConfirmed) ? last : undefined;
}
type RequestReceipt = { principalId?: string; actor: TaskActor; requestId: string; hash: string; taskId: string; result: TaskRecord };
export type TaskState = {
  version: 1; next: number; tasks: TaskRecord[]; requests: RequestReceipt[];
  dispatches?: Record<string, import("@hosty-sdk/app/providers").TaskDispatchRef>;
  /** Executor-owned records share the same fsynced aggregate; they never appear in task responses. */
  journal?: Record<string, unknown>;
};

/** Single writer for tasks, graph, request receipts and private orchestration intents. No network I/O inside transactions. */
export class TaskStore {
  afterCreate?: (state: TaskState, task: TaskRecord) => void;
  beforeReopen?: (state: TaskState, task: TaskRecord) => void;
  beforeChild?: (state: TaskState, parent: TaskRecord) => void;
  beforeAttempt?: (state: TaskState, task: TaskRecord) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private readonly file: string;
  constructor(directory: string, readonly provider: TaskProviderRef, readonly prefix = "HRN") {
    this.file = path.join(directory, "tasks", "tasks.json");
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(prefix)) throw new Error("Invalid task prefix.");
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  private async load(): Promise<TaskState> {
    try {
      const s = JSON.parse(await readFile(this.file, "utf8")) as TaskState;
      if (s.version !== 1 || !Number.isSafeInteger(s.next) || s.next < 1 || !Array.isArray(s.tasks) || !Array.isArray(s.requests)) throw new Error("Invalid task store; refusing to reset it.");
      return s;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, next: 1, tasks: [], requests: [] }; throw e; }
  }
  private async save(s: TaskState) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const h = await open(temp, "wx", 0o600);
      try { await h.writeFile(JSON.stringify(s)); await h.sync(); } finally { await h.close(); }
      await rename(temp, this.file);
      const dir = await open(path.dirname(this.file), "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
    for (const listener of this.listeners) { try { listener(); } catch { /* A subscriber cannot undo a durable commit. */ } }
  }
  transaction<T>(fn: (state: TaskState) => T): Promise<T> {
    return this.serial(async () => {
      const state = await this.load(), before = fingerprint(state), result = fn(state);
      if (fingerprint(state) !== before) await this.save(state);
      return structuredClone(result);
    });
  }
  readJournal<T>(key: string): Promise<T | undefined> { return this.serial(async () => (await this.load()).journal?.[key] as T | undefined); }
  journalEntries<T>(prefix: string): Promise<Array<[string, T]>> {
    return this.serial(async () => Object.entries((await this.load()).journal ?? {}).filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>);
  }
  writeJournal<T>(key: string, value: T): Promise<void> { return this.transaction(s => { (s.journal ??= {})[key] = value; }); }
  find(s: TaskState, id: string, actor?: TaskActor): TaskRecord {
    const t = s.tasks.find(t => t.ref.id === uuid(id));
    if (!t || actor && !canRead(t, actor)) return taskError("task_not_found", "Task not found.", 404);
    return t;
  }
  private localRef(s: TaskState, ref: TaskRef, actor: TaskActor): TaskRecord {
    if (fingerprint(providerRef(ref)) !== fingerprint(this.provider)) return taskError("unsupported_capability", "Relationships require the same task provider installation.");
    return this.find(s, ref.id, actor);
  }
  private replay(s: TaskState, actor: TaskActor, requestId: string, input: unknown, taskId?: string, principalId?: string) {
    const r = s.requests.find(r => sameActor(r.actor, actor) && r.requestId === requestId && r.principalId === principalId);
    if (r && (r.hash !== fingerprint(input) || taskId !== undefined && r.taskId !== taskId)) return taskError("request_conflict", "This request ID already has different input.");
    return r?.result;
  }
  private remember(s: TaskState, actor: TaskActor, id: string, input: unknown, result: TaskRecord, principalId?: string) {
    s.requests.push({ actor, principalId, requestId: id, hash: fingerprint(input), taskId: result.ref.id, result: structuredClone(result) });
  }
  touch(t: TaskRecord) { t.revision++; t.updatedAt = new Date().toISOString(); }
  all(): Promise<TaskRecord[]> { return this.serial(async () => (await this.load()).tasks); }
  get(id: string, actor: TaskActor) { return this.serial(async () => this.find(await this.load(), id, actor)); }
  request(actor: TaskActor, requestId: string, principalId?: string) {
    return this.serial(async () => {
      const s = await this.load(), r = s.requests.find(r => r.requestId === uuid(requestId) && sameActor(r.actor, actor) && r.principalId === principalId);
      if (!r) return taskError("request_not_found", "No applied request with this ID is visible.", 404);
      this.find(s, r.taskId, actor);
      return { requestId: r.requestId, state: "applied" as const, taskRef: r.result.ref, result: r.result };
    });
  }
  list(actor: TaskActor, cursor = "", limit = 50, status?: TaskStatus, filters: { parentTaskRef?: string; rootTaskRef?: string; rootsOnly?: boolean } = {}) {
    return this.serial(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor && !/^\d+$/.test(cursor) || status && !taskStatuses.includes(status)) return taskError("query_invalid", "Use a valid cursor, status and page size (1–100).", 400);
      const rows = (await this.load()).tasks.filter(t => canRead(t, actor) && (!status || t.status === status)
        && (!filters.rootsOnly || t.parentTaskRef === null)
        && (!filters.parentTaskRef || t.parentTaskRef && taskReferenceKey(t.parentTaskRef) === filters.parentTaskRef)
        && (!filters.rootTaskRef || taskReferenceKey(t.rootTaskRef) === filters.rootTaskRef));
      const start = Number(cursor || 0); return { tasks: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null };
    });
  }
  dispatch(id: string) { return this.serial(async () => (await this.load()).dispatches?.[uuid(id)]); }
  private graph(s: TaskState, task: TaskRecord, actor: TaskActor) {
    for (const ref of task.dependsOn) {
      const prerequisite = this.localRef(s, ref, actor);
      if (!sameActor(task.owner, prerequisite.owner) || prerequisite.rootTaskRef.id !== task.rootTaskRef.id)
        return taskError("relations_invalid", "Prerequisites must belong to this owner's task tree.");
    }
    const rows = s.tasks.filter(t => t.rootTaskRef.id === task.rootTaskRef.id), byId = new Map(rows.map(t => [t.ref.id, t]));
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) return taskError("relations_cycle", "Task prerequisites and parent completion waits must be acyclic.");
      if (visited.has(id)) return;
      visiting.add(id);
      const t = byId.get(id)!;
      for (const dependency of t.dependsOn) visit(dependency.id);
      for (const child of rows.filter(c => c.parentTaskRef?.id === id)) visit(child.ref.id);
      for (const replacement of t.disposition?.replacementRefs ?? []) visit(replacement.id);
      visiting.delete(id); visited.add(id);
    };
    for (const t of rows) visit(t.ref.id);
  }
  private bumpGraph(s: TaskState, rootId: string) {
    const root = this.find(s, rootId), revision = root.graphRevision + 1;
    for (const t of s.tasks.filter(t => t.rootTaskRef.id === rootId)) { t.graphRevision = revision; this.touch(t); }
  }
  create(actor: TaskActor, input: TaskCreate, principalId?: string, guard?: (s: TaskState) => void) {
    return this.transaction(s => { guard?.(s); return this.createIn(s, actor, input, principalId); });
  }
  createIn(s: TaskState, actor: TaskActor, input: TaskCreate, principalId?: string): TaskRecord {
    const id = uuid(input.requestId), replay = this.replay(s, actor, id, { operation: "create", ...input }, undefined, principalId);
    if (replay) { this.find(s, replay.ref.id, actor); return replay; }
    const value = taskInput(input.input), now = new Date().toISOString();
    if (!Number.isSafeInteger(s.next + 1)) return taskError("numbers_exhausted", "Task number range exhausted.");
    const parent = value.parentTaskRef ? this.localRef(s, value.parentTaskRef, actor) : null;
    if (parent && (!sameActor(parent.owner, actor) || ["Done", "Cancelled"].includes(parent.status) || parent.cancelRequested || parent.disposition))
      return taskError("parent_closed", "Create children only in an owned, open task tree.");
    if (parent && input.expectedGraphRevision !== parent.graphRevision) return taskError("graph_changed", "Reload the task tree before changing its relationships.");
    if (!parent && value.review.mode === "delegator") return taskError("review_invalid", "Delegator review requires a parent task.", 400);
    if (parent) this.beforeChild?.(s, parent);
    const ref = { ...this.provider, id: randomUUID() };
    const task: TaskRecord = { ...value, ref, number: `${this.prefix}-${s.next++}`, rootTaskRef: parent?.rootTaskRef ?? ref,
      depth: parent ? parent.depth + 1 : 0, relationRevision: 1, graphRevision: parent?.graphRevision ?? 1,
      revision: 1, inputRevision: 1, status: "Draft", createdBy: actor, owner: actor.userId ? { userId: actor.userId, appId: null } : actor,
      createdAt: now, updatedAt: now, cancelRequested: false, armed: false, attempts: [], outcomes: [] };
    s.tasks.push(task); this.afterCreate?.(s, task); this.graph(s, task, actor); if (parent) this.bumpGraph(s, task.rootTaskRef.id);
    this.remember(s, actor, id, { operation: "create", ...input }, task, principalId); return task;
  }
  edit(id: string, actor: TaskActor, input: TaskEdit, principalId?: string, guard?: (t: TaskRecord, s: TaskState) => void) {
    return this.mutate(id, actor, input, "edit", (t, s) => {
      guard?.(t, s);
      if (t.status !== "Draft" || activeAttempt(t)) return taskError("task_not_editable", "Return stopped work to Draft before editing.");
      const value = taskInput(input.input);
      if (!value.parentTaskRef && value.review.mode === "delegator") return taskError("review_invalid", "Delegator review requires a parent task.", 400);
      if (fingerprint(value.parentTaskRef) !== fingerprint(t.parentTaskRef)) return taskError("parent_immutable", "A task's parent cannot change.");
      if (input.expectedGraphRevision !== t.graphRevision) return taskError("graph_changed", "Reload the task tree before editing.");
      const relationChanged = fingerprint(value.dependsOn) !== fingerprint(t.dependsOn);
      if (fingerprint(value) === fingerprint(taskInput(t))) return;
      this.invalidateDependants(s, t);
      Object.assign(t, value); t.inputRevision++;
      if (relationChanged) { t.relationRevision++; this.graph(s, t, actor); this.bumpGraph(s, t.rootTaskRef.id); }
    }, principalId);
  }
  private mutate(id: string, actor: TaskActor, input: TaskAction | TaskEdit, operation: string, fn: (t: TaskRecord, s: TaskState) => void, principalId?: string, dispatch?: import("@hosty-sdk/app/providers").TaskDispatchRef) {
    return this.transaction(s => {
      const requestId = uuid(input.requestId), t = this.find(s, id, actor), payload = { operation, id, ...input };
      const replay = this.replay(s, actor, requestId, payload, id, principalId); if (replay) return replay;
      if (input.expectedRevision !== t.revision) return taskError("task_changed", "Task changed. Reload before applying this action.");
      fn(t, s); if (dispatch) (s.dispatches ??= {})[t.ref.id] = dispatch;
      this.touch(t); this.refresh(s); this.publishChild(s, t); this.remember(s, actor, requestId, payload, t, principalId); return t;
    });
  }
  private satisfied(s: TaskState, t: TaskRecord) {
    return t.dependsOn.every(ref => { const p = this.find(s, ref.id); return p.status === "Done" && !!p.acceptedResultRef && !activeAttempt(p); });
  }
  private childrenDone(s: TaskState, t: TaskRecord) {
    return s.tasks.filter(c => c.parentTaskRef?.id === t.ref.id).every(c => !activeAttempt(c) && (
      c.status === "Done" && !!c.acceptedResultRef || c.disposition?.kind === "not_required"
      || c.disposition?.kind === "superseded" && c.disposition.replacementRefs.every(ref => {
        const replacement = this.find(s, ref.id);
        return replacement.status === "Done" && !!replacement.acceptedResultRef && !activeAttempt(replacement);
      })));
  }
  private childOutcomes(s: TaskState, t: TaskRecord): TaskOutcomeRef[] {
    return s.tasks.filter(c => c.parentTaskRef?.id === t.ref.id).flatMap(c => c.disposition?.kind === "superseded"
      ? c.disposition.replacementRefs.map(ref => this.find(s, ref.id).acceptedResultRef!)
      : c.acceptedResultRef ? [c.acceptedResultRef] : []);
  }
  validateResult(taskId: string, executionId: string): Promise<TaskOutcomeRef[]> {
    return this.transaction(s => {
      const t = this.find(s, taskId), a = activeAttempt(t);
      if (!a || a.executionId !== executionId || a.cancelRequested || t.cancelRequested)
        return taskError("execution_closed", "Only the current admitted attempt may submit a result.");
      if (!this.childrenDone(s, t)) return taskError("children_incomplete", "Review all required children and accepted replacements before submitting the parent result.");
      if (a.invalidated || !this.satisfied(s, t) || a.request.prerequisiteOutcomes.some(o => fingerprint(this.find(s, o.taskRef.id).acceptedResultRef) !== fingerprint(o)))
        return taskError("prerequisite_changed", "This execution used a superseded prerequisite.");
      return this.childOutcomes(s, t);
    });
  }
  snapshot(s: TaskState, t: TaskRecord): TaskExecutionInput {
    return { version: 1, taskRef: t.ref, inputRevision: t.inputRevision,
      ...(t.assignee?.kind === "app" && t.assignee.selection ? { selection: t.assignee.selection } : {}),
      content: { title: t.title, markdown: t.markdown, resources: t.resources, review: t.review },
      relations: { rootTaskRef: t.rootTaskRef, parentTaskRef: t.parentTaskRef, relationRevision: t.relationRevision },
      prerequisiteOutcomes: t.dependsOn.map(ref => this.find(s, ref.id).acceptedResultRef!) };
  }
  private admit(s: TaskState, t: TaskRecord) {
    if (!t.armed || activeAttempt(t) || !t.assignee) return;
    if (!this.satisfied(s, t)) { t.status = "Blocked"; t.blocked = { reason: "prerequisites", message: "Waiting for accepted prerequisite outcomes." }; return; }
    t.status = "Ready"; delete t.blocked;
    if (t.assignee.kind === "app") {
      this.beforeAttempt?.(s, t);
      t.attempts.push({ executionId: randomUUID(), executor: t.assignee.executor, request: this.snapshot(s, t),
        cancelRequested: false, createdAt: new Date().toISOString() });
      t.armed = false;
      const root = s.journal?.["root:" + t.rootTaskRef.id] as { generation: number } | undefined;
      if (root) t.coordination = { rootGeneration: root.generation, coordinatorEpoch: (t.coordination?.coordinatorEpoch ?? 0) + 1, executionId: t.attempts.at(-1)!.executionId };
    }
  }
  private refresh(s: TaskState) {
    for (const t of s.tasks) {
      if (t.armed && ["prerequisites", "limits"].includes(t.blocked?.reason ?? "") && this.satisfied(s, t)) {
        const before = fingerprint(t);
        try { this.admit(s, t); }
        catch (error) {
          if (!(error instanceof ProviderError) || !["limit_exceeded", "root_paused", "root_stopped"].includes(error.code)) throw error;
          t.status = "Blocked"; t.blocked = { reason: "limits", message: error.message };
        }
        if (fingerprint(t) !== before) this.touch(t);
      }
    }
  }
  private publishChild(s: TaskState, t: TaskRecord): void {
    if (!t.parentTaskRef) return;
    const attempt = t.attempts.at(-1), result = t.resultRef;
    if (!result && !["Cancelled", "Done"].includes(t.status) && !["execution_failed", "executor_unavailable", "needs_input", "prerequisite_changed"].includes(t.blocked?.reason ?? "")) return;
    const root = s.journal?.["root:" + t.rootTaskRef.id] as { generation: number } | undefined;
    if (!root) return;
    const generation = t.coordination?.rootGeneration ?? root.generation;
    const id = fingerprint({ task: t.ref, generation, result, status: t.status, blocked: t.blocked?.reason, receipt: attempt?.receipt?.revision });
    const key = "child-outbox:" + id;
    if (s.journal?.[key]) return;
    (s.journal ??= {})[key] = { id, parentTaskRef: t.parentTaskRef, taskRef: t.ref, rootGeneration: generation, taskRevision: t.revision,
      resultRevision: result?.resultRevision ?? 0, receiptRevision: attempt?.receipt?.revision ?? 0, resultRef: result,
      status: t.blocked?.reason ?? t.status, summary: (t.result?.markdown ?? t.blocked?.message ?? t.status).slice(0, 2000), delivered: false };
  }
  refreshQueued(): Promise<void> { return this.transaction(s => this.refresh(s)); }
  private invalidateDependants(s: TaskState, changed: TaskRecord, visited = new Set<string>()) {
    if (visited.has(changed.ref.id)) return; visited.add(changed.ref.id);
    delete changed.acceptedResultRef;
    for (const t of s.tasks.filter(t => t.dependsOn.some(r => r.id === changed.ref.id) || t.ref.id === changed.parentTaskRef?.id)) {
      if (!t.attempts.length && !t.resultRef && t.status !== "InProgress") continue;
      const a = activeAttempt(t);
      if (a && a.request.prerequisiteOutcomes.some(o => o.taskRef.id === changed.ref.id)) { a.cancelRequested = true; a.invalidated = true; }
      if (t.acceptedResultRef || t.resultRef && t.status === "Done" || t.assignee?.kind === "human" && t.status === "InProgress") {
        t.status = "Blocked"; t.blocked = { reason: "prerequisite_changed", message: "A previously accepted prerequisite changed. Review or retry this work." };
      }
      this.touch(t); this.invalidateDependants(s, t, visited);
    }
  }
  private recordResult(s: TaskState, t: TaskRecord, result: TaskResult, executionId: string | null, inputRevision: number, invalidated = false, childOutcomes?: TaskOutcomeRef[]) {
    const ref = { taskRef: t.ref, inputRevision, executionId, resultRevision: (t.outcomes.at(-1)?.ref.resultRevision ?? 0) + 1 };
    t.outcomes.push({ ref, result, childOutcomes: childOutcomes ?? this.childOutcomes(s, t), recordedAt: new Date().toISOString(), ...(invalidated ? { invalidated: true } : {}) });
    if (invalidated || inputRevision !== t.inputRevision) {
      t.status = "Blocked"; t.blocked = { reason: "prerequisite_changed", message: "This result used a superseded prerequisite. Retry with current inputs." }; return;
    }
    t.result = result; t.resultRef = ref; this.finish(s, t);
  }
  private finish(s: TaskState, t: TaskRecord) {
    if (!this.childrenDone(s, t)) { t.status = "Blocked"; t.blocked = { reason: "children_incomplete", message: "The executor submitted a result before reviewing required children. Retry after accepting their results." }; return; }
    if (t.review.mode !== "none") { t.status = "Blocked"; t.blocked = { reason: "needs_review", message: "Review the submitted result." }; return; }
    this.acceptResult(t);
  }
  private acceptResult(t: TaskRecord) {
    t.status = "Done"; t.armed = false; t.acceptedResultRef = t.resultRef;
    const outcome = t.outcomes.find(o => o.ref.resultRevision === t.resultRef?.resultRevision);
    if (outcome) outcome.acceptedAt = new Date().toISOString(); delete t.blocked;
  }
  async action(id: string, actor: TaskActor, input: TaskAction, prepare?: (t: TaskRecord) => Promise<TaskAssignee>, principalId?: string, dispatch?: import("@hosty-sdk/app/providers").TaskDispatchRef, guard?: (t: TaskRecord, s: TaskState) => void) {
    // Selection may call other providers. Keep network work outside the aggregate writer and then CAS.
    let prepared: TaskAssignee | undefined;
    if (prepare && ["ready", "retry", "request_changes"].includes(input.action)) {
      const prior = await this.serial(async () => { const s = await this.load(); const t = this.find(s, id, actor);
        return { t, s, replay: this.replay(s, actor, uuid(input.requestId), { operation: "action", id, ...input }, id, principalId) }; });
      if (prior.replay) return prior.replay;
      if (prior.t.revision !== input.expectedRevision) return taskError("task_changed", "Task changed. Reload before applying this action.");
      guard?.(prior.t, prior.s);
      if (input.selection && prior.t.assignee?.kind === "app") prior.t.assignee.selection = selection(input.selection);
      if (prior.t.assignee) prepared = await prepare(prior.t);
    }
    return this.mutate(id, actor, input, "action", (t, s) => {
      guard?.(t, s); const active = activeAttempt(t);
      if (t.cancelRequested && input.action !== "cancel") return taskError("cancellation_pending", "Wait for confirmed cancellation.");
      switch (input.action) {
        case "ready":
          if (["Ready", "InProgress"].includes(t.status) || t.armed) return;
          if (t.status !== "Draft" || active) return taskError("task_not_ready", "Return stopped work to Draft before starting a new attempt.");
          if (!t.title || !t.markdown.trim() || !t.assignee) return taskError("task_incomplete", "A title, description and assignee are required.");
          if (prepared) t.assignee = prepared;
          delete t.result; delete t.resultRef; delete t.acceptedResultRef; delete t.disposition;
          t.armed = true; this.admit(s, t); return;
        case "draft":
          this.beforeReopen?.(s, t);
          if (active) return taskError("execution_active", "The previous execution must be confirmed stopped.");
          this.invalidateDependants(s, t); t.status = "Draft"; t.armed = false; t.cancelRequested = false; delete t.blocked; delete t.disposition; return;
        case "start":
          if (t.status !== "Ready" || t.assignee?.kind !== "human" || !this.satisfied(s, t)) return taskError("task_transition_invalid", "Only eligible human-assigned Ready work can be started manually.");
          t.armed = false; t.status = "InProgress"; (s.journal ??= {})["human-input:" + t.ref.id] = this.snapshot(s, t); return;
        case "complete":
          if (t.status !== "InProgress" || t.assignee?.kind !== "human") return taskError("task_transition_invalid", "Only active human work can be completed manually.");
          if (!this.childrenDone(s, t)) return taskError("children_incomplete", "Review all required children before completing this task.");
          if (!this.satisfied(s, t)) return taskError("prerequisite_changed", "Complete work only against accepted prerequisites.");
          this.recordResult(s, t, taskResult(input.result), null, t.inputRevision); return;
        case "accept": case "request_changes":
          if (!sameActor(t.owner, actor)) return taskError("review_forbidden", "Only the task owner or its current delegator can review the result.", 403);
          if (t.blocked?.reason !== "needs_review" || active || !t.result || !input.resultRef || fingerprint(input.resultRef) !== fingerprint(t.resultRef)
            || t.resultRef?.inputRevision !== t.inputRevision || !this.childrenDone(s, t)) return taskError("review_changed", "Review the exact current result and input revision.");
          if (input.action === "accept") { this.acceptResult(t); return; }
          if (!text(input.feedback, 4000, true)) return taskError("feedback_required", "Describe the requested changes (at most 4000 characters).", 400);
          this.invalidateDependants(s, t);
          t.markdown += `\n\n## Requested changes\n${input.feedback}`;
          if (t.markdown.length > 32000) return taskError("task_invalid", "Shorten the description before adding feedback.", 400);
          t.inputRevision++; if (prepared) t.assignee = prepared;
          delete t.result; delete t.resultRef; t.armed = true; this.admit(s, t); return;
        case "retry":
          if (active || t.status !== "Blocked" || !["execution_failed", "prerequisite_changed", "children_incomplete"].includes(t.blocked?.reason ?? ""))
            return taskError("retry_invalid", "Retry only confirmed-stopped failed or invalidated work.");
          if (input.selection) {
            if (t.assignee?.kind !== "app") return taskError("selection_invalid", "Only an application execution has an executor selection.", 400);
            t.assignee.selection = selection(input.selection); t.inputRevision++;
          }
          if (prepared) t.assignee = prepared;
          delete t.result; delete t.resultRef; t.armed = true; this.admit(s, t); return;
        case "disposition": {
          if (!sameActor(t.owner, actor) || !t.parentTaskRef) return taskError("disposition_forbidden", "Only owned child work can be explicitly disposed.", 403);
          if (active) return taskError("execution_active", "Stop the child before disposing of it.");
          const d = input.disposition;
          if (!d || !["superseded", "not_required"].includes(d.kind) || !text(d.reason, 2000, true) || !Array.isArray(d.replacementRefs) || d.replacementRefs.length > 100
            || d.kind === "superseded" && !d.replacementRefs.length || d.kind === "not_required" && d.replacementRefs.length > 0) return taskError("disposition_invalid", "Supply a reason and replacement references for superseded work.", 400);
          const refs = d.replacementRefs.map(taskRef);
          for (const ref of refs) { const replacement = this.localRef(s, ref, actor); if (replacement.rootTaskRef.id !== t.rootTaskRef.id || replacement.ref.id === t.ref.id) return taskError("relations_invalid", "Select replacement tasks from this tree."); }
          this.invalidateDependants(s, t); t.disposition = { kind: d.kind, reason: d.reason, replacementRefs: refs }; this.graph(s, t, actor); this.bumpGraph(s, t.rootTaskRef.id); t.status = "Cancelled"; t.armed = false; delete t.blocked; return;
        }
        case "cancel": {
          const pending = [t];
          for (let i = 0; i < pending.length; i++) pending.push(...s.tasks.filter(c => c.parentTaskRef?.id === pending[i]!.ref.id));
          for (const child of pending) {
            if (child.status === "Done" && child === t) return taskError("task_transition_invalid", "Reopen completed work before cancelling.");
            if (child.status === "Done") continue;
            const a = activeAttempt(child); child.armed = false;
            if (a) { a.cancelRequested = true; child.cancelRequested = true; }
            else { child.status = "Cancelled"; child.cancelRequested = false; delete child.blocked; }
            if (child !== t) this.touch(child); this.publishChild(s, child);
          } return;
        }
        default: return taskError("action_invalid", "Unknown task action.", 400);
      }
    }, principalId, dispatch);
  }
  observe(id: string, executionId: string, receipt: TaskExecutionReceipt) {
    return this.transaction(s => {
      const t = this.find(s, id), a = t.attempts.at(-1);
      if (!a || a.executionId !== executionId || receipt.executionId !== executionId) return t;
      const recoveringAvailability = t.blocked?.reason === "executor_unavailable";
      if (a.receipt && (receipt.revision < a.receipt.revision || receipt.revision === a.receipt.revision
        && (!recoveringAvailability || fingerprint(receipt) !== fingerprint(a.receipt)))) return t;
      if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || typeof receipt.stopConfirmed !== "boolean"
        || !["accepted", "running", "awaiting_input", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(receipt.state)) return taskError("receipt_invalid", "Executor returned an invalid receipt.", 502);
      if (a.receipt?.stopConfirmed && taskExecutionTerminal(a.receipt.state)) return t;
      a.receipt = structuredClone(receipt);
      if (t.status !== "Cancelled") {
        if (recoveringAvailability) { t.status = receipt.state === "running" ? "InProgress" : "Ready"; delete t.blocked; }
        if (t.cancelRequested) {
          if (receipt.stopConfirmed && taskExecutionTerminal(receipt.state)) { t.status = "Cancelled"; t.cancelRequested = false; delete t.blocked; }
        } else if (receipt.state === "completed" && receipt.stopConfirmed && receipt.result) {
          const stale = a.invalidated || a.request.prerequisiteOutcomes.some(o => fingerprint(this.find(s, o.taskRef.id).acceptedResultRef) !== fingerprint(o));
          const childChanged = receipt.childOutcomes !== undefined && fingerprint(receipt.childOutcomes) !== fingerprint(this.childOutcomes(s, t));
          this.recordResult(s, t, taskResult(receipt.result), executionId, a.request.inputRevision, stale || childChanged, receipt.childOutcomes);
        } else if (taskExecutionTerminal(receipt.state)) {
          t.status = "Blocked"; t.blocked = { reason: a.invalidated ? "prerequisite_changed" : "execution_failed", message: receipt.error?.message ?? "The execution ended without an explicit task result." };
        } else if (receipt.state === "awaiting_input") {
          t.status = "Blocked"; t.blocked = { reason: receipt.wait?.kind === "children" ? "waiting_children" : receipt.wait?.kind === "limits" ? receipt.error?.code ?? "limits" : "needs_input", message: "The execution is waiting for a continuation." };
        } else if (receipt.state === "running") { t.status = "InProgress"; delete t.blocked; }
      }
      this.touch(t); this.refresh(s); this.publishChild(s, t); return t;
    });
  }
  unavailable(id: string, message: string) {
    return this.transaction(s => {
      const t = this.find(s, id); if (!activeAttempt(t) || t.cancelRequested) return;
      if (t.blocked?.reason === "executor_unavailable" && t.blocked.message === message) return;
      t.status = "Blocked"; t.blocked = { reason: "executor_unavailable", message }; this.touch(t); this.publishChild(s, t);
    });
  }
}
