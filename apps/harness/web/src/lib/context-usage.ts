import type { ContextUsage } from "../../../src/harness/context-usage";
import type { AssistantEvent } from "./assistant-api";

export type ContextUsageState = { sessionId: string; sequence: number; usage: ContextUsage | null };
export const emptyContextUsage = (sessionId: string): ContextUsageState => ({ sessionId, sequence: -1, usage: null });

/** Cursor ordering protects against replay and late callbacks from another conversation. */
export function applyContextUsage(current: ContextUsageState, sessionId: string, event: AssistantEvent): ContextUsageState {
  if (current.sessionId !== sessionId || event.type !== "context_usage"
    || !Number.isSafeInteger(event.seq) || event.seq <= current.sequence) return current;
  const value = event.usage as ContextUsage | null | undefined;
  const valid = value && Number.isSafeInteger(value.usedTokens) && value.usedTokens >= 0
    && (value.maxTokens === null || Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0)
    && typeof value.estimated === "boolean" && typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt));
  return { sessionId, sequence: event.seq, usage: valid ? value : null };
}
