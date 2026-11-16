export type QuestionAnswers = Record<string, string | string[]>;

/** A provider's decision ID is scoped to one immutable public run, not a conversation. */
export function providerDecisionCardId(runId: string, decisionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([runId, decisionId]));
  return "agent-decision-" + Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

export function providerDecisionCard(cardId: string): { runId: string; decisionId: string } | null {
  const encoded = /^agent-decision-((?:[a-f0-9]{2}){1,4096})$/.exec(cardId)?.[1];
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(encoded.match(/../g)!, value => Number.parseInt(value, 16));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== "string")) return null;
    const [runId, decisionId] = value as [string, string];
    return runId && decisionId && providerDecisionCardId(runId, decisionId) === cardId ? { runId, decisionId } : null;
  } catch { return null; }
}

/** Older public transcript entries already retain their run in the durable event identity. */
export function transcriptDecisionId(event: { type: string; questionId?: unknown; approvalId?: unknown; providerEventId?: unknown }): string {
  const id = String(event.type.startsWith("approval_") ? event.approvalId : event.questionId);
  if (providerDecisionCard(id)) return id;
  const original = typeof event.providerEventId === "string" ? /^([^:]+):(?:decision|resolved):/.exec(event.providerEventId) : null;
  return original ? providerDecisionCardId(original[1]!, id) : id;
}
