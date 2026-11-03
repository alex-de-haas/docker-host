import type { DecisionAnswers, DecisionResolve } from "@hosty-sdk/app/decisions";
export type DecisionDraft = { revision: number; answers: DecisionAnswers; request?: DecisionResolve; uncertain?: boolean };
const values = new Map<string, DecisionDraft>();
const listeners = new Map<string, Set<() => void>>();
export const decisionDraftKey = (owner: string, id: string) => `hosty.decision.${encodeURIComponent(owner)}.${encodeURIComponent(id)}`;
export function readDecisionDraft(key: string, revision: number): DecisionDraft {
  let draft = values.get(key);
  if (!draft) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (saved && Number.isSafeInteger(saved.revision) && saved.answers && typeof saved.answers === "object" && !Array.isArray(saved.answers))
        draft = { ...saved, uncertain: !!saved.request };
    } catch { /* Storage is optional; keep this tab's draft in memory. */ }
    draft ??= { revision, answers: {} }; values.set(key, draft);
  }
  return draft;
}
export function writeDecisionDraft(key: string, value: DecisionDraft): void {
  values.set(key, value);
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Preserve the in-memory draft. */ }
  listeners.get(key)?.forEach(listener => listener());
}
export function watchDecisionDraft(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
