"use client";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import type { DecisionAnswer, DecisionOption, DecisionQuestion as DecisionQuestionInput, DecisionRecord } from "@hosty-sdk/app/decisions";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { readDecision, readDecisionWait, resolveDecision, retryDecision, subscribeDecisionUpdates, type DecisionWaitView } from "@/lib/decisions";
import { decisionDraftKey, readDecisionDraft, writeDecisionDraft, watchDecisionDraft } from "@/lib/decision-drafts";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
const label = (value: string) => value.replaceAll("_", " ");
/** The saved choices and text of every question, in question order. */
const answerSummary = (record: DecisionRecord) => record.input?.questions.map(q => {
  const answer = record.resolution?.answers[q.id], text = answer?.text?.trim();
  return [...(q.options ?? []).filter(o => answer?.optionIds?.includes(o.id)).map(o => o.label), ...(text ? [text] : [])].join(", ");
}).filter(Boolean).join("; ") || (record.input ? "Not answered" : "Decision content removed");
/** What a closed question still asks of the reader: a stuck continuation outranks the saved answer. */
function closedStatus(record: DecisionRecord, wait: DecisionWaitView | null): { label: string; tone: string } {
  const continuation = record.continuation?.state;
  if (record.state === "answered" && (wait?.state === "blocked" || continuation === "blocked")) return { label: "Blocked", tone: "text-warning-foreground" };
  if (record.state === "answered" && continuation === "failed") return { label: "Failed", tone: "text-destructive-foreground" };
  if (record.state === "withdrawn" || record.state === "expired") return { label: record.state === "withdrawn" ? "Withdrawn" : "Expired", tone: "text-destructive-foreground" };
  return { label: record.state === "stale" ? "Stale" : "Answered", tone: "text-muted-foreground" };
}

