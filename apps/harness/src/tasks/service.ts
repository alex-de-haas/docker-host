import { TaskAttention } from "./attention.js";
import { TaskControls } from "./controls.js";
import { TaskSources } from "./sources.js";
import { TaskAdoptions } from "./adoptions.js";
import { TaskOrchestrator } from "./orchestrator.js";
import { assertTaskCoordinator } from "./workflow.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "../sessions/manager.js";
import { isSameOriginRequest, resolveAdminActor } from "../auth.js";
import { delegationCredential } from "../session-delegation.js";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type ProviderInvocation } from "@hosty-sdk/app/providers";
import { mediatedTaskRequest } from "./mediation.js";
import { MediatedTaskExecutorClient, TaskExecutorClient } from "@hosty-sdk/app/tasks/server";
import { taskReferenceKey, taskStatuses, type TaskAction, type TaskActor, type TaskAssignee, type TaskCreate, type TaskEdit,
  type TaskExecutionInput, type TaskProviderRef, type TaskRecord, type TaskStatus } from "@hosty-sdk/app/tasks";
import { fingerprint, TaskStore, activeAttempt, taskError, providerRef } from "./store.js";
import { TaskPolicies, type TaskLimits } from "./policy.js";
import { HarnessTaskExecutor, type ExecutionAuthority } from "./executor.js";

