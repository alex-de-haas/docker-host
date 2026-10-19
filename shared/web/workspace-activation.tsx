"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type ActivationSelection = { coreSelected: boolean; coreWorktreeId?: string | null; apps?: { appId: string; selected: boolean; worktreeId?: string | null; runtime?: string | null }[] };
type Participant = { id: string; kind: string; name: string; selected: boolean; unavailable?: string; reason: string; worktreeId?: string; sourcePath?: string; branch?: string; commit?: string; changedFiles?: number; currentRuntime?: string; targetRuntime?: string; availableRuntimes: string[]; worktreeOptions?: string[] };
type Review = { plan: { coreInstance: string; participants: Participant[] }; planDigest: string; consequences: string[] };
type Activation = { id: string; phase: string; apps: string[]; coreProject?: string; coreReturned?: boolean; returnedApps?: string[]; error?: string; returns?: { request: { requestId: string }; state: string }[] };
type Detail = { status: { activation: Activation; helper?: { state: string; error?: string; logPath?: string }; cancellationRequested: boolean }; children: { appId: string; phase: string; error?: string }[] };
type Pending = { kind: string; body: Record<string, unknown> };
const button = "rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-muted";

/** Shared review uses the host surface's authenticated transport; it never stores credentials. */
export function WorkspaceActivationPanel({ request, storageKey, onlyApp }: {
  workspaceId: string; request: (kind: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>; storageKey: string; onlyApp?: string;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [selection, setSelection] = useState<ActivationSelection>({ coreSelected: !onlyApp });
  const [inventory, setInventory] = useState<Activation[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pending, setPending] = useState<Pending | null>(() => { try { return JSON.parse(localStorage.getItem(storageKey + ":v1") ?? "null"); } catch { return null; } });
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [returnApps, setReturnApps] = useState<string[]>([]); const [returnCore, setReturnCore] = useState(false); const [accept, setAccept] = useState(false);
  const executing = useRef(false);
  const pendingRequest = useRef(pending);
  const statusRequest = useRef<AbortController | null>(null);
  const remember = (value: Pending | null) => { pendingRequest.current = value; setPending(value); try { if (value) localStorage.setItem(storageKey + ":v1", JSON.stringify(value)); else localStorage.removeItem(storageKey + ":v1"); } catch { /* In-memory recovery remains available. */ } };
  const load = useCallback(async (signal?: AbortSignal) => {
    const rows = await request("list", {}, signal) as Activation[];
    if (!signal?.aborted) { setInventory(rows); setId(old => old ?? (pendingRequest.current?.body.activationId as string | undefined) ?? (pendingRequest.current?.body.requestId as string | undefined) ?? rows.at(-1)?.id ?? null); }
  }, [request, pending]);
  useEffect(() => {
    const abort = new AbortController();
    void request("list", {}, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      const rows = value as Activation[]; setInventory(rows);
      setId(old => old ?? (pendingRequest.current?.body.activationId as string | undefined) ?? (pendingRequest.current?.body.requestId as string | undefined) ?? rows.at(-1)?.id ?? null);
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [request, pending]);
  const active = detail?.status.activation.id === id ? detail.status.activation : inventory.find(a => a.id === id);
  const inTransition = !!active && !["active", "returned", "cancelled"].includes(active.phase);
  const selectedReturnApps = returnApps.filter(app => active?.apps.includes(app) && !active.returnedApps?.includes(app));
  const selectedReturnCore = returnCore && !!active?.coreProject && !active.coreReturned;
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController(); statusRequest.current = abort; let timer: ReturnType<typeof setTimeout>; let reading = false;
    const poll = async () => {
      if (abort.signal.aborted || reading || document.visibilityState === "hidden") return;
      clearTimeout(timer); reading = true;
      try {
        const value = await request("status", { activationId: id }, abort.signal) as Detail;
        if (!abort.signal.aborted) { setDetail(value); setError(""); }
      } catch (e) { if (!abort.signal.aborted) setError(`Reconnecting: ${e instanceof Error ? e.message : String(e)}. The operation ID is retained. If the previous Core lacks this API, inspect it with hosty core workspace-activation using this ID.`); }
      finally { reading = false; if (!abort.signal.aborted && inTransition) timer = setTimeout(() => void poll(), 3000); }
    };
    const visible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", visible); void poll();
    return () => { abort.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [id, inTransition, request, revision]);
  const plan = async () => {
    setBusy(true); setError(""); setReview(null);
    try {
      let value = await request("plan", { selection }) as Review;
      const chosen = { coreSelected: value.plan.participants.some(p => p.kind === "core" && p.selected), coreWorktreeId: value.plan.participants.find(p => p.kind === "core")?.worktreeId,
        apps: value.plan.participants.filter(p => p.kind === "app").map(p => ({ appId: p.id, selected: onlyApp ? p.id === onlyApp && !p.unavailable : p.selected, worktreeId: p.worktreeId, runtime: p.targetRuntime })) };
      if (onlyApp) value = await request("plan", { selection: chosen }) as Review;
      setSelection(chosen); setReview(value); setRows(value.plan.participants);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const run = async (action: Pending) => {
    if (executing.current) return; executing.current = true; setBusy(true); setError(""); remember(action);
    const previousId = id;
    const operationId = (action.body.activationId ?? action.body.requestId) as string;
    if (operationId) setId(operationId);
    try {
      await request(action.kind, action.body);
      remember(null); setReview(null); await load();
      if (operationId) setDetail(await request("status", { activationId: operationId }) as Detail);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "activation_review_changed") { statusRequest.current?.abort(); remember(null); setReview(null); setId(previousId); }
      setError(e instanceof Error ? e.message : String(e));
    }
    finally { executing.current = false; setBusy(false); }
  };
  const choose = (p: Participant, changes: Record<string, unknown>) => {
    setReview(null);
    if (p.kind === "core") setSelection(s => ({ ...s, ...(changes.selected !== undefined ? { coreSelected: !!changes.selected } : {}), ...(changes.worktreeId !== undefined ? { coreWorktreeId: changes.worktreeId as string } : {}) }));
    else setSelection(s => ({ ...s, apps: (s.apps ?? []).map(a => a.appId === p.id ? { ...a, ...changes } : a) }));
  };
  // Keep rows while a selection invalidates its executable review.
  const [rows, setRows] = useState<Participant[]>([]);

  return <section className="space-y-3 rounded-md border p-3" aria-label="Workspace runtime activation">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">Use workspace on this Core</h3>
      <button className={button} disabled={busy || !!pending} onClick={() => void plan()}>Review selection</button>
      <button className={button} disabled={busy} onClick={() => { setRevision(n => n + 1); void load().catch(e => setError(e.message)); }}>Refresh status</button></div>
    <p className="text-sm text-muted-foreground">Runs selected source with ordinary users and data. A sandbox preview is separate.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {pending && <div className="space-y-2 text-sm"><p>The request is retained. Retry uses the same ID and arguments.</p><code className="break-all">{String(pending.body.activationId ?? pending.body.requestId)}</code>
      <button className={button} disabled={busy} onClick={() => void run(pending)}>Retry original request</button></div>}
    {rows.length > 0 && <fieldset disabled={busy || !!pending} className="space-y-3"><legend className="sr-only">Participants</legend>
      {rows.map(p => <div key={p.id} className="space-y-1 border-b pb-2 text-sm"><label className="flex gap-2"><input type="checkbox"
        checked={p.kind === "core" ? selection.coreSelected : selection.apps?.find(a => a.appId === p.id)?.selected ?? false}
        disabled={!!p.unavailable || !!onlyApp && p.kind === "app" && p.id !== onlyApp} onChange={e => choose(p, { selected: e.target.checked })} />{p.name}</label>
        <p className="break-all text-xs">{p.currentRuntime} → {p.targetRuntime} · {p.reason === "configured-repository-match" ? "Matches configured Core repository" : "Explicit app binding"}</p>
        <p className="break-all text-xs">{p.sourcePath} · {p.branch} · {p.commit?.slice(0, 10)} · {p.changedFiles ?? "unknown"} changed files</p>
        {p.unavailable && <p className="text-xs text-destructive">{p.unavailable}</p>}
        {(p.worktreeOptions?.length ?? 0) > 1 && <label>Worktree <select value={p.kind === "core" ? selection.coreWorktreeId ?? "" : selection.apps?.find(a => a.appId === p.id)?.worktreeId ?? ""} onChange={e => choose(p, { worktreeId: e.target.value })}><option value="">Choose worktree</option>{p.worktreeOptions!.map(t => <option key={t}>{t}</option>)}</select></label>}
        {p.availableRuntimes.length > 1 && <label>Development runtime <select value={selection.apps?.find(a => a.appId === p.id)?.runtime ?? ""} onChange={e => choose(p, { runtime: e.target.value })}><option value="">Choose runtime</option>{p.availableRuntimes.map(r => <option key={r}>{r}</option>)}</select></label>}
      </div>)}
      {!review && <p className="text-sm">Selection changed. Review again before applying.</p>}
      {review && <><p className="text-xs">Target Core: {review.plan.coreInstance}</p><ul className="list-disc pl-5 text-sm">{review.consequences.map(c => <li key={c}>{c}</li>)}</ul>
        <button className={button} disabled={!review.plan.participants.some(p => p.selected)} onClick={() => void run({ kind: "apply", body: { requestId: crypto.randomUUID(), selection, planDigest: review.planDigest } })}>Apply reviewed selection</button></>}
    </fieldset>}
    {inventory.length > 0 && <label className="block text-sm">Retained activation <select className="w-full rounded border bg-background p-1" value={id ?? ""} onChange={e => { setId(e.target.value); setReturnApps([]); setReturnCore(false); }}>
      {inventory.map(a => <option key={a.id} value={a.id}>{a.phase} · {a.id}</option>)}</select></label>}
    {active && <div className="space-y-2 text-sm"><p role="status">{active.phase} · {detail?.status.helper?.state ?? "Awaiting helper"}</p><code className="break-all text-xs">{active.id}</code>
      {[active.error, detail?.status.helper?.error].filter(Boolean).map((e, i) => <p key={i} role="alert">{e}</p>)}
      {detail?.children.map(c => <p key={c.appId}>{c.appId}: {c.phase}{c.error ? ` — ${c.error}` : ""}</p>)}
      {detail?.status.helper?.logPath && <p className="break-all text-xs">Helper log: {detail.status.helper.logPath}</p>}
      {inTransition && <div className="flex gap-2"><button className={button} disabled={busy || !!pending} onClick={() => void run({ kind: "cancel", body: { activationId: active.id } })}>Pause at next boundary</button><button className={button} disabled={busy || !!pending} onClick={() => void run({ kind: "resume", body: { activationId: active.id } })}>Resume original activation</button></div>}
      {!["returned", "cancelled"].includes(active.phase) && <fieldset className="space-y-2" disabled={busy || !!pending}><legend className="font-medium">Return to previous runtime</legend>
        {active.apps.filter(a => !(active.returnedApps ?? []).includes(a)).map(a => <label key={a} className="flex gap-2"><input type="checkbox" checked={returnApps.includes(a)} onChange={e => setReturnApps(old => e.target.checked ? [...old, a] : old.filter(id => id !== a))} />{a}</label>)}
        {active.coreProject && !active.coreReturned && <label className="flex gap-2"><input type="checkbox" checked={returnCore} onChange={e => setReturnCore(e.target.checked)} />Core — captured previous executable</label>}
        <label className="flex gap-2"><input type="checkbox" checked={accept} onChange={e => setAccept(e.target.checked)} />I accept compatibility of current data with the selected previous runtimes. No data is restored.</label>
        <button className={button} disabled={(!selectedReturnCore && selectedReturnApps.length === 0) || selectedReturnCore && !accept} onClick={() => void run({ kind: "return", body: { activationId: active.id, return: { requestId: crypto.randomUUID(), apps: selectedReturnApps, core: selectedReturnCore, acceptDataChanges: accept } } })}>Return selected participants</button>
      </fieldset>}
    </div>}
  </section>;
}
