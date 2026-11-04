"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Field, FieldTitle, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getSessionModels, setSessionModel, type AssistantSession, type ModelCatalog } from "@/lib/assistant-api";

type ModelProps = {
  session: AssistantSession; busy: boolean; onChange(record: AssistantSession): void; onSavingChange(saving: boolean): void;
};

export function useSessionModel({ session, busy, onChange, onSavingChange }: ModelProps) {
  const binding = JSON.stringify([session.id, session.connectionId, session.connectionRevision]);
  const [catalogResult, setCatalogResult] = useState<{ binding: string; value?: ModelCatalog; error?: string } | null>(null);
  const catalog = session.connectionId && catalogResult?.binding === binding ? catalogResult.value ?? null : null;
  const catalogError = session.connectionId && catalogResult?.binding === binding ? catalogResult.error ?? "" : "";
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const savingRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    if (session.connectionId) void getSessionModels(session.id).then(value => { if (!disposed) setCatalogResult({ binding, value }); })
      .catch(cause => { if (!disposed) setCatalogResult({ binding, error: cause instanceof Error ? cause.message : "Model choices unavailable." }); });
    return () => { disposed = true; };
  }, [session.id, session.connectionId, session.connectionRevision, binding, retry]);
  const selected = session.executionSelection ?? { model: null, reasoningEffort: null };
  const model = catalog?.models.find(m => m.id === (selected.model ?? catalog.defaultModel));
  const disabled = !!session.taskExecutionId || busy || saving || !session.connectionId || ["running", "awaiting_approval", "awaiting_question"].includes(session.status);
  async function save(next: typeof selected) {
    if (disabled || savingRef.current) return;
    savingRef.current = true; setSaving(true); onSavingChange(true); setError("");
    try { onChange(await setSessionModel(session.id, next, session.selectionRevision ?? 0)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save model selection."); }
    finally { savingRef.current = false; setSaving(false); onSavingChange(false); }
  }
  const modelLabel = selected.model ? model?.label ?? `${selected.model} (unavailable)` : "Agent default";
  const effortLabel = selected.reasoningEffort ? model?.efforts.find(e => e.id === selected.reasoningEffort)?.label ?? `${selected.reasoningEffort} (unavailable)` : "Default effort";
  return { session, catalog, catalogError, error, saving, selected, model, disabled, save, modelLabel, effortLabel, retry: () => setRetry(value => value + 1) };
}

export function SessionModel(props: ModelProps) {
  return <SessionModelFields controller={useSessionModel(props)} />;
}

export function SessionModelFields({ controller }: { controller: ReturnType<typeof useSessionModel> }) {
  const { session, catalog, catalogError, error, saving, selected, model, disabled, save, modelLabel, effortLabel, retry } = controller;
  return <FieldGroup className="gap-4">
    <Field className="gap-2" data-disabled={disabled}>
      <FieldTitle>Model</FieldTitle>
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className="h-9 w-full min-w-0 justify-between px-3" disabled={disabled} aria-label="Model">
          <span className="min-w-0 truncate">{modelLabel}</span><ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger><DropdownMenuContent side="top" align="start" className="max-h-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
        <DropdownMenuRadioGroup value={selected.model ?? "__default__"} onValueChange={value => {
          const nextModel = value === "__default__" ? null : value;
          const choice = catalog?.models.find(m => m.id === (nextModel ?? catalog.defaultModel));
          const effort = choice?.efforts.some(e => e.id === selected.reasoningEffort) ? selected.reasoningEffort : null;
          void save({ model: nextModel, reasoningEffort: effort });
        }}>
          <DropdownMenuRadioItem value="__default__">Agent default</DropdownMenuRadioItem>
          {catalog?.models.map(m => <DropdownMenuRadioItem key={m.id} value={m.id} disabled={Boolean(m.unavailableReason)}>{m.label}{m.unavailableReason ? ` — ${m.unavailableReason}` : ""}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent></DropdownMenu>
      {session.taskExecutionId && <FieldDescription>Model and effort are fixed for this task.</FieldDescription>}
    </Field>
    <ReasoningControl key={JSON.stringify([session.connectionId, session.connectionRevision, model?.id, model?.efforts])}
      model={model} value={selected.reasoningEffort} label={effortLabel} disabled={disabled || !!model?.unavailableReason}
      onChange={value => save({ ...selected, reasoningEffort: value })} />
    {saving && <span role="status" className="sr-only">Saving model…</span>}
    {catalogError && <div className="flex flex-col gap-2"><p role="alert" className="text-xs text-destructive-foreground wrap-anywhere">{catalogError}</p><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={retry}>Retry models</Button></div>}
    {error && <p role="alert" className="text-xs text-destructive-foreground wrap-anywhere">{error}</p>}
  </FieldGroup>;
}

function ReasoningControl({ model, value, label, disabled, onChange }: {
  model: ModelCatalog["models"][number] | undefined; value: string | null; label: string; disabled: boolean;
  onChange(value: string | null): Promise<void>;
}) {
  const labelId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const levels = model?.efforts ?? [];
  const index = levels.findIndex(e => e.id === (value ?? model?.defaultEffort));
  const binary = levels.length === 2 && levels.some(e => e.id === "true") && levels.some(e => e.id === "false");
  const shownLabel = preview === null ? label : levels[preview].label;
  async function commit(index: number) {
    await onChange(levels[index].id);
    setPreview(null);
  }
  return <Field className="gap-2" data-disabled={disabled}>
    <div className="flex items-center justify-between gap-2">
      <FieldTitle id={labelId}>{binary ? "Thinking" : "Reasoning effort"}</FieldTitle>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || value === null} aria-label="Use default effort" onClick={() => void onChange(null)}>Default</Button>
    </div>
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm" aria-label="Selected reasoning effort" aria-live="polite">{shownLabel}</span>
      {binary && <Switch aria-labelledby={labelId} checked={(value ?? model?.defaultEffort) === "true"} disabled={disabled}
        onCheckedChange={checked => void onChange(String(checked))} />}
    </div>
    {!binary && levels.length > 1 && <>
      <Slider className="my-2" min={0} max={levels.length - 1} step={1} value={[preview ?? Math.max(0, index)]} disabled={disabled}
        thumbProps={{ "aria-labelledby": labelId, "aria-valuetext": shownLabel, "aria-disabled": disabled, tabIndex: 0 }}
        onValueChange={values => setPreview(values[0])} onValueCommit={values => void commit(values[0])} />
      <div className="flex justify-between gap-2 text-xs text-muted-foreground" aria-hidden="true"><span>{levels[0].label}</span><span>{levels.at(-1)!.label}</span></div>
    </>}
    {!binary && levels.length === 1 && <Button type="button" size="sm" variant="outline" disabled={disabled || value === levels[0].id} onClick={() => void onChange(levels[0].id)}>Use {levels[0].label}</Button>}
    {!levels.length && <FieldDescription>{model ? "This model does not offer reasoning levels." : "Select a model with known reasoning support to choose a level."}</FieldDescription>}
  </Field>;
}
