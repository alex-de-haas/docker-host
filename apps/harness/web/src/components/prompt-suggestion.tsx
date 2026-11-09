"use client";
import { Button } from "@/components/ui/button";
import type { PromptSuggestion } from "@/lib/prompt-suggestions";

const labels: Record<PromptSuggestion["state"], string> = {
  available: "", "selected-for-draft": "Selected for draft", dismissed: "Dismissed", expired: "Expired", superseded: "Superseded",
};
/** Literal text stays in history; a selection is not a delivery receipt. */
export function PromptSuggestionCard({ text, state = "available", canInsert = true, actionable = true, busy = false, tabHint = false, onAccept, onDismiss }:
  { text: string; state?: PromptSuggestion["state"]; canInsert?: boolean; actionable?: boolean; busy?: boolean; tabHint?: boolean; onAccept?: () => void; onDismiss?: () => void }) {
  return <div className="min-w-0 rounded-md border bg-muted/40 p-3" aria-label="Suggested next message" data-slot="prompt-suggestion">
    <p className="text-xs font-medium text-muted-foreground">Suggested next message</p>
    <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm">{text}</p>
    {state === "available" && actionable ? <div className="mt-2 flex flex-wrap gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={!canInsert || busy || !onAccept} onClick={onAccept}>Use suggestion{tabHint && canInsert && !busy && <span className="hidden text-xs text-muted-foreground sm:inline">Tab</span>}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy || !onDismiss} onClick={onDismiss}>Dismiss</Button>
      {!canInsert && <p className="w-full text-xs text-muted-foreground">Your current draft is preserved. Use this suggestion after clearing it or finishing your edit.</p>}
    </div> : labels[state] && <p className="mt-2 text-xs font-medium text-muted-foreground" role="status">{labels[state]}</p>}
  </div>;
}
