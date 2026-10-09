/** Transient observations only; never a tool result or a durable invocation history. */
export interface ActiveTool {
  toolName: string;
  detail?: string;
  mcp?: { server: string; tool: string };
}

export interface HarnessActivity {
  phase: "working" | "thinking" | "responding";
  tool: ActiveTool | null;
  toolCount: number;
}

export interface SessionActivity {
  epoch: string;
  revision: number;
  activity: HarnessActivity | null;
}

export const workingActivity = (): HarnessActivity => ({ phase: "working", tool: null, toolCount: 0 });

const bounded = (value: unknown): string | undefined => typeof value === "string"
  ? value.replace(/[\s\u0000-\u001f]+/g, " ").trim().slice(0, 120) || undefined : undefined;

/** Allowlisted display fields: never forward command strings, MCP arguments or result bodies. */
export function activeTool(toolName: string, input?: unknown, mcp?: ActiveTool["mcp"]): ActiveTool {
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const detail = ["Read", "Write", "Edit", "MultiEdit"].includes(toolName)
    ? bounded(fields.file_path) : undefined;
  return { toolName: bounded(toolName) ?? "Tool", ...(detail ? { detail } : {}),
    ...(mcp ? { mcp: { server: bounded(mcp.server) ?? "App", tool: bounded(mcp.tool) ?? "Tool" } } : {}) };
}

/** Native IDs correlate overlapping work; repeated token/progress frames do not flood SSE. */
export class ActivityTracker {
  private readonly tools = new Map<string, ActiveTool>();
  private readonly phases = new Map<string, "thinking" | "responding">();
  private previous = "";
  constructor(private readonly publish: (activity: HarnessActivity) => void) {}

  reset(): void {
    this.tools.clear(); this.phases.clear(); this.previous = "";
    this.emit();
  }

  phase(id: string, phase: "thinking" | "responding"): void {
    this.phases.set(id, phase);
    this.emit();
  }

  start(id: string, tool: ActiveTool): void {
    this.tools.set(id, tool);
    this.emit();
  }

  finish(id: string): void {
    this.tools.delete(id); this.phases.delete(id);
    this.emit();
  }

  private emit(): void {
    const activity: HarnessActivity = {
      phase: [...this.phases.values()].at(-1) ?? "working",
      tool: [...this.tools.values()].at(-1) ?? null,
      toolCount: this.tools.size,
    };
    const serialized = JSON.stringify(activity);
    if (serialized === this.previous) return;
    this.previous = serialized;
    this.publish(activity);
  }
}
