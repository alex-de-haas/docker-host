export type SuggestionInsertionIntent = {
  version: 1; requestId: string; suggestionId: string; expectedRevision: number; text: string;
  generation: string; state: "pending" | "selected" | "applied";
  action: "selected-for-draft" | "dismissed";
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/** The origin is the installation boundary; identities prevent another user's intent being restored. */
export const insertionScope = (origin: string, userId: string, sessionId: string) => [origin, userId, sessionId].map(encodeURIComponent).join(".");

export class SuggestionInsertion {
  private readonly key: string;
  private readonly generationKey: string;
  private readonly draftKey: string;
  private applying = false;
  constructor(scope: string, sessionId: string, private readonly storage: Storage = localStorage) {
    this.key = `hosty.prompt-suggestion.insertion.v1.${scope}`;
    this.generationKey = `hosty.prompt-suggestion.generation.v1.${scope}`;
    this.draftKey = `hosty.assistant.draft.${sessionId}`;
  }
  private generation(): string {
    const existing = this.storage.getItem(this.generationKey);
    if (existing) return existing;
    const next = crypto.randomUUID(); this.storage.setItem(this.generationKey, next); return next;
  }
  changed(): void {
    if (!this.applying) this.storage.setItem(this.generationKey, crypto.randomUUID());
  }
  read(): SuggestionInsertionIntent | null {
    const value = JSON.parse(this.storage.getItem(this.key) ?? "null") as SuggestionInsertionIntent | null;
    if (!value) return null;
    if (value.version !== 1 || typeof value.requestId !== "string" || typeof value.suggestionId !== "string"
      || !Number.isSafeInteger(value.expectedRevision) || typeof value.text !== "string" || value.text.length > 4000
      || typeof value.generation !== "string" || !["pending", "selected", "applied"].includes(value.state)
      || !["selected-for-draft", "dismissed"].includes(value.action))
      throw new Error("The saved suggestion choice could not be read. Your draft has been preserved.");
    return value;
  }
  stage(value: { suggestionId: string; revision: number; text: string }, action: SuggestionInsertionIntent["action"] = "selected-for-draft"): SuggestionInsertionIntent {
    if (this.read()) throw new Error("Recover the previous suggestion choice before selecting another.");
    const intent: SuggestionInsertionIntent = { version: 1, requestId: crypto.randomUUID(), suggestionId: value.suggestionId,
      expectedRevision: value.revision, text: value.text, generation: this.generation(), state: "pending", action };
    this.storage.setItem(this.key, JSON.stringify(intent));
    return intent;
  }
  selected(intent: SuggestionInsertionIntent): SuggestionInsertionIntent {
    const next = { ...intent, state: "selected" as const }; this.storage.setItem(this.key, JSON.stringify(next)); return next;
  }
  forget(intent: SuggestionInsertionIntent): void {
    if (this.read()?.requestId === intent.requestId) this.storage.removeItem(this.key);
  }
  /** Explicit Retry may target the new empty draft; ordinary recovery never changes its guard. */
  retry(intent: SuggestionInsertionIntent): SuggestionInsertionIntent {
    const next = { ...intent, generation: this.generation() }; this.storage.setItem(this.key, JSON.stringify(next)); return next;
  }
  restoreIfPersisted(intent: SuggestionInsertionIntent): boolean {
    if (this.generation() !== intent.generation || this.storage.getItem(this.draftKey) !== intent.text) return false;
    this.forget(intent); return true;
  }
  apply(intent: SuggestionInsertionIntent, insert: (text: string) => boolean): "inserted" | "restored" | "draft-changed" | "refused" {
    if (this.generation() !== intent.generation) return "draft-changed";
    const storedDraft = this.storage.getItem(this.draftKey) ?? "";
    if (storedDraft === intent.text) { this.forget(intent); return "restored"; }
    if (storedDraft.trim()) return "draft-changed";
    // Persist the actual draft before touching React state. A crash between these writes is
    // recovered by the exact saved text, never by appending a second copy.
    this.storage.setItem(this.draftKey, intent.text);
    this.storage.setItem(this.key, JSON.stringify({ ...intent, state: "applied" }));
    this.applying = true;
    let inserted = false;
    try { inserted = insert(intent.text); }
    finally { this.applying = false; }
    if (inserted) { this.forget(intent); return "inserted"; }
    if (this.generation() === intent.generation && this.storage.getItem(this.draftKey) === intent.text)
      this.storage.setItem(this.draftKey, "");
    this.selected(intent);
    return "refused";
  }
}
