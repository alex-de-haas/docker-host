import type { AssistantEvent } from "./assistant-api";
import { parseMcpToolName } from "./tool-display";
import { toolResults } from "./transcript-items";

export type McpActivity = {
  total: number;
  tools: Array<{ server: string; name: string; calls: number; completed: number; failed: number; cancelled: number; unknown: number }>;
};

const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

function mcpIdentity(event: AssistantEvent): { server: string; name: string } | undefined {
  if (Object.hasOwn(event, "mcp")) {
    const metadata = event.mcp;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
    const { server, tool } = metadata as Record<string, unknown>;
    return validName(server) && validName(tool) ? { server, name: tool } : undefined;
  }
  const parsed = typeof event.toolName === "string" ? parseMcpToolName(event.toolName) : null;
  return parsed && validName(parsed.server) && validName(parsed.tool) ? { server: parsed.server, name: parsed.tool } : undefined;
}

/** Recorded calls only: provider refusals and unreported nested calls do not establish execution. */
export function observedMcpActivity(events: readonly AssistantEvent[]): McpActivity {
  const seen = new Set<number>();
  const unique = events.filter(event => {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) return false;
    if (seen.has(event.seq)) return false;
    seen.add(event.seq);
    return true;
  });
  const outcomes = toolResults(unique).results;
  const tools = new Map<string, McpActivity["tools"][number]>();
  let total = 0;
  for (const event of unique) {
    if (event.type !== "tool_use") continue;
    const identity = mcpIdentity(event);
    if (!identity) continue;
    const key = JSON.stringify([identity.server, identity.name]);
    let tool = tools.get(key);
    if (!tool) {
      tool = { ...identity, calls: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 };
      tools.set(key, tool);
    }
    total++;
    tool.calls++;
    tool[outcomes[event.seq]?.status ?? "unknown"]++;
  }
  return { total, tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server) || a.name.localeCompare(b.name)) };
}
