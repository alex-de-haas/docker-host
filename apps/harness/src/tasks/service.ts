import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "../sessions/manager.js";
import { isSameOriginRequest, resolveAdminActor } from "../auth.js";
import { delegationCredential } from "../session-delegation.js";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type ProviderInvocation } from "@hosty-sdk/app/providers";
import { mediatedTaskRequest } from "./mediation.js";
import { MediatedTaskExecutorClient, TaskExecutorClient } from "@hosty-sdk/app/tasks/server";
import { taskStatuses, type TaskAction, type TaskActor, type TaskAssignee, type TaskCreate, type TaskEdit,
  type TaskExecutionInput, type TaskProviderRef, type TaskRecord, type TaskStatus } from "@hosty-sdk/app/tasks";
import { TaskStore, activeAttempt, taskError, providerRef } from "./store.js";
import { HarnessTaskExecutor, type ExecutionAuthority } from "./executor.js";

type Authority = ExecutionAuthority;
export class TaskService {
  readonly store: TaskStore;
  readonly executor: HarnessTaskExecutor;
  private readonly current = new Map<string, Authority>();
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private readonly streams = new Set<ServerResponse>();
  private readonly retries = new Map<string, { failures: number; after: number }>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  readonly provider: TaskProviderRef;
  constructor(private readonly manager: SessionManager) {
    this.provider = { appId: process.env.HOSTY_APP_ID ?? "hosty.harness", installationId: process.env.HOSTY_APP_INSTALLATION_ID ?? "standalone", key: "default" };
    this.store = new TaskStore(manager.store.dataDir, this.provider);
    this.executor = new HarnessTaskExecutor(manager);
    this.timer = setInterval(() => { void this.tick(); }, 2000); this.timer.unref();
    this.unsubscribe = this.store.subscribe(() => { queueMicrotask(() => { void this.tick(); }); });
    manager.taskAction = (id, action, input, credential, dispatchGuard) => this.tool(id, action, input, credential, dispatchGuard);
  }
  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer); this.unsubscribe(); this.manager.taskAction = undefined;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    return this.inFlight ?? Promise.resolve();
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
    const options = this.own(assignee.executor) && !authority.taskDispatch ? await this.executor.options() : await this.remote(assignee.executor, authority).options();
    const id = assignee.optionId ?? options.defaultId;
    const option = options.options.find(o => o.id === id);
    if (!option) return taskError("executor_option_unavailable", "Select an available executor option.");
    return { ...assignee, optionId: option.id, name: option.name };
  }
  async action(id: string, authority: Authority, input: TaskAction) {
    await authority.validate(); this.remember(authority);
    return this.store.action(id, authority.actor, input, t => this.selection(t, authority), authority.principalId, authority.taskDispatch, task => {
      if (authority.principalId && input.action && ["ready", "start", "cancel"].includes(input.action)
          && (task.assignee?.kind === "app" || activeAttempt(task)) && authority.mediatedOperation !== "execute")
        return taskError("execution_permission_required", "This action requires an exact Core execution authorization.", 403);
    });
  }
  tick(): Promise<void> {
    if (this.closed) return this.inFlight ?? Promise.resolve();
    return this.inFlight ??= this.reconcile().finally(() => { this.inFlight = null; });
  }
  private async reconcile() {
    try {
      await this.executor.tick();
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
    if (action === "task-result") return this.executor.report(sessionId, input.requestId as string, input.result);
    if (!credential) return taskError("task_credentials_required", "Refresh the session's Hosty credentials before managing tasks.", 401);
    return this.manager.invokeCoreTask(sessionId, action, input, this.provider, dispatchGuard);
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
      ...(mediated ? { principalId: mediated.invocation.principalId, taskDispatch: delegation?.dispatch ?? mediated.invocation.taskDispatch ?? undefined, mediatedOperation: mediated.invocation.operation } : {}),
      credential: call ? undefined : await delegationCredential(request), validate: async () => { if (delegation) { const current = await new ProviderClient().taskDispatchAuthority(delegation.dispatch); if (current.scope.executionId !== delegation.executionId || current.dispatch.userId !== userId) return taskError("execution_changed", "Execution authority changed.", 403); return; } if (await validate() !== userId) return taskError("actor_changed", "Task actor changed.", 403); } };
    if (this.closed) return taskError("tasks_stopping", "Task dispatch is stopping.", 503);
    this.remember(authority);
    const send = async (status: number, body: unknown) => { await validate(); response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    const route = url.pathname.slice(tasks ? "/api/tasks/v1".length : "/api/task-executor/v1".length);
    if (tasks) {
      if (method === "GET" && route === "/capabilities") { await send(200, { version: 1, prefix: this.store.prefix, statuses: taskStatuses, maxPageSize: 100 }); return true; }
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
        const page = await this.store.list(authority.actor, url.searchParams.get("cursor") ?? "", Number(url.searchParams.get("limit") ?? 50), (url.searchParams.get("status") || undefined) as TaskStatus | undefined);
        await send(200, { ...page, tasks: page.tasks.map(t => this.publicTask(t, authority.actor)) }); return true;
      }
      if (route === "/tasks" && method === "POST") { await send(201, await this.store.create(authority.actor, await readJson() as TaskCreate, authority.principalId)); return true; }
      const match = route.match(/^\/tasks\/([a-f0-9-]{36})(\/actions)?$/i);
      if (match) {
        if (method === "GET" && !match[2]) await send(200, this.publicTask(await this.store.get(match[1]!, authority.actor), authority.actor));
        else if (method === "PATCH" && !match[2]) await send(200, this.publicTask(await this.store.edit(match[1]!, authority.actor, await readJson() as TaskEdit, authority.principalId), authority.actor));
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
