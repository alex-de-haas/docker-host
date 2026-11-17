import type { HarnessEvent, HarnessEventSource } from "@hosty/agent-provider-runtime/harness/adapter";

type ChildState = "running" | "waiting_for_input" | "succeeded" | "failed" | "cancelled";
type Task = { runId?: string; parent?: string; background: boolean; ambient: boolean; agent: boolean; state: ChildState };
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 480 && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const terminal = (state: ChildState) => ["succeeded", "failed", "cancelled"].includes(state);
const states: Record<string, ChildState | undefined> = { completed: "succeeded", failed: "failed", stopped: "cancelled", killed: "cancelled", paused: "waiting_for_input", pending: "running", running: "running" };

/** Pinned SDK lifecycle signals, separate from an individual root model turn's result. */
export class ClaudeBackgroundLifecycle {
  private readonly tasks = new Map<string, Task>();
  private level: Set<string> | undefined;
  private unknown = false;
  private observedSessionState = false;
  idle = false;
  constructor(private readonly source: (parent: string) => HarnessEventSource | undefined,
    private readonly emit: (event: HarnessEvent) => void) {}
  get requiresIdle(): boolean { return this.observedSessionState; }
  get busy(): boolean {
    return this.unknown || (this.level ? this.level.size > 0 : [...this.tasks.values()].some(task => task.agent && task.background && !task.ambient && !terminal(task.state)));
  }
  beginTurn(): void { this.idle = false; }
  observe(message: Record<string, unknown>, acceptNew = true): boolean {
    if (message.type !== "system") return false;
    if (message.subtype === "session_state_changed") {
      if (!["idle", "running", "requires_action"].includes(String(message.state))) return true;
      this.observedSessionState = true; this.idle = message.state === "idle"; return true;
    }
    if (message.subtype === "background_tasks_changed") {
      // The SDK specifies replace semantics; edge bookend ordering is independent.
      if (!Array.isArray(message.tasks) || message.tasks.length > 256
        || message.tasks.some(value => !object(value) || !identity(value.task_id) || !identity(value.task_type) || value.run_id !== undefined && !identity(value.run_id) || value.ambient !== undefined && typeof value.ambient !== "boolean")) {
        if (!this.unknown) this.emit({ type: "notice", message: "Claude background activity could not be verified. Execution remains active until a current native inventory is available." });
        this.unknown = true; return true;
      }
      // Only native agents require a parent continuation. Long-lived background shells
      // and watchers can remain active after a completed conversation turn.
      this.level = new Set(message.tasks.filter(task => task.task_type === "local_agent" && task.ambient !== true).map(task => task.task_id));
      this.unknown = false; return true;
    }
    if (!["task_started", "task_updated", "task_progress", "task_notification"].includes(String(message.subtype))) return false;
    if (!identity(message.task_id) || message.run_id !== undefined && !identity(message.run_id)) return true;
    let task = this.tasks.get(message.task_id);
    const runId = message.run_id as string | undefined;
    // The pinned SDK documents lexical run ordering for resumed task identities.
    if (task?.runId && (!runId || runId < task.runId)) return true;
    const newRun = task?.runId !== runId && runId !== undefined;
    if (!task || newRun) {
      if (!acceptNew) return true;
      if (this.tasks.size >= 256 && !task) { this.unknown = true; return true; }
      task = { runId, background: false, ambient: false, agent: false, state: "running" };
      this.tasks.set(message.task_id, task);
    }
    const before = JSON.stringify(task);
    if (identity(message.tool_use_id)) task.parent = message.tool_use_id;
    if (typeof message.ambient === "boolean") task.ambient = message.ambient;
    else if (message.skip_transcript === true) task.ambient = true;
    if (message.subtype === "task_started") {
      task.agent = message.task_type === "local_agent" || typeof message.subagent_type === "string";
      if (typeof message.is_backgrounded === "boolean") task.background = message.is_backgrounded;
    }
    const patch = object(message.patch);
    if (message.subtype === "task_updated" && typeof patch?.is_backgrounded === "boolean") task.background = patch.is_backgrounded;
    const state = message.subtype === "task_notification" ? message.status : message.subtype === "task_updated" ? patch?.status : undefined;
    const projected = states[String(state)];
    // A duplicate start/progress from the same native task run cannot revive it.
    if (projected && (!terminal(task.state) || terminal(projected))) task.state = projected;
    if (task.agent && !task.ambient && task.parent && before !== JSON.stringify(task)) {
      const source = this.source(task.parent);
      if (source) this.emit({ type: "agent_status", ...source, state: task.state, stopConfirmed: false, source });
    }
    return true;
  }
}
