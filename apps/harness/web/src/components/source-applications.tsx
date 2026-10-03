"use client";

import { useMemo, useState } from "react";
import { createInstallationClient, openInstallationConfirmation, showInstallationConfirmation } from "@hosty-sdk/app/install";
import { useInstallation } from "@hosty-sdk/app/install/react";
import { call } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Connection = { id: string; label: string };
type Binding = { connectionId: string };
type SourceAccess = { manifestUrl?: string; status: string; hasGitSource: boolean; access?: { manifest?: Binding; git?: Binding } };

/** Source selection stays with Harness; Core owns the final decision and provider credentials. */
export function SourceApplications({ connections }: { connections: Connection[] }) {
  const client = useMemo(() => createInstallationClient({ baseUrl: "/installations", request: (url, body, method = "POST") =>
    call(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }), []);
  const { flow, request, busy, error } = useInstallation(client);
  const [mode, setMode] = useState("install");
  const [appId, setAppId] = useState("");
  const [loadedId, setLoadedId] = useState("");
  const [access, setAccess] = useState<SourceAccess | null>(null);
  const [manifest, setManifest] = useState("");
  const [runtime, setRuntime] = useState("");
  const [manifestConnection, setManifestConnection] = useState("");
  const [gitConnection, setGitConnection] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [autostart, setAutostart] = useState(true);
  const frozen = !!request && request.status !== "draft";
  const locked = busy || loading || frozen;
  const clear = () => flow.clearReview();
  const readBindings = async () => {
    setLoading(true); setLoadError(""); setAccess(null); setLoadedId(""); clear();
    try {
      const value = await (await call(`/apps/${encodeURIComponent(appId.trim())}/source-access`)).json() as SourceAccess;
      setAccess(value); setLoadedId(appId.trim()); setManifest(value.manifestUrl ?? "");
      setManifestConnection("keep"); setGitConnection("keep");
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "Could not read source connections."); }
    finally { setLoading(false); }
  };
  const review = async () => {
    const sourceConnections = {
      ...(manifestConnection === "keep" ? {} : manifestConnection ? { manifestConnectionId: manifestConnection } : { clearManifestConnection: true }),
      ...(gitConnection === "keep" ? {} : gitConnection ? { gitConnectionId: gitConnection } : { clearGitConnection: true }),
    };
    await flow.review({ ...(mode === "update" ? { updateAppId: loadedId } : {}),
      ...(manifest.trim() ? { manifestPath: manifest.trim() } : {}), ...(runtime.trim() ? { selectedRuntime: runtime.trim() } : {}), sourceConnections });
    const plan = flow.snapshot().request?.plan;
    setSettings(Object.fromEntries((plan?.settings ?? []).map(s => [s.key, s.secret ? "" : s.defaultValue ?? ""])));
    setAutostart(plan?.defaultAutostart ?? true);
  };
  const confirm = async () => {
    const popup = openInstallationConfirmation();
    const values = Object.fromEntries((request?.plan?.settings ?? []).filter(s => !s.secret || settings[s.key]).map(s => [s.key, settings[s.key] ?? ""]));
    const submitted = await flow.submit(values, autostart);
    if (submitted) showInstallationConfirmation(popup, submitted); else popup?.close();
  };
  const select = (label: string, value: string, change: (value: string) => void, binding?: Binding) => <label className="flex flex-col gap-1 text-sm">{label}
    <select className="rounded-md border bg-background p-2" value={value} disabled={locked} onChange={e => { change(e.target.value); clear(); }}>
      {mode === "update" && <option value="keep">Keep current connection{binding ? ` (${connections.find(c => c.id === binding.connectionId)?.label ?? "saved account unavailable"})` : " (public)"}</option>}
      <option value="">Public / no connection</option>
      {connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select></label>;
  const plan = request?.plan;
  const update = request?.updatePlan;
  return <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Application sources">
    <h3 className="font-medium">Application sources</h3>
    <p className="text-sm text-muted-foreground">Install from a manifest or reconnect an installed app to your source accounts. Hosty Core reviews and confirms every installation or update.</p>
    <label className="flex flex-col gap-1 text-sm">Operation<select className="rounded-md border bg-background p-2" value={mode} disabled={locked} onChange={e => {
      setMode(e.target.value); setAccess(null); setLoadedId(""); setManifest(""); setRuntime(""); setManifestConnection(e.target.value === "update" ? "keep" : ""); setGitConnection(e.target.value === "update" ? "keep" : ""); clear();
    }}><option value="install">Install app</option><option value="update">Update source connections</option></select></label>
    {mode === "update" && <><label className="flex flex-col gap-1 text-sm">Installed app ID<Input value={appId} disabled={locked} onChange={e => { setAppId(e.target.value); setLoadedId(""); setAccess(null); clear(); }} /></label>
      <Button variant="outline" disabled={locked || !appId.trim()} onClick={() => void readBindings()}>Load source connections</Button>
      {access?.status === "reconnect-required" && <p role="status">A saved connection needs to be replaced or changed to public access.</p>}</>}
    {(mode === "install" || loadedId) && <>
      <label className="flex flex-col gap-1 text-sm">Manifest path or URL<Input value={manifest} disabled={locked} onChange={e => { setManifest(e.target.value); clear(); }} /></label>
      {mode === "update" && <p className="text-xs text-muted-foreground">Leave the manifest field empty to keep the installed source.</p>}
      <label className="flex flex-col gap-1 text-sm">Runtime (optional)<Input value={runtime} disabled={locked} onChange={e => { setRuntime(e.target.value); clear(); }} placeholder="Use default / keep current" /></label>
      {select("Manifest connection", manifestConnection, setManifestConnection, access?.access?.manifest)}
      {(mode === "install" || access?.hasGitSource) && select("Git source connection", gitConnection, setGitConnection, access?.access?.git)}
      <Button variant="outline" disabled={locked || (mode === "install" && !manifest.trim())} onClick={() => void review()}>Review request</Button>
    </>}
    {loading && <p role="status">Loading source connections…</p>}
    {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error || loadError}</p>}
    {(plan || update) && <div className="flex flex-col gap-3">
      <p>{plan?.displayName ?? update?.displayName} · {plan?.targetVersion ?? update?.targetVersion} · {plan?.targetRuntime ?? update?.targetRuntime}</p>
      {plan?.targetRuntimeType === "localCommand" && <p className="text-sm">This runtime executes commands directly on the host. Only install code you trust.</p>}
      {plan?.settings.map(s => <label key={s.key} className="flex flex-col gap-1 text-sm">{s.label || s.key}{s.required ? " (required)" : ""}
        {s.type === "select" && s.options?.length && !s.secret ? <select value={settings[s.key] ?? ""} disabled={locked} onChange={e => setSettings(v => ({ ...v, [s.key]: e.target.value }))}>
          <option value="">Select a value</option>{s.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select> : <Input type={s.secret ? "password" : s.type === "number" ? "number" : "text"} autoComplete="off" value={settings[s.key] ?? ""} disabled={locked} onChange={e => setSettings(v => ({ ...v, [s.key]: e.target.value }))} />}
        {s.description && <span className="text-xs text-muted-foreground">{s.description}</span>}</label>)}
      {plan && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autostart} disabled={locked} onChange={e => setAutostart(e.target.checked)} />Start automatically</label>}
      {!frozen && <Button disabled={busy} onClick={() => void confirm()}>Continue to Core confirmation</Button>}
    </div>}
    {frozen && <div role="status" className="text-sm">
      <p>{request.status === "pending" ? "Waiting for confirmation in Hosty Core." : request.status === "executing" ? "Core is applying the request…" : request.status === "succeeded" ? "Request completed." : request.status === "denied" ? "Request cancelled." : "Request failed. Review a new request to retry."}</p>
      {request.status === "pending" && <a className="underline" href={request.approvalUrl} target="_blank" rel="noopener noreferrer">Open Core confirmation</a>}
      {["succeeded", "denied", "failed"].includes(request.status) && <Button variant="outline" onClick={() => window.location.reload()}>New request</Button>}
    </div>}
  </section>;
}
