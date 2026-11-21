"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AssistantApiError, changeSessionContext, getSessionContextOptions, type AssistantSession, type ModelCatalog,
  type SessionContextOptions, type SessionContextRequest } from "@/lib/assistant-api";
import { rememberManualModel, rememberManualProvider } from "@/lib/browser-agent-preferences";
import { connectionModels } from "@/lib/profiles-api";

type Props = {
  session: AssistantSession; busy: boolean; onChange(session: AssistantSession): void;
  onSavingChange(saving: boolean): void; onClose(): void; focusTrigger(): void;
};
type Review = { input: SessionContextRequest; connectionName: string; modelName: string };
type Choice = SessionContextOptions["connections"][number];
const ready = (c: Choice) => c.available !== false && !!c.bindingRevision;
const selectStyle = "mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50";

function pendingReview(key: string): Review | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Review | null;
    const input = saved?.input;
    if (input && typeof input.requestId === "string" && typeof input.connectionId === "string" &&
      Number.isSafeInteger(input.expectedRevision) && (input.mode === "fresh" || input.mode === "resume")) return saved;
  } catch { /* A user can still review a change if browser storage is unavailable. */ }
  return null;
}

export function SessionContextDialog({ session, busy, onChange, onSavingChange, onClose, focusTrigger }: Props) {
  const storageKey = "hosty.session-context.v1." + JSON.stringify([session.createdBy ?? "", session.id]);
  const [pending, setPending] = useState(() => pendingReview(storageKey));
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const shown = pending ?? review;
  const locked = busy || !!session.taskExecutionId;

  async function confirm(change: Review) {
    if (locked || inFlight.current) return;
    inFlight.current = true;
    setError("");
    try {
      const existing = pendingReview(storageKey);
      if (existing && existing.input.requestId !== change.input.requestId) {
        setPending(existing);
        inFlight.current = false;
        return;
      }
      localStorage.setItem(storageKey, JSON.stringify(change));
    } catch {
      setError("Allow browser storage so this change can be retried if the response is lost.");
      inFlight.current = false;
      return;
    }
    setPending(change); setSaving(true); onSavingChange(true);
    try {
      const record = await changeSessionContext(session.id, change.input);
      try { localStorage.removeItem(storageKey); } catch { /* A later replay still returns this confirmed receipt. */ }
      rememberManualProvider(record); rememberManualModel(record);
      onChange(record); onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm the context change.");
      if (cause instanceof AssistantApiError && [400, 403, 404, 409, 422].includes(cause.status ?? 0)) {
        try { localStorage.removeItem(storageKey); } catch { /* The server still rejects this stale request on replay. */ }
        setPending(null); setReview(null);
      }
    } finally { inFlight.current = false; setSaving(false); onSavingChange(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !inFlight.current) onClose(); }}>
    <DialogContent showCloseButton={!saving} onCloseAutoFocus={event => { event.preventDefault(); focusTrigger(); }}>
      <DialogHeader>
        <DialogTitle>{shown ? shown.input.mode === "resume" ? "Resume the verified context?" : "Start a new context?" : "Change session context"}</DialogTitle>
        <DialogDescription>{shown ? shown.connectionName + " · " + shown.modelName : "Choose a connection and model for this chat."}</DialogDescription>
      </DialogHeader>
      {shown ? <>
        <DialogBody>
          <p className="text-sm">{shown.input.mode === "resume" ? "The provider verified this chat’s previous context. Your next message will continue it."
            : "Your earlier messages stay visible in this chat. The model will receive your next message and the files you attach to it. It will have no prior conversation history."}</p>
          {pending && !saving && <p className="text-sm text-muted-foreground">Retry to check the outcome of your confirmed change.</p>}
          {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{pending ? "Close" : "Cancel"}</Button>
          <Button type="button" disabled={locked || saving} onClick={() => void confirm(shown)}>
            {saving ? "Saving…" : pending ? "Retry confirmed change" : shown.input.mode === "resume" ? "Resume context" : "Start new context"}
          </Button>
        </DialogFooter>
      </> : <ContextChoices session={session} disabled={locked} error={error} onClose={onClose}
        onReview={value => { setError(""); setReview(value); }} />}
    </DialogContent>
  </Dialog>;
}

function ContextChoices({ session, disabled, error, onReview, onClose }: Pick<Props, "session" | "onClose"> &
  { disabled: boolean; error: string; onReview(value: Review): void }) {
  const [options, setOptions] = useState<SessionContextOptions | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    let active = true;
    void getSessionContextOptions(session.id).then(next => {
      if (!active) return;
      setOptions(next);
      setSelected(current => {
        const id = current || next.currentConnectionId;
        return next.connections.find(c => c.id === id && ready(c))?.id ?? "";
      });
    }).catch(cause => { if (active) setLoadError(cause instanceof Error ? cause.message : "Could not load connections."); });
    return () => { active = false; };
  }, [session.id, attempt]);
  const refresh = () => { setOptions(null); setLoadError(""); setAttempt(n => n + 1); };
  const candidate = options?.connections.find(c => c.id === selected && ready(c));
  const connectionFields = <>
      {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
      {options && <label className="text-sm font-medium">Connection
        <select className={selectStyle} value={selected} onChange={e => setSelected(e.target.value)}>
          <option value="" disabled>Choose a connection</option>
          {options.connections.map(c => <option key={c.id} value={c.id} disabled={!ready(c)}>{c.name}{c.reason ? " — " + c.reason : ""}</option>)}
        </select>
      </label>}
      {candidate?.reason && <p role="status" className="text-sm">{candidate.reason}</p>}
      {options?.blockedReason && <p role="status" className="text-sm">{options.blockedReason}</p>}
      {loadError ? <p role="alert" className="text-sm text-destructive-foreground">{loadError}</p> :
        !options ? <p role="status" className="text-sm">Loading connections…</p> :
        !options.connections.some(ready) && <p className="text-sm">Configure an account for this provider in Shell Settings, then refresh connections.</p>}
      {(loadError || options) && <Button type="button" size="sm" variant="outline" className="self-start" onClick={refresh}>Refresh connections</Button>}
  </>;
  return candidate && options
      ? <ContextModels key={JSON.stringify([candidate.id, candidate.bindingRevision])} candidate={candidate} revision={options.selectionRevision}
          initial={session.executionSelection} disabled={disabled || !!options.blockedReason} onReview={onReview} onClose={onClose}>{connectionFields}</ContextModels>
      : <><DialogBody>{connectionFields}</DialogBody><DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button></DialogFooter></>;
}

