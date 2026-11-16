import { claudeMcpContextDetail } from "./context-mcp.js";
import { contextUsage, type ContextUsage } from "@hosty/agent-provider-runtime/harness/context-usage";
export { contextUsage, ContextUsageReader, type ContextUsage } from "@hosty/agent-provider-runtime/harness/context-usage";

export function claudeContextUsage(value: unknown): ContextUsage | null {
  const usage = value as { totalTokens?: unknown; maxTokens?: unknown } | null;
  const snapshot = contextUsage(usage?.totalTokens, usage?.maxTokens, true);
  const mcp = claudeMcpContextDetail(value);
  return snapshot && mcp ? { ...snapshot, mcp } : snapshot;
}

