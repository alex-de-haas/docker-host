import type { HarnessEvent, HarnessEventSource } from "@hosty/agent-provider-runtime/harness/adapter";

type ChildState = "running" | "waiting_for_input" | "succeeded" | "failed" | "cancelled";
export type BashCall = { toolId: string; parent?: string; runId: string };
type Task = { runId?: string; parent?: string; owner?: string; kind?: string; background: boolean; ambient: boolean; agent: boolean; state: ChildState };
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 480 && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const terminal = (state: ChildState) => ["succeeded", "failed", "cancelled"].includes(state);
const states: Record<string, ChildState | undefined> = { completed: "succeeded", failed: "failed", stopped: "cancelled", killed: "cancelled", paused: "waiting_for_input", pending: "running", running: "running" };
const metadataValid = (value: Record<string, unknown>) => identity(value.task_id)
  && (value.run_id === undefined || identity(value.run_id))
  && (value.task_type === undefined || identity(value.task_type))
  && (value.parent_task_id === undefined || identity(value.parent_task_id))
  && (value.ambient === undefined || typeof value.ambient === "boolean");

/** Pinned SDK lifecycle signals, separate from an individual root model turn's result. */
export class ClaudeBackgroundLifecycle {
  private readonly tasks = new Map<string, Task>();
  private level: Set<string> | undefined;
  private unknown = false;
  private overflowed = false;
  idle = false;
  constructor(private readonly source: (parent: string) => HarnessEventSource | undefined,
    private readonly emit: (event: HarnessEvent, parent?: string) => void) {}
  get busy(): boolean {
    if (this.unknown || this.overflowed) return true;
    const live = this.level ?? new Set([...this.tasks].filter(([, task]) => task.background && !terminal(task.state)).map(([id]) => id));
    return [...live].some(id => this.requiresContinuation(id));
  }
  beginTurn(): void { this.idle = false; }

  bashCall(id: string): BashCall | undefined {
    const task = this.tasks.get(id);
    if (task?.kind !== "local_bash" || !task.background || task.ambient || !task.parent || !task.runId) return;
    return this.bashScope(task.parent, task.runId, task.owner);
  }

  /** A stop may race task registration. Use its existing owner without admitting a new agent. */
  bashStartedDuringStop(message: Record<string, unknown>): BashCall | undefined {
    if (!metadataValid(message) || message.task_type !== "local_bash" || message.is_backgrounded !== true
      || message.ambient === true || message.skip_transcript === true
      || !identity(message.run_id) || !identity(message.tool_use_id)) return;
    const task = this.tasks.get(message.task_id as string);
    if (task && (task.runId !== message.run_id || task.kind !== "local_bash" || task.ambient
      || task.parent && task.parent !== message.tool_use_id
      || task.owner && message.parent_task_id !== undefined && task.owner !== message.parent_task_id)) return;
    return this.bashScope(message.tool_use_id, message.run_id, (message.parent_task_id as string | undefined) ?? task?.owner);
  }

  private bashScope(toolId: string, runId: string, ownerId?: string): BashCall | undefined {
    if (ownerId === undefined) return { toolId, runId };
    const owner = this.tasks.get(ownerId);
    if (owner?.agent && owner.parent) return { toolId, parent: owner.parent, runId };
  }

