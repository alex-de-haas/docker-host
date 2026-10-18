"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { CoreEnvironment, CoreEnvironmentSavedConsent } from "./sandbox-server.js";

export type EnvironmentRequest = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface EnvironmentWorkspace { id: string; worktrees: { id: string; label: string; state: string }[] }
export interface EnvironmentApps { state: string; apps: { id: string; displayName: string; version?: string; runtimeState: string; health?: string; previewUrl?: string }[]; error?: string }
type Pending = { path: string; body: Record<string, unknown>; id?: string; kind: string };
const button = "inline-flex items-center justify-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed";
const field = "w-full rounded-md border bg-background px-3 py-2 text-sm";
function message(error: unknown) { return error instanceof Error ? error.message : "Sandbox request failed."; }
function link(value?: string) {
  try { const url = new URL(value ?? ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

/** Shared operator panel; each host supplies its authenticated same-origin Core transport. */
export function CoreEnvironmentPanel({ request, storageKey, workspace, workspaceHref }: {
  request: EnvironmentRequest; storageKey: string; workspace?: EnvironmentWorkspace; workspaceHref?: (id: string) => string;
}) {
  const [consents, setConsents] = useState<CoreEnvironmentSavedConsent[]>([]);
  const [environments, setEnvironments] = useState<CoreEnvironment[]>([]);
  const [apps, setApps] = useState<Record<string, EnvironmentApps>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const active = useRef(true);
  const refreshSequence = useRef(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const savePending = useCallback((value: Pending | null) => {
    // Do not send a mutation if its replay identity cannot be persisted.
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey);
    pendingRef.current = value; if (active.current) setPending(value);
  }, [storageKey]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    try {
      const result = await request<{ environments: CoreEnvironment[]; consents?: CoreEnvironmentSavedConsent[] }>("", undefined, signal);
      if (signal?.aborted || !active.current || sequence !== refreshSequence.current) return;
      const selected = result.environments.filter(e => !workspace || e.context?.workspaceId === workspace.id);
      setConsents(result.consents ?? []);
      setEnvironments(selected.filter(e => e.state !== "finished")); setLoading(false); setReadError("");
      const saved = pendingRef.current;
      if (saved?.id) {
        const item = selected.find(e => e.id === saved.id);
        const operation = item?.operations.find(o => o.id.replaceAll("-", "") === String(saved.body.requestId).replaceAll("-", ""));
        if (operation && ["succeeded", "failed"].includes(operation.state)) {
          const superseded = operation !== item?.operations.at(-1);
          if (operation.state === "succeeded" || saved.kind !== "finish" || superseded) savePending(null);
          setError(operation.state === "failed" ? item?.error ?? "Sandbox operation failed." : "");
          if (item?.state === "finished") setNotice("Sandbox deleted. Workspace source is preserved.");
          else if (superseded) setNotice("A newer operation replaced the previous request. Review the current sandbox status.");
        }
      }
      const results = await Promise.all(selected.filter(e => e.state === "running").map(async e => {
        try { return [e.id, await request<EnvironmentApps>(`/${e.id}/apps`, undefined, signal)] as const; }
        catch (cause) { return [e.id, { state: "unavailable", apps: [], error: message(cause) }] as const; }
      }));
      if (!signal?.aborted && active.current && sequence === refreshSequence.current) setApps(Object.fromEntries(results));
    } catch (cause) {
      if (!signal?.aborted && active.current && sequence === refreshSequence.current) { setEnvironments([]); setConsents([]); setApps({}); setLoading(false); setReadError(message(cause)); }
    }
  }, [request, workspace, savePending]);
  useEffect(() => {
    active.current = true; const controller = new AbortController();
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Pending | null;
      if (saved && /^\/(?:from-workspace|[a-f0-9]{32}\/operations\/(?:start|stop|restart|finish))$/.test(saved.path)
          && typeof saved.body?.requestId === "string") { pendingRef.current = saved; setPending(saved); setNotice("A previous request needs confirmation. Refresh or retry the same request."); }
    } catch { setError("Cannot read the saved sandbox request."); }
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try { await refresh(controller.signal); } finally { polling = false; }
    }
    void poll();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void poll(); }, 5000);
    return () => { active.current = false; controller.abort(); clearInterval(timer); };
  }, [refresh, storageKey]);
  async function run(value: Pending) {
    setBusy(true); setError("");
    try {
      savePending(value);
      const result = await request<CoreEnvironment>(value.path, value.body);
      if (value.kind !== "finish" || result.state === "finished") savePending(null);
      if (result.error) throw new Error(result.error);
      if (result.state === "finished") setNotice("Sandbox deleted. Workspace source is preserved.");
      else setNotice("");
      await refresh(); return result;
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status && status >= 400 && status < 500) savePending(null);
      if (active.current) setError(message(cause));
      return null;
    } finally { if (active.current) setBusy(false); }
  }
  async function command(item: CoreEnvironment, kind: string) {
    return run({ path: `/${item.id}/operations/${kind}`, body: { requestId: crypto.randomUUID(), expectedRevision: item.revision }, id: item.id, kind });
  }
  async function create(body: Record<string, unknown>) {
    const created = await run({ path: "/from-workspace", body: { ...body, requestId: crypto.randomUUID() }, kind: "create" });
    if (created) { if (active.current) { setCreating(false); await command(created, "start"); } }
  }
  const disabled = busy || pending !== null;
  return <section className="space-y-4 rounded-lg border bg-card p-4" aria-label="Sandbox environments">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Sandbox environments</h3><p className="text-sm text-muted-foreground">Separate Core instances with their own apps, users and temporary data.</p></div>
      <div className="flex gap-2"><button className={button} onClick={() => { setError(""); void refresh(); }}>Refresh sandboxes</button>
        {workspace && <button className={button} disabled={disabled || !workspace.worktrees.some(t => t.state === "active")} onClick={() => setCreating(!creating)}>Create sandbox</button>}</div></header>
    {creating && workspace && <CreateEnvironment workspace={workspace} disabled={disabled} onCreate={create} onCancel={() => setCreating(false)} />}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {(error || readError) && <p role="alert" className="text-sm text-destructive">{error || readError}</p>}
    {pending && <div className="flex items-center gap-3 text-sm"><span>{busy ? `Sandbox ${pending.kind} is in progress…` : "The request outcome is not confirmed."}</span><button className={button} disabled={busy} onClick={() => void run(pending)}>Retry same request</button></div>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">Loading sandboxes…</p> : !environments.length && !error && !readError && <p className="text-sm text-muted-foreground">No active sandbox environments.</p>}
    {!workspace && consents.length > 0 && <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Saved launch permissions ({consents.length})</summary><p className="mt-2 text-xs text-muted-foreground">Revocation affects all matching launches and delegated access. Running children and their own accounts remain; use Stop or Delete sandbox to end them.</p><ul className="divide-y">{consents.map(grant => <li key={grant.id} className="space-y-2 py-3 text-sm"><p>{grant.appId} · {grant.mode} · {grant.state}</p><p className="break-all text-xs text-muted-foreground">{grant.target}</p><button className={button} disabled={disabled} onClick={() => { setBusy(true); void request(`/consents/${grant.id}/revoke`, {}).then(() => refresh()).catch(cause => setError(message(cause))).finally(() => setBusy(false)); }}>Revoke permission for {grant.appId}</button></li>)}</ul></details>}
    {environments.map(item => <article key={item.id} className="space-y-3 rounded-md border p-3" aria-label={`Sandbox ${item.label}`}>
      <header className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-medium">{item.label} <span className="ml-2 rounded border px-2 py-0.5 text-xs font-normal">{item.state}</span></h4>
        <p className="mt-1 text-xs text-muted-foreground">{item.mode === "source" ? "Core built from workspace source" : item.mode === "release" ? "Installed Core release" : "Current Core build"}{item.context?.workspaceId && workspaceHref && <> · <a className="underline" href={workspaceHref(item.context.workspaceId)}>Open workspace</a></>}</p></div>
        <div className="flex flex-wrap gap-2">
          {item.state === "running" && link(item.previewUrl) && <a className={button} href={item.previewUrl + "/login"} target="_blank" rel="noreferrer">Open Core</a>}
          <button className={button} disabled={disabled || ["building", "starting", "stopping", "finishing", "cleanup-failed"].includes(item.state)} onClick={() => void command(item, item.state === "running" ? "stop" : "start")}>{item.state === "running" ? "Stop" : "Start"}</button>
          <button className={button + " text-destructive"} disabled={disabled || item.state === "finishing"} onClick={() => setRemoving(item.id)}>{item.state === "cleanup-failed" ? "Retry deletion" : "Delete sandbox"}</button>
        </div></header>
      {item.limits && <p className="text-xs text-muted-foreground">Reserved: {(item.limits.memoryBytes / 1073741824).toFixed(1)} GiB container memory · {item.limits.cpus} CPUs · {item.limits.pids} PIDs · {(item.limits.diskBytes / 1073741824).toFixed(1)} GiB soft disk limit. Released after deletion.</p>}
      {item.usage && <p className="text-xs text-muted-foreground">{item.usage.state === "unknown" ? "Resource usage unavailable; the reservation remains active." : `Observed: ${(item.usage.containerMemoryBytes / 1048576).toFixed(0)} MiB containers · ${(item.usage.coreMemoryBytes / 1048576).toFixed(0)} MiB Core process · ${(item.usage.ownedDiskBytes / 1073741824).toFixed(2)} GiB owned data.`}</p>}
      {item.access && <div className="space-y-2 text-sm" aria-label="Sandbox consent"><p>{item.access.state === "operator" ? "Operator launch" : item.access.state === "active" ? item.access.saved ? "Saved launch permission" : "Permission for this run" : item.access.state === "target-changed" ? "Core target changed or unavailable; review launch permission" : "Launch permission revoked or unavailable"}</p><p className="text-xs text-muted-foreground">{item.access.description}</p>{item.access.grantId && ["active", "target-changed"].includes(item.access.state) && <button className={button} disabled={disabled} onClick={() => { setBusy(true); void request(`/${item.id}/consent/revoke`, {}).then(() => refresh()).catch(cause => setError(message(cause))).finally(() => setBusy(false)); }}>Revoke launch permission</button>}</div>}
      {item.error && <p role="alert" className="text-sm text-destructive">{item.error}</p>}
      {item.state === "running" && <><EnvironmentApplications value={apps[item.id]} />
        {apps[item.id] && ["setup-required", "sign-in-required"].includes(apps[item.id].state) && <SetupAccount request={request} id={item.id} disabled={disabled} onDone={() => refresh()} />}</>}
      {removing === item.id && <div role="alertdialog" aria-label={`Delete ${item.label}`} className="space-y-3 rounded-md border border-destructive p-3"><p className="text-sm">Permanently delete this sandbox, all its apps, test users, data and caches? Workspace source and shared folders are preserved.</p><div className="flex gap-2"><button className={button + " text-destructive"} disabled={disabled} onClick={() => { setRemoving(null); void command(item, "finish"); }}>Delete permanently</button><button className={button} onClick={() => setRemoving(null)}>Cancel</button></div></div>}
    </article>)}
  </section>;
}
function EnvironmentApplications({ value }: { value?: EnvironmentApps }) {
  if (!value) return <p role="status" className="text-sm text-muted-foreground">Reading application status…</p>;
  if (value.state !== "ready") return <p role="status" className="text-sm text-muted-foreground">{value.error ?? (value.state === "setup-required" ? "Set up a test administrator for this fresh Core." : "Application status is unavailable.")}</p>;
  if (!value.apps.length) return <p className="text-sm text-muted-foreground">No apps installed in this sandbox yet.</p>;
  return <ul className="divide-y" aria-label="Sandbox applications">{value.apps.map(app => <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><div><span className="font-medium">{app.displayName}</span><span className="ml-2 text-muted-foreground">{app.runtimeState} · {app.health ?? "Health unknown"}</span></div>{app.runtimeState === "running" && link(app.previewUrl) && <a className={button} href={app.previewUrl} target="_blank" rel="noreferrer">Open preview<span className="sr-only"> for {app.displayName}</span></a>}</li>)}</ul>;
}
function CreateEnvironment({ workspace, disabled, onCreate, onCancel }: { workspace: EnvironmentWorkspace; disabled: boolean; onCreate: (body: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const trees = workspace.worktrees.filter(t => t.state === "active");
  const [selected, setSelected] = useState(trees.slice(0, 16).map(t => t.id));
  const [source, setSource] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void onCreate({ label: form.get("label"), workspaceId: workspace.id, worktreeIds: selected,
      ...(source ? { coreWorktreeId: form.get("coreWorktreeId"), coreProject: form.get("coreProject") } : {}) });
  }
  return <form onSubmit={submit} className="space-y-3 rounded-md border bg-muted/30 p-3" aria-label="Create workspace sandbox">
    <label className="block space-y-1 text-sm">Sandbox name<input className={field} name="label" required maxLength={120} defaultValue="Workspace sandbox" /></label>
    <fieldset className="space-y-2"><legend className="text-sm font-medium">Attached worktrees</legend>{trees.map(t => <label key={t.id} className="flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(t.id)} onChange={e => setSelected(old => e.target.checked ? [...old, t.id] : old.filter(id => id !== t.id))} />{t.label}</label>)}</fieldset>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={source} onChange={e => setSource(e.target.checked)} />Build Core from a worktree</label>
    {source && <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm">Core worktree<select className={field} name="coreWorktreeId" required>{trees.filter(t => selected.includes(t.id)).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label><label className="space-y-1 text-sm">Core project, relative to worktree<input className={field} name="coreProject" required defaultValue="apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj" /></label></div>}
    <p className="text-xs text-muted-foreground">Starts a fresh Core with separate users and data. Attached worktrees stay available until the sandbox is deleted.</p>
    <div className="flex gap-2"><button className={button} type="submit" disabled={disabled || selected.length === 0 || selected.length > 16}>Create and start</button><button className={button} type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
function SetupAccount({ request, id, disabled, onDone }: { request: EnvironmentRequest; id: string; disabled: boolean; onDone: () => Promise<void> }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError("");
    try { const result = await request<{ status: number; body?: { message?: string } }>(`/${id}/setup`, { email: data.get("email"), displayName: data.get("displayName"), password: data.get("password") });
      if (result.status !== 200) throw new Error(result.body?.message ?? "Sandbox account setup failed."); await onDone();
    } catch (cause) { setError(message(cause)); } finally { (form.elements.namedItem("password") as HTMLInputElement).value = ""; setBusy(false); }
  }
  return <form onSubmit={submit} aria-label="Sandbox administrator" className="space-y-3 rounded-md border p-3"><p className="text-sm">Use a separate sandbox administrator. For an existing Core, enter its current account. Parent credentials are not copied.</p><div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">Display name<input className={field} name="displayName" required autoComplete="off" /></label><label className="text-sm">Test email<input className={field} type="email" name="email" required autoComplete="off" /></label><label className="text-sm">Test password<input className={field} type="password" name="password" minLength={12} required autoComplete="new-password" /></label></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<button className={button} disabled={disabled || busy}>{busy ? "Connecting…" : "Connect test account"}</button></form>;
}
