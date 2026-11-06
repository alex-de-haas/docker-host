"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { FeedbackCollection, FeedbackDispatch, FeedbackReport } from "@hosty-sdk/app/feedback";
import { call, ApiError } from "@/lib/api";
import { listSessions, type AssistantSession } from "@/lib/assistant-api";
import { developmentRequest, type DevelopmentWorkspace } from "@/lib/development-api";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Inbox, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { FeedbackAgentSettings, type FeedbackAgentConfig } from "./feedback-agent-settings";
import { FeedbackSelect } from "./feedback-select";
import type { BrowserAgentDefaults } from "@/lib/browser-agent-preferences";
import { feedbackWorkspace } from "../../../src/feedback/workspace";

const isBusy = (status?: string) => !!status && ["running", "awaiting_approval", "awaiting_question", "suggesting"].includes(status);
export const feedbackEligible = (report: FeedbackReport) => report.status === "unprocessed" && !report.disposition;
const label = (r: FeedbackReport) => r.comment.trim() || r.annotations[0]?.text || "Feedback";
type Review = { reports: FeedbackReport[]; repeat: boolean };
type DispatchBody = FeedbackAgentConfig & { requestId: string; reports: { id: string; revision: number }[]; sessionId: string | null; workspaceId: string | null; instruction: string };
type EditDraft = { report: FeedbackReport; comment: string; annotations: { id: string; text: string }[] };
type DetailMutation = { kind: "edit" | "delete"; reportId: string; body: string };

