import type { ProviderClient } from "./providers-server.js";
import type { TaskProviderRef, TaskRef, TaskRecord, TaskPage, TaskCreate, TaskEdit, TaskAction,
  TaskStatus, TaskCapabilities, TaskExecutorOptions, TaskExecutionInput, TaskExecutionReceipt } from "./tasks.js";

/** Server-side task API. Every request obtains a fresh Core binding; no mutation is retried implicitly. */
export class TaskClient {
  constructor(private readonly providers: ProviderClient, private readonly provider: TaskProviderRef,
    private readonly userToken?: () => Promise<string>) {}
  private call<T>(route: string, method = "GET", input?: unknown, signal?: AbortSignal) {
    return this.providers.taskRequest<T>(this.provider, "tasks", route, method, input, this.userToken, signal);
  }
  private id(ref: TaskRef): string {
    if (ref.appId !== this.provider.appId || ref.installationId !== this.provider.installationId || ref.key !== this.provider.key)
      throw new Error("The task belongs to another provider installation.");
    return encodeURIComponent(ref.id);
  }
  capabilities(signal?: AbortSignal) { return this.call<TaskCapabilities>("/capabilities", "GET", undefined, signal); }
  list(options: { cursor?: string; limit?: number; status?: TaskStatus; signal?: AbortSignal } = {}) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.status) query.set("status", options.status);
    return this.call<TaskPage>(`/tasks?${query}`, "GET", undefined, options.signal);
  }
  create(input: TaskCreate, signal?: AbortSignal) { return this.call<TaskRecord>("/tasks", "POST", input, signal); }
  get(ref: TaskRef, signal?: AbortSignal) { return this.call<TaskRecord>(`/tasks/${this.id(ref)}`, "GET", undefined, signal); }
  edit(ref: TaskRef, input: TaskEdit, signal?: AbortSignal) { return this.call<TaskRecord>(`/tasks/${this.id(ref)}`, "PATCH", input, signal); }
  action(ref: TaskRef, input: TaskAction, signal?: AbortSignal) { return this.call<TaskRecord>(`/tasks/${this.id(ref)}/actions`, "POST", input, signal); }
}

export class TaskExecutorClient {
  constructor(private readonly providers: ProviderClient, private readonly executor: TaskProviderRef,
    private readonly userToken?: () => Promise<string>) {}
  private call<T>(route: string, method = "GET", input?: unknown, signal?: AbortSignal) {
    return this.providers.taskRequest<T>(this.executor, "task-executor", route, method, input, this.userToken, signal);
  }
  options(signal?: AbortSignal) { return this.call<TaskExecutorOptions>("/options", "GET", undefined, signal); }
  accept(executionId: string, input: TaskExecutionInput, signal?: AbortSignal) {
    return this.call<TaskExecutionReceipt>(`/executions/${encodeURIComponent(executionId)}`, "PUT", input, signal);
  }
  get(executionId: string, signal?: AbortSignal) {
    return this.call<TaskExecutionReceipt>(`/executions/${encodeURIComponent(executionId)}`, "GET", undefined, signal);
  }
  cancel(executionId: string, requestId: string, signal?: AbortSignal) {
    return this.call<TaskExecutionReceipt>(`/executions/${encodeURIComponent(executionId)}/cancel`, "POST", { requestId }, signal);
  }
}
