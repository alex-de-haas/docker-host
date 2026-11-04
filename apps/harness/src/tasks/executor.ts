import { TaskConfigurations } from "./configurations.js";
import { taskReferenceKey } from "@hosty-sdk/app/tasks";
import { createHash, randomUUID } from "node:crypto";
import type { TaskActor, TaskExecutionInput, TaskExecutionReceipt, TaskResult, TaskExecutorOptions } from "@hosty-sdk/app/tasks";
import { taskExecutionTerminal } from "@hosty-sdk/app/tasks";
import type { SessionManager } from "../sessions/manager.js";
import { fingerprint, executionInput, taskError, taskResult, uuid, sameActor, TaskStore } from "./store.js";

export type ExecutionAuthority = { actor: TaskActor; scope: string; credential?: string; principalId?: string; taskDispatch?: import("@hosty-sdk/app/providers").TaskDispatchRef; mediatedOperation?: string; taskWorkflow?: import("@hosty-sdk/app/providers").TaskWorkflowBinding; validate: () => Promise<void> };
type Execution = {
  scope: string; actor: TaskActor; hash?: string; input?: TaskExecutionInput; receipt: TaskExecutionReceipt;
  source?: { workspaceId: string };
  sessionId?: string; adoptionId?: string; launchRequested: boolean; cancellation: boolean;
  launch?: { commandId: string; prompt: string; contextRevision: number; selectionRevision: number; delivered?: boolean };
  outcome?: { requestId: string; result: TaskResult; childOutcomes?: import("@hosty-sdk/app/tasks").TaskOutcomeRef[] }; cancelRequests: string[];
};

