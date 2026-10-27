import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { TaskActor, TaskExecutionInput, TaskExecutionReceipt, TaskResult } from "@hosty-sdk/app/tasks";
import { taskExecutionTerminal } from "@hosty-sdk/app/tasks";
import type { SessionManager } from "../sessions/manager.js";
import { fingerprint, providerRef, taskError, taskInput, taskResult, uuid, sameActor } from "./store.js";

export type ExecutionAuthority = { actor: TaskActor; scope: string; credential?: string; validate: () => Promise<void> };
type Execution = {
  scope: string; actor: TaskActor; hash?: string; input?: TaskExecutionInput; receipt: TaskExecutionReceipt;
  sessionId?: string; launchRequested: boolean; cancellation: boolean;
  outcome?: { requestId: string; result: TaskResult }; cancelRequests: string[];
};

/** The acceptance and cancellation tombstones outlive session/event retention. */
export class HarnessTaskExecutor {
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  private authorities = new Map<string, ExecutionAuthority>();
  constructor(private readonly manager: SessionManager) { this.root = path.join(manager.store.dataDir, "tasks", "executions"); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  private key(scope: string, id: string) { return createHash("sha256").update(scope + ":" + uuid(id)).digest("hex"); }
  private async load(key: string): Promise<Execution | null> {
    try { return JSON.parse(await readFile(path.join(this.root, key + ".json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private async save(key: string, record: Execution) {
    await mkdir(this.root, { recursive: true });
    const file = path.join(this.root, key + ".json"), temp = file + "." + randomUUID() + ".tmp";
    try {
      const f = await open(temp, "wx", 0o600); try { await f.writeFile(JSON.stringify(record)); await f.sync(); } finally { await f.close(); }
      await rename(temp, file); const d = await open(this.root, "r"); try { await d.sync(); } finally { await d.close(); }
    } finally { await rm(temp, { force: true }); }
  }
  private checked(record: Execution | null, authority: ExecutionAuthority) {
    if (!record || record.scope !== authority.scope || !sameActor(record.actor, authority.actor)) return taskError("execution_not_found", "Execution not found.", 404);
    return record;
  }
  private touch(record: Execution) { record.receipt.revision++; record.receipt.updatedAt = new Date().toISOString(); }
  async options() {
    const directory = await this.manager.profiles?.read();
    return { options: (directory?.profiles ?? []).map(p => ({ id: p.id, name: p.name, capabilities: ["markdown", "resources", "existing-workspace"] })), defaultId: directory?.defaultId ?? null };
  }
  accept(id: string, value: TaskExecutionInput, authority: ExecutionAuthority) {
    return this.serial(async () => {
      await authority.validate(); const key = this.key(authority.scope, id), existing = await this.load(key);
      if (existing) {
        this.checked(existing, authority);
        if (existing.hash && existing.hash !== fingerprint(value)) return taskError("execution_conflict", "This execution ID already has different input.");
        this.authorities.set(key, authority); return existing.receipt;
      }
      if (!authority.actor.userId) return taskError("execution_actor_required", "Harness execution requires an acting administrator.", 403);
      const input = taskInput({ ...value?.input, assignee: null });
      if (!value?.taskRef || !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1 || !input.title || !input.markdown.trim())
        return taskError("execution_invalid", "A qualified task and immutable nonempty input are required.", 400);
      providerRef(value.taskRef); uuid(value.taskRef.id);
      if (value.executorOptionId !== undefined && (typeof value.executorOptionId !== "string" || value.executorOptionId.length > 200)) return taskError("executor_invalid", "Invalid executor option.", 400);
      const now = new Date().toISOString();
      const record: Execution = { scope: authority.scope, actor: authority.actor, hash: fingerprint(value), input: structuredClone(value),
        receipt: { executionId: uuid(id), revision: 1, state: "accepted", stopConfirmed: false, createdAt: now, updatedAt: now },
        launchRequested: false, cancellation: false, cancelRequests: [] };
      // Session creation is replayable and does not start the model. Its profile snapshot survives
      // a crash between this write and the acceptance journal, including later profile deletion.
      try {
        const session = await this.manager.createSession({ createdBy: authority.actor.userId, clientRequestId: key,
          title: input.title, profileId: value.executorOptionId, taskExecutionId: id });
        if (!session.agentProfile) return taskError("profile_required", "Select a Harness profile before starting a task.");
        record.sessionId = session.id;
        record.receipt.sessionRef = { id: session.id, path: `/assistant?session=${encodeURIComponent(session.id)}` };
      } catch (error) {
        record.receipt.state = "failed"; record.receipt.stopConfirmed = true;
        record.receipt.error = { code: (error as { code?: string }).code ?? "admission_failed", message: error instanceof Error ? error.message : "Task admission failed." };
      }
      await this.save(key, record); this.authorities.set(key, authority); return record.receipt;
    });
  }
  /** Internal read-only projection: recovery may observe existing work without retaining user credentials. */
  peek(id: string, scope: string, userId: string | null) {
    return this.serial(async () => {
      const record = await this.load(this.key(scope, id));
      return record?.actor.userId === userId ? record.receipt : null;
    });
  }
  /** Replays cancellation already authorized and journaled by our own task store. Never launches work. */
  recoverCancellation(id: string, scope: string, userId: string | null) {
    return this.cancel(id, id, { scope, actor: { userId, appId: null }, validate: async () => {} });
  }
  get(id: string, authority: ExecutionAuthority) {
    return this.serial(async () => {
      await authority.validate(); const key = this.key(authority.scope, id), record = this.checked(await this.load(key), authority);
      this.authorities.set(key, authority); return record.receipt;
    });
  }
  cancel(id: string, requestId: string, authority: ExecutionAuthority) {
    return this.serial(async () => {
      await authority.validate(); uuid(requestId); const key = this.key(authority.scope, id); let record = await this.load(key);
      if (!record) {
        const now = new Date().toISOString(); record = { scope: authority.scope, actor: authority.actor, launchRequested: false,
          cancellation: true, cancelRequests: [requestId], receipt: { executionId: uuid(id), revision: 1, state: "cancelled", stopConfirmed: true, createdAt: now, updatedAt: now } };
      } else {
        this.checked(record, authority); if (record.cancelRequests.includes(requestId)) return record.receipt;
        record.cancelRequests.push(requestId); record.cancellation = true;
        if (!taskExecutionTerminal(record.receipt.state) || !record.receipt.stopConfirmed) {
          record.receipt.state = record.launchRequested ? "cancelling" : "cancelled";
          record.receipt.stopConfirmed = !record.launchRequested; this.touch(record);
        }
      }
      await this.save(key, record); this.authorities.set(key, authority); return record.receipt;
    });
  }
  report(sessionId: string, requestId: string, value: unknown) {
    return this.serial(async () => {
      uuid(requestId); const result = taskResult(value);
      for (const key of await this.keys()) {
        const record = (await this.load(key))!;
        if (record.sessionId !== sessionId) continue;
        if (record.outcome) {
          if (record.outcome.requestId !== requestId || fingerprint(record.outcome.result) !== fingerprint(result)) return taskError("result_conflict", "An explicit result is already recorded.");
          return { recorded: true, executionId: record.receipt.executionId };
        }
        if (record.cancellation || taskExecutionTerminal(record.receipt.state)) return taskError("execution_closed", "This task execution no longer accepts results.");
        record.outcome = { requestId, result }; this.touch(record); await this.save(key, record);
        return { recorded: true, executionId: record.receipt.executionId };
      }
      return taskError("task_binding_required", "This session is not bound to an active task.");
    });
  }
  private async keys() {
    try { return (await readdir(this.root)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => n.slice(0, -5)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  }
  async tick() {
    for (const key of await this.keys()) await this.serial(() => this.reconcile(key));
  }
  private async dispatchWasRejected(sessionId: string, id: string, userId: string) {
    const session = await this.manager.getSession(sessionId);
    if (!session || session.taskRun?.started) return false;
    try { return (await this.manager.messageReceipt(sessionId, id, userId)).state === "rejected"; }
    catch (error) { return (error as { code?: string }).code === "message_request_not_found"; }
  }
  private async reconcile(key: string) {
    const r = (await this.load(key))!;
    if (taskExecutionTerminal(r.receipt.state) && r.receipt.stopConfirmed || !r.sessionId) return;
    const before = fingerprint(r.receipt), authority = this.authorities.get(key);
    try {
      if (authority && !r.cancellation) {
        try { await authority.validate(); }
        catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 401 && status !== 403) throw error;
          r.cancellation = true; r.receipt.state = "cancelling";
          r.receipt.error = { code: "authority_revoked", message: "Execution authority expired or was revoked; stopping this attempt." };
          this.touch(r); await this.save(key, r);
        }
      }
      if (r.cancellation) {
        if (r.launchRequested) await this.manager.cancelSession(r.sessionId);
        r.receipt.state = "cancelled"; r.receipt.stopConfirmed = true;
      } else if (!r.launchRequested) {
        if (!authority) return;
        await authority.validate();
        if (r.input!.input.workspaceId) {
          if (!authority.credential) return taskError("workspace_credentials_required", "Open this task in Harness to authorize its existing workspace.", 401);
          const inventory = await this.manager.workspaceInventory(authority.credential) as { workspaces: { id: string; participation?: { revision: number } | null }[] };
          const workspace = inventory.workspaces.find(w => w.id === r.input!.input.workspaceId);
          if (!workspace?.participation) return taskError("workspace_missing", "The selected existing workspace is unavailable.", 404);
          const session = await this.manager.getSession(r.sessionId);
          const prior = session?.associationRequests?.find(a => a.id === r.receipt.executionId);
          await this.manager.workspaceAction(r.sessionId, "attach", prior?.input ?? { workspaceId: workspace.id, expectedRevision: workspace.participation.revision, requestId: r.receipt.executionId }, authority.credential, authority.actor.userId!);
        }
        // Persist intent before native dispatch. The session's durable message receipt owns any
        // crash ambiguity after this point; recovery must never send a fresh turn automatically.
        r.launchRequested = true; await this.save(key, r);
        const session = (await this.manager.getSession(r.sessionId))!;
        const input = r.input!.input;
        await this.manager.postMessage(r.sessionId, `${input.title}\n\n${input.markdown}\n\nTask resource references (context, not permission):\n${JSON.stringify(input.resources)}\n\nReport the explicit task outcome with task_result using a UUID requestId and result { markdown, resources }. Then finish this turn. A chat reply alone does not complete the task.`,
          authority.credential, [], { taskDispatch: true, actorUserId: authority.actor.userId!, clientRequestId: r.receipt.executionId, expectedRevision: session.appContextRevision ?? 0, selectionRevision: session.selectionRevision ?? 0 });
      }
      if (!r.cancellation && r.launchRequested) {
        const session = await this.manager.getSession(r.sessionId);
        if (!session) { r.receipt.state = "interrupted"; r.receipt.stopConfirmed = false; r.receipt.error = { code: "session_missing", message: "The execution session is unavailable; native exit is unconfirmed." }; }
        else if (session.taskRun?.error) { r.receipt.state = "interrupted"; r.receipt.stopConfirmed = false; r.receipt.error = { code: "exit_unconfirmed", message: session.taskRun.error }; }
        else if (session.taskRun?.exitConfirmed && !session.taskRun.started) {
          r.receipt.state = "failed"; r.receipt.stopConfirmed = true;
          r.receipt.error = { code: "admission_failed", message: "The task was rejected before native execution started." };
        } else if (["awaiting_question", "awaiting_approval"].includes(session.status)) r.receipt.state = "awaiting_input";
        else if (session.status === "running") {
          r.receipt.state = "running";
          // A native process lost across a Harness restart has no safe replacement.
          if (!this.manager.worker && !this.manager.hasLiveTaskRun(r.sessionId)) {
            r.receipt.state = "interrupted"; r.receipt.error = { code: "exit_unconfirmed", message: "Harness restarted; the native execution's exit is unconfirmed." };
          }
        } else if (session.taskRun?.exitConfirmed) {
          r.receipt.stopConfirmed = true;
          if (session.status === "cancelled") r.receipt.state = "cancelled";
          else if (session.status === "idle" && r.outcome) { r.receipt.state = "completed"; r.receipt.result = r.outcome.result; delete r.receipt.error; }
          else { r.receipt.state = "failed"; r.receipt.error = { code: "task_result_missing", message: "The turn stopped without an explicit successful task outcome." }; }
        } else {
          const receipt = await this.manager.messageReceipt(r.sessionId, r.receipt.executionId, r.actor.userId!);
          r.receipt.state = "interrupted"; r.receipt.stopConfirmed = receipt.state === "rejected";
          r.receipt.error = { code: "dispatch_uncertain", message: "Native dispatch is not confirmed. Inspect the session before retrying." };
        }
      }
    } catch (error) {
      r.receipt.error = { code: (error as { code?: string }).code ?? "execution_unavailable", message: error instanceof Error ? error.message : "Execution unavailable." };
      r.receipt.state = r.cancellation ? "cancelling" : r.launchRequested ? "interrupted" : "failed";
      r.receipt.stopConfirmed = !r.launchRequested || await this.dispatchWasRejected(r.sessionId, r.receipt.executionId, r.actor.userId!);
      if (r.receipt.stopConfirmed) r.receipt.state = r.cancellation ? "cancelled" : "failed";
    }
    if (before !== fingerprint(r.receipt)) { this.touch(r); await this.save(key, r); }
  }
}