export function FeedbackInbox({ workspaceId, sessionId, running, disabled = false }: { workspaceId?: string; sessionId?: string; running?: boolean; disabled?: boolean }) {
  const [data, setData] = useState<FeedbackCollection>({ reports: [], dispatches: [] });
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [status, setStatus] = useState("unprocessed"), [app, setApp] = useState("");
  const [binding, setBinding] = useState("all"), [detailId, setDetailId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null), [deleting, setDeleting] = useState<FeedbackReport | null>(null);
  const [detailError, setDetailError] = useState(""), [mutationUncertain, setMutationUncertain] = useState(false), [revisionConflict, setRevisionConflict] = useState(false);
  const [review, setReview] = useState<Review | null>(null), [instruction, setInstruction] = useState("");
  const [targetWorkspace, setTargetWorkspace] = useState(workspaceId ?? ""), [targetChat, setTargetChat] = useState(sessionId ?? "");
  const [sessions, setSessions] = useState<AssistantSession[]>([]), [workspaces, setWorkspaces] = useState<DevelopmentWorkspace[]>([]);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [agentConfig, setAgentConfig] = useState<FeedbackAgentConfig>({}), [agentReady, setAgentReady] = useState(false);
  const onBrowserDefaults = useCallback((defaults: BrowserAgentDefaults | undefined) => setAgentConfig(current => ({ ...current, browserDefaults: defaults })), []);
  const pending = useRef<DispatchBody | null>(null), generation = useRef(0), directOpened = useRef(false);
  const pendingMutation = useRef<DetailMutation | null>(null);
  const inbox = useRef<HTMLElement>(null), lastOpenedReport = useRef<string | null>(null);
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
    if (!reports.length || disabled || busy || uncertain || mutationUncertain) return;
    pending.current = null; setUncertain(false); setError(""); setNotice("");
    setReview({ reports, repeat });
    if (workspaceId) { setTargetWorkspace(workspaceId); setTargetChat(sessionId ?? ""); }
    setAgentConfig({}); setAgentReady(false);
    try { await loadDestinations(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const deliver = async (body: DispatchBody) => {
    if (busy) return;
    pending.current = body; setBusy(true); setError("");
    try {
      const result: FeedbackDispatch = await (await call("/feedback/dispatches", { method: "POST", body: JSON.stringify(body) })).json();
      if (result.state === "rejected") throw new ApiError(409, "feedback_rejected", result.error ?? "This prompt was refused. Review and send again.");
      if (result.state === "unknown" || result.state === "reserved") throw new Error(result.error ?? "Delivery was not confirmed. Retry the same request.");
      pending.current = null; setUncertain(false); setReview(null); setSelected([]); setInstruction("");
      setNotice("Sent to chat. Processing is tracked against this prompt."); await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A transport failure may follow acceptance. Keep the exact UUID and payload for retry.
      const known = e instanceof ApiError && e.status < 500 && !["message_outcome_unknown", "feedback_dispatch_conflict"].includes(e.code ?? "");
      setUncertain(!known); if (known) pending.current = null;
    } finally { setBusy(false); }
  };
  const send = async () => {
    if (!review || busy) return;
    await deliver(pending.current ?? { requestId: crypto.randomUUID(), reports: review.reports.map(r => ({ id: r.id, revision: r.revision })),
      workspaceId: targetWorkspace || null, sessionId: targetChat || null, instruction, ...(!targetChat ? agentConfig : {}) });
  };
  const sendReports = async (reports: FeedbackReport[], repeat = false) => {
    if (!workspaceId) return openReview(reports, repeat);
    if (!reports.length || !sessionId || running || disabled || busy || uncertain || mutationUncertain) return;
    setError(""); setNotice("");
    await deliver({ requestId: crypto.randomUUID(), reports: reports.map(r => ({ id: r.id, revision: r.revision })),
      workspaceId, sessionId, instruction: "" });
  };
  const recover = async (attempt: FeedbackDispatch) => {
    if (disabled || busy || uncertain || mutationUncertain) return;
    setBusy(true); setError("");
    try { await call("/feedback/dispatches", { method: "POST", body: JSON.stringify(attempt.input) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const mutateDetail = async (operation: DetailMutation) => {
    if (disabled || busy || uncertain) return;
    pendingMutation.current = operation; setBusy(true); setDetailError(""); setNotice("");
    try {
      const response = await call("/feedback/" + operation.reportId + "/" + operation.kind, { method: "POST", body: operation.body });
      if (operation.kind === "edit") {
        const updated = await response.json() as FeedbackReport;
        // Older background reads cannot replace the newly accepted revision.
        generation.current++;
        setData(current => ({ ...current, reports: current.reports.some(r => r.id === updated.id) ? current.reports.map(r => r.id === updated.id ? updated : r) : [...current.reports, updated] }));
        setEditDraft(null); setNotice("Feedback updated.");
      } else {
        generation.current++;
        setData(current => ({ ...current, reports: current.reports.filter(r => r.id !== operation.reportId) }));
        setSelected(ids => ids.filter(id => id !== operation.reportId)); setDetailId(null); setDeleting(null); setNotice("Feedback deleted.");
      }
      pendingMutation.current = null; setMutationUncertain(false); setRevisionConflict(false);
      await refresh();
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
      const known = e instanceof ApiError && e.status < 500;
      setMutationUncertain(!known);
      if (known) { pendingMutation.current = null; setRevisionConflict(e.code === "feedback_revision_conflict"); }
    } finally { setBusy(false); }
  };
  const cancelDetailEdit = () => {
    setEditDraft(null); setDeleting(null); setDetailError(""); setRevisionConflict(false); pendingMutation.current = null;
  };
  const scoped = data.reports.filter(r => !workspaceId || r.workspaceId === workspaceId);
  const rows = workspaceId ? scoped : scoped.filter(r => (!app || r.context.appId === app) && (binding !== "unassigned" || !r.workspaceId)
    && (status === "all" || status === "unprocessed" ? status === "all" || feedbackEligible(r) : status === "needs-review" ? ["failed", "partial", "uncertain", "cancelled"].includes(r.status) : r.status === status));
  const selectedRows = scoped.filter(r => selected.includes(r.id) && r.status !== "pending" && !r.disposition);
  const detail = data.reports.find(r => r.id === detailId) ?? editDraft?.report ?? deleting;
  const mutationsDisabled = disabled || busy || uncertain || mutationUncertain;
  const detailMutationDisabled = mutationsDisabled || !!detail && ["pending", "uncertain"].includes(detail.status);
  const detailLocked = busy || mutationUncertain;
  const invalidAnnotations = !!editDraft?.annotations.some(n => !n.text.trim());
  const openReport = (report: FeedbackReport, action: "preview" | "edit" | "delete" = "preview") => {
    if (detailLocked || action !== "preview" && (mutationsDisabled || ["pending", "uncertain"].includes(report.status))) return;
    lastOpenedReport.current = report.id;
    setDetailId(report.id); cancelDetailEdit();
    if (action === "edit") setEditDraft({ report, comment: report.comment, annotations: report.annotations.map(n => ({ id: n.id, text: n.text })) });
    if (action === "delete") setDeleting(report);
  };
  const recoverable = data.dispatches.filter(attempt => attempt.state === "reserved"
    && scoped.some(report => attempt.input.reports.some(selection => selection.id === report.id)));
  const targetSessions = sessions.filter(session => feedbackWorkspace(session) === (targetWorkspace || null));
  const target = targetSessions.find(s => s.id === targetChat);
  const targetBusy = targetChat === sessionId && running || isBusy(target?.status);
  const canSend = !!review?.reports.length && !busy && !disabled && (!targetChat ? agentReady : !!target && !targetBusy);
  const chatStatus = !workspaceId ? null : !sessionId ? { label: "Select a chat", detail: "Select a chat in this workspace to send feedback." }
    : running ? { label: "Chat busy", detail: "This chat is busy. Wait for it to finish before sending feedback." } : null;
  const bulkActions = <>
    <Button size="sm" className={workspaceId ? "h-7 px-2 text-xs" : undefined} disabled={mutationsDisabled || !selectedRows.length || !!workspaceId && (!sessionId || !!running)} onClick={() => void sendReports(selectedRows, selectedRows.some(r => r.status !== "unprocessed"))}>Send selected ({selectedRows.length})</Button>
    <Button size="sm" variant="ghost" className={workspaceId ? "h-7 px-2 text-xs text-muted-foreground" : "text-muted-foreground"} disabled={mutationsDisabled || !scoped.some(feedbackEligible) || !!workspaceId && (!sessionId || !!running)} onClick={() => void sendReports(scoped.filter(feedbackEligible).slice(0, 50))}>Address all{scoped.filter(feedbackEligible).length > 50 ? " (first 50)" : ""}</Button>
  </>;
  if (workspaceId && !error && !detail && (!loaded || !scoped.length)) return null;
  const title = workspaceId ? <h3 className="text-xs font-semibold text-muted-foreground">Feedback {!!scoped.length && <span className="ml-1 font-mono font-normal tabular-nums">{scoped.length}</span>}</h3> : <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>;
  return <section ref={inbox} data-workspace-section={workspaceId ? "" : undefined} className={workspaceId ? "space-y-2 text-xs" : "mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6"} aria-label="Feedback">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 space-y-1">{title}
      {!workspaceId && <p className="text-sm text-muted-foreground">Review observations, select related feedback and send it to one chat.</p>}
    </div><div className="flex items-center gap-2">
      {chatStatus && <span role="status" title={chatStatus.detail} className="text-xs text-muted-foreground"><span aria-hidden>{chatStatus.label}</span><span className="sr-only">{chatStatus.detail}</span></span>}
      {workspaceId ? <Button type="button" variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" aria-label="Refresh feedback" title="Refresh feedback" disabled={busy} onClick={() => void refresh()}><RefreshCw className="size-3.5" aria-hidden /></Button>
        : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className="size-3.5" aria-hidden />Refresh</Button>}
    </div></header>
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!workspaceId && <div className="overflow-hidden rounded-xl border bg-card">
      <div className="grid min-w-0 gap-3 p-3 sm:grid-cols-3 sm:p-4">
        <div className="grid min-w-0 gap-1.5"><span className="text-xs font-medium text-muted-foreground">Status</span>
          <FeedbackSelect label="Feedback status" value={status} onValueChange={setStatus} options={[
            { value: "unprocessed", label: "Unprocessed" }, { value: "pending", label: "In progress" }, { value: "processed", label: "Processed" }, { value: "needs-review", label: "Needs review" }, { value: "all", label: "All" },
          ]} />
        </div>
        <div className="grid min-w-0 gap-1.5"><span className="text-xs font-medium text-muted-foreground">Application</span>
          <FeedbackSelect label="Feedback application" value={app} onValueChange={setApp} options={[{ value: "", label: "All applications" },
            ...[...new Map(scoped.map(report => [report.context.appId, report.context.appName])).entries()].map(([value, label]) => ({ value, label })),
          ]} />
        </div>
        <div className="grid min-w-0 gap-1.5"><span className="text-xs font-medium text-muted-foreground">Workspace</span>
          <FeedbackSelect label="Feedback workspace filter" value={binding} onValueChange={setBinding} options={[{ value: "all", label: "All workspaces" }, { value: "unassigned", label: "Unassigned" }]} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-3 py-2.5 sm:px-4">
        <p className="text-xs text-muted-foreground" aria-live="polite">{loaded ? <><span className="font-medium text-foreground tabular-nums">{rows.length}</span> {rows.length === 1 ? "report" : "reports"}{selectedRows.length > 0 && <> · <span className="text-foreground tabular-nums">{selectedRows.length} selected</span></>}</> : "Loading feedback…"}</p>
        <div className="flex flex-wrap items-center gap-1.5">{bulkActions}</div>
      </div>
    </div>}
    {workspaceId && uncertain && <div className="space-y-2"><p role="status" className="text-sm">Delivery was not confirmed. Retry sends the same request to the original chat.</p>
      <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => { if (pending.current) void deliver(pending.current); }}>Retry same request</Button></div>}
    {!!recoverable.length && <div className="space-y-2" aria-label="Unconfirmed feedback deliveries">{recoverable.map(attempt => <div key={attempt.id} className="flex flex-wrap items-center gap-2 text-sm">
      <span>Delivery to chat is not confirmed.</span><Button size="sm" variant="outline" disabled={mutationsDisabled} onClick={() => void recover(attempt)}>Recover delivery</Button>
    </div>)}</div>}
    {workspaceId && <div className="flex flex-wrap gap-1.5">{bulkActions}</div>}
    {!loaded ? <p role="status" className={workspaceId ? undefined : "rounded-xl border bg-card p-6 text-sm text-muted-foreground"}>Loading feedback…</p> : !rows.length ? <div className={workspaceId ? "text-sm text-muted-foreground" : "flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"}>
      {!workspaceId && <Inbox className="size-6" aria-hidden />}<p>No feedback matches this view.</p>
    </div> :
      <ul className={workspaceId ? "space-y-1" : "divide-y overflow-hidden rounded-xl border bg-card"}>{rows.map(report => <li key={report.id} className={workspaceId ? "flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted focus-within:bg-muted" : "flex items-start gap-3 p-3 transition-colors hover:bg-muted/40 focus-within:bg-muted/40 sm:p-4"}>
        <label className={workspaceId ? "-my-1 flex size-6 shrink-0 items-center justify-center" : "-my-1 flex size-7 shrink-0 items-center justify-center"}>
        <input type="checkbox" aria-label={"Select " + label(report)} checked={selected.includes(report.id)} disabled={report.status === "pending" || !!report.disposition || mutationsDisabled}
          onChange={e => setSelected(ids => e.target.checked ? [...ids, report.id] : ids.filter(id => id !== report.id))} className={workspaceId ? "size-3.5" : "size-4 accent-primary"} /></label>
        <button data-feedback-preview={report.id} className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-brand" title={workspaceId ? `${label(report)}\n${report.context.appName} · ${report.context.version ?? "Version unknown"} · ${new Date(report.context.observedAt).toLocaleString()}` : undefined} onClick={() => openReport(report)}>
          <span className={workspaceId ? "block truncate text-xs font-medium leading-4" : "line-clamp-2 text-sm font-medium leading-5 wrap-anywhere"}>{label(report)}</span>
          {workspaceId ? <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground"><span className="truncate">{report.context.appName}</span><span aria-hidden>·</span><span className="shrink-0">{report.annotations.length} {report.annotations.length === 1 ? "annotation" : "annotations"}</span><span className="ml-auto shrink-0">{report.disposition ?? report.status}</span></span> : <><span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="min-w-0 font-medium wrap-anywhere">{report.context.appName}</span><span>{report.context.version ?? "Version unknown"}</span><span>{report.annotations.length} {report.annotations.length === 1 ? "annotation" : "annotations"}</span><FeedbackStatus report={report} />
          </span>
          <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">{report.workspaceId ? "Workspace " + (workspaces.find(w => w.id === report.workspaceId)?.name ?? report.workspaceId.slice(0, 8)) : "Unassigned"} · <time dateTime={report.context.observedAt} title={new Date(report.context.observedAt).toLocaleString()}>{new Date(report.context.observedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span>
          </>}
        </button><FeedbackActions report={report} disabled={mutationsDisabled || detailLocked || ["pending", "uncertain"].includes(report.status)} onEdit={() => openReport(report, "edit")} onDelete={() => openReport(report, "delete")} /></li>)}</ul>}
    <Dialog open={!!detail} onOpenChange={open => { if (!open && !detailLocked) { setDetailId(null); cancelDetailEdit(); } }}><DialogContent className="sm:max-w-2xl" showCloseButton={!detailLocked}
      onCloseAutoFocus={event => { event.preventDefault(); const preview = [...(inbox.current?.querySelectorAll<HTMLButtonElement>("[data-feedback-preview]") ?? [])].find(button => button.dataset.feedbackPreview === lastOpenedReport.current); (preview ?? inbox.current?.querySelector<HTMLButtonElement>("button"))?.focus(); }}
      onEscapeKeyDown={e => { if (detailLocked) e.preventDefault(); }} onPointerDownOutside={e => { if (detailLocked) e.preventDefault(); }}>
      <DialogHeader><div className="flex items-center justify-between gap-2"><DialogTitle>{deleting ? "Delete feedback?" : editDraft ? "Edit feedback" : "Feedback details"}</DialogTitle>
        {detail && !editDraft && !deleting && <FeedbackActions report={detail} disabled={detailMutationDisabled} onEdit={() => openReport(detail, "edit")} onDelete={() => openReport(detail, "delete")} />}</div>
        <DialogDescription>{detail?.context.appName} · {detail?.context.version ?? "Version unknown"}{detail && <> · <time dateTime={detail.context.observedAt}>{new Date(detail.context.observedAt).toLocaleString()}</time></>}</DialogDescription></DialogHeader>
      <DialogBody>
      {detail && (deleting ? <><p className="whitespace-pre-wrap text-sm">{label(deleting)}</p><p className="text-sm">This permanently deletes this report, all annotations and its screenshots. This cannot be undone.</p><p className="text-sm text-muted-foreground">Feedback already sent to chat remains in that conversation.</p></> : <>
        {editDraft ? <label className="grid gap-1 text-sm">Overall comment<Textarea autoFocus aria-label="Overall comment" maxLength={5000} value={editDraft.comment} disabled={detailMutationDisabled} onChange={e => setEditDraft(current => current && { ...current, comment: e.target.value })} /></label>
          : <p className="whitespace-pre-wrap text-sm">{detail.comment}</p>}
        {editDraft && <p className="text-sm text-muted-foreground">Saving marks this report unprocessed so its updated text can be handled again. Earlier processing history is retained.</p>}
        <p className="text-xs text-muted-foreground">Observed in {detail.context.workspaceId ? "workspace " + detail.context.workspaceId.slice(0, 8) : detail.context.executionKind} · {detail.context.sourceRevision?.slice(0, 12) ?? "Source revision unknown"}. This observation is retained when reassigned.</p>
        <ol className="space-y-4">{detail.annotations.map((note, i) => <li key={note.id} className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">{i + 1}. {note.target?.label ?? note.target?.kind ?? "Page"} · {note.route}</p>
          {editDraft ? <label className="mt-2 grid gap-1 text-sm">Annotation {i + 1}<Textarea aria-label={"Annotation " + (i + 1)} required maxLength={2000} value={editDraft.annotations.find(n => n.id === note.id)?.text ?? ""} disabled={detailMutationDisabled}
            onChange={e => setEditDraft(current => current && { ...current, annotations: current.annotations.map(n => n.id === note.id ? { ...n, text: e.target.value } : n) })} /></label> : <p className="whitespace-pre-wrap text-sm">{note.text}</p>}
          {note.mediaType && <FeedbackImage reportId={detail.id} noteId={note.id} />}</li>)}</ol>
        {!editDraft && <><p className="text-sm"><span className="text-muted-foreground">Current workspace: </span>{detail.workspaceId ? workspaces.find(w => w.id === detail.workspaceId)?.name ?? detail.workspaceId.slice(0, 8) : "Unassigned"}</p>
        <details><summary className="cursor-pointer text-sm font-medium">Processing history</summary><ul className="mt-2 space-y-3">{data.dispatches.filter(d => d.input.reports.some(r => r.id === detail.id)).map(d => <li key={d.id} className="rounded border p-2 text-sm">
          <a className="underline" href={"/chats?session=" + encodeURIComponent(d.input.sessionId)}>Open chat</a> · Prompt {d.messageSequence ?? "not confirmed"} · {d.state}
          <p>{d.outcomes?.find(o => o.reportId === detail.id)?.summary ?? d.error}</p><p className="whitespace-pre-wrap text-xs">{d.input.instruction}</p>
        </li>)}</ul></details></>}
      </>)}
      {detailError && <p role="alert" className="text-sm text-destructive-foreground">{detailError}</p>}
      {invalidAnnotations && <p className="text-sm text-destructive-foreground">Each annotation needs a comment.</p>}
      {revisionConflict && <p className="text-sm">Cancel and refresh feedback before reviewing the latest version.</p>}
      {mutationUncertain && <p role="status" className="text-sm">The change was not confirmed. Retry uses the same request.</p>}
      </DialogBody>
      {(editDraft || deleting) && <DialogFooter><Button variant="outline" disabled={detailLocked} onClick={cancelDetailEdit}>Cancel</Button>
        {mutationUncertain ? <Button disabled={busy || disabled} onClick={() => { if (pendingMutation.current) void mutateDetail(pendingMutation.current); }}>Retry same request</Button>
          : deleting ? <Button variant="destructive" disabled={detailMutationDisabled || revisionConflict} onClick={() => void mutateDetail({ kind: "delete", reportId: deleting.id,
            body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: deleting.revision }) })}>{busy ? "Deleting…" : "Delete feedback"}</Button>
          : editDraft && <Button disabled={detailMutationDisabled || revisionConflict || invalidAnnotations} onClick={() => void mutateDetail({ kind: "edit", reportId: editDraft.report.id,
            body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: editDraft.report.revision, comment: editDraft.comment, annotations: editDraft.annotations }) })}>{busy ? "Saving…" : "Save changes"}</Button>}
      </DialogFooter>}
    </DialogContent></Dialog>
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy && !uncertain) setReview(null); }}><DialogContent className="sm:max-w-xl" showCloseButton={!busy && !uncertain} onEscapeKeyDown={e => { if (uncertain || busy) e.preventDefault(); }} onPointerDownOutside={e => { if (uncertain || busy) e.preventDefault(); }}>
      <DialogHeader><DialogTitle>{review?.repeat ? "Send feedback again" : "Send feedback to chat"}</DialogTitle><DialogDescription>One prompt will contain {review?.reports.length ?? 0} complete reports. Review the destination and add any instructions.</DialogDescription></DialogHeader>
      <DialogBody>
      <ul className="max-h-40 min-w-0 list-inside list-decimal overflow-y-auto text-sm wrap-anywhere">{review?.reports.map(r => <li key={r.id}>{label(r)} · {r.annotations.length} annotations · {r.status}</li>)}</ul>
      <label className="grid min-w-0 gap-1 text-sm">Workspace<FeedbackSelect label="Workspace" value={targetWorkspace} disabled={busy || uncertain} onValueChange={value => { setTargetWorkspace(value); setTargetChat(""); if (targetChat) setAgentReady(false); }} options={[
        { value: "", label: "New workspace through a new chat" }, ...workspaces.map(workspace => ({ value: workspace.id, label: workspace.name ?? workspace.owner.label ?? workspace.id.slice(0, 8) })),
      ]} /></label>
      <label className="grid min-w-0 gap-1 text-sm">Chat<FeedbackSelect label="Chat" value={targetChat} disabled={busy || uncertain} onValueChange={value => { setTargetChat(value); if (!value) setAgentReady(false); }} options={[
        { value: "", label: "New chat" }, ...targetSessions.map(session => ({ value: session.id, label: (session.title ?? "Untitled chat") + (isBusy(session.status) ? " · busy" : "") })),
      ]} /></label>
      {!targetChat ? <FeedbackAgentSettings value={agentConfig} onChange={setAgentConfig} onReadyChange={setAgentReady} onDefaultsChange={onBrowserDefaults} disabled={busy || uncertain} />
        : <p className="text-sm text-muted-foreground">Uses this chat’s current agent, reasoning and autonomy settings.</p>}
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
      {!uncertain && !!targetChat && !target && <p role="status" className="text-sm">The selected chat is no longer available in this workspace. Refresh chats or choose another chat.</p>}
      {uncertain && <p role="status" className="text-sm">Delivery was not confirmed. Retry uses the same request and cannot create a second prompt.</p>}
      {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
      </DialogBody>
      <DialogFooter><Button variant="outline" disabled={busy || uncertain} onClick={() => setReview(null)}>Cancel</Button><Button disabled={!canSend && !uncertain || busy} onClick={() => void send()}>{busy ? "Sending…" : uncertain ? "Retry same request" : "Send to chat"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}

function FeedbackStatus({ report }: { report: FeedbackReport }) {
  const state = report.disposition ?? report.status;
  const labels: Record<string, string> = { unprocessed: "Unprocessed", pending: "In progress", processed: "Processed", partial: "Partial", failed: "Failed", cancelled: "Cancelled", uncertain: "Delivery unknown", dismissed: "Dismissed", duplicate: "Duplicate" };
  const tone = state === "processed" ? "text-success-foreground" : state === "failed" ? "text-destructive-foreground"
    : ["partial", "uncertain"].includes(state) ? "text-warning-foreground" : state === "pending" ? "text-info-foreground" : "text-muted-foreground";
  return <Badge variant="outline" className={`gap-1.5 px-1.5 py-0 font-normal ${tone}`}><span className="size-1.5 rounded-full bg-current" aria-hidden />{labels[state] ?? state}</Badge>;
}

function FeedbackActions({ report, disabled, onEdit, onDelete }: { report: FeedbackReport; disabled: boolean; onEdit: () => void; onDelete: () => void }) {
  const openingDialog = useRef(false);
  return <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0 text-muted-foreground" aria-label={`Feedback actions for ${label(report)}`} disabled={disabled}><MoreHorizontal className="size-3.5" aria-hidden /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (openingDialog.current) { event.preventDefault(); openingDialog.current = false; } }}>
      <DropdownMenuItem disabled={disabled} onSelect={() => { openingDialog.current = true; onEdit(); }}><Pencil aria-hidden />Edit</DropdownMenuItem>
      <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={() => { openingDialog.current = true; onDelete(); }}><Trash2 aria-hidden />Delete</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
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
