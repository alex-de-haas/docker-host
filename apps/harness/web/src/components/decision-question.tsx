"use client";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import type { DecisionAnswer, DecisionRecord } from "@hosty-sdk/app/decisions";
import { ApiError } from "@/lib/api";
import { readDecision, readDecisionWait, resolveDecision, retryDecision, subscribeDecisionUpdates, type DecisionWaitView } from "@/lib/decisions";
import { decisionDraftKey, readDecisionDraft, writeDecisionDraft, watchDecisionDraft } from "@/lib/decision-drafts";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
const label = (value: string) => value.replaceAll("_", " ");

/** Both chat and inbox read the authoritative ID; drafts are scoped to its addressed user. */
export function DecisionQuestion({ decisionId, waitId, onChanged }: { decisionId?: string; waitId?: string; onChanged?: () => void }) {
  const [record, setRecord] = useState<DecisionRecord | null>(null), [wait, setWait] = useState<DecisionWaitView | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      if (waitId) {
        const current = await readDecisionWait(waitId); setWait(current);
        setRecord(current.core ? await readDecision(current.core.id) : null);
      } else if (decisionId) {
        const row = await readDecision(decisionId); setRecord(row);
        const ref = row.input?.waitReference;
        if (ref && /^[a-f0-9]{64}$/.test(ref)) {
          const local = await readDecisionWait(ref).catch(() => null);
          setWait(local?.core?.id === row.id ? local : null);
        } else setWait(null);
      }
      setError(""); return true;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { setRecord(null); setWait(null); }
      setError(error instanceof Error ? error.message : "Decision is unavailable."); return false;
    }
  }, [decisionId, waitId]);
  useEffect(() => {
    return subscribeDecisionUpdates(refresh, () => setError("Live updates are unavailable. Refresh before answering."));
  }, [refresh]);
  return <section aria-label="Agent question" className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="outline" onClick={() => void refresh()}>Refresh</Button></p>}
    {!record ? <div className="space-y-3"><p className="text-sm">{wait ? "The question is retained in this chat. Saving its shared record is pending." : error ? "This question cannot be read with the current access." : "Loading question…"}</p>
      {wait?.error && <p role="status" className="text-sm text-muted-foreground">{wait.error}</p>}
      {wait && <Button variant="outline" onClick={() => void retryDecision(wait.id).then(refresh).catch(e => setError(e.message))}>Retry saving question</Button>}</div>
      : <DecisionAnswerForm key={`${record.userId}:${record.id}`} record={record} unavailable={!!error} onSaved={async row => { setRecord(row); await refresh(); onChanged?.(); }} />}
    {wait && <div className="space-y-2 border-t pt-3 text-sm">
      {wait.error && <p role="status">{wait.error}</p>}
      {wait.state === "blocked" && <Button size="sm" variant="outline" onClick={() => void retryDecision(wait.id).then(refresh).catch(e => setError(e.message))}>Check continuation</Button>}
      <a className="text-primary underline" href={`/development?session=${encodeURIComponent(wait.sessionId)}`}>Open originating chat</a>
    </div>}
  </section>;
}
export function DecisionAnswerForm({ record, unavailable = false, onSaved }: { record: DecisionRecord; unavailable?: boolean; onSaved: (record: DecisionRecord) => Promise<void> }) {
  const key = decisionDraftKey(record.userId, record.id), prefix = useId();
  const subscribe = useCallback((listener: () => void) => watchDecisionDraft(key, listener), [key]);
  const snapshot = useCallback(() => readDecisionDraft(key, record.revision), [key, record.revision]);
  const draft = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = record.state === "pending", stale = draft.revision !== record.revision;
  const frozen = unavailable || busy || !!draft.request || !pending;
  const answer = (id: string): DecisionAnswer => record.resolution?.answers[id] ?? draft.answers[id] ?? {};
  const edit = (id: string, value: DecisionAnswer) => writeDecisionDraft(key, { ...draft, answers: { ...draft.answers, [id]: value } });
  const valid = record.input?.questions.every(q => { const a = draft.answers[q.id]; return !!a && (!!a.optionIds?.length || !!a.text?.trim()); });
  const submit = async () => {
    if (busy || unavailable || !pending || stale && !draft.request) return;
    const request = draft.request ?? { requestId: crypto.randomUUID(), expectedRevision: record.revision, answers: draft.answers };
    writeDecisionDraft(key, { ...draft, request, uncertain: false }); setBusy(true); setError("");
    try {
      const saved = await resolveDecision(record.id, request);
      writeDecisionDraft(key, { revision: saved.revision, answers: saved.resolution?.answers ?? draft.answers });
      await onSaved(saved);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        writeDecisionDraft(key, { ...draft, request: undefined, uncertain: false });
        await readDecision(record.id).then(onSaved).catch(() => {});
        setError(error.message);
      } else {
        writeDecisionDraft(key, { ...draft, request, uncertain: true });
        setError("The response could not be confirmed. Check the original submission before editing or sending another answer.");
      }
    } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <header className="space-y-1"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{record.input?.title ?? "Decision content removed"}</h2><span className="rounded bg-muted px-2 py-1 text-xs">{label(record.state)}</span></div>
      <p className="break-words text-xs text-muted-foreground">Requested by {record.sourceAppId ?? "Core operator"} · <time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time> · Revision {record.revision}</p>
      {record.input?.reason && <p className="whitespace-pre-wrap text-sm">{record.input.reason}</p>}
    </header>
    {record.input?.questions.map(q => <fieldset key={q.id} disabled={frozen} className="space-y-3">
      <legend className="mb-2 whitespace-pre-wrap text-sm font-medium">{q.question}</legend>
      {q.options?.map(o => <label key={o.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
        <input type={q.multiple ? "checkbox" : "radio"} name={`${prefix}-${q.id}`} value={o.id} checked={answer(q.id).optionIds?.includes(o.id) ?? false} className="mt-1 shrink-0 accent-primary"
          onChange={e => { const current = draft.answers[q.id] ?? {}; edit(q.id, { ...current, optionIds: q.multiple ? e.target.checked ? [...(current.optionIds ?? []), o.id] : (current.optionIds ?? []).filter(id => id !== o.id) : [o.id] }); }} />
        <span className="min-w-0 text-sm"><span className="block whitespace-pre-wrap font-medium">{o.label}</span>{o.description && <span className="block whitespace-pre-wrap text-muted-foreground">{o.description}</span>}</span>
      </label>)}
      {q.allowText !== false && <label className="block space-y-1 text-sm"><span>{q.options?.length ? "Your own answer or additional detail" : "Your answer"}</span>
        <Textarea value={answer(q.id).text ?? ""} maxLength={4000} onChange={e => edit(q.id, { ...(draft.answers[q.id] ?? {}), text: e.target.value })} /></label>}
    </fieldset>)}
    {record.reason && <p role="status" className="text-sm">{record.reason}</p>}
    {record.input?.materials?.length ? <details className="text-sm"><summary>Reviewed materials</summary><ul className="mt-2 space-y-1">{record.input.materials.map((m, i) => <li key={i} className="break-all">{m.kind}: {m.id}{m.revision ? ` · Revision ${m.revision}` : ""}</li>)}</ul></details> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {pending && stale && !draft.request && <div role="alert" className="space-y-2 text-sm"><p>This question changed. Your draft is retained; review the current question before submitting.</p><Button variant="outline" onClick={() => writeDecisionDraft(key, { revision: record.revision, answers: Object.fromEntries((record.input?.questions ?? []).map(q => {
        const previous = draft.answers[q.id] ?? {};
        const optionIds = previous.optionIds?.filter(id => q.options?.some(option => option.id === id));
        return [q.id, { optionIds: q.multiple ? optionIds : optionIds?.slice(0, 1), ...(q.allowText !== false ? { text: previous.text } : {}) }];
      })) })}>I reviewed this revision</Button></div>}
    {pending && <div className="space-y-2"><p className="text-xs text-muted-foreground">Your answer is saved once and passed to the originating work. Permissions remain separate.</p>
      <Button disabled={busy || unavailable || !draft.request && (!valid || stale)} onClick={() => void submit()}>{busy ? "Saving…" : draft.request ? "Check original submission" : "Submit answer"}</Button></div>}
    {record.notificationPending && record.state === "pending" && <p role="alert">The question is saved, but its notification could not be delivered. Delivery will be retried.</p>}
    {record.resolution && <div role="status" className="space-y-1 border-t pt-3 text-sm"><p>Answer saved · {new Date(record.resolution.answeredAt).toLocaleString()}</p>
      <p>Continuation: {label(record.continuation?.state ?? "pending")}{record.continuation?.reason ? ` · ${label(record.continuation.reason)}` : ""}</p>
      {record.continuation?.outcome && <p>{record.continuation.outcome}</p>}
    </div>}
  </div>;
}
