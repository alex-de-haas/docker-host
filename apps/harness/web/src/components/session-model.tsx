"use client";

import { useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { getSessionModels, setSessionModel, type AssistantSession, type ModelCatalog } from "@/lib/assistant-api";

export function SessionModel({ session, busy, onChange, onSavingChange }: {
  session: AssistantSession; busy: boolean; onChange(record: AssistantSession): void; onSavingChange(saving: boolean): void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    if (session.connectionId) void getSessionModels(session.id).then(value => { if (!disposed) setCatalog(value); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : "Model choices unavailable."); });
    return () => { disposed = true; };
  }, [session.id, session.connectionId, session.connectionRevision]);
  const selected = session.executionSelection ?? { model: null, reasoningEffort: null };
  const model = catalog?.models.find(m => m.id === (selected.model ?? catalog.defaultModel));
  const disabled = busy || saving || !session.connectionId || ["running", "awaiting_approval", "awaiting_question"].includes(session.status);
  async function save(next: typeof selected) {
    if (disabled || savingRef.current) return;
    savingRef.current = true; setSaving(true); onSavingChange(true); setError("");
    try { onChange(await setSessionModel(session.id, next, session.selectionRevision ?? 0)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save model selection."); }
    finally { savingRef.current = false; setSaving(false); onSavingChange(false); }
  }
  return <div className="flex min-w-0 flex-col text-xs">
    <div className="flex flex-wrap">
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" className="h-9 max-w-48 truncate px-2" disabled={disabled} aria-label="Model">
          {selected.model ? model?.label ?? `${selected.model} (unavailable)` : "Agent default"}
        </Button>
      </DropdownMenuTrigger><DropdownMenuContent side="top" align="start">
        <DropdownMenuRadioGroup value={selected.model ?? "__default__"} onValueChange={value => {
          const nextModel = value === "__default__" ? null : value;
          const choice = catalog?.models.find(m => m.id === (nextModel ?? catalog.defaultModel));
          const effort = choice?.efforts.some(e => e.id === selected.reasoningEffort) ? selected.reasoningEffort : null;
          void save({ model: nextModel, reasoningEffort: effort });
        }}>
          <DropdownMenuRadioItem value="__default__">Agent default</DropdownMenuRadioItem>
          {catalog?.models.map(m => <DropdownMenuRadioItem key={m.id} value={m.id}>{m.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" className="h-9 px-2" disabled={disabled} aria-label="Reasoning effort">
          {selected.reasoningEffort ? model?.efforts.find(e => e.id === selected.reasoningEffort)?.label ?? `${selected.reasoningEffort} (unavailable)` : "Default effort"}
        </Button>
      </DropdownMenuTrigger><DropdownMenuContent side="top" align="start">
        <DropdownMenuRadioGroup value={selected.reasoningEffort ?? "__default__"} onValueChange={value => void save({ ...selected, reasoningEffort: value === "__default__" ? null : value })}>
          <DropdownMenuRadioItem value="__default__">Default</DropdownMenuRadioItem>
          {model?.efforts.map(e => <DropdownMenuRadioItem key={e.id} value={e.id}>{e.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        {!model?.efforts.length && <p className="max-w-64 px-2 py-1 text-muted-foreground">Select a model with known reasoning effort support to choose a level.</p>}
      </DropdownMenuContent></DropdownMenu>
    </div>
    {saving && <span role="status">Saving model…</span>}
    {error && <span role="alert" className="max-w-80 text-destructive">{error}</span>}
  </div>;
}
