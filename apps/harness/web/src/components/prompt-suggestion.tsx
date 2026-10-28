"use client";
import { Button } from "@/components/ui/button";
/** Literal text; accepting only fills the existing editable draft. */
export function PromptSuggestionCard({ text, onAccept, onDismiss }: { text: string; onAccept: () => void; onDismiss: () => void }) {
  return <div className="mx-3 mt-3 min-w-0 rounded-md border bg-muted/40 p-3" aria-label="Suggested next message">
    <p className="text-xs font-medium text-muted-foreground">Suggested next message</p>
    <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm">{text}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={onAccept}>Use suggestion<span className="hidden text-xs text-muted-foreground sm:inline">Tab</span></Button>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
    </div>
  </div>;
}