/** Both chat and inbox read the authoritative ID; drafts are scoped to its addressed user. */
export function DecisionQuestion({ decisionId, waitId, onChanged }: { decisionId?: string; waitId?: string; onChanged?: () => void }) {
  const [record, setRecord] = useState<DecisionRecord | null>(null), [wait, setWait] = useState<DecisionWaitView | null>(null);
  const [error, setError] = useState(""), [open, setOpen] = useState(false);
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
  // A chat renders its own wait, so only another view links back to the originating chat.
  const notice = record && wait?.error && wait.error !== record.reason ? wait.error : "", origin = !!wait && !waitId;
  const card = <section aria-label="Agent question" className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="outline" onClick={() => void refresh()}>Refresh</Button></p>}
    {!record ? <div className="space-y-3"><p className="text-sm">{wait ? "The question is retained in this chat. Saving its shared record is pending." : error ? "This question cannot be read with the current access." : "Loading question…"}</p>
      {wait?.error && <p role="status" className="text-sm text-muted-foreground">{wait.error}</p>}
      {wait && <Button variant="outline" onClick={() => void retryDecision(wait.id).then(refresh).catch(e => setError(e.message))}>Retry saving question</Button>}</div>
      : <DecisionAnswerForm key={`${record.userId}:${record.id}`} record={record} unavailable={!!error} onSaved={async row => { setRecord(row); await refresh(); onChanged?.(); }} />}
    {wait && (notice || wait.state === "blocked" || origin) && <div className="space-y-2 border-t pt-3 text-sm">
      {notice && <p role="status" className="wrap-anywhere">{notice}</p>}
      {(wait.state === "blocked" || origin) && <div className="flex flex-wrap items-center gap-3">
        {wait.state === "blocked" && <Button size="sm" variant="outline" onClick={() => void retryDecision(wait.id).then(refresh).catch(e => setError(e.message))}>Check continuation</Button>}
        {origin && <a className="text-primary underline" href={`/development?session=${encodeURIComponent(wait.sessionId)}`}>Open originating chat</a>}
      </div>}
    </div>}
  </section>;
  // In a chat a closed question folds to one line, like a tool call; Decisions keeps its details open.
  if (!waitId || !record || record.state === "pending") return card;
  const status = closedStatus(record, wait), Chevron = open ? ChevronDown : ChevronRight;
  return <div className="min-w-0 text-xs text-muted-foreground" data-slot="decision-row">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(current => !current)}
      className="h-auto min-h-8 w-full min-w-0 justify-start gap-1.5 px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
      <HelpCircle className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{answerSummary(record)}</span>
        {record.input?.questions[0] && <span className="ml-1 font-normal">{record.input.questions[0].question}</span>}</span>
      <Badge variant="outline" className={cn("ml-auto shrink-0 px-1.5 py-0 font-normal", status.tone)}>{status.label}</Badge>
      <Chevron className="size-3 shrink-0" aria-hidden />
    </Button>
    {open && <div className="pt-1">{card}</div>}
  </div>;
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
  return <div className={pending ? "space-y-4" : "space-y-3"}>
    <header className="space-y-1"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="min-w-0 font-semibold wrap-anywhere">{record.input?.title ?? "Decision content removed"}</h2><span className="rounded bg-muted px-2 py-1 text-xs">{label(record.state)}</span></div>
      <p className="text-xs text-muted-foreground wrap-anywhere">Requested by {record.sourceAppId ?? "Core operator"} · <time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time> · Revision {record.revision}</p>
      {record.input?.reason && <p className="whitespace-pre-wrap text-sm wrap-anywhere">{record.input.reason}</p>}
    </header>
    {!pending ? record.input?.questions.length ? <dl className="space-y-3">{record.input.questions.map(q => <ClosedAnswer key={q.id} question={q} answer={record.resolution?.answers[q.id]} />)}</dl> : null
      : record.input?.questions.map(q => <fieldset key={q.id} disabled={frozen} className="min-w-0 space-y-3">
      <legend className="mb-2 max-w-full whitespace-pre-wrap text-sm font-medium wrap-anywhere">{q.question}</legend>
      {q.options?.map(o => <label key={o.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
        <input type={q.multiple ? "checkbox" : "radio"} name={`${prefix}-${q.id}`} value={o.id} checked={answer(q.id).optionIds?.includes(o.id) ?? false} className="mt-1 shrink-0 accent-primary"
          onChange={e => { const current = draft.answers[q.id] ?? {}; edit(q.id, { ...current, optionIds: q.multiple ? e.target.checked ? [...(current.optionIds ?? []), o.id] : (current.optionIds ?? []).filter(id => id !== o.id) : [o.id] }); }} />
        <span className="min-w-0 text-sm wrap-anywhere"><span className="block whitespace-pre-wrap font-medium">{o.label}</span>{o.description && <span className="block whitespace-pre-wrap text-muted-foreground">{o.description}</span>}</span>
      </label>)}
      {q.allowText !== false && <label className="block space-y-1 text-sm"><span>{q.options?.length ? "Your own answer or additional detail" : "Your answer"}</span>
        <Textarea value={answer(q.id).text ?? ""} maxLength={4000} onChange={e => edit(q.id, { ...(draft.answers[q.id] ?? {}), text: e.target.value })} /></label>}
    </fieldset>)}
    {record.reason && <p role="status" className="text-sm wrap-anywhere">{record.reason}</p>}
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
    {record.resolution && <div role="status" className="space-y-1 border-t pt-3 text-xs text-muted-foreground"><p>Answer saved · {new Date(record.resolution.answeredAt).toLocaleString()} · Continuation: {label(record.continuation?.state ?? "pending")}{record.continuation?.reason && record.continuation.reason !== record.continuation.state ? ` · ${label(record.continuation.reason)}` : ""}</p>
      {record.continuation?.outcome && <p className="text-sm text-foreground">{record.continuation.outcome}</p>}
    </div>}
  </div>;
}
/** A closed question keeps only the saved answer in view; the offered options stay one click away. */
function ClosedAnswer({ question: q, answer }: { question: DecisionQuestionInput; answer?: DecisionAnswer }) {
  const picks = q.options?.filter(o => answer?.optionIds?.includes(o.id)) ?? [], text = answer?.text?.trim();
  const ambiguous = (o: DecisionOption) => !!o.description && !!q.options?.some(other => other.id !== o.id && other.label === o.label);
  return <div className="min-w-0">
    <dt className="whitespace-pre-wrap text-xs text-muted-foreground wrap-anywhere">{q.question}</dt>
    <dd className="mt-1 space-y-1 text-sm wrap-anywhere">
      {picks.map(o => <p key={o.id} className="whitespace-pre-wrap font-medium">{o.label}{ambiguous(o) && <span className="font-normal text-muted-foreground"> · {o.description}</span>}</p>)}
      {text && <p className="whitespace-pre-wrap">{text}</p>}
      {!picks.length && !text && <p className="text-muted-foreground">Not answered</p>}
      {q.options?.length ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer select-none">All options ({q.options.length})</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">{q.options.map(o => <li key={o.id} className={picks.includes(o) ? "whitespace-pre-wrap font-medium text-foreground" : "whitespace-pre-wrap"}>
          {o.label}{o.description ? ` — ${o.description}` : ""}{picks.includes(o) && <span className="sr-only"> (chosen)</span>}</li>)}</ul></details> : null}
    </dd>
  </div>;
}