  private requiresContinuation(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.ambient) return false;
    const visited = new Set<string>();
    let current: Task | undefined = task, next: string | undefined = id, agent = false;
    while (current && next) {
      if (visited.has(next)) return true; // Cyclic ownership cannot prove completion.
      visited.add(next);
      if (current.agent && !current.ambient) agent = true;
      next = current.owner; current = next ? this.tasks.get(next) : undefined;
    }
    // SDK unknown parents are untracked, not inferred agents. Root shells/watchers
    // remain independent; known ended agents still own their live descendants.
    return agent;
  }

  private uncertain(): void {
    if (!this.unknown) this.emit({ type: "notice", message: "Claude background activity could not be verified. Execution remains active until a current native inventory is available." });
    this.unknown = true;
  }

  private remember(message: Record<string, unknown>, inventory: boolean, acceptNew: boolean): Task | undefined {
    const id = message.task_id as string, runId = message.run_id as string | undefined;
    let task = this.tasks.get(id);
    // The pinned SDK documents lexical run ordering for resumed task identities.
    if (task?.runId && (!runId || runId < task.runId)) return undefined;
    if (!task) {
      if (!acceptNew) return undefined;
      if (this.tasks.size >= 256) { this.overflowed = true; this.uncertain(); return undefined; }
      task = { background: false, ambient: false, agent: false, state: "running" };
      this.tasks.set(id, task);
    } else if (runId !== undefined && task.runId !== runId) {
      task.state = "running"; task.background = false; task.ambient = false;
    }
    if (identity(message.task_type)) {
      if (task.kind && task.kind !== message.task_type) { this.uncertain(); return undefined; }
      task.kind = message.task_type; task.agent = message.task_type === "local_agent";
    } else if (message.subtype === "task_started" && typeof message.subagent_type === "string") task.agent = true;
    if (runId !== undefined) task.runId = runId;
    if (identity(message.tool_use_id)) task.parent = message.tool_use_id;
    // The SDK can omit an owner after it stops tracking the launcher. Retain
    // previously observed ancestry rather than reclassifying its command as root-owned.
    if (message.parent_task_id !== undefined) task.owner = message.parent_task_id as string;
    if (typeof message.ambient === "boolean") task.ambient = message.ambient;
    else if (inventory) task.ambient = false;
    else if (message.skip_transcript === true) task.ambient = true;
    if (inventory) task.background = true;
    else if (message.subtype === "task_started" && typeof message.is_backgrounded === "boolean") task.background = message.is_backgrounded;
    return task;
  }

  observe(message: Record<string, unknown>, acceptNew = true): boolean {
    if (message.type !== "system") return false;
    if (message.subtype === "session_state_changed") {
      if (!["idle", "running", "requires_action"].includes(String(message.state))) return true;
      this.idle = message.state === "idle" && !this.busy; return true;
    }
    if (message.subtype === "background_tasks_changed") {
      // Membership is replaced, independently of edge bookend ordering. Metadata
      // is retained separately because a completed agent may own a live command.
      if (!Array.isArray(message.tasks) || message.tasks.length > 256
        || message.tasks.some(value => !object(value) || !metadataValid(value) || !identity(value.task_type))
        || new Set(message.tasks.map(value => value.task_id)).size !== message.tasks.length) {
        this.uncertain(); return true;
      }
      this.unknown = false;
      for (const task of message.tasks) this.remember(task, true, acceptNew);
      this.level = new Set(message.tasks.map(task => task.task_id));
      return true;
    }
    if (!["task_started", "task_updated", "task_progress", "task_notification"].includes(String(message.subtype))) return false;
    if (!metadataValid(message)) { this.uncertain(); return true; }
    const before = JSON.stringify(this.tasks.get(message.task_id as string));
    const task = this.remember(message, false, acceptNew);
    if (!task) return true;
    const patch = object(message.patch);
    if (message.subtype === "task_updated" && typeof patch?.is_backgrounded === "boolean") task.background = patch.is_backgrounded;
    const state = message.subtype === "task_notification" ? message.status : message.subtype === "task_updated" ? patch?.status : undefined;
    const projected = states[String(state)];
    // A duplicate start/progress from the same native task run cannot revive it.
    if (projected && (!terminal(task.state) || terminal(projected))) task.state = projected;
    if (task.agent && !task.ambient && task.parent && before !== JSON.stringify(task)) {
      const source = this.source(task.parent);
      if (source) this.emit({ type: "agent_status", ...source, state: task.state, stopConfirmed: false, source }, task.parent);
    }
    return true;
  }
}
