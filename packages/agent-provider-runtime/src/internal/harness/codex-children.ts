import type { HarnessEvent, HarnessEventSource } from "./adapter.js";
import { codexCommandResult, commandToolUseId } from "./command-result.js";
import { toolResult, shouldRetainToolOutput } from "./tool-result.js";

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
export const CODEX_CHILD_METADATA_TIMEOUT_MS = 5_000;
/** Pinned0.167 typed observations; reading history never starts or resumes a native thread. */
export class CodexChildren {
  private readonly activities = new Set<string>();
  private readonly tools = new Set<string>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly closedTurns = new Set<number>();
  private readonly spawned = new Map<number, Set<string>>();
  private readonly verified = new Map<number, Set<string>>();
  private readonly activityRevisions = new Map<string, number>();
  private warned = false;
  constructor(private readonly runId: string, readonly sources: Map<string, HarnessEventSource>,
    private readonly read: (threadId: string) => Promise<unknown>, private readonly emit: (event: HarnessEvent) => void,
    private readonly available: () => boolean) {}

  observe(params: Record<string, unknown>, rootThread: string, rootTurn: string, turn: number): void {
    this.observeItem(params, rootThread, rootTurn, turn);
  }
  private observeItem(params: Record<string, unknown>, rootThread: string, rootTurn: string, turn: number, verifiedParentTurn?: string): void {
    const item = object(params.item), parent = params.threadId;
    if (!item || item.type !== "subAgentActivity" || !identity(item.id) || !identity(item.agentThreadId)
      || !identity(parent) || !identity(params.turnId) || parent === rootThread && params.turnId !== rootTurn
      || parent !== rootThread && (!this.sources.has(parent) || params.turnId !== verifiedParentTurn) || item.agentThreadId === rootThread
      || !["started", "interacted", "interrupted", "completed"].includes(String(item.kind)) || this.closedTurns.has(turn)) return;
    const parentSource = this.sources.get(parent), expectedParent = parentSource?.agentId ?? "root";
    let source = this.sources.get(item.agentThreadId);
    if (source && item.kind === "started" && source.parentAgentId !== expectedParent) { this.incomplete("Conflicting native child lineage was omitted."); return; }
    if (!source && item.kind !== "started") { this.incomplete("A native child activity had no observed spawn lineage; coverage is partial."); return; }
    const callId = commandToolUseId(this.runId, turn, item.id, params.turnId);
    if (!callId) return;
    if (!source) {
      if (this.sources.size >= 256) { this.incomplete("Additional native child observations exceeded the bounded inventory."); return; }
      source = { agentId: item.agentThreadId, parentAgentId: expectedParent, parentToolCallId: callId };
      this.sources.set(item.agentThreadId, source);
    }
    const key = JSON.stringify([turn, parent, params.turnId, item.id, item.kind]);
    if (this.activities.has(key)) return;
    if (this.activities.size >= 2048) { this.incomplete("Additional native child activities exceeded the bounded inventory."); return; }
    this.activities.add(key);
    if (item.kind === "started" || item.kind === "interacted" || item.kind === "interrupted") {
      if (item.kind !== "interrupted") {
        this.verified.get(turn)?.delete(source.agentId);
        const activityKey = JSON.stringify([turn, source.agentId]);
        this.activityRevisions.set(activityKey, (this.activityRevisions.get(activityKey) ?? 0) + 1);
      }
      // Closing a completed child preserves its current verified history. Active or
      // unverified children still fail the final observed-versus-verified check.
      let children = this.spawned.get(turn); if (!children) this.spawned.set(turn, children = new Set());
      children.add(source.agentId);
    }
    // Completed means AgentStatus::Completed in the pinned producer. Interrupted is
    // an observation of the native control, never process-tree exit confirmation.
    this.emit({ type: "agent_status", ...source, source,
      state: item.kind === "completed" ? "succeeded" : item.kind === "interrupted" ? "unknown" : "running", stopConfirmed: false });
    if (item.kind !== "completed") {
      const name = item.kind === "started" ? "spawn" : item.kind === "interrupted" ? "interrupt" : "sendInput";
      this.emit({ type: "tool_use", toolUseId: callId, toolName: `Agent: ${name}`, input: { operation: item.kind }, ...(parentSource ? { source: parentSource } : {}) });
      this.emit({ ...toolResult(callId, "completed", `Native subagent ${String(item.kind)} observation.`), ...(parentSource ? { source: parentSource } : {}) });
    }
    if (item.kind === "completed") {
      // The pinned producer names its completed observation with the exact child turn
      // (core/agent/control/completion.rs). Never select an old turn by position/time.
      const childTurn = item.id.startsWith("subagent-completed-") ? item.id.slice("subagent-completed-".length) : null;
      if (!identity(childTurn)) { this.incomplete("The completed native child turn was not identified; coverage is partial."); return; }
      this.history(source, source.parentAgentId === "root" ? rootThread : source.parentAgentId!, childTurn, rootThread, rootTurn, turn);
    }
  }