/** The acceptance and cancellation tombstones outlive session/event retention. */
export class HarnessTaskExecutor {
  private readonly aggregate: TaskStore;
  readonly configurations: TaskConfigurations;
  beforeResult?: (input: TaskExecutionInput, executionId: string) => Promise<import("@hosty-sdk/app/tasks").TaskOutcomeRef[]>;
  beforeLaunch?: (input: TaskExecutionInput, executionId: string, sessionId: string, authority: ExecutionAuthority) => Promise<boolean>;
  receiptChanged?: (input: TaskExecutionInput, receipt: TaskExecutionReceipt) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private authorities = new Map<string, ExecutionAuthority>();
  constructor(private readonly manager: SessionManager, aggregate?: TaskStore) {
    this.aggregate = aggregate ?? new TaskStore(manager.store.dataDir, { appId: process.env.HOSTY_APP_ID ?? "hosty.harness", installationId: process.env.HOSTY_APP_INSTALLATION_ID ?? "standalone", key: "default" });
    this.configurations = new TaskConfigurations(this.aggregate, manager.profiles ?? undefined);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  private key(scope: string, id: string) { return createHash("sha256").update(scope + ":" + uuid(id)).digest("hex"); }
  private async load(key: string): Promise<Execution | null> { return await this.aggregate.readJournal<Execution>("execution:" + key) ?? null; }
  private async save(key: string, record: Execution) {
    await this.aggregate.writeJournal("execution:" + key, record);
    if (record.input) await this.receiptChanged?.(record.input, record.receipt);
  }
  private checked(record: Execution | null, authority: ExecutionAuthority) {
    if (!record || record.scope !== authority.scope || !sameActor(record.actor, authority.actor)) return taskError("execution_not_found", "Execution not found.", 404);
    return record;
  }
  private conversationPath(sessionId: string, authority: ExecutionAuthority): string | null {
    const route = `/assistant?session=${encodeURIComponent(sessionId)}`;
    const local = !authority.actor.appId || authority.actor.appId === (process.env.HOSTY_APP_ID ?? "hosty.harness")
      && authority.actor.installationId === (process.env.HOSTY_APP_INSTALLATION_ID ?? "standalone");
    if (local) return route;
    try {
      const origin = new URL(process.env.HOSTY_PUBLIC_ORIGIN_HTTP ?? "");
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) return null;
      return new URL(route, origin).href;
    } catch { return null; }
  }
  private touch(record: Execution) { record.receipt.revision++; record.receipt.updatedAt = new Date().toISOString(); }
  async options(): Promise<TaskExecutorOptions> {
    const directory = await this.manager.profiles?.read();
    return { version: 1, revision: directory?.revision ?? 0,
      options: await Promise.all((directory?.profiles ?? []).map(async p => ({
        id: p.id, revision: p.revision, name: p.name, description: p.description,
        capabilities: ["markdown", "resources", "options", "cancellation"],
        availability: await this.manager.taskExecutorAvailability(p),
      }))), defaultId: directory?.defaultId ?? null };
  }
  bindSource(id: string, workspaceId: string, authority: ExecutionAuthority) {
    return this.serial(async () => {
      await authority.validate();
      const key = this.key(authority.scope, id), record = this.checked(await this.load(key), authority);
      if (record.source?.workspaceId === workspaceId) return;
      if (record.launchRequested || record.cancellation || record.source) return taskError("source_boundary_required", "Source changes require a confirmed continuation boundary.");
      if (!workspaceId || workspaceId.length > 200) return taskError("source_invalid", "Choose an authorized workspace.", 400);
      record.source = { workspaceId }; await this.save(key, record);
    });
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
      const checked = executionInput(value), input = checked.content;
      const now = new Date().toISOString();
      const record: Execution = { scope: authority.scope, actor: authority.actor, hash: fingerprint(value), input: structuredClone(value),
        receipt: { executionId: uuid(id), revision: 1, state: "accepted", stopConfirmed: false, createdAt: now, updatedAt: now },
        launchRequested: false, cancellation: false, cancelRequests: [] };
      // Session creation is replayable and does not start the model. Its profile snapshot survives
      // a crash between this write and the acceptance journal, including later profile deletion.
      try {
        let configuration = value.selection?.kind === "configuration" ? await this.configurations.resolve(value.selection, authority.actor.userId, checked) : undefined;
        if (configuration?.launchMode === "adopt" && (!configuration.adoption?.approved || !configuration.sessionId))
          return taskError("consent_required", "The conversation owner must approve this adoption.", 403);
        if (configuration?.launchMode === "adopt") {
          const original = await this.manager.getSession(configuration.sessionId!);
          if (original?.taskExecutionId && original.taskExecutionId !== id) {
            const task = await this.aggregate.get(checked.taskRef.id, authority.actor);
            const previous = task.attempts.find(attempt => attempt.executionId === original.taskExecutionId);
            if (!previous?.receipt?.stopConfirmed || task.attempts.at(-1)?.executionId !== id)
              return taskError("execution_active", "Confirm the original adopted attempt stopped before admitting its retry.");
            // Adoption belongs to the first attempt only. A retry inherits the
            // retained configuration but never the previous native conversation.
            configuration = { ...configuration, launchMode: "new", sessionId: undefined, adoption: undefined };
          }
        }
        const session = configuration?.launchMode === "adopt" ? await this.manager.getSession(configuration.sessionId!) : await this.manager.createSession({ createdBy: authority.actor.userId, clientRequestId: key,
          title: input.title, ...(configuration ? { taskConfiguration: configuration } : { profileId: value.selection?.id, profileRevision: value.selection?.revision }), taskExecutionId: id });
        if (!session) return taskError("session_missing", "The original conversation is unavailable.", 404);
        if (configuration?.launchMode === "adopt") record.adoptionId = configuration.selection.id;
        if (!record.adoptionId && !session.agentProfile) return taskError("profile_required", "Select a Harness profile before starting a task.");
        if (!record.adoptionId) {
          await this.manager.bindTaskDecisionReference(session.id, id, authority.actor.userId!, { kind: "task", id: taskReferenceKey(value.taskRef), revision: String(value.inputRevision) });
          await this.manager.bindTaskContext(session.id, id, authority.actor.userId, checked);
        }
        record.sessionId = session.id;
        await this.aggregate.writeJournal("executor-label:" + id, { owner: authority.actor.userId, sessionId: session.id,
          kind: record.adoptionId && !session.agentProfile ? "none" : configuration?.launchMode === "new" ? "configuration" : "option",
          name: session.agentProfile?.name ?? configuration?.name ?? "No profile", rationale: configuration?.rationale });
        const conversation = this.conversationPath(session.id, authority);
        if (conversation) record.receipt.sessionRef = { id: session.id, path: conversation };
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
        const liveInterrupted = record.receipt.state === "interrupted" && !record.receipt.stopConfirmed
          && this.manager.hasLiveTaskRun(sessionId);
        if (record.cancellation || taskExecutionTerminal(record.receipt.state) && !liveInterrupted)
          return taskError("execution_closed", "This task execution no longer accepts results.");
        const childOutcomes = record.input ? await this.beforeResult?.(record.input, record.receipt.executionId) : undefined;
        record.outcome = { requestId, result, childOutcomes }; this.touch(record); await this.save(key, record);
        return { recorded: true, executionId: record.receipt.executionId };
      }
      return taskError("task_binding_required", "This session is not bound to an active task.");
    });
  }
  private async keys() { return (await this.aggregate.journalEntries<Execution>("execution:")).map(([key]) => key.slice("execution:".length)); }
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
    const before = fingerprint(r.receipt), authority = this.authorities.get(key), recoveringLaunch = r.launchRequested;
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
        if (r.adoptionId) {
          const config = await this.configurations.resolve(r.input!.selection!, r.actor.userId!, r.input!);
          if (!await this.manager.adoptTaskSession(config, r.input!, r.receipt.executionId, r.actor.userId!)) return;
        }
        if (this.beforeLaunch && !await this.beforeLaunch(r.input!, r.receipt.executionId, r.sessionId!, authority)) {
          if (!r.receipt.wait) { r.receipt.wait = { kind: "limits", reference: r.input!.relations.rootTaskRef.id }; this.touch(r); await this.save(key, r); }
          return;
        }
        delete r.receipt.wait;
        if (r.source?.workspaceId) {
          if (authority.taskDispatch) await this.manager.prepareTaskWorkspace(r.sessionId, authority.taskDispatch, r.receipt.executionId, r.source?.workspaceId);
          else {
          if (!authority.credential) return taskError("workspace_credentials_required", "Open this task in Harness to authorize its existing workspace.", 401);
          const inventory = await this.manager.workspaceInventory(authority.credential) as { workspaces: { id: string; participation?: { revision: number } | null }[] };
          const workspace = inventory.workspaces.find(w => w.id === r.source?.workspaceId);
          if (!workspace?.participation) return taskError("workspace_missing", "The selected existing workspace is unavailable.", 404);
          const session = await this.manager.getSession(r.sessionId);
          const prior = session?.associationRequests?.find(a => a.id === r.receipt.executionId);
          await this.manager.workspaceAction(r.sessionId, "attach", prior?.input ?? { workspaceId: workspace.id, expectedRevision: workspace.participation.revision, requestId: r.receipt.executionId }, authority.credential, authority.actor.userId!);
          }
        }
        // Persist intent before native dispatch. The session's durable message receipt owns any
        // crash ambiguity after this point; recovery must never send a fresh turn automatically.
        const session = (await this.manager.getSession(r.sessionId))!;
        const input = r.input!.content;
        const prompt = `${input.title}\n\n${input.markdown}\n\nTask resource references (context, not permission):\n${JSON.stringify(input.resources)}\n\nReport the explicit task outcome with task_result using a UUID requestId and result { markdown, resources }. Then finish this turn. A chat reply alone does not complete the task.`;
        r.launch = { commandId: r.adoptionId ? session.taskBarrier!.commandId : r.receipt.executionId, prompt,
          contextRevision: session.appContextRevision ?? 0, selectionRevision: session.selectionRevision ?? 0 };
        r.launchRequested = true; await this.save(key, r);
      }
      if (!r.cancellation && r.launchRequested && r.launch && !r.launch.delivered && authority) {
        await authority.validate();
        // A crash before the session receipt is different from uncertain native admission.
        // Recheck current limits/source/mode only for a proven unstarted message; replay an
        // existing receipt unchanged so it can never become permission for a duplicate turn.
        let unstarted = false;
        try { if (recoveringLaunch) await this.manager.messageReceipt(r.sessionId, r.launch.commandId, r.actor.userId!); }
        catch (error) {
          if ((error as { code?: string }).code !== "message_request_not_found") throw error;
          unstarted = true;
        }
        if (unstarted && this.beforeLaunch && !await this.beforeLaunch(r.input!, r.receipt.executionId, r.sessionId, authority)) {
          r.receipt.state = "accepted"; r.receipt.nativeStopConfirmed = true;
          r.receipt.wait = { kind: "limits", reference: r.input!.relations.rootTaskRef.id };
          this.touch(r); await this.save(key, r); return;
        }
        // Message receipts are written before dispatch. Reuse their original command and exact
        // prompt; an unknown receipt never permits another native turn.
        if (r.adoptionId) await this.manager.resumeTaskBarrier(r.sessionId, r.actor.userId!, r.launch.prompt, authority.credential);
        else await this.manager.postMessage(r.sessionId, r.launch.prompt, authority.credential, [], { taskDispatch: true,
          actorUserId: r.actor.userId!, clientRequestId: r.launch.commandId, expectedRevision: r.launch.contextRevision, selectionRevision: r.launch.selectionRevision });
        r.launch.delivered = true; await this.save(key, r);
      }
      if (!r.cancellation && r.launchRequested) {
        const session = await this.manager.getSession(r.sessionId);
        if (!session) { r.receipt.state = "interrupted"; r.receipt.stopConfirmed = false; r.receipt.error = { code: "session_missing", message: "The execution session is unavailable; native exit is unconfirmed." }; }
        else if (session.taskBarrier && session.taskBarrier.state !== "resuming") {
          r.receipt.state = "awaiting_input"; r.receipt.stopConfirmed = false;
          r.receipt.nativeStopConfirmed = session.taskBarrier.state === "parked" && session.taskRun?.exitConfirmed === true;
          if (session.taskBarrier.kind === "limits") {
            const control = await this.aggregate.readJournal<{ reason: string }>("runtime-control:" + r.receipt.executionId);
            r.receipt.error = { code: control?.reason ?? "limits", message: "Execution is paused at its retained checkpoint by root policy." };
          }
          r.receipt.wait = { kind: session.taskBarrier.kind === "child_wait" ? "children" : session.taskBarrier.kind === "task_adoption" ? "mode" : session.taskBarrier.kind === "limits" ? "limits" : "source", reference: session.taskBarrier.id };
        }
        else if (session.taskRun?.error) { r.receipt.state = "interrupted"; r.receipt.stopConfirmed = false; r.receipt.error = { code: "exit_unconfirmed", message: session.taskRun.error }; }
        else if (session.taskRun?.exitConfirmed && !session.taskRun.started) {
          r.receipt.state = "failed"; r.receipt.stopConfirmed = true;
          r.receipt.error = { code: "admission_failed", message: "The task was rejected before native execution started." };
        } else if (["awaiting_question", "awaiting_approval"].includes(session.status)) {
          r.receipt.state = "awaiting_input";
          r.receipt.stopConfirmed = false;
          r.receipt.nativeStopConfirmed = session.taskRun?.exitConfirmed === true;
          delete r.receipt.error;
        }
        else if (session.status === "running") {
          r.receipt.state = "running"; r.receipt.nativeStopConfirmed = false; delete r.receipt.wait; delete r.receipt.error;
          // A native process lost across a Harness restart has no safe replacement.
          if (!this.manager.worker && !this.manager.hasLiveTaskRun(r.sessionId)) {
            r.receipt.state = "interrupted"; r.receipt.error = { code: "exit_unconfirmed", message: "Harness restarted; the native execution's exit is unconfirmed." };
          }
        } else if (session.taskRun?.exitConfirmed) {
          r.receipt.stopConfirmed = true;
          if (session.status === "cancelled") r.receipt.state = "cancelled";
          else if (session.status === "idle" && r.outcome) { r.receipt.state = "completed"; r.receipt.result = r.outcome.result; r.receipt.childOutcomes = r.outcome.childOutcomes; delete r.receipt.error; }
          else { r.receipt.state = "failed"; r.receipt.error = { code: "task_result_missing", message: "The turn stopped without an explicit successful task outcome." }; }
        } else {
          const receipt = await this.manager.messageReceipt(r.sessionId, r.launch?.commandId ?? r.receipt.executionId, r.actor.userId!);
          r.receipt.state = "interrupted"; r.receipt.stopConfirmed = receipt.state === "rejected";
          r.receipt.error = { code: "dispatch_uncertain", message: "Native dispatch is not confirmed. Inspect the session before retrying." };
        }
      }
    } catch (error) {
      r.receipt.error = { code: (error as { code?: string }).code ?? "execution_unavailable", message: error instanceof Error ? error.message : "Execution unavailable." };
      r.receipt.state = r.cancellation ? "cancelling" : r.launchRequested ? "interrupted" : "failed";
      r.receipt.stopConfirmed = !r.launchRequested || await this.dispatchWasRejected(r.sessionId, r.launch?.commandId ?? r.receipt.executionId, r.actor.userId!);
      if (r.receipt.stopConfirmed) r.receipt.state = r.cancellation ? "cancelled" : "failed";
      const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
      if (!r.cancellation && !r.launchRequested && (status === undefined || status >= 500 || ["revision_conflict", "source_pending", "source_boundary_required", "session_detached", "workspace_unavailable", "root_paused"].includes(r.receipt.error.code))) {
        r.receipt.state = "accepted"; r.receipt.stopConfirmed = false; r.receipt.nativeStopConfirmed = true;
        r.receipt.wait = { kind: "source", reference: r.input!.relations.rootTaskRef.id };
      }
    }
    if (before !== fingerprint(r.receipt)) { this.touch(r); await this.save(key, r); }
  }
}