function ContextModels({ candidate, revision, initial, disabled, onReview, onClose, children }: {
  children: ReactNode; candidate: Choice; revision: number; initial: AssistantSession["executionSelection"]; disabled: boolean; onReview(value: Review): void; onClose(): void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void connectionModels(candidate.id).then(next => {
      if (!active) return;
      const model = next.models.find(m => !m.unavailableReason && m.id === (initial?.model ?? next.defaultModel));
      setCatalog(next); setModelId(model?.id ?? "");
      setEffort(model?.efforts.find(e => e.id === initial?.reasoningEffort)?.id ?? "");
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load models."); });
    return () => { active = false; };
  }, [candidate.id, initial?.model, initial?.reasoningEffort, attempt]);
  const model = catalog?.models.find(m => m.id === modelId && !m.unavailableReason);
  const review = (mode: SessionContextRequest["mode"]) => {
    if (!model || disabled || !candidate.bindingRevision) return;
    onReview({ input: { mode, requestId: crypto.randomUUID(), expectedRevision: revision, connectionId: candidate.id,
      expectedBinding: candidate.bindingRevision, model: model.id, reasoningEffort: effort || null }, connectionName: candidate.name, modelName: model.label });
  };
  return <>
    <DialogBody>
      {children}
      {error ? <><p role="alert" className="text-sm text-destructive-foreground">{error}</p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => { setError(""); setAttempt(n => n + 1); }}>Retry models</Button></> :
        !catalog ? <p role="status" className="text-sm">Loading models…</p> : <>
          <label className="text-sm font-medium">Model
            <select className={selectStyle} value={modelId} onChange={e => { setModelId(e.target.value); setEffort(""); }}>
              <option value="" disabled>Choose a model</option>
              {initial?.model && !catalog.models.some(m => m.id === initial.model) && <option disabled value={initial.model}>{initial.model} (unavailable)</option>}
              {catalog.models.map(m => <option key={m.id} value={m.id} disabled={!!m.unavailableReason}>{m.label}{m.unavailableReason ? " — " + m.unavailableReason : ""}</option>)}
            </select>
          </label>
          {model && model.efforts.length > 0 && <label className="text-sm font-medium">Reasoning effort
            <select className={selectStyle} value={effort} onChange={e => setEffort(e.target.value)}>
              <option value="">Default effort</option>
              {model.efforts.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </label>}
          {!catalog.models.some(m => !m.unavailableReason) && <p className="text-sm">This connection has no available models.</p>}
        </>}
    </DialogBody>
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
      <Button type="button" variant={candidate.canResume ? "outline" : "default"} disabled={disabled || !model} onClick={() => review("fresh")}>Review fresh start</Button>
      {candidate.canResume && <Button type="button" disabled={disabled || !model} onClick={() => review("resume")}>Review verified resume</Button>}
    </DialogFooter>
  </>;
}