  private history(source: HarnessEventSource, parent: string, expectedChildTurn: string, rootThread: string, rootTurn: string, turn: number): void {
    const key = JSON.stringify([turn, source.agentId, expectedChildTurn]);
    if (this.reads.has(key)) return;
    if (this.pending.size >= 8 || this.reads.size >= 256) { this.incomplete("Additional native child metadata exceeded the bounded read concurrency."); return; }
    const activityKey = JSON.stringify([turn, source.agentId]), revision = this.activityRevisions.get(activityKey);
    const task = this.read(source.agentId).then(value => {
      if (!this.available() || this.closedTurns.has(turn)) return;
      const response = object(value), thread = object(response?.thread);
      if (!thread || thread.id !== source.agentId || thread.parentThreadId != null && thread.parentThreadId !== parent
        || !Array.isArray(thread.turns) || thread.turns.length > 128 || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
        throw new Error("The child history identity or bound was not verified.");
      const selected = thread.turns.filter(value => object(value)?.id === expectedChildTurn);
      if (selected.length !== 1) throw new Error("The exact completed child turn was unavailable.");
      let count = 0;
      for (const entry of selected) {
        const childTurn = object(entry);
        if (!childTurn || !identity(childTurn.id) || !Array.isArray(childTurn.items)) throw new Error("The child turn history was not verified.");
        for (const value of childTurn.items) {
          if (++count > 512) { this.incomplete("Additional native child history exceeded the bounded inventory."); return; }
          const item = object(value); if (!item) throw new Error("The child item history was not verified.");
          if (item.type === "subAgentActivity") this.observeItem({ threadId: source.agentId, turnId: childTurn.id, item }, rootThread, rootTurn, turn, childTurn.id);
          else this.projectTool(item, childTurn.id, source, turn);
        }
      }
      let verified = this.verified.get(turn); if (!verified) this.verified.set(turn, verified = new Set());
      if (this.activityRevisions.get(activityKey) === revision) verified.add(source.agentId);
    }).catch(() => { if (this.available() && !this.closedTurns.has(turn)) this.incomplete("Native child tool history is unavailable or could not be verified; coverage is partial."); })
      .finally(() => this.pending.delete(task));
    this.reads.set(key, task); this.pending.add(task);
  }

  private projectTool(item: Record<string, unknown>, childTurn: string, source: HarnessEventSource, turn: number): void {
    const type = item.type;
    if (!["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(type))) return;
    const id = commandToolUseId(this.runId, turn, item.id, childTurn);
    if (!id) { this.incomplete("A native child tool had no verified item identity."); return; }
    const key = JSON.stringify([turn, source.agentId, childTurn, item.id]);
    if (this.tools.has(key)) return;
    if (this.tools.size >= 2048) { this.incomplete("Additional native child tools exceeded the bounded inventory."); return; }
    this.tools.add(key);
    const command = type === "commandExecution" ? codexCommandResult(id, item) : null;
    const name = type === "commandExecution" ? "Command" : type === "fileChange" ? "FileChange"
      : type === "mcpToolCall" ? `mcp__${String(item.server ?? "App")}__${String(item.tool ?? "Tool")}`
        : type === "webSearch" ? "WebSearch" : typeof item.namespace === "string" ? `${item.namespace}: ${String(item.tool ?? "Tool")}` : String(item.tool ?? "Tool");
    let status: "completed" | "failed" | "cancelled" | "unknown" = "unknown", output: unknown;
    if (type === "commandExecution") { status = command?.status ?? "unknown"; output = item.aggregatedOutput; }
    else if (type === "fileChange") { status = item.status === "completed" ? "completed" : item.status === "failed" || item.status === "declined" ? "failed" : "unknown"; output = item.changes; }
    else if (type === "mcpToolCall") {
      const result = object(item.result), error = object(item.error), hasResult = Array.isArray(result?.content) || result?.structuredContent != null;
      status = item.status === "failed" || typeof error?.message === "string" ? "failed" : item.status === "completed" && hasResult ? "completed" : "unknown";
      output = error?.message ?? (hasResult ? { content: result?.content, structuredContent: result?.structuredContent } : undefined);
    } else if (type === "dynamicToolCall") {
      status = item.status === "failed" || item.success === false ? "failed" : item.status === "completed" && item.success === true && Array.isArray(item.contentItems) ? "completed" : "unknown";
      output = Array.isArray(item.contentItems) ? item.contentItems.map(value => { const block = object(value); return block?.type === "inputText" ? { type: "text", text: block.text } : { type: "image" }; }) : undefined;
    } else { status = "completed"; output = item.results; }
    this.emit({ type: "tool_use", toolUseId: id, toolName: name,
      input: type === "commandExecution" ? { command: item.command ?? null } : type === "fileChange" ? { changes: item.changes ?? null } : item.arguments ?? { query: item.query }, source });
    if (command) this.emit({ ...command, source });
    if (shouldRetainToolOutput(name)) this.emit({ ...toolResult(id, status, output, item.durationMs), source });
    this.emit({ type: "native_effect", id, state: status === "unknown" ? "unknown" : "settled", source });
  }

  async finish(turn: number): Promise<void> {
    const deadline = Date.now() + CODEX_CHILD_METADATA_TIMEOUT_MS;
    while (this.pending.size && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, deadline - Date.now())); })]);
      if (timer) clearTimeout(timer);
    }
    if (this.pending.size) this.incomplete("Native child metadata exceeded its bounded observation deadline; coverage is partial.");
    if ([...(this.spawned.get(turn) ?? [])].some(id => !this.verified.get(turn)?.has(id)))
      this.incomplete("An observed native child has no verified completed tool history; coverage is partial.");
    this.closedTurns.add(turn);
  }
  private incomplete(message: string): void {
    if (this.warned) return;
    this.warned = true; this.emit({ type: "notice", message, incomplete: ["tools"] });
  }
}
