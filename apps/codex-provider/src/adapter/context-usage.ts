import { contextUsage, type ContextUsage } from "@hosty/agent-provider-runtime/harness/context-usage";
export { contextUsage, ContextUsageReader, type ContextUsage } from "@hosty/agent-provider-runtime/harness/context-usage";

export function codexContextUsage(value: unknown): ContextUsage | null {
  const usage = value as { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } | null;
  // Cached input and reasoning output are already included in totalTokens.
  return contextUsage(usage?.last?.totalTokens, usage?.modelContextWindow, true);
}

