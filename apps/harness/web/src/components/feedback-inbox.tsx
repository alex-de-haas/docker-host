"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { FeedbackCollection, FeedbackDispatch, FeedbackReport } from "@hosty-sdk/app/feedback";
import { call, ApiError } from "@/lib/api";
import { listSessions, type AssistantSession } from "@/lib/assistant-api";
import { developmentRequest, type DevelopmentWorkspace } from "@/lib/development-api";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";

const selectClass = "rounded-md border bg-background px-2 py-2 text-sm";
const isBusy = (status?: string) => !!status && ["running", "awaiting_approval", "awaiting_question", "suggesting"].includes(status);
export const feedbackEligible = (report: FeedbackReport) => report.status === "unprocessed" && !report.disposition;
const label = (r: FeedbackReport) => r.comment.trim() || r.annotations[0]?.text || "Feedback";
type Review = { reports: FeedbackReport[]; repeat: boolean };
type DispatchBody = { requestId: string; reports: { id: string; revision: number }[]; sessionId: string | null; workspaceId: string | null; instruction: string };

export function FeedbackInbox({ workspaceId, sessionId, running, disabled = false }: { workspaceId?: string; sessionId?: string; running?: boolean; disabled?: boolean }) {
  const [data, setData] = useState<FeedbackCollection>({ reports: [], dispatches: [] });
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [status, setStatus] = useState("unprocessed"), [app, setApp] = useState("");
  const [binding, setBinding] = useState("all"), [detailId, setDetailId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null), [instruction, setInstruction] = useState("");
  const [targetWorkspace, setTargetWorkspace] = useState(workspaceId ?? ""), [targetChat, setTargetChat] = useState(sessionId ?? "");
  const [sessions, setSessions] = useState<AssistantSession[]>([]), [workspaces, setWorkspaces] = useState<DevelopmentWorkspace[]>([]);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const pending = useRef<DispatchBody | null>(null), generation = useRef(0), directOpened = useRef(false);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    return call("/feedback").then(response => response.json() as Promise<FeedbackCollection>).then(result => {
      if (current === generation.current) { setData(result); setLoaded(true); setError(""); }
    }).catch(e => { if (current === generation.current) { setError(e instanceof Error ? e.message : String(e)); setLoaded(true); } });
  }, []);
  const refreshOnEntry = useEffectEvent(() => refresh());
  useEffect(() => {
    void refreshOnEntry(); const focus = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    const requests = generation;
    return () => { requests.current++; window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [refresh, workspaceId, running]);
  const loadDestinations = async () => {
    const [chats, inventory] = await Promise.all([listSessions(), developmentRequest<{ workspaces: DevelopmentWorkspace[] }>()]);
    setSessions(chats); setWorkspaces(inventory.workspaces.filter(w => !["deleting", "deleted"].includes(w.workflow.state)));
  };
  useEffect(() => {
    if (workspaceId || directOpened.current || !loaded) return;
    const reportId = new URL(window.location.href).searchParams.get("feedback");
    const report = data.reports.find(r => r.id === reportId); if (!report) return;
    directOpened.current = true;
    void Promise.all([listSessions(), developmentRequest<{ workspaces: DevelopmentWorkspace[] }>()]).then(([chats, inventory]) => {
      setSessions(chats); setWorkspaces(inventory.workspaces); setTargetWorkspace(report.workspaceId ?? ""); setTargetChat("");
      setReview({ reports: [report], repeat: report.status !== "unprocessed" });
    }).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [workspaceId, loaded, data.reports]);
  const openReview = async (reports: FeedbackReport[], repeat = false) => {
    if (!reports.length || disabled || busy) return;
    pending.current = null; setUncertain(false); setError(""); setNotice("");
    setReview({ reports, repeat }); setTargetWorkspace(workspaceId ?? ""); setTargetChat(sessionId ?? "");
    try { await loadDestinations(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const send = async () => {
    if (!review || busy) return;
    const body = pending.current ?? { requestId: crypto.randomUUID(), reports: review.reports.map(r => ({ id: r.id, revision: r.revision })),
      workspaceId: targetWorkspace || null, sessionId: targetChat || null, instruction };
    pending.current = body; setBusy(true); setError("");
    try {
      const result: FeedbackDispatch = await (await call("/feedback/dispatches", { method: "POST", body: JSON.stringify(body) })).json();
      if (result.state === "rejected") throw new ApiError(409, "feedback_rejected", result.error ?? "This prompt was refused. Review and send again.");
      pending.current = null; setUncertain(false); setReview(null); setSelected([]); setInstruction("");
      setNotice("Sent to chat. Processing is tracked against this prompt."); await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A transport failure may follow acceptance. Keep the exact UUID and payload for retry.
      const known = e instanceof ApiError && e.status < 500 && !["message_outcome_unknown", "feedback_dispatch_conflict"].includes(e.code ?? "");
      setUncertain(!known); if (known) pending.current = null;
    } finally { setBusy(false); }
  };
  const recover = async (attempt: FeedbackDispatch) => {
    setBusy(true); setError("");
    try { await call("/feedback/dispatches", { method: "POST", body: JSON.stringify(attempt.input) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const change = async (report: FeedbackReport, nextWorkspace: string | null, disposition = report.disposition) => {
    setBusy(true); setError("");
    try { await call("/feedback/" + report.id, { method: "POST", body: JSON.stringify({ expectedRevision: report.revision, workspaceId: nextWorkspace, disposition }) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const scoped = data.reports.filter(r => !workspaceId || r.workspaceId === workspaceId);
  const rows = scoped.filter(r => (!app || r.context.appId === app) && (binding !== "unassigned" || !r.workspaceId)
    && (status === "all" || status === "unprocessed" ? status === "all" || feedbackEligible(r) : status === "needs-review" ? ["failed", "partial", "uncertain", "cancelled"].includes(r.status) : r.status === status));
  const selectedRows = scoped.filter(r => selected.includes(r.id) && r.status !== "pending" && !r.disposition);
  const detail = data.reports.find(r => r.id === detailId);
  const target = sessions.find(s => s.id === targetChat);
  const targetBusy = targetChat === sessionId && running || isBusy(target?.status);
  const canSend = !!review?.reports.length && !busy && !disabled && (!targetChat || !!target && !targetBusy);
  const title = workspaceId ? <h3 className="text-sm font-semibold">Feedback</h3> : <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>;
  return <section className={workspaceId ? "space-y-3 border-t pt-4" : "mx-auto max-w-5xl space-y-5 p-6"} aria-label="Feedback">
    <header className="flex flex-wrap items-center justify-between gap-2">{title}<Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button></header>
    {!workspaceId && <p className="text-sm text-muted-foreground">Review observations, select related feedback and send it to one chat.</p>}
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <select aria-label="Feedback status" className={selectClass} value={status} onChange={e => setStatus(e.target.value)}>
        <option value="unprocessed">Unprocessed</option><option value="pending">In progress</option><option value="processed">Processed</option><option value="needs-review">Needs review</option><option value="all">All</option>
      </select>
      {!workspaceId && <><select aria-label="Feedback application" className={selectClass} value={app} onChange={e => setApp(e.target.value)}><option value="">All applications</option>
        {[...new Map(scoped.map(r => [r.context.appId, r.context.appName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select aria-label="Feedback workspace filter" className={selectClass} value={binding} onChange={e => setBinding(e.target.value)}><option value="all">All workspaces</option><option value="unassigned">Unassigned</option></select></>}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled || busy || !selectedRows.length} onClick={() => void openReview(selectedRows, selectedRows.some(r => r.status !== "unprocessed"))}>Send selected ({selectedRows.length})</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy || !scoped.some(feedbackEligible)} onClick={() => void openReview(scoped.filter(feedbackEligible).slice(0, 50))}>Address all{scoped.filter(feedbackEligible).length > 50 ? " (first 50)" : ""}</Button>
    </div>
    {!loaded ? <p role="status">Loading feedback…</p> : !rows.length ? <p className="text-sm text-muted-foreground">No feedback matches this view.</p> :
      <ul className="divide-y rounded-md border">{rows.map(report => <li key={report.id} className="flex items-start gap-3 p-3">
        <input type="checkbox" aria-label={"Select " + label(report)} checked={selected.includes(report.id)} disabled={report.status === "pending" || !!report.disposition || busy}
          onChange={e => setSelected(ids => e.target.checked ? [...ids, report.id] : ids.filter(id => id !== report.id))} className="mt-1" />
        <button className="min-w-0 flex-1 text-left" onClick={() => { setDetailId(report.id); void loadDestinations().catch(() => undefined); }}>
          <span className="block truncate text-sm font-medium">{label(report)}</span>
          <span className="block text-xs text-muted-foreground">{report.context.appName} · {report.context.version ?? "Version unknown"} · {report.annotations.length} annotations · {report.disposition ?? report.status}</span>
          <span className="block text-xs text-muted-foreground">{report.workspaceId ? "Workspace " + (workspaces.find(w => w.id === report.workspaceId)?.name ?? report.workspaceId.slice(0, 8)) : "Unassigned"} · {new Date(report.context.observedAt).toLocaleString()}</span>
        </button></li>)}</ul>}
    <Dialog open={!!detail} onOpenChange={open => { if (!open) setDetailId(null); }}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Feedback details</DialogTitle><DialogDescription>{detail?.context.appName} · {detail?.context.version ?? "Version unknown"}</DialogDescription></DialogHeader>
      {detail && <><p className="whitespace-pre-wrap text-sm">{detail.comment}</p><p className="text-xs text-muted-foreground">Observed in {detail.context.workspaceId ? "workspace " + detail.context.workspaceId.slice(0, 8) : detail.context.executionKind} · {detail.context.sourceRevision?.slice(0, 12) ?? "Source revision unknown"}. This observation is retained when reassigned.</p>
        <ol className="space-y-4">{detail.annotations.map((note, i) => <li key={note.id} className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">{i + 1}. {note.target?.label ?? note.target?.kind ?? "Page"} · {note.route}</p><p className="whitespace-pre-wrap text-sm">{note.text}</p>
          {note.mediaType && <FeedbackImage reportId={detail.id} noteId={note.id} />}</li>)}</ol>
        <label className="grid gap-1 text-sm">Current workspace<select aria-label="Current workspace" className={selectClass} value={detail.workspaceId ?? ""} disabled={busy || ["pending", "uncertain"].includes(detail.status)} onChange={e => void change(detail, e.target.value || null)}>
          <option value="">Unassigned</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name ?? w.owner.label ?? w.id.slice(0, 8)}</option>)}</select></label>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || detail.status === "pending" || !!detail.disposition} onClick={() => { setDetailId(null); void openReview([detail], detail.status !== "unprocessed"); }}>{detail.status === "unprocessed" ? "Send to chat" : "Send again"}</Button>
          <Button variant="outline" disabled={busy || ["pending", "uncertain"].includes(detail.status)} onClick={() => void change(detail, detail.workspaceId, detail.disposition ? null : "dismissed")}>{detail.disposition ? "Restore" : "Dismiss"}</Button>
          {!detail.disposition && <Button variant="outline" disabled={busy || ["pending", "uncertain"].includes(detail.status)} onClick={() => void change(detail, detail.workspaceId, "duplicate")}>Mark duplicate</Button>}</div>
        <details><summary className="cursor-pointer text-sm font-medium">Processing history</summary><ul className="mt-2 space-y-3">{data.dispatches.filter(d => d.input.reports.some(r => r.id === detail.id)).map(d => <li key={d.id} className="rounded border p-2 text-sm">
          <a className="underline" href={"/chats?session=" + encodeURIComponent(d.input.sessionId)}>Open chat</a> · Prompt {d.messageSequence ?? "not confirmed"} · {d.state}
          <p>{d.outcomes?.find(o => o.reportId === detail.id)?.summary ?? d.error}</p><p className="whitespace-pre-wrap text-xs">{d.input.instruction}</p>
          {d.state === "reserved" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void recover(d)}>Recover delivery</Button>}
        </li>)}</ul></details></>}
    </DialogContent></Dialog>
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy && !uncertain) setReview(null); }}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl" onEscapeKeyDown={e => { if (uncertain || busy) e.preventDefault(); }} onPointerDownOutside={e => { if (uncertain || busy) e.preventDefault(); }}>
      <DialogHeader><DialogTitle>{review?.repeat ? "Send feedback again" : "Send feedback to chat"}</DialogTitle><DialogDescription>One prompt will contain {review?.reports.length ?? 0} complete reports. Review the destination and add any instructions.</DialogDescription></DialogHeader>
      <ul className="max-h-40 list-inside list-decimal overflow-auto text-sm">{review?.reports.map(r => <li key={r.id}>{label(r)} · {r.annotations.length} annotations · {r.status}</li>)}</ul>
      <label className="grid gap-1 text-sm">Workspace<select aria-label="Workspace" className={selectClass} value={targetWorkspace} disabled={busy || uncertain} onChange={e => { setTargetWorkspace(e.target.value); setTargetChat(""); }}>
        <option value="">New workspace through a new chat</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name ?? w.owner.label ?? w.id.slice(0, 8)}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Chat<select aria-label="Chat" className={selectClass} value={targetChat} disabled={busy || uncertain} onChange={e => setTargetChat(e.target.value)}><option value="">New chat · default agent</option>
        {sessions.filter(s => (s.workspaceAssociation?.id ?? "") === targetWorkspace).map(s => <option key={s.id} value={s.id}>{s.title ?? "Untitled chat"}{isBusy(s.status) ? " · busy" : ""}</option>)}</select></label>
      <Button variant="outline" size="sm" disabled={busy || uncertain} onClick={() => {
        void call("/feedback").then(response => response.json() as Promise<FeedbackCollection>).then(fresh => {
          setData(fresh); setReview(previous => previous && { ...previous, reports: previous.reports.flatMap(old => {
            const current = fresh.reports.find(r => r.id === old.id);
            return current && !current.disposition && (previous.repeat ? current.status !== "pending" : feedbackEligible(current)) ? [current] : [];
          }) }); setError("");
        }).catch(e => setError(e.message));
      }}>Refresh selected reports</Button>
      <Button variant="outline" size="sm" disabled={busy || uncertain} onClick={() => void loadDestinations().catch(e => setError(e.message))}>Refresh chats</Button>
      <label className="grid gap-1 text-sm">Additional instructions<Textarea aria-label="Additional instructions" value={instruction} maxLength={5000} disabled={busy || uncertain} onChange={e => setInstruction(e.target.value)} placeholder="What should the agent take into account?" /></label>
      {review?.reports.some(r => r.workspaceId && r.workspaceId !== targetWorkspace) && <p className="text-sm">Sending reassigns these reports to the destination workspace. Their original observation and processing history remain.</p>}
      {targetBusy && <p role="status" className="text-sm">This chat is busy. Wait for it to finish or choose another chat.</p>}
      {uncertain && <p role="status" className="text-sm">Delivery was not confirmed. Retry uses the same request and cannot create a second prompt.</p>}
      {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy || uncertain} onClick={() => setReview(null)}>Cancel</Button><Button disabled={!canSend && !uncertain || busy} onClick={() => void send()}>{busy ? "Sending…" : uncertain ? "Retry same request" : "Send to chat"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}

function FeedbackImage({ reportId, noteId }: { reportId: string; noteId: string }) {
  const [src, setSrc] = useState(""), [error, setError] = useState("");
  useEffect(() => { const abort = new AbortController(); let url = "";
    void call("/feedback/" + reportId + "/images/" + noteId, { signal: abort.signal }).then(r => r.blob()).then(blob => {
      if (!abort.signal.aborted) { url = URL.createObjectURL(blob); setSrc(url); }
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [reportId, noteId]);
  // Private Blob URLs are fetched with app identity and cannot use the public image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return error ? <p role="status">{error}</p> : src ? <img src={src} alt="User-approved screenshot for this annotation" className="mt-2 max-h-80 max-w-full rounded border object-contain" /> : <p className="text-xs">Loading screenshot…</p>;
}
