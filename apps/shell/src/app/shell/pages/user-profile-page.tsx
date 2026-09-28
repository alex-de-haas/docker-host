"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";

type Connection = { id: string; label: string; provider: string; organization: string; accountId: string; accountName: string;
  method: string; status: string; checkedAt?: string; expiresAt?: string };
type Profile = { id: string; email?: string; displayName?: string; connections: Connection[]; providers: { gitHubDevice: boolean; azureDevice: boolean } };
type Device = { id: string; status: string; userCode: string; verificationUri: string; expiresAt: string; interval: number };
type Send = (url: string, body?: unknown, method?: string) => Promise<Response>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function UserProfilePage({ coreOrigin, sendCsrfJson, onSaved }: { coreOrigin: string; sendCsrfJson: Send; onSaved: () => Promise<void> }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("github");
  const [method, setMethod] = useState("device");
  const [label, setLabel] = useState("");
  const [organization, setOrganization] = useState("");
  const [tenant, setTenant] = useState("");
  const [token, setToken] = useState("");
  const [privateRepositories, setPrivateRepositories] = useState(false);
  const [device, setDevice] = useState<Device | null>(null);
  const endpoint = `${coreOrigin}/api/profile`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { credentials: "include", cache: "no-store", signal });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) throw new Error(await readCoreError(response));
    return await response.json() as Profile;
  }, [endpoint, coreOrigin]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(value => { if (!controller.signal.aborted) { setProfile(value); setName(value.displayName ?? ""); } })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!device) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await sendCsrfJson(`${endpoint}/connections/device/${device.id}/poll`, {});
        const next = await response.json() as Device;
        if (!active) return;
        if (next.status === "connected") {
          setDevice(null); setAdding(false); setNotice("Account connected."); setProfile(await load());
        } else setDevice(next);
      } catch (cause) {
        if (active) { setError(message(cause)); setDevice(null); }
      }
    }, Math.max(device.interval, 5) * 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [device, endpoint, sendCsrfJson, load]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); return true; }
    catch (cause) { setError(message(cause)); return false; }
    finally { setBusy(false); }
  };
  const saveName = () => run(async () => {
    const response = await sendCsrfJson(endpoint, { displayName: name }, "PUT");
    const updated = await response.json() as Profile;
    setProfile(updated); setName(updated.displayName ?? ""); setNotice("Profile saved."); await onSaved();
  });
  const connect = () => run(async () => {
    try {
      const response = await sendCsrfJson(`${endpoint}/connections/${method}`, {
        label, provider, organization, tenant: tenant || undefined, token: method === "pat" ? token : undefined, privateRepositories,
      });
      if (method === "device") setDevice(await response.json() as Device);
      else { setProfile(await load()); setAdding(false); setNotice("Account connected."); }
    } finally { setToken(""); }
  });
  const cancel = () => run(async () => {
    const id = device?.id;
    setDevice(null);
    if (id) await sendCsrfJson(`${endpoint}/connections/device/${id}`, undefined, "DELETE");
    setAdding(false); setToken(""); setProfile(await load());
  });
  const update = (id: string, action: "rename" | "check" | "disconnect", nextLabel?: string) => run(async () => {
    try {
      await sendCsrfJson(`${endpoint}/connections/${id}${action === "check" ? "/check" : ""}`,
        action === "rename" ? { label: nextLabel } : undefined, action === "rename" ? "PUT" : action === "disconnect" ? "DELETE" : "POST");
      setNotice(action === "check" ? "Connection verified." : action === "rename" ? "Connection renamed." : "Connection removed from Hosty.");
    } finally { setProfile(await load()); }
  });
  const configured = provider === "github" ? profile?.providers.gitHubDevice : profile?.providers.azureDevice;
  return <section className="max-w-2xl space-y-6" aria-label="Your profile">
    <div><h2 className="text-lg font-medium">Your profile</h2><p className="text-sm text-muted-foreground">Your name and connected accounts on this host.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!profile && !error && <p>Loading profile…</p>}
    {profile && <>
      <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void saveName(); }}>
        <p className="text-sm text-muted-foreground">{profile.email}</p>
        <Label htmlFor="profile-name">Display name</Label>
        <Input id="profile-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required />
        <Button type="submit" disabled={busy || !name.trim()}>Save name</Button>
      </form>
      <div className="space-y-3">
        <div className="flex items-center justify-between"><h3 className="font-medium">Connected accounts</h3>
          <Button variant="outline" disabled={busy || adding} onClick={() => { setAdding(true); setLabel(""); setError(""); setNotice(""); }}>Add connection</Button></div>
        <p className="text-sm text-muted-foreground">Connect several accounts, including different accounts of the same provider. Connections belong to you and do not change how you sign in to Hosty.</p>
        {!profile.connections.length && <p className="text-sm text-muted-foreground">No connected accounts yet.</p>}
        {profile.connections.map(connection => <ConnectionCard key={connection.id} connection={connection} busy={busy} update={update} />)}
      </div>
      {adding && <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void connect(); }}>
        <h3 className="font-medium">Connect an account</h3>
        {device ? <div className="space-y-3">
          <p>Open the provider page and enter this code:</p><p className="font-mono text-xl tracking-widest" aria-label="Verification code">{device.userCode}</p>
          <Button asChild variant="outline"><a href={device.verificationUri} target="_blank" rel="noreferrer">Open authorization page</a></Button>
          <p role="status" className="text-sm text-muted-foreground">Waiting for authorization. Use the account you want to connect. Expires {new Date(device.expiresAt).toLocaleTimeString()}.</p>
        </div> : <>
          <Label htmlFor="connection-label">Connection name</Label><Input id="connection-label" placeholder="Personal GitHub or Work" value={label} onChange={e => setLabel(e.target.value)} maxLength={100} required />
          <Label htmlFor="connection-provider">Provider</Label><select id="connection-provider" className="w-full rounded-md border bg-background p-2 text-sm" value={provider} onChange={e => setProvider(e.target.value)}>
            <option value="github">GitHub</option><option value="azure-devops">Azure DevOps Services</option></select>
          {provider === "azure-devops" && <>
            <Label htmlFor="connection-org">Organization</Label><Input id="connection-org" placeholder="Organization in dev.azure.com/organization" value={organization} onChange={e => setOrganization(e.target.value)} required />
            {method === "device" && <><Label htmlFor="connection-tenant">Microsoft tenant ID (optional)</Label><Input id="connection-tenant" value={tenant} onChange={e => setTenant(e.target.value)} placeholder="Tenant UUID; leave empty for organization accounts" /></>}
          </>}
          <Label htmlFor="connection-method">Connection method</Label><select id="connection-method" className="w-full rounded-md border bg-background p-2 text-sm" value={method} onChange={e => setMethod(e.target.value)}>
            <option value="device">Sign in with provider</option><option value="pat">Personal access token</option></select>
          {method === "device" && !configured && <p className="text-sm text-muted-foreground">Provider sign-in is not configured on this host. Ask the host operator to configure its OAuth registration, or use a personal access token.</p>}
          {method === "device" && provider === "github" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={privateRepositories} onChange={e => setPrivateRepositories(e.target.checked)} />Request access to private repositories too</label>}
          {method === "pat" && <><Label htmlFor="connection-token">Personal access token</Label><Input id="connection-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required /><p className="text-xs text-muted-foreground">Core stores the token; it is never shown again. Provider permissions determine what this connection can do.</p></>}
          <Button type="submit" disabled={busy || !label.trim() || (method === "device" && !configured)}>Connect account</Button>
        </>}
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
      </form>}
    </>}
  </section>;
}
function ConnectionCard({ connection: c, busy, update }: { connection: Connection; busy: boolean; update: (id: string, action: "rename" | "check" | "disconnect", label?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false); const [label, setLabel] = useState(c.label); const [removing, setRemoving] = useState(false);
  return <article className="space-y-2 rounded-lg border p-4" aria-label={c.label}>
    <div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">{c.label}</h4><span className="text-xs text-muted-foreground">{c.status === "connected" ? "Connected" : c.status === "reconnect-required" ? "Reconnect required" : "Provider unavailable"}</span></div>
    <p className="text-sm">{c.provider === "github" ? "GitHub" : "Azure DevOps"} · {c.accountName}{c.organization ? ` · ${c.organization}` : ""}</p>
    {c.checkedAt && <p className="text-xs text-muted-foreground">Last checked {new Date(c.checkedAt).toLocaleString()}</p>}
    {editing ? <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void update(c.id, "rename", label).then(saved => { if (saved) setEditing(false); }); }}>
      <Input aria-label={`Name for ${c.label}`} value={label} onChange={e => setLabel(e.target.value)} maxLength={100} required /><Button disabled={busy}>Save</Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel rename</Button>
    </form> : <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(c.id, "check")}>Check connection</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setLabel(c.label); setEditing(true); }}>Rename</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>Disconnect</Button>
    </div>}
    {removing && <div className="space-y-2"><p className="text-sm">Remove this connection from Hosty? To revoke the provider&apos;s authorization too, use the provider&apos;s account settings.</p>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void update(c.id, "disconnect")}>Remove connection</Button>
      <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>Keep connection</Button></div>}
  </article>;
}
