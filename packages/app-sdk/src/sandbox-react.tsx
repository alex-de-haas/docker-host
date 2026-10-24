"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SdkChromeStyles, SdkProgress, SdkSpinner } from "./sdk-chrome";
import type { CoreEnvironment, CoreEnvironmentSavedConsent } from "./sandbox-server.js";

export type EnvironmentRequest = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface EnvironmentWorkspace { id: string; worktrees: { id: string; label: string; state: string }[] }
export interface EnvironmentApps { state: string; apps: { id: string; displayName: string; version?: string; runtimeState: string; health?: string; previewUrl?: string }[]; error?: string }
type Pending = { path: string; body: Record<string, unknown>; id?: string; kind: string };
const button = "hosty-sdk-button";
const field = "hosty-sdk-input";
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
  return <section data-hosty-sdk className="hosty-sandbox" aria-label="Sandbox environments"><SdkChromeStyles /><style>{styles}</style>
    <header className="hosty-sandbox-header"><div><h3 className="hosty-sandbox-title">Sandbox environments</h3><p className="hosty-sandbox-muted">Separate Core instances with their own apps, users and temporary data.</p></div>
      <div className="hosty-sandbox-actions"><button className={button} onClick={() => { setError(""); void refresh(); }}>Refresh sandboxes</button>
        {workspace && <button className={button} disabled={disabled || !workspace.worktrees.some(t => t.state === "active")} onClick={() => setCreating(!creating)}>Create sandbox</button>}</div></header>
    {busy && <SdkProgress label="Sandbox operation in progress" />}
    {creating && workspace && <CreateEnvironment workspace={workspace} disabled={disabled} onCreate={create} onCancel={() => setCreating(false)} />}
    {notice && <p role="status" className="hosty-sandbox-muted">{notice}</p>}
    {(error || readError) && <p role="alert" className="hosty-sandbox-error">{error || readError}</p>}
    {pending && <div className="hosty-sandbox-pending"><span>{busy && <SdkSpinner />}{busy ? `Sandbox ${pending.kind} is in progress…` : "The request outcome is not confirmed."}</span><button className={button} disabled={busy} onClick={() => void run(pending)}>Retry same request</button></div>}
    {loading ? <p role="status" className="hosty-sdk-status"><SdkSpinner />Loading sandboxes…</p> : !environments.length && !error && !readError && <p className="hosty-sandbox-muted">No active sandbox environments.</p>}
    {!workspace && consents.length > 0 && <details className="hosty-sandbox-box"><summary className="hosty-sandbox-summary">Saved launch permissions ({consents.length})</summary><p className="hosty-sandbox-fine">Revocation affects all matching launches and delegated access. Running children and their own accounts remain; use Stop or Delete sandbox to end them.</p><ul className="hosty-sandbox-list">{consents.map(grant => <li key={grant.id} className="hosty-sandbox-consent"><p>{grant.appId} · {grant.mode} · {grant.state}</p><p className="hosty-sandbox-path">{grant.target}</p><button className={button} disabled={disabled} onClick={() => { setBusy(true); void request(`/consents/${grant.id}/revoke`, {}).then(() => refresh()).catch(cause => setError(message(cause))).finally(() => setBusy(false)); }}>Revoke permission for {grant.appId}</button></li>)}</ul></details>}
    {environments.map(item => <article key={item.id} className="hosty-sandbox-box" aria-label={`Sandbox ${item.label}`}>
      <header className="hosty-sandbox-header"><div><h4 className="hosty-sandbox-title">{item.label} <span className="hosty-sandbox-state">{item.state}</span></h4>
        <p className="hosty-sandbox-fine">{item.mode === "source" ? "Core built from workspace source" : item.mode === "release" ? "Installed Core release" : "Current Core build"}{item.context?.workspaceId && workspaceHref && <> · <a className="hosty-sandbox-link" href={workspaceHref(item.context.workspaceId)}>Open workspace</a></>}</p></div>
        <div className="hosty-sandbox-actions">
          {item.state === "running" && link(item.previewUrl) && <a className={button} href={item.previewUrl + "/login"} target="_blank" rel="noreferrer">Open Core</a>}
          <button className={button} disabled={disabled || ["building", "starting", "stopping", "finishing", "cleanup-failed"].includes(item.state)} onClick={() => void command(item, item.state === "running" ? "stop" : "start")}>{item.state === "running" ? "Stop" : "Start"}</button>
          <button className={button + " hosty-sdk-danger"} disabled={disabled || item.state === "finishing"} onClick={() => setRemoving(item.id)}>{item.state === "cleanup-failed" ? "Retry deletion" : "Delete sandbox"}</button>
        </div></header>
      {item.limits && <p className="hosty-sandbox-fine">Reserved: {(item.limits.memoryBytes / 1073741824).toFixed(1)} GiB container memory · {item.limits.cpus} CPUs · {item.limits.pids} PIDs · {(item.limits.diskBytes / 1073741824).toFixed(1)} GiB soft disk limit. Released after deletion.</p>}
      {item.usage && <p className="hosty-sandbox-fine">{item.usage.state === "unknown" ? "Resource usage unavailable; the reservation remains active." : `Observed: ${(item.usage.containerMemoryBytes / 1048576).toFixed(0)} MiB containers · ${(item.usage.coreMemoryBytes / 1048576).toFixed(0)} MiB Core process · ${(item.usage.ownedDiskBytes / 1073741824).toFixed(2)} GiB owned data.`}</p>}
      {item.access && <div className="hosty-sandbox-consent" aria-label="Sandbox consent"><p>{item.access.state === "operator" ? "Operator launch" : item.access.state === "active" ? item.access.saved ? "Saved launch permission" : "Permission for this run" : item.access.state === "target-changed" ? "Core target changed or unavailable; review launch permission" : "Launch permission revoked or unavailable"}</p><p className="hosty-sandbox-fine">{item.access.description}</p>{item.access.grantId && ["active", "target-changed"].includes(item.access.state) && <button className={button} disabled={disabled} onClick={() => { setBusy(true); void request(`/${item.id}/consent/revoke`, {}).then(() => refresh()).catch(cause => setError(message(cause))).finally(() => setBusy(false)); }}>Revoke launch permission</button>}</div>}
      {item.error && <p role="alert" className="hosty-sandbox-error">{item.error}</p>}
      {item.state === "running" && <><EnvironmentApplications value={apps[item.id]} />
        {apps[item.id] && ["setup-required", "sign-in-required"].includes(apps[item.id].state) && <SetupAccount request={request} id={item.id} disabled={disabled} onDone={() => refresh()} />}</>}
      {removing === item.id && <div role="alertdialog" aria-label={`Delete ${item.label}`} className="hosty-sandbox-confirm"><p className="hosty-sandbox-text">Permanently delete this sandbox, all its apps, test users, data and caches? Workspace source and shared folders are preserved.</p><div className="hosty-sandbox-actions"><button className={button + " hosty-sdk-danger"} disabled={disabled} onClick={() => { setRemoving(null); void command(item, "finish"); }}>Delete permanently</button><button className={button} onClick={() => setRemoving(null)}>Cancel</button></div></div>}
    </article>)}
  </section>;
}
function EnvironmentApplications({ value }: { value?: EnvironmentApps }) {
  if (!value) return <p role="status" className="hosty-sdk-status"><SdkSpinner />Reading application status…</p>;
  if (value.state !== "ready") return <p role="status" className="hosty-sandbox-muted">{value.error ?? (value.state === "setup-required" ? "Set up a test administrator for this fresh Core." : "Application status is unavailable.")}</p>;
  if (!value.apps.length) return <p className="hosty-sandbox-muted">No apps installed in this sandbox yet.</p>;
  return <ul className="hosty-sandbox-list" aria-label="Sandbox applications">{value.apps.map(app => <li key={app.id} className="hosty-sandbox-app"><div><span className="hosty-sandbox-title">{app.displayName}</span><span className="hosty-sandbox-app-state">{app.runtimeState} · {app.health ?? "Health unknown"}</span></div>{app.runtimeState === "running" && link(app.previewUrl) && <a className={button} href={app.previewUrl} target="_blank" rel="noreferrer">Open preview<span className="hosty-sdk-sr-only"> for {app.displayName}</span></a>}</li>)}</ul>;
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
  return <form onSubmit={submit} className="hosty-sandbox-form" aria-label="Create workspace sandbox">
    <label className="hosty-sandbox-field">Sandbox name<input className={field} name="label" required maxLength={120} defaultValue="Workspace sandbox" /></label>
    <fieldset className="hosty-sandbox-group"><legend className="hosty-sandbox-legend">Attached worktrees</legend>{trees.map(t => <label key={t.id} className="hosty-sandbox-check"><input type="checkbox" checked={selected.includes(t.id)} onChange={e => setSelected(old => e.target.checked ? [...old, t.id] : old.filter(id => id !== t.id))} />{t.label}</label>)}</fieldset>
    <label className="hosty-sandbox-check"><input type="checkbox" checked={source} onChange={e => setSource(e.target.checked)} />Build Core from a worktree</label>
    {source && <div className="hosty-sandbox-fields"><label className="hosty-sandbox-field">Core worktree<select className={field} name="coreWorktreeId" required>{trees.filter(t => selected.includes(t.id)).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label><label className="hosty-sandbox-field">Core project, relative to worktree<input className={field} name="coreProject" required defaultValue="apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj" /></label></div>}
    <p className="hosty-sandbox-fine">Starts a fresh Core with separate users and data. Attached worktrees stay available until the sandbox is deleted.</p>
    <div className="hosty-sandbox-actions"><button className={button} type="submit" disabled={disabled || selected.length === 0 || selected.length > 16}>Create and start</button><button className={button} type="button" onClick={onCancel}>Cancel</button></div>
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
  return <form onSubmit={submit} aria-label="Sandbox administrator" className="hosty-sandbox-box"><p className="hosty-sandbox-text">Use a separate sandbox administrator. For an existing Core, enter its current account. Parent credentials are not copied.</p><div className="hosty-sandbox-fields"><label className="hosty-sandbox-text">Display name<input className={field} name="displayName" required autoComplete="off" /></label><label className="hosty-sandbox-text">Test email<input className={field} type="email" name="email" required autoComplete="off" /></label><label className="hosty-sandbox-text">Test password<input className={field} type="password" name="password" minLength={12} required autoComplete="new-password" /></label></div>{error && <p role="alert" className="hosty-sandbox-error">{error}</p>}<button className={button} disabled={disabled || busy}>{busy ? "Connecting…" : "Connect test account"}</button></form>;
}

const styles = `
.hosty-sandbox{padding:16px;border:1px solid var(--hs-border);border-radius:10px;background:var(--hs-card);min-width:0}
.hosty-sandbox>:not(style)+:not(style){margin-top:16px}.hosty-sandbox .hosty-sandbox-header{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px}.hosty-sandbox :where(h3,h4,p){margin:0}.hosty-sandbox h3{font:600 16px/24px var(--hs-font)}.hosty-sandbox h4{font:500 14px/22px var(--hs-font)}.hosty-sandbox :where(header,article,form)>p{margin-top:8px}.hosty-sandbox .hosty-sandbox-title{font-weight:500}
.hosty-sandbox .hosty-sandbox-muted{color:var(--hs-muted);font-size:13px;line-height:20px}.hosty-sandbox .hosty-sandbox-fine{color:var(--hs-muted);font-size:12px;line-height:20px}.hosty-sandbox .hosty-sandbox-path{overflow-wrap:anywhere;color:var(--hs-muted);font:400 12px/20px var(--hs-mono)}
.hosty-sandbox .hosty-sandbox-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.hosty-sandbox .hosty-sandbox-box,.hosty-sandbox .hosty-sandbox-form,.hosty-sandbox .hosty-sandbox-confirm{border:1px solid var(--hs-border);border-radius:10px;padding:12px;min-width:0}.hosty-sandbox .hosty-sandbox-box>:not(:first-child){margin-top:12px}.hosty-sandbox .hosty-sandbox-form{background:var(--hs-bg);display:flex;flex-direction:column;gap:12px}.hosty-sandbox .hosty-sandbox-confirm{background:var(--hs-danger-soft);border-color:var(--hs-danger);margin-top:12px}.hosty-sandbox-confirm>.hosty-sandbox-actions{margin-top:12px}
.hosty-sandbox .hosty-sandbox-error{padding:10px 12px;border:1px solid var(--hs-danger);border-radius:8px;color:var(--hs-danger);background:var(--hs-danger-soft)}.hosty-sandbox .hosty-sandbox-pending{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.hosty-sandbox-pending>span{display:flex;align-items:center;gap:8px}.hosty-sandbox .hosty-sandbox-state{display:inline-block;padding:1px 6px;margin-left:8px;border:1px solid var(--hs-border);border-radius:6px;color:var(--hs-muted);font:400 12px/18px var(--hs-font)}
.hosty-sandbox .hosty-sandbox-list{list-style:none;padding:0;margin:0}.hosty-sandbox .hosty-sandbox-list>li+li{border-top:1px solid var(--hs-border)}.hosty-sandbox .hosty-sandbox-consent{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 0}.hosty-sandbox .hosty-sandbox-app{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:10px 0}.hosty-sandbox-app-state{color:var(--hs-muted);margin-left:8px}
.hosty-sandbox .hosty-sandbox-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px}.hosty-sandbox .hosty-sandbox-field,.hosty-sandbox .hosty-sandbox-fields>label{display:flex;flex-direction:column;gap:6px;font:500 13px/20px var(--hs-font);min-width:0}.hosty-sandbox .hosty-sandbox-check{display:flex;align-items:flex-start;gap:8px;font-size:14px}.hosty-sandbox input[type=checkbox]{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--hs-brand)}.hosty-sandbox input[type=checkbox]:focus-visible{outline:2px solid var(--hs-brand);outline-offset:2px}
.hosty-sandbox .hosty-sandbox-group{min-width:0;border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.hosty-sandbox legend{font:500 13px/20px var(--hs-font);margin-bottom:8px}.hosty-sandbox .hosty-sandbox-summary{cursor:pointer;font-weight:500}.hosty-sandbox .hosty-sandbox-link{color:var(--hs-info);text-decoration:underline;text-underline-offset:3px}
`;
