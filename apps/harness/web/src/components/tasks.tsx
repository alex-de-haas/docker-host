"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { TaskAction, TaskInput, TaskRecord, TaskProviderRef, TaskResource, TaskExecutorOptions, TaskPage } from "@hosty-sdk/app/tasks";
import { taskStatuses } from "@hosty-sdk/app/tasks";
import { call, ApiError } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Executor = TaskProviderRef & { displayName: string; available: boolean; options: TaskExecutorOptions["options"] | null; defaultId?: string | null };
type Directory = { provider: TaskProviderRef; users: { id: string; displayName?: string; email?: string }[]; executors: Executor[];
  workspaces: { workspaces: { id: string; name?: string; title?: string }[] }; warning?: string };
const empty = (): TaskInput => ({ title: "", markdown: "", assignee: null, requiresReview: false, resources: [] });
const inputOf = (t: TaskRecord): TaskInput => ({ title: t.title, markdown: t.markdown, assignee: t.assignee, requiresReview: t.requiresReview, resources: t.resources, ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}) });
const key = (p: TaskProviderRef) => `${p.appId}:${p.installationId}:${p.key}`;
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

export function Tasks() {
  const [rows, setRows] = useState<TaskRecord[]>([]), [directory, setDirectory] = useState<Directory | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [creating, setCreating] = useState(false);
  const [storedDraft, setDraft] = useState<TaskInput>(empty), [baseRevision, setBaseRevision] = useState(0), [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [filter, setFilter] = useState("");
  const [result, setResult] = useState(""), [feedback, setFeedback] = useState("");
  const [resource, setResource] = useState<TaskResource>({ kind: "external", owner: "", id: "", version: { mode: "live" } });
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ route: string; method: string; body: string } | null>(null);
  const selectedTask = rows.find(t => t.ref.id === selected);
  const draft = !dirty && !creating && selectedTask ? inputOf(selectedTask) : storedDraft;
  const edit = (patch: Partial<TaskInput>) => { if (!dirty) setBaseRevision(selectedTask?.revision ?? 0); setDraft({ ...draft, ...patch }); setDirty(true); };
  const refresh = useCallback(async () => {
    let cursor: string | null = null; const tasks: TaskRecord[] = [];
    do { const page: TaskPage = await (await call(`/tasks/v1/tasks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json(); tasks.push(...page.tasks); cursor = page.nextCursor; } while (cursor);
    setRows(tasks);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let retry: ReturnType<typeof setTimeout> | undefined;
    void call("/tasks/v1/directory").then(r => r.json()).then(setDirectory).catch(e => setError(e.message));
    const stream = async () => {
      try {
        const response = await appFetch("/api/tasks/v1/events", { signal: controller.signal, credentials: "include" });
        if (!response.ok || !response.body) throw new Error("Task updates are unavailable.");
        await refresh();
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          if (buffer.length > 64000) throw new Error("Task update stream needs reconnecting.");
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            if (event.includes("event: changed")) await refresh();
          }
        }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Task updates disconnected."); }
      if (!controller.signal.aborted) retry = setTimeout(() => { void stream(); }, 3000);
    };
    void stream();
    const visible = () => { if (document.visibilityState === "visible") void refresh().catch(e => setError(e.message)); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearTimeout(retry); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const choose = (t?: TaskRecord) => {
    if (dirty || uncertain) { setError("Save or discard the current draft before changing tasks."); return; }
    setSelected(t?.ref.id ?? null); setCreating(!t); setDraft(t ? inputOf(t) : empty()); setBaseRevision(t?.revision ?? 0);
    setResult(""); setFeedback(""); setError(null);
  };
  const send = async (route?: string, method?: string, body?: unknown) => {
    if (!pending.current && route && method) pending.current = { route, method, body: JSON.stringify(body) };
    if (!pending.current) return;
    setBusy(true); setError(null);
    try {
      const op = pending.current;
      const task: TaskRecord = await (await call(op.route, { method: op.method, body: op.body })).json();
      pending.current = null; setUncertain(false); setDirty(false); setCreating(false); setSelected(task.ref.id); setDraft(inputOf(task)); setBaseRevision(task.revision);
      setRows(rows => rows.some(t => t.ref.id === task.ref.id) ? rows.map(t => t.ref.id === task.ref.id ? task : t) : [...rows, task]);
      setResult(""); setFeedback("");
      // The mutation is confirmed. A later list refresh cannot turn it into an uncertain command.
      await refresh().catch(e => setError(e instanceof Error ? e.message : "Task list refresh failed."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Task request failed.");
      // A transport/5xx failure may follow a durable write. Retain exact request ID and input.
      if (e instanceof ApiError && e.status < 500) { pending.current = null; setUncertain(false); }
      else setUncertain(true);
    } finally { setBusy(false); }
  };
  const save = () => send(creating ? "/tasks/v1/tasks" : `/tasks/v1/tasks/${selected}`, creating ? "POST" : "PATCH",
    { requestId: crypto.randomUUID(), ...(creating ? {} : { expectedRevision: baseRevision }), input: draft });
  const action = (name: TaskAction["action"]) => {
    if (!selectedTask) return;
    void send(`/tasks/v1/tasks/${selectedTask.ref.id}/actions`, "POST", { requestId: crypto.randomUUID(), expectedRevision: selectedTask.revision, action: name,
      ...(name === "complete" ? { result: { markdown: result, resources: [] } } : {}),
      ...(name === "accept" || name === "request_changes" ? { resultInputRevision: selectedTask.resultInputRevision, feedback } : {}) });
  };
  const selectAssignee = async (value: string) => {
    if (!directory) return;
    if (!value) { edit({ assignee: null }); return; }
    if (value.startsWith("human:")) { const u = directory.users.find(u => u.id === value.slice(6))!; edit({ assignee: { kind: "human", userId: u.id, name: u.displayName ?? u.email ?? u.id } }); return; }
    const executor = directory.executors.find(e => key(e) === value.slice(4)); if (!executor) return;
    try {
      let options = executor.options;
      if (!options) {
        const loaded: TaskExecutorOptions = await (await call("/tasks/v1/executor-options", { method: "POST", body: JSON.stringify(executor) })).json();
        options = loaded.options; executor.options = options; executor.defaultId = loaded.defaultId;
        setDirectory({ ...directory });
      }
      const option = options.find(o => o.id === executor.defaultId) ?? options[0];
      edit({ assignee: { kind: "app", executor: { appId: executor.appId, installationId: executor.installationId, key: executor.key }, ...(option ? { optionId: option.id, name: option.name } : {}) } });
    } catch (e) { setError(e instanceof Error ? e.message : "Executor unavailable."); }
  };
  const editable = creating || selectedTask?.status === "Draft";
  const selectedExecutor = draft.assignee?.kind === "app" ? directory?.executors.find(e => key(e) === key(draft.assignee?.kind === "app" ? draft.assignee.executor : directory!.provider)) : undefined;
  const active = selectedTask?.attempts.at(-1);
  const running = active && (!active.receipt || !active.receipt.stopConfirmed || !["completed", "failed", "cancelled", "interrupted"].includes(active.receipt.state));
  const disabled = busy || uncertain || dirty;
  return <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 p-5 md:p-8">
    <header className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">Tasks</h1><p className="text-sm text-muted-foreground">Assign work, follow execution and review results.</p></div><Button onClick={() => choose()} disabled={busy || uncertain}>New task</Button></header>
    {directory?.warning && <p role="status" className="text-sm text-muted-foreground">{directory.warning}</p>}
    {error && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">{error}{uncertain && <Button variant="outline" className="ml-3" disabled={busy} onClick={() => void send()}>Retry original request</Button>}</div>}
    <div className="grid flex-1 gap-6 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-3"><label className="block text-sm">Status<select className={selectClass} value={filter} onChange={e => setFilter(e.target.value)}><option value="">All tasks</option>{taskStatuses.map(s => <option key={s}>{s}</option>)}</select></label>
        <nav aria-label="Tasks" className="space-y-1">{rows.filter(t => !filter || t.status === filter).slice().reverse().map(t => <button type="button" key={t.ref.id} aria-current={selected === t.ref.id ? "page" : undefined} className={`w-full rounded-md p-3 text-left hover:bg-muted ${selected === t.ref.id ? "bg-muted" : ""}`} onClick={() => choose(t)}>
          <span className="text-xs text-muted-foreground">{t.number} · {t.cancelRequested ? "Cancelling" : t.status}</span><span className="block truncate text-sm font-medium">{t.title || "Untitled task"}</span></button>)}</nav>
        {!rows.length && <p className="text-sm text-muted-foreground">No tasks yet. Create one to get started.</p>}
      </aside>
      {!selectedTask && !creating ? <section className="rounded-lg border border-dashed p-10 text-sm text-muted-foreground">Select a task to see its description, execution and result.</section> : <section className="min-w-0 space-y-6">
        <div className="flex items-center justify-between"><div className="text-sm text-muted-foreground">{creating ? "New task" : `${selectedTask!.number} · ${selectedTask!.cancelRequested ? "Cancelling" : selectedTask!.status}`}</div>
          {selectedTask && <span className="text-xs text-muted-foreground">Revision {selectedTask.revision}</span>}</div>
        {selectedTask?.blocked && <p role="status" className="rounded-md bg-muted p-3 text-sm">{selectedTask.blocked.message}</p>}
        {editable || dirty ? <div className="space-y-4">
          <fieldset className="space-y-4" disabled={!editable}>
          <label className="block space-y-1 text-sm">Title<Input value={draft.title} maxLength={200} onChange={e => edit({ title: e.target.value })} disabled={busy || uncertain} /></label>
          <label className="block space-y-1 text-sm">Description · Markdown<Textarea className="min-h-40" value={draft.markdown} maxLength={32000} onChange={e => edit({ markdown: e.target.value })} disabled={busy || uncertain} /></label>
          <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm">Assignee<select className={selectClass} disabled={!directory || busy || uncertain} value={draft.assignee?.kind === "human" ? `human:${draft.assignee.userId}` : draft.assignee?.kind === "app" ? `app:${key(draft.assignee.executor)}` : ""} onChange={e => void selectAssignee(e.target.value)}>
            <option value="">Choose an assignee</option><optgroup label="People">{directory?.users.map(u => <option key={u.id} value={`human:${u.id}`}>{u.displayName ?? u.email ?? u.id}</option>)}</optgroup><optgroup label="Executors">{directory?.executors.map(e => <option key={key(e)} value={`app:${key(e)}`} disabled={!e.available}>{e.displayName}</option>)}</optgroup></select></label>
          {draft.assignee?.kind === "app" && <label className="block text-sm">Executor option<select className={selectClass} value={draft.assignee.optionId ?? ""} disabled={busy || uncertain} onChange={e => { const option = selectedExecutor?.options?.find(o => o.id === e.target.value); if (draft.assignee?.kind === "app") edit({ assignee: { ...draft.assignee, optionId: e.target.value, name: option?.name } }); }}>
            <option value="">Choose an option</option>{selectedExecutor?.options?.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}</div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.requiresReview} onChange={e => edit({ requiresReview: e.target.checked })} disabled={busy || uncertain} />Review result before completing</label>
          <label className="block text-sm">Existing workspace · optional<select className={selectClass} value={draft.workspaceId ?? ""} disabled={busy || uncertain} onChange={e => edit({ workspaceId: e.target.value || undefined })}><option value="">No workspace</option>{directory?.workspaces.workspaces.map(w => <option key={w.id} value={w.id}>{w.name ?? w.title ?? w.id}</option>)}</select></label>
          <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">Resource references ({draft.resources.length})</summary><div className="mt-3 space-y-2">
            {draft.resources.map((r, i) => <div key={i} className="flex justify-between gap-3 text-sm"><span className="break-all">{r.label ?? r.id} · {r.version.mode === "live" ? "Live" : r.version.revision}</span><Button size="sm" variant="ghost" onClick={() => edit({ resources: draft.resources.filter((_, j) => j !== i) })}>Remove</Button></div>)}
            <label className="block text-sm">Kind<select className={selectClass} value={resource.kind} onChange={e => setResource({ ...resource, kind: e.target.value as TaskResource["kind"] })}><option value="external">External material</option><option value="app">Application</option><option value="workspace">Workspace reference</option></select></label>
            <Input aria-label="Resource owner" placeholder="Owner / provider" value={resource.owner} onChange={e => setResource({ ...resource, owner: e.target.value })} />
            <Input aria-label="Resource ID" placeholder="Resource ID or URL" value={resource.id} onChange={e => setResource({ ...resource, id: e.target.value })} />
            <Input aria-label="Resource revision" placeholder="Revision (leave blank for live reference)" value={resource.version.mode === "pinned" ? resource.version.revision : ""} onChange={e => setResource({ ...resource, version: e.target.value ? { mode: "pinned", revision: e.target.value } : { mode: "live" } })} />
            <Button variant="outline" disabled={!resource.owner || !resource.id || draft.resources.length >= 32 || busy || uncertain} onClick={() => { edit({ resources: [...draft.resources, resource] }); setResource({ kind: "external", owner: "", id: "", version: { mode: "live" } }); }}>Add reference</Button>
          </div></details>
          </fieldset>
          {dirty && !editable && <p role="status" className="text-sm text-muted-foreground">This task is no longer a Draft. Your unsaved input is preserved for copying. Discard edits to continue.</p>}
          {editable && dirty && selectedTask && baseRevision !== selectedTask.revision && <p className="text-sm text-muted-foreground">This task changed while you were editing. Your input is preserved; reload before saving.</p>}
          <div className="flex gap-2"><Button disabled={!editable || busy || uncertain || !directory || !creating && !dirty} onClick={() => void save()}>Save draft</Button>{dirty && <Button variant="outline" disabled={busy || uncertain} onClick={() => { setDirty(false); setDraft(selectedTask ? inputOf(selectedTask) : empty()); setError(null); }}>Discard edits</Button>}</div>
        </div> : <div className="space-y-3"><h2 className="text-xl font-semibold">{selectedTask!.title}</h2><p className="text-sm text-muted-foreground">{selectedTask!.assignee?.name ?? (selectedTask!.assignee?.kind === "human" ? selectedTask!.assignee.userId : selectedTask!.assignee?.executor.appId)}</p><Markdown text={selectedTask!.markdown} />
          {!!selectedTask!.resources.length && <ul className="space-y-1 text-sm">{selectedTask!.resources.map((r, i) => <li key={i} className="break-all">{r.kind}: {r.label ?? r.id} · {r.owner} · {r.version.mode === "live" ? "Live" : r.version.revision}</li>)}</ul>}{selectedTask!.workspaceId && <p className="text-sm text-muted-foreground">Workspace: {directory?.workspaces.workspaces.find(w => w.id === selectedTask!.workspaceId)?.name ?? selectedTask!.workspaceId}</p>}</div>}
        {selectedTask && <div className="space-y-3">
          {selectedTask.status === "InProgress" && selectedTask.assignee?.kind === "human" && <label className="block text-sm">Result · Markdown<Textarea value={result} onChange={e => setResult(e.target.value)} maxLength={32000} /></label>}
          {selectedTask.blocked?.reason === "needs_review" && <label className="block text-sm">Review feedback<Textarea value={feedback} onChange={e => setFeedback(e.target.value)} maxLength={4000} /></label>}
          <div className="flex flex-wrap gap-2">
            {selectedTask.status === "Draft" && <Button disabled={disabled} onClick={() => action("ready")}>Ready</Button>}
            {selectedTask.status === "Ready" && selectedTask.assignee?.kind === "human" && <Button disabled={disabled} onClick={() => action("start")}>Start work</Button>}
            {selectedTask.status === "InProgress" && selectedTask.assignee?.kind === "human" && <Button disabled={disabled || !result.trim()} onClick={() => action("complete")}>Submit result</Button>}
            {selectedTask.blocked?.reason === "needs_review" && <><Button disabled={disabled} onClick={() => action("accept")}>Accept result</Button><Button variant="outline" disabled={disabled || !feedback.trim()} onClick={() => action("request_changes")}>Request changes</Button></>}
            {selectedTask.status !== "Draft" && !running && !selectedTask.cancelRequested && <Button variant="outline" disabled={disabled} onClick={() => action("draft")}>{["Done", "Cancelled"].includes(selectedTask.status) ? "Reopen" : "Return to Draft / retry"}</Button>}
            {!["Done", "Cancelled"].includes(selectedTask.status) && <Button variant="outline" disabled={disabled || selectedTask.cancelRequested} onClick={() => action("cancel")}>{selectedTask.cancelRequested ? "Cancelling…" : "Cancel task"}</Button>}
          </div>
        </div>}
        {selectedTask?.result && <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Result</h2><Markdown text={selectedTask.result.markdown} />{selectedTask.result.resources.map((r, i) => <p key={i} className="break-all text-sm">{r.label ?? r.id} · {r.owner}</p>)}</section>}
        {(selectedTask?.outcomes?.filter(o => !o.executionId).length ?? 0) > 1 && <section className="space-y-3"><h2 className="font-semibold">Result history</h2>{selectedTask!.outcomes!.filter(o => !o.executionId).slice().reverse().map((o, i) => <details key={i} className="rounded-md border p-3"><summary className="cursor-pointer text-sm">Input revision {o.inputRevision} · {new Date(o.recordedAt).toLocaleString()}</summary><Markdown text={o.result.markdown} /></details>)}</section>}
        {!!selectedTask?.attempts.length && <section className="space-y-3"><h2 className="font-semibold">Execution history</h2>{selectedTask.attempts.slice().reverse().map((a, i) => <article className="space-y-2 rounded-md border p-3 text-sm" key={a.executionId}><div className="flex flex-wrap justify-between gap-2"><span>Attempt {selectedTask.attempts.length - i} · {a.receipt?.state ?? "Queued"}</span><span className="text-muted-foreground">{a.executor.appId}</span></div>{a.receipt?.error && <p>{a.receipt.error.message}</p>}{a.receipt?.sessionRef && <a className="underline underline-offset-4" href={a.receipt.sessionRef.path}>Open execution conversation</a>}{a.receipt?.result && <details><summary className="cursor-pointer">Attempt result</summary><Markdown text={a.receipt.result.markdown} /></details>}<p className="text-xs text-muted-foreground">{a.receipt?.stopConfirmed ? "Execution stopped" : "No stop confirmation"}</p></article>)}</section>}
      </section>}
    </div>
  </main>;
}
