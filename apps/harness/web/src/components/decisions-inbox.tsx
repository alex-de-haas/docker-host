"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { DecisionRecord } from "@hosty-sdk/app/decisions";
import { taskReferenceKey } from "@hosty-sdk/app/tasks";
import type { TaskAction, TaskPage, TaskRecord } from "@hosty-sdk/app/tasks";
import { permissionNotice, requestPermissionReview, type PermissionNoticeState } from "@hosty-sdk/app/permissions";
import { call, ApiError } from "@/lib/api";
import { listDecisions, subscribeDecisionUpdates, type DecisionProjection } from "@/lib/decisions";
import { resolveApproval } from "@/lib/assistant-api";
import { DecisionQuestion } from "./decision-question";
import { ApprovalCard } from "./transcript";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";

type Item = { id: string; kind: "question" | "permission" | "confirmation" | "review" | "recovery" | "task_mode"; title: string; createdAt: string;
  sessionId?: string; taskId?: string; question?: DecisionRecord; projection?: DecisionProjection; task?: TaskRecord; permission?: PermissionNoticeState };
const types = { task_mode: "Autonomous task execution", question: "Agent questions", permission: "Tool permissions", confirmation: "Core confirmations", review: "Task reviews", recovery: "Execution recovery" };
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
export function DecisionsInbox() {
  const [items, setItems] = useState<Item[]>([]), [history, setHistory] = useState(false), [kind, setKind] = useState("");
  const [selected, setSelected] = useState<string | null>(null), [session, setSession] = useState(""), [task, setTask] = useState(""), [search, setSearch] = useState("");
  const [errors, setErrors] = useState<string[]>([]), [loaded, setLoaded] = useState(false), [pending, setPending] = useState<number | null>(null);
  const generation = useRef(0), openedLink = useRef(false);
  const refresh = useCallback(async () => {
    const own = ++generation.current;
    const tasks = async () => {
      const identity: { status: string; userId?: string } = await (await call("/auth/identity")).json();
      if (identity.status !== "active" || !identity.userId) throw new Error("Task review identity is unavailable.");
      let cursor: string | null = null; const rows: TaskRecord[] = [];
      do {
        const page: TaskPage = await (await call(`/tasks/v1/tasks?status=Blocked&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
        rows.push(...page.tasks.filter(t => t.owner.userId === identity.userId && t.blocked?.reason === "needs_review" && !t.cancelRequested)); cursor = page.nextCursor;
      } while (cursor);
      return rows;
    };
    const [questions, sources, reviews, permissions] = await Promise.allSettled([
      listDecisions(history),
      call("/decisions/projections").then(r => r.json() as Promise<{ items: DecisionProjection[]; warnings: string[] }>),
      tasks(), call("/hosty/permissions").then(r => r.json() as Promise<PermissionNoticeState>),
    ]);
    if (own !== generation.current) return;
    const next: Item[] = [], warnings: string[] = [];
    const unavailable = (name: string, reason: unknown) => warnings.push(`${name} unavailable: ${reason instanceof Error ? reason.message : "refresh this source."}`);
    if (questions.status === "fulfilled") for (const question of questions.value.items) next.push({ id: `question:${question.id}`, kind: "question", title: question.input?.title ?? "Decision content removed", createdAt: question.createdAt,
      sessionId: question.input?.subject?.kind === "conversation" ? question.input.subject.id : undefined, taskId: question.input?.task?.id, question });
    else unavailable("Shared questions", questions.reason);
    if (sources.status === "fulfilled") {
      warnings.push(...sources.value.warnings);
      if (!history) for (const projection of sources.value.items) next.push({ ...projection, projection });
    } else unavailable("Chat permissions and recovery", sources.reason);
    if (reviews.status === "fulfilled") {
      if (!history) for (const task of reviews.value) next.push({ id: `review:${task.ref.appId}:${task.ref.installationId}:${task.ref.key}:${task.ref.id}`, kind: "review", title: task.title, taskId: taskReferenceKey(task.ref), createdAt: task.updatedAt, task });
    } else unavailable("Task reviews", reviews.reason);
    if (permissions.status === "fulfilled") {
      const state = permissions.value;
      if (!history && permissionNotice(state)) next.push({ id: `confirmation:${state.appId}`, kind: "confirmation", title: "Review Harness access in Core", createdAt: "", permission: state });
    } else unavailable("Core confirmations", permissions.reason);
    next.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    setItems(next); setErrors(warnings); setLoaded(true);
    if (!openedLink.current) {
      openedLink.current = true;
      const id = new URL(window.location.href).searchParams.get("decision");
      if (id && /^[a-f0-9-]{36}$/.test(id)) setSelected(`question:${id}`);
    }
    setPending(warnings.length ? null : history ? questions.status === "fulfilled" ? questions.value.pendingCount + (sources.status === "fulfilled" ? sources.value.items.length : 0) + (reviews.status === "fulfilled" ? reviews.value.length : 0) + (permissions.status === "fulfilled" && permissionNotice(permissions.value) ? 1 : 0) : null : next.length);
  }, [history]);
  useEffect(() => {
    const requests = generation;
    const stop = subscribeDecisionUpdates(refresh, () => setErrors(current => current.includes("Live updates unavailable. Refresh to check current state.") ? current : [...current, "Live updates unavailable. Refresh to check current state."]));
    return () => { requests.current++; stop(); };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = async () => {
      try {
        const response = await appFetch("/api/tasks/v1/events", { credentials: "include", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("Task review updates unavailable.");
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          if (buffer.length > 64000) throw new Error("Task updates need reconnecting.");
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            if (/event: (changed|stream.ready)/.test(frame)) void refresh();
          }
        }
      } catch { /* Read current task state when reconnecting; source failure stays visible in refresh. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); void stream(); }, 5000);
    };
    void stream(); return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  const filtered = items.filter(item => (!kind || item.kind === kind) && (!session || item.sessionId === session) && (!task || item.taskId === task) && (!search || item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const chosen = items.find(item => item.id === selected);
  const sessions = [...new Set(items.flatMap(item => item.sessionId ? [item.sessionId] : []))];
  const tasks = [...new Set(items.flatMap(item => item.taskId ? [item.taskId] : []))];
  return <main className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">Decisions <span className="ml-1 rounded-full bg-muted px-2 py-1 text-sm" aria-label={pending === null ? "Pending count unavailable" : `${pending} pending`}>{pending ?? "—"}</span></h1><p className="mt-1 text-sm text-muted-foreground">Questions and actions that need your attention.</p></div><Button variant="outline" onClick={() => void refresh()}>Refresh</Button></header>
    {errors.length > 0 && <div role="alert" className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm">{errors.map(error => <p key={error}>{error}</p>)}</div>}
    <div className="flex flex-wrap gap-2" aria-label="Decision views"><Button variant={history ? "outline" : "default"} aria-pressed={!history} onClick={() => setHistory(false)}>Needs attention</Button><Button variant={history ? "default" : "outline"} aria-pressed={history} onClick={() => setHistory(true)}>History</Button></div>
    <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <aside className="space-y-3"><Input aria-label="Search decisions" placeholder="Search decisions…" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="block space-y-1 text-sm"><span>Type</span><select className={selectClass} value={kind} onChange={e => setKind(e.target.value)}><option value="">All types</option>{Object.entries(types).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-2"><label className="block space-y-1 text-sm"><span>Chat</span><select className={selectClass} value={session} onChange={e => setSession(e.target.value)}><option value="">All chats</option>{sessions.map(id => <option key={id} value={id}>{items.find(i => i.sessionId === id)?.title ?? id}</option>)}</select></label>
        <label className="block space-y-1 text-sm"><span>Task</span><select className={selectClass} value={task} onChange={e => setTask(e.target.value)}><option value="">All tasks</option>{tasks.map(id => <option key={id} value={id}>{items.find(i => i.taskId === id)?.title ?? id}</option>)}</select></label></div>
        <nav aria-label="Decisions" className="space-y-1">{filtered.map(item => <button type="button" key={item.id} className={`w-full rounded-lg border p-3 text-left hover:bg-muted ${selected === item.id ? "border-primary bg-muted" : "border-transparent"}`} aria-current={selected === item.id ? "page" : undefined} onClick={() => setSelected(item.id)}>
          <span className="text-xs text-muted-foreground">{types[item.kind]}</span><span className="block break-words text-sm font-medium">{item.title}</span>{item.createdAt && <time className="text-xs text-muted-foreground" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>}
        </button>)}</nav>
        {loaded && !filtered.length && <p role="status" className="p-3 text-sm text-muted-foreground">{errors.length ? "Some sources could not be checked." : history ? "No decision history matches these filters." : "No decisions need your attention."}</p>}
      </aside>
      <section className="min-w-0">{chosen ? <DecisionDetail key={chosen.id} item={chosen} refresh={refresh} /> : selected?.startsWith("question:") ? <DecisionQuestion decisionId={selected.slice(9)} onChanged={() => void refresh()} /> : <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">Select a decision to review its details and available actions.</div>}</section>
    </div>
  </main>;
}
function DecisionDetail({ item, refresh }: { item: Item; refresh: () => Promise<void> }) {
  if (item.question) return <DecisionQuestion decisionId={item.question.id} onChanged={() => void refresh()} />;
  if (item.task) return <TaskReview task={item.task} refresh={refresh} />;
  if (item.permission) return <section className="space-y-4 rounded-lg border p-4"><h2 className="font-semibold">{item.title}</h2><p className="text-sm">Core owns this confirmation. Review the exact requested access there.</p><Button disabled={permissionNotice(item.permission) !== "missing" || item.permission.permissions?.reviewAvailable === false} onClick={() => requestPermissionReview(item.permission!)}>Review access in Core</Button>{permissionNotice(item.permission) === "unsupported" && <p role="status" className="text-sm">This Core does not support a required permission. Update compatibility before reviewing.</p>}</section>;
  const projection = item.projection!;
  if (projection.kind === "task_mode") return <TaskModeProposal proposal={projection} refresh={refresh} />;
  return <div className="space-y-3">{projection.kind === "permission" && projection.event ? <ApprovalCard approvalId={String(projection.event.approvalId)} toolName={String(projection.event.toolName ?? "Action")} input={projection.event.input}
    title={typeof projection.event.title === "string" ? projection.event.title : null} reason={typeof projection.event.reason === "string" ? projection.event.reason : null}
    decision={projection.available ? null : { decision: "cancelled", message: projection.error ?? "The native request is unavailable." }} reasonBox
    onDecide={async (id, decision, message) => { await resolveApproval(projection.sessionId, id, decision, message); await refresh(); }} />
    : <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">{projection.title}</h2><p className="text-sm">{projection.error}</p><p className="text-sm text-muted-foreground">Recovery uses the original chat’s supported controls. An unknown stop must be reconciled there.</p></section>}
    <a className="text-sm text-primary underline" href={`/development?session=${encodeURIComponent(projection.sessionId)}`}>Open originating chat</a>
  </div>;
}
function TaskReview({ task, refresh }: { task: TaskRecord; refresh: () => Promise<void> }) {
  const [feedback, setFeedback] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(task.revision), [request, setRequest] = useState<TaskAction | null>(null);
  const send = async (action?: "accept" | "request_changes") => {
    const input = request ?? { requestId: crypto.randomUUID(), expectedRevision: reviewed, resultRef: task.resultRef, action: action!, ...(action === "request_changes" ? { feedback } : {}) };
    setRequest(input); setBusy(true); setError("");
    try {
      await call(`/tasks/v1/tasks/${encodeURIComponent(task.ref.id)}/actions`, { method: "POST", body: JSON.stringify(input) });
      setRequest(null); await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) { setRequest(null); await refresh(); }
      setError(error instanceof Error ? error.message : "Review outcome could not be confirmed.");
    } finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-lg border p-4"><h2 className="font-semibold">{task.title}</h2><p className="text-xs text-muted-foreground">Task {task.number} · Revision {task.revision} · Result for input {task.resultRef?.inputRevision}</p>
    <Markdown text={task.result?.markdown ?? "No result content is available."} />
    <label className="block space-y-1 text-sm"><span>Changes to request</span><Textarea value={feedback} disabled={busy || !!request} onChange={e => setFeedback(e.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {reviewed !== task.revision && !request && <div role="alert" className="space-y-2 text-sm"><p>The task changed. Review its current result before deciding.</p><Button variant="outline" onClick={() => setReviewed(task.revision)}>I reviewed this revision</Button></div>}
    <div className="flex flex-wrap gap-2">{request ? <Button disabled={busy} onClick={() => void send()}>Check original review</Button> : <><Button disabled={busy || reviewed !== task.revision} onClick={() => void send("accept")}>Accept result</Button><Button variant="outline" disabled={busy || reviewed !== task.revision || !feedback.trim()} onClick={() => void send("request_changes")}>Request changes</Button></>}</div>
    <p className="text-xs text-muted-foreground">Requesting changes starts a fresh attempt on this task, subject to its execution limits.</p><a className="text-sm text-primary underline" href="/tasks">Open Tasks</a>
  </section>;
}

function TaskModeProposal({ proposal, refresh }: { proposal: DecisionProjection; refresh: () => Promise<void> }) {
  const [request, setRequest] = useState<{ requestId: string; expectedRevision: number; choice: "approve" | "decline" } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const answer = async (choice?: "approve" | "decline") => {
    const input = request ?? { requestId: crypto.randomUUID(), expectedRevision: proposal.revision!, choice: choice! };
    setRequest(input); setBusy(true); setError("");
    try {
      await call(`/task-orchestration/v1/adoptions/${encodeURIComponent(proposal.id)}/consent`, { method: "POST", body: JSON.stringify(input) });
      setRequest(null); await refresh();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) { setRequest(null); await refresh(); }
      setError(failure instanceof Error ? failure.message : "The decision could not be confirmed. Check the original response.");
    } finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-lg border p-4"><h2 className="font-semibold">Run {proposal.title} autonomously?</h2>
    <p className="text-sm">This switches the originating chat to Autonomous so it can execute this task and delegate subtasks. The chat keeps this mode afterwards. Explicit tool permission rules still apply.</p>
    {(error || proposal.error) && <p role="alert" className="text-sm text-destructive">{error || proposal.error}</p>}
    <div className="flex flex-wrap gap-2">{request ? <Button disabled={busy} onClick={() => void answer()}>Check original decision</Button> : <>
      <Button disabled={busy || !proposal.available} onClick={() => void answer("approve")}>{proposal.approved ? "Retry approved transition" : "Switch to Autonomous"}</Button>
      {!proposal.approved && <Button variant="outline" disabled={busy || !proposal.available} onClick={() => void answer("decline")}>Keep Normal</Button>}</>}</div>
    <a className="text-sm text-primary underline" href={`/development?session=${encodeURIComponent(proposal.sessionId)}`}>Open originating chat</a>
  </section>;
}