type Authority = ExecutionAuthority;
export class TaskService {
  readonly store: TaskStore;
  readonly executor: HarnessTaskExecutor;
  readonly policies: TaskPolicies;
  readonly orchestration: TaskOrchestrator;
  readonly adoptions: TaskAdoptions;
  readonly sources: TaskSources;
  readonly controls: TaskControls;
  readonly attention: TaskAttention;
  private readonly current = new Map<string, Authority>();
  private closed = false;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly streams = new Set<ServerResponse>();
  private readonly retries = new Map<string, { failures: number; after: number }>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  readonly provider: TaskProviderRef;
  constructor(private readonly manager: SessionManager) {
    this.provider = { appId: process.env.HOSTY_APP_ID ?? "hosty.harness", installationId: process.env.HOSTY_APP_INSTALLATION_ID ?? "standalone", key: "default" };
    this.store = new TaskStore(manager.store.dataDir, this.provider);
    this.executor = new HarnessTaskExecutor(manager, this.store);
    this.policies = new TaskPolicies(this.store);
    this.attention = new TaskAttention(this.store, (owner, task, execution) => manager.notifyTask(owner, task, execution));
    this.orchestration = new TaskOrchestrator(this.store, manager, this.executor, this.policies);
    this.sources = new TaskSources(this.store, manager, this.orchestration);
    this.sources.capacityAvailable = async () => {
      if (!manager.worker) return true;
      const runtime = await manager.worker.capabilities();
      return (runtime.occupied ?? 0) < runtime.capacity;
    };
    this.sources.admit = (state, taskId, executionId) => this.policies.reserveIn(state, taskId, executionId);
    this.controls = new TaskControls(this.store, manager, this.policies, this.orchestration);
    this.orchestration.beforeResume = id => this.sources.beforeResume(id);
    manager.beforeTaskDecisionResume = async id => {
      const session = await manager.getSession(id);
      if (!session) return false;
      // As at initial admission, another provider owns its graph and source policy.
      if (!session.taskContext || !session.taskExecutionId || !this.own(session.taskContext.taskRef)) return true;
      if (!await this.sources.beforeResume(id)) return false;
      return this.policies.reserve(session.taskContext.taskRef.id, session.taskExecutionId);
    };
    this.adoptions = new TaskAdoptions(this.store, manager, (task, requestId, credential) => this.action(task.ref.id,
      { actor: { userId: task.owner.userId, appId: null }, scope: this.ownScope(), credential, validate: async () => {} },
      { requestId, expectedRevision: task.revision, action: "ready" }));
    manager.taskDecisionProjections = async owner => [...await this.adoptions.projections(owner), ...await this.controls.projections(owner), ...await this.sources.projections(owner), ...await this.attention.projections(owner)];
    this.store.afterCreate = (state, task) => { if (!task.parentTaskRef && task.assignee?.kind === "app") this.policies.ensure(state, task, task.assignee.executor); };
    this.store.beforeReopen = (state, task) => this.policies.reopen(state, task);
    manager.taskModeChanged = async record => { if (record.taskContext && record.taskExecutionId) await this.policies.setMode(record.taskContext.taskRef.id, record.taskExecutionId, record.autonomy ?? "normal"); };
    this.store.beforeChild = (state, parent) => this.policies.child(state, parent);
    this.store.beforeAttempt = (state, task) => this.policies.attempt(state, task);
    this.executor.beforeResult = async (input, id) => this.own(input.taskRef) ? this.store.validateResult(input.taskRef.id, id) : [];
    this.executor.beforeLaunch = async (input, id, sessionId, authority) => {
      const session = await manager.getSession(sessionId);
      if (!session || session.autonomy !== "autonomous") return false;
      // External providers own their task lifecycle; the executor has no local task graph.
      if (!this.own(input.taskRef)) return true;
      await this.orchestration.bindNative(input.taskRef.id, id, sessionId, authority.taskDispatch);
      await this.policies.setMode(input.taskRef.id, id, session.autonomy);
      return this.sources.beforeLaunch(input, id, sessionId, authority);
    };
    this.executor.receiptChanged = async (input, receipt) => { await this.policies.observe(input.taskRef.id, receipt.executionId, receipt); await this.sources.writers.observe(receipt.executionId, receipt); };
    manager.taskUsage = async (record, runId, usage) => {
      if (record.taskExecutionId && record.taskContext && record.workerRun?.id === runId)
        await this.policies.segmentUsage(record.taskContext.taskRef.id, record.taskExecutionId, runId, usage);
    };
    this.timer = setInterval(() => { void this.tick(); }, 2000); this.timer.unref();
    this.unsubscribe = this.store.subscribe(() => { queueMicrotask(() => { void this.tick(); }); });
    manager.taskAction = (id, action, input, credential, dispatchGuard) => this.tool(id, action, input, credential, dispatchGuard);
  }
  close(): Promise<void> {
    this.closed = true;
    this.manager.taskDecisionProjections = undefined; this.manager.taskModeChanged = undefined;
    clearInterval(this.timer); this.unsubscribe(); this.manager.taskAction = undefined; this.manager.taskUsage = undefined; this.manager.beforeTaskDecisionResume = undefined;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    return Promise.all([...this.jobs.values()]).then(() => {});
  }
  private ownScope() { return `${this.provider.appId}:${this.provider.installationId}`; }
  private own(executor: TaskProviderRef) { return executor.appId === this.provider.appId && executor.installationId === this.provider.installationId && executor.key === this.provider.key; }
  private remote(executor: TaskProviderRef, authority: Authority) {
    if (authority.taskDispatch) return new MediatedTaskExecutorClient(new ProviderClient(), executor, authority.taskDispatch);
    return new TaskExecutorClient(new ProviderClient(), executor, authority.credential ? async () => authority.credential! : undefined);
  }
  private remember(authority: Authority) {
    if (authority.principalId) return;
    if (authority.actor.userId && (authority.credential || !this.current.get(authority.actor.userId)?.credential)) this.current.set(authority.actor.userId, authority);
  }
  private executionAuthority(task: TaskRecord, authority: Authority): Authority {
    return { ...authority, scope: this.ownScope(), actor: { userId: task.owner.userId, appId: this.provider.appId, installationId: this.provider.installationId } };
  }
  private async selection(task: TaskRecord, authority: Authority): Promise<TaskAssignee> {
    const assignee = task.assignee!;
    if (assignee.kind === "human") {
      const directory = await this.users();
      if (!directory.some(u => u.id === assignee.userId)) return taskError("assignee_unavailable", "The selected person is no longer available.");
      return assignee;
    }
    if (assignee.selection?.kind === "configuration") {
      if (!this.own(assignee.executor) || !authority.actor.userId) return taskError("unsupported_capability", "Coordinated roles require this executor installation.");
      const snapshot = await this.store.transaction(state => this.store.snapshot(state, task));
      const config = await this.executor.configurations.resolve(assignee.selection, authority.actor.userId, snapshot);
      return { ...assignee, name: config.name };
    }
    const options = this.own(assignee.executor) && !authority.taskDispatch ? await this.executor.options() : await this.remote(assignee.executor, authority).options();
    const id = assignee.selection?.id ?? options.defaultId;
    const option = options.options.find(o => o.id === id);
    if (!option) return taskError("executor_option_unavailable", "Select an available executor option.");
    if (assignee.selection && assignee.selection.revision !== option.revision) return taskError("selection_changed", "Reload executor choices before starting this task.");
    return { ...assignee, selection: { kind: "option", id: option.id, revision: option.revision }, name: option.name };
  }
  async action(id: string, authority: Authority, input: TaskAction) {
    await authority.validate(); this.remember(authority);
    // User actions enter Core once so background execution retains current, scoped provenance.
    if (!authority.principalId && authority.credential && process.env.HOSTY_CORE_ORIGIN && process.env.HOSTY_APP_SERVICE_TOKEN
      && ["ready", "retry", "request_changes", "cancel"].includes(input.action)) {
      const response = await fetch(new URL("/api/tasks/v1/action", process.env.HOSTY_CORE_ORIGIN), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${process.env.HOSTY_APP_SERVICE_TOKEN}`, "X-Hosty-App-Identity": authority.credential, "content-type": "application/json" },
        body: JSON.stringify({ taskRef: { ...this.provider, id }, input }),
      });
      const result = await response.json() as TaskRecord & { code?: string; message?: string; error?: { code: string; message: string } };
      if (!response.ok) return taskError(result.error?.code ?? result.code ?? "provider_unavailable", result.error?.message ?? result.message ?? "Core task authorization failed; retain the original request ID.", response.status);
      return result;
    }
    return this.store.action(id, authority.actor, input, t => this.selection(t, authority), authority.principalId, authority.taskDispatch, (task, state) => {
      if (authority.taskWorkflow && ["remove", "restore"].includes(input.action))
        return taskError("removal_forbidden", "Task-bound agents cannot remove execution history.", 403);
      if (authority.taskWorkflow) {
        const parent = assertTaskCoordinator(this.store, state, authority.taskWorkflow, authority.actor.userId!, task);
        if (["accept", "request_changes", "disposition"].includes(input.action) && task.parentTaskRef?.id !== parent.ref.id)
          return taskError("review_forbidden", "A coordinator reviews only its direct children.", 403);
      }
      if (authority.principalId && input.action && ["ready", "retry", "request_changes", "start", "cancel"].includes(input.action)
          && (task.assignee?.kind === "app" || activeAttempt(task)) && authority.mediatedOperation !== "execute")
        return taskError("execution_permission_required", "This action requires an exact Core execution authorization.", 403);
    });
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.all([...this.jobs.values()]).then(() => {});
    // A policy question in one recovery phase must not hold the native executor or
    // unrelated phases behind it. Each phase still has only one in-flight pass.
    return Promise.all([
      this.run("adoptions", () => this.adoptions.reconcile()),
      this.run("controls", () => this.controls.reconcile()),
      this.run("sources", () => this.sources.reconcile()),
      this.run("orchestration", () => this.orchestration.reconcile()),
      this.run("dispatch", () => this.reconcile()),
      this.run("attention", () => this.attention.reconcile()),
    ]).then(() => {});
  }
  private run(key: string, action: () => Promise<void>): Promise<void> {
    const pending = this.jobs.get(key);
    if (pending) return pending;
    const work = action().catch(error => { console.error(`[tasks] ${key} recovery failed`, error); })
      .finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, work);
    return work;
  }
  private async reconcile() {
    try {
      await this.executor.tick();
      await this.store.refreshQueued();
      for (const task of await this.store.all()) {
        if (this.closed) break;
        const attempt = activeAttempt(task); if (!attempt) continue;
        if (attempt.cancelRequested && this.own(attempt.executor)) {
          const receipt = await this.executor.recoverCancellation(attempt.executionId, this.ownScope(), task.owner.userId);
          await this.store.observe(task.ref.id, attempt.executionId, receipt);
          continue;
        }
        if ((this.retries.get(attempt.executionId)?.after ?? 0) > Date.now() && !attempt.cancelRequested) continue;
        const dispatch = await this.store.dispatch(task.ref.id);
        const authority: Authority | undefined = dispatch ? { actor: { userId: dispatch.userId, appId: null }, scope: this.ownScope(), principalId: dispatch.principalId, taskDispatch: dispatch,
          validate: async () => { await new ProviderClient().taskDispatchAuthority(dispatch); } }
          : task.owner.userId ? this.current.get(task.owner.userId) : undefined;
        if (!authority) {
          const receipt = this.own(attempt.executor) ? await this.executor.peek(attempt.executionId, this.ownScope(), task.owner.userId) : null;
          if (receipt) await this.store.observe(task.ref.id, attempt.executionId, receipt);
          if (!receipt || receipt.state === "accepted") await this.store.unavailable(task.ref.id, "Sign in to Harness to resume dispatch with the original execution ID.");
          continue;
        }
        try {
          await authority.validate();
          const local = this.own(attempt.executor) && !authority.taskDispatch, bound = this.executionAuthority(task, authority), remote = local ? null : this.remote(attempt.executor, authority);
          let receipt;
          if (attempt.cancelRequested) receipt = local ? await this.executor.cancel(attempt.executionId, attempt.executionId, bound) : await remote!.cancel(attempt.executionId, attempt.executionId);
          else {
            try { receipt = local ? await this.executor.get(attempt.executionId, bound) : await remote!.get(attempt.executionId); }
            catch (error) {
              if (!(error instanceof ProviderError) || error.status !== 404) throw error;
              receipt = local ? await this.executor.accept(attempt.executionId, attempt.request, bound) : await remote!.accept(attempt.executionId, attempt.request);
            }
          }
          await this.store.observe(task.ref.id, attempt.executionId, receipt);
          this.retries.delete(attempt.executionId);
        } catch (error) {
          const failures = (this.retries.get(attempt.executionId)?.failures ?? 0) + 1;
          this.retries.set(attempt.executionId, { failures, after: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) });
          await this.store.unavailable(task.ref.id, error instanceof Error ? error.message : "Executor unavailable.");
        }
      }
    } catch (error) { console.error("[tasks] recovery failed", error); }
  }
  private async users(): Promise<Array<{ id: string; displayName?: string; email?: string }>> {
    const origin = process.env.HOSTY_CORE_ORIGIN, token = process.env.HOSTY_APP_SERVICE_TOKEN;
    if (!origin || !token) return taskError("directory_unavailable", "Task assignments require the Core user directory.", 503);
    const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.provider.appId)}/directory/users?limit=200`, origin),
      { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return taskError("directory_unavailable", "The Core user directory is unavailable.", response.status);
    return (await response.json() as { users: Array<{ id: string; displayName?: string; email?: string }> }).users;
  }
  private publicTask(task: TaskRecord, actor: TaskActor) {
    const owner = !!actor.userId && task.owner.userId === actor.userId;
    return { ...task, attempts: task.attempts.map(a => {
      if (!a.receipt?.sessionRef) return a;
      const ref = a.receipt.sessionRef;
      let permitted = owner && this.own(a.executor) && /^\/assistant(?:[/?]|$)/.test(ref.path);
      if (owner && !this.own(a.executor)) {
        try { const url = new URL(ref.path); permitted = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
        catch { /* Another app's relative route cannot resolve against Harness's origin. */ }
      }
      return { ...a, receipt: { ...a.receipt, sessionRef: permitted ? ref : undefined } };
    }) };
  }
  private async tool(sessionId: string, action: string, input: Record<string, unknown>, credential?: string, dispatchGuard?: () => Promise<void>) {
    const session = await this.manager.getSession(sessionId);
    if (!session) return taskError("session_missing", "Session is unavailable.", 404);
    if (session.taskBarrier && session.taskBarrier.state !== "resuming" && !["task-wait", "task-request-input", "task-adopt", "task-bind-workspace", "task-get", "task-options", "task-execution-get"].includes(action))
      return taskError("barrier_pending", "Yield the current turn; this task is waiting for its recorded continuation.");
    if (action === "task-legacy-list" || action === "task-legacy-action") {
      if (session.taskContext) return taskError("removal_forbidden", "Task-bound agents cannot manage retained legacy records.", 403);
      const actor = { userId: session.createdBy, appId: null };
      return action === "task-legacy-list" ? this.store.legacyList(actor, Number(input.cursor ?? 0)) : this.store.legacyAction(actor, input.id, input);
    }
    if (action === "task-adopt") return this.adoptions.adopt(sessionId, input);
    if (!session.taskContext && action === "task-execution-get") return { sessionId, mode: session.autonomy ?? "normal",
      selectionRevision: session.selectionRevision ?? 0, contextRevision: session.appContextRevision ?? 0, autonomyRevision: session.autonomyRevision ?? 0 };
    if (action === "task-bind-workspace") return this.sources.bind(sessionId, input);
    if (session.taskContext && action === "task-create") return this.orchestration.create(sessionId, input);
    if (session.taskContext && action === "task-edit") return this.orchestration.edit(sessionId, input);
    if (action === "task-prepare-executor") return this.orchestration.prepare(sessionId, input);
    if (action === "task-delegate") return this.orchestration.delegate(sessionId, input);
    if (action === "task-wait") return this.orchestration.wait(sessionId, input);
    if (action === "task-plan") return this.orchestration.plan(sessionId, input);
    if (action === "task-execution-get") return this.orchestration.summary(sessionId, input);
    if (session.taskContext && action === "task-action") return this.orchestration.action(sessionId, input);
    if (session.taskContext && action === "task-get") return this.orchestration.get(sessionId, input.taskId);
    if (session.taskContext && action === "task-list") return this.orchestration.summary(sessionId, input);
    if (action === "task-executor-options") { if (session.taskContext) await this.orchestration.context(sessionId); return this.executor.options(); }
    if (session.taskContext && action === "task-options") { await this.orchestration.context(sessionId); return this.executor.options(); }
    if (action === "task-request-input") {
      const title = session.taskContext && this.own(session.taskContext.taskRef)
        ? await this.store.get(session.taskContext.taskRef.id, { userId: session.createdBy, appId: null }).then(task => `${task.number} · ${task.title}`) : undefined;
      return this.manager.requestTaskInput(sessionId, input, title);
    }
    if (action === "task-fail") return this.executor.fail(sessionId, input.requestId as string, input.result);
    if (action === "task-result") {
      if (input.completed !== true) return taskError("completion_required", "Attest completed work. Use task_request_input for required answers or task_fail for an unsuccessful outcome.", 400);
      return this.executor.report(sessionId, input.requestId as string, input.result);
    }
    if (!credential) return taskError("task_credentials_required", "Refresh the session's Hosty credentials before managing tasks.", 401);
    return this.manager.invokeCoreTask(sessionId, action, input, this.provider, dispatchGuard);
  }

  async operatorRoute(request: IncomingMessage, response: ServerResponse, url: URL, owner: string, interactive: boolean, readJson: () => Promise<Record<string, unknown>>): Promise<boolean> {
    const prefix = "/api/task-orchestration/v1";
    if (!url.pathname.startsWith(prefix + "/")) return false;
    const route = url.pathname.slice(prefix.length), method = request.method ?? "GET";
    const send = (body: unknown) => { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    if (method !== "GET" && (!interactive || !isSameOriginRequest(request)))
      return taskError("interactive_action_required", "Change task execution policy through an authenticated Harness user action.", 403);
    if (route === "/legacy-tasks" && method === "GET") { send(await this.store.legacyList({ userId: owner, appId: null }, Number(url.searchParams.get("cursor") ?? 0))); return true; }
    const legacy = route.match(/^\/legacy-tasks\/([a-f0-9]{64})\/actions$/);
    if (legacy && method === "POST") { send(await this.store.legacyAction({ userId: owner, appId: null }, legacy[1], await readJson())); return true; }
    const workspace = route.match(/^\/workspaces\/([^/]+)\/execution-summary$/);
    if (workspace && method === "GET") {
      const credential = await delegationCredential(request);
      if (!credential) return taskError("app_session_required", "Open Harness through Core to inspect task workspace history.", 401);
      send(await this.sources.summary(decodeURIComponent(workspace[1]!), owner, credential, url.searchParams.get("cursor") ?? "0", Number(url.searchParams.get("limit") ?? 100))); return true;
    }
    const adoption = route.match(/^\/adoptions\/([a-f0-9-]{36})(?:\/(consent))?$/i);
    if (adoption && method === "GET") { send(await this.adoptions.get(adoption[1]!, owner)); return true; }
    if (adoption?.[2] === "consent" && method === "POST") {
      const credential = await delegationCredential(request);
      if (!credential) return taskError("app_session_required", "Open Harness through Core to answer mode proposals.", 401);
      send(await this.adoptions.consent(adoption[1]!, owner, await readJson() as { requestId: string; expectedRevision: number; choice: "approve" | "decline" }, credential)); return true;
    }
    if (route === "/settings" && method === "GET") { send(await this.policies.defaults()); return true; }
    if (route === "/settings" && method === "PUT") {
      send(await this.policies.updateDefaults(owner, await readJson() as { requestId: string; expectedRevision: number; values: TaskLimits })); return true;
    }
    const sessionRoute = route.match(/^\/sessions\/([^/]+)\/adoptions$/);
    const boundRoute = route.match(/^\/roots\/([a-f0-9-]{36})\/(plan|source)$/i);
    const action = sessionRoute ? "task-adopt" : boundRoute ? boundRoute[2] === "plan" ? "task-plan" : "task-bind-workspace"
      : ({ "/configurations": "task-prepare-executor", "/children": "task-delegate", "/waits": "task-wait" } as Record<string, string>)[route];
    if (method === "POST" && action) {
      const { sessionId: suppliedSession, ...input } = await readJson();
      const sessionId = sessionRoute ? decodeURIComponent(sessionRoute[1]!) : suppliedSession;
      if (typeof sessionId !== "string") return taskError("session_required", "Identify the current owned coordinating session.", 400);
      const session = await this.manager.getSession(sessionId);
      if (!session || session.createdBy !== owner) return taskError("session_missing", "This session is unavailable.", 404);
      if (boundRoute && session.taskContext?.rootTaskRef.id !== boundRoute[1]) return taskError("permission_denied", "Use the session's admitted root.", 403);
      send(await this.tool(sessionId, action, input, await delegationCredential(request))); return true;
    }
    const root = route.match(/^\/roots\/([a-f0-9-]{36})(?:\/(limits|control))?$/i);
    if (root) {
      if (method === "GET") {
        const policy = await this.policies.get(root[1]!, owner);
        if (root[2] === "limits") send(policy);
        else {
          const page = await this.store.list({ userId: owner, appId: null }, url.searchParams.get("cursor") ?? "", Number(url.searchParams.get("limit") ?? 50), undefined,
            { rootTaskRef: taskReferenceKey(policy.rootTaskRef) });
          send({ root: policy, plan: await this.store.readJournal("plan:" + policy.rootTaskRef.id),
            source: await this.orchestration.sourceSummary(policy.rootTaskRef.id), tasks: page.tasks.map(t => this.publicTask(t, { userId: owner, appId: null })), nextCursor: page.nextCursor });
        }
        return true;
      }
      if (method === "PUT" && root[2] === "limits") { send(await this.policies.updateRoot(root[1]!, owner, await readJson() as { requestId: string; expectedRevision: number; values: TaskLimits })); return true; }
      if (method === "POST" && root[2] === "control") {
        const input = await readJson() as { requestId: string; expectedRevision: number; action: "pause" | "resume" | "stop" };
        send(await this.policies.control(root[1]!, owner, input, () => this.controls.validateResume(root[1]!, owner))); return true;
      }
    }
    return taskError("not_found", "Unknown task orchestration operation.", 404);
  }

  async route(request: IncomingMessage, response: ServerResponse, url: URL, readJson: () => Promise<Record<string, unknown>>): Promise<boolean> {
    const tasks = url.pathname === "/api/tasks/v1" || url.pathname.startsWith("/api/tasks/v1/");
    const executions = url.pathname === "/api/task-executor/v1" || url.pathname.startsWith("/api/task-executor/v1/");
    if (!tasks && !executions) return false;
    if (this.closed) return taskError("tasks_stopping", "Task dispatch is stopping.", 503);
    const kind = tasks ? "tasks" : "task-executor", method = request.method ?? "GET";
    const bearer = request.headers.authorization?.replace(/^Bearer /i, "");
    const mediated = await mediatedTaskRequest(request, url, kind, this.provider.key);
    if (mediated) readJson = mediated.read;
    let invocation: ProviderInvocation | null = null;
    const validate = async () => {
      if (mediated) {
        const v = await mediated.validate();
        if (v.hostRole !== "host.admin") return taskError("admin_required", "Harness tasks require an acting administrator.", 403);
        return v.userId;
      }
      if (bearer?.startsWith("hosty_provider.")) {
        const v = await new ProviderClient().validate(bearer, kind);
        if (!v.userId || v.hostRole !== "host.admin") return taskError("admin_required", "Harness tasks require an acting administrator.", 403);
        invocation = v; return v.userId;
      }
      const actor = await resolveAdminActor(request);
      if (!actor) return taskError("task_unauthorized", "A Host administrator session is required.", 401);
      if (actor.via === "app-session" && method !== "GET" && method !== "HEAD" && !isSameOriginRequest(request)) return taskError("cross_site_request_blocked", "Use the Harness origin for cookie-authenticated changes.", 403);
      return actor.userId;
    };
    const userId = await validate();
    // Provider credentials are never reinterpreted as ordinary app/user credentials.
    const call = (mediated?.invocation ?? invocation) as ProviderInvocation | import("@hosty-sdk/app/providers").MediatedProviderInvocation | null;
    const delegation = mediated?.invocation.taskDelegation;
    const source = delegation?.taskRef;
    const authority: Authority = { actor: { userId, appId: source?.appId ?? call?.callerAppId ?? null, ...(source ? { installationId: source.installationId } : call?.callerInstallation ? { installationId: call.callerInstallation } : {}) },
      scope: source ? `${source.appId}:${source.installationId}` : call ? `${call.callerAppId}:${call.callerInstallation}` : this.ownScope(),
      ...(mediated ? { principalId: mediated.invocation.principalId, taskDispatch: delegation?.dispatch ?? mediated.invocation.taskDispatch ?? undefined, mediatedOperation: mediated.invocation.operation, taskWorkflow: mediated.invocation.taskWorkflow } : {}),
      credential: call ? undefined : await delegationCredential(request), validate: async () => { if (delegation) { const current = await new ProviderClient().taskDispatchAuthority(delegation.dispatch); if (current.scope.executionId !== delegation.executionId || current.dispatch.userId !== userId) return taskError("execution_changed", "Execution authority changed.", 403); return; } if (await validate() !== userId) return taskError("actor_changed", "Task actor changed.", 403); } };
    if (this.closed) return taskError("tasks_stopping", "Task dispatch is stopping.", 503);
    this.remember(authority);
    const send = async (status: number, body: unknown) => { await validate(); response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    const route = url.pathname.slice(tasks ? "/api/tasks/v1".length : "/api/task-executor/v1".length);
    if (tasks) {
      if (method === "GET" && route === "/capabilities") { await send(200, { version: 1, prefix: this.store.prefix, statuses: taskStatuses, maxPageSize: 100, capabilities: ["markdown", "resources", "review", "events", "parent-child", "prerequisites", "delegated-review", "removal"] }); return true; }
      if (method === "GET" && route === "/directory") {
        const options = await this.executor.options();
        let others: unknown[] = [], warning: string | undefined;
        try { others = (await new ProviderClient().list("task-executor")).filter(p => p.appId !== this.provider.appId).map(p => ({ ...p, options: null })); }
        catch (e) { warning = e instanceof Error ? e.message : "Executor directory unavailable."; }
        const workspaces = authority.credential ? await this.manager.workspaceInventory(authority.credential).catch(() => ({ workspaces: [] })) : { workspaces: [] };
        await send(200, { provider: this.provider, users: await this.users(), executors: [{ ...this.provider, displayName: "Harness", available: true, ...options }, ...others], workspaces, warning }); return true;
      }
      if (method === "POST" && route === "/executor-options") {
        const ref = providerRef(await readJson()); await send(200, this.own(ref) ? await this.executor.options() : await this.remote(ref, authority).options()); return true;
      }
      if (method === "GET" && route === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const emit = () => { if (!response.destroyed) response.write("event: changed\ndata: {}\n\n"); };
        this.streams.add(response);
        const unsubscribe = this.store.subscribe(emit); emit();
        const timer = setInterval(() => { void authority.validate().then(() => response.write(": keepalive\n\n")).catch(() => response.end()); }, 15000);
        response.on("close", () => { clearInterval(timer); unsubscribe(); this.streams.delete(response); }); return true;
      }
      if (route === "/tasks" && method === "GET") {
        const page = await this.store.list(authority.actor, url.searchParams.get("cursor") ?? "", Number(url.searchParams.get("limit") ?? 50), (url.searchParams.get("status") || undefined) as TaskStatus | undefined,
          { parentTaskRef: url.searchParams.get("parentTaskRef") ?? undefined, rootTaskRef: url.searchParams.get("rootTaskRef") ?? undefined, rootsOnly: url.searchParams.get("rootsOnly") === "true", removed: url.searchParams.get("removed") === "true" });
        await send(200, { ...page, tasks: page.tasks.map(t => this.publicTask(t, authority.actor)) }); return true;
      }
      if (route === "/tasks" && method === "POST") {
        const input = await readJson() as TaskCreate;
        await send(201, await this.store.create(authority.actor, input, authority.principalId, state => {
          if (!authority.taskWorkflow) return;
          const parent = assertTaskCoordinator(this.store, state, authority.taskWorkflow, userId);
          if (fingerprint(input.input.parentTaskRef) !== fingerprint(parent.ref)) return taskError("root_task_required", "Create children under this session's admitted task.");
        })); return true;
      }
      const requestMatch = route.match(/^\/requests\/([a-f0-9-]{36})$/i);
      if (requestMatch && method === "GET") { const receipt = await this.store.request(authority.actor, requestMatch[1]!, authority.principalId); await send(200, { ...receipt, result: this.publicTask(receipt.result, authority.actor) }); return true; }
      const match = route.match(/^\/tasks\/([a-f0-9-]{36})(\/actions)?$/i);
      if (match) {
        if (method === "GET" && !match[2]) await send(200, this.publicTask(await this.store.get(match[1]!, authority.actor), authority.actor));
        else if (method === "PATCH" && !match[2]) await send(200, this.publicTask(await this.store.edit(match[1]!, authority.actor, await readJson() as TaskEdit, authority.principalId, (task, state) => { if (authority.taskWorkflow) assertTaskCoordinator(this.store, state, authority.taskWorkflow, userId, task); }), authority.actor));
        else if (method === "POST" && match[2]) await send(200, this.publicTask(await this.action(match[1]!, authority, await readJson() as TaskAction), authority.actor));
        else await send(405, { code: "method_not_allowed", message: "Unsupported task method." });
        return true;
      }
    } else {
      if (method === "GET" && route === "/options") { await send(200, await this.executor.options()); return true; }
      const match = route.match(/^\/executions\/([a-f0-9-]{36})(\/cancel)?$/i);
      if (match) {
        if (method === "PUT" && !match[2]) {
          const input = await readJson() as TaskExecutionInput;
          if (call && (input.taskRef?.appId !== (source?.appId ?? call.callerAppId) || input.taskRef?.installationId !== (source?.installationId ?? call.callerInstallation)
              || source && (input.taskRef?.id !== source.id || input.taskRef?.key !== source.key || match[1] !== delegation?.executionId)))
            return taskError("task_provider_mismatch", "The calling provider must own the task reference.", 403);
          await send(202, await this.executor.accept(match[1]!, input, authority));
        } else if (method === "GET" && !match[2]) await send(200, await this.executor.get(match[1]!, authority));
        else if (method === "POST" && match[2]) await send(200, await this.executor.cancel(match[1]!, (await readJson()).requestId as string, authority));
        else await send(405, { code: "method_not_allowed", message: "Unsupported execution method." });
        return true;
      }
    }
    await send(404, { code: "not_found", message: "Unknown task operation." }); return true;
  }
}
