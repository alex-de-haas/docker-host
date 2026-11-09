import { randomUUID } from "node:crypto";
import { suggestionText, SUGGESTION_TTL_MS } from "../harness/prompt-suggestion.js";
import { AppContextError } from "./app-context.js";
import { messageRequestId, type SessionRecord, type SessionStore, type StoredEvent } from "./store.js";

export type SuggestionState = "available" | "selected-for-draft" | "dismissed" | "expired" | "superseded";
export interface HistoricalSuggestion {
  suggestionId: string;
  sessionId: string;
  userId: string;
  attemptId: string;
  answerSeq: number;
  text: string;
  contextKey: string;
  expiresAt: number;
  revision: number;
  state: SuggestionState;
  createdAt: string;
  resolvedAt?: string;
}
export const SUGGESTION_CREATED = "prompt_suggestion_created";
export const SUGGESTION_RESOLVED = "prompt_suggestion_resolved";

/** Only literal, correlated prediction metadata is persisted; this never creates a model turn. */
export function historicalSuggestions(events: readonly StoredEvent[]): Map<string, HistoricalSuggestion> {
  const values = new Map<string, HistoricalSuggestion>();
  for (const event of events) {
    if (event.type === SUGGESTION_CREATED && typeof event.suggestionId === "string" && typeof event.text === "string") {
      if (values.has(event.suggestionId)) continue;
      values.set(event.suggestionId, {
        suggestionId: event.suggestionId, sessionId: String(event.sessionId), userId: String(event.userId),
        attemptId: String(event.attemptId), answerSeq: Number(event.answerSeq), text: event.text,
        contextKey: String(event.contextKey), expiresAt: Number(event.expiresAt), revision: 1,
        state: "available", createdAt: event.ts,
      });
    } else if (event.type === SUGGESTION_RESOLVED && typeof event.suggestionId === "string") {
      const previous = values.get(event.suggestionId);
      if (previous?.state === "available" && ["selected-for-draft", "dismissed", "expired", "superseded"].includes(String(event.state)))
        values.set(event.suggestionId, { ...previous, state: event.state as SuggestionState, revision: 2, resolvedAt: event.ts });
    }
  }
  return values;
}

type Append = (sessionId: string, payload: Record<string, unknown> & { type: string }) => Promise<number | undefined>;
/** The caller holds the existing session serializer for every operation, including reconciliation. */
export class SuggestionHistory {
  constructor(private readonly store: Pick<SessionStore, "readEvents">, private readonly append: Append, private readonly now = Date.now) {}

  async create(record: SessionRecord, input: { attemptId: string; text: string; contextKey: string; expiresAt?: number }): Promise<HistoricalSuggestion> {
    const text = suggestionText(input.text);
    if (!text || !input.attemptId) throw new AppContextError(400, "invalid_suggestion", "The suggestion is invalid.");
    const events = await this.store.readEvents(record.id);
    const existing = [...historicalSuggestions(events).values()].find(value => value.attemptId === input.attemptId);
    if (existing) return existing;
    await this.invalidate(record, "superseded");
    const suggestionId = randomUUID(), answerSeq = events.findLast(event => event.type === "assistant_text")?.seq ?? 0;
    const expiresAt = input.expiresAt ?? this.now() + SUGGESTION_TTL_MS;
    await this.append(record.id, { type: SUGGESTION_CREATED, suggestionId, sessionId: record.id, userId: record.createdBy,
      attemptId: input.attemptId, answerSeq, text, contextKey: input.contextKey, expiresAt });
    return (await this.read(record)).get(suggestionId)!;
  }

  async read(record: SessionRecord): Promise<Map<string, HistoricalSuggestion>> {
    return historicalSuggestions(await this.store.readEvents(record.id));
  }

  async reconcile(record: SessionRecord, contextKey: string): Promise<void> {
    for (const value of (await this.read(record)).values()) {
      if (value.state !== "available") continue;
      const state = value.expiresAt <= this.now() ? "expired" : value.contextKey !== contextKey ? "superseded" : null;
      if (state) await this.append(record.id, { type: SUGGESTION_RESOLVED, suggestionId: value.suggestionId, state });
    }
  }

  async invalidate(record: SessionRecord, state: "superseded" | "expired" = "superseded"): Promise<void> {
    for (const value of (await this.read(record)).values()) if (value.state === "available")
      await this.append(record.id, { type: SUGGESTION_RESOLVED, suggestionId: value.suggestionId, state });
  }

  async action(record: SessionRecord, actorUserId: string, suggestionId: string, input: Record<string, unknown>, contextKey: string): Promise<HistoricalSuggestion> {
    if (actorUserId !== record.createdBy) throw new AppContextError(403, "suggestion_forbidden", "Only this conversation's owner can choose a suggestion.");
    let requestId: string;
    try { requestId = messageRequestId(input.requestId); }
    catch { throw new AppContextError(400, "invalid_request_id", "Provide a UUID for this suggestion action."); }
    if (!["selected-for-draft", "dismissed"].includes(String(input.action)) || !Number.isSafeInteger(input.expectedRevision))
      throw new AppContextError(400, "invalid_suggestion_action", "Choose a current suggestion action and revision.");
    const events = await this.store.readEvents(record.id);
    const previous = events.find(event => event.type === SUGGESTION_RESOLVED && event.requestId === requestId);
    if (previous) {
      if (previous.suggestionId !== suggestionId || previous.state !== input.action || previous.expectedRevision !== input.expectedRevision)
        throw new AppContextError(409, "suggestion_request_conflict", "This request was already used for another suggestion choice.");
      return historicalSuggestions(events).get(suggestionId)!;
    }
    await this.reconcile(record, contextKey);
    const value = (await this.read(record)).get(suggestionId);
    if (!value) throw new AppContextError(404, "suggestion_not_found", "This suggestion does not exist.");
    if (value.state !== "available" || value.revision !== input.expectedRevision)
      throw new AppContextError(409, "suggestion_changed", "This suggestion changed. Refresh its recorded choice before acting.");
    await this.append(record.id, { type: SUGGESTION_RESOLVED, suggestionId, state: input.action, requestId,
      expectedRevision: input.expectedRevision, actorUserId });
    return (await this.read(record)).get(suggestionId)!;
  }
}
