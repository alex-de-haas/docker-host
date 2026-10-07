"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { createSourceConnectionsApi, type SourceProfile, type SourceConnection, type SourceSend } from "../source/source-connections";
import { SourcePermissionHelp, isSourcePermissionError } from "../source/source-permission-help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Connection = SourceConnection;
type Profile = SourceProfile;
type Device = { id: string; status: string; userCode: string; verificationUri: string; expiresAt: string; interval: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function SourceProviders({ coreOrigin, sendCsrfJson }: { coreOrigin: string; sendCsrfJson: SourceSend }) {
  const { call, send } = useMemo(() => createSourceConnectionsApi(coreOrigin, sendCsrfJson), [coreOrigin, sendCsrfJson]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [error, setError] = useState("");
  const [permissionMissing, setPermissionMissing] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [provider, setProvider] = useState("github");
  const [method, setMethod] = useState("device");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [privateRepositories, setPrivateRepositories] = useState(false);
  const [device, setDevice] = useState<Device | null>(null);
  const endpoint = "/source-connections";
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await call(endpoint, { cache: "no-store", signal });
    return await response.json() as Profile;
  }, [endpoint, call]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(value => { if (!controller.signal.aborted) { setProfile(value); setGitName(value.gitIdentity?.name ?? ""); setGitEmail(value.gitIdentity?.email ?? ""); } })
      .catch(cause => { if (!controller.signal.aborted) { setError(message(cause)); setPermissionMissing(isSourcePermissionError(cause)); } });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!device) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await send(`${endpoint}/device/${device.id}/poll`, {});
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
  }, [device, endpoint, load, send]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); return true; }
    catch (cause) { setError(message(cause)); setPermissionMissing(isSourcePermissionError(cause)); return false; }
    finally { setBusy(false); }
  };
  const saveIdentity = () => run(async () => {
    const response = await send(`${endpoint}/identity`, { gitIdentity: gitName.trim() || gitEmail.trim() ? { name: gitName.trim(), email: gitEmail.trim() } : null }, "PUT");
    const updated = await response.json() as Profile;
    setProfile(updated); setGitName(updated.gitIdentity?.name ?? ""); setGitEmail(updated.gitIdentity?.email ?? ""); setNotice("Git identity saved.");
  });
  const connect = () => run(async () => {
    try {
      const response = await send(`${endpoint}/${method}`, {
        label, provider, token: method === "pat" ? token : undefined, privateRepositories,
      });
      if (method === "device") setDevice(await response.json() as Device);
      else { setProfile(await load()); setAdding(false); setNotice("Account connected."); }
    } finally { setToken(""); }
  });
  const cancel = async () => {
    setToken("");
    const cancelled = await run(async () => {
      const id = device?.id;
      setDevice(null);
      if (id) await send(`${endpoint}/device/${id}`, undefined, "DELETE");
      setProfile(await load());
    });
    if (cancelled) setAdding(false);
  };
  const changeAdding = (open: boolean) => {
    if (busy) return;
    if (!open) { void cancel(); return; }
    setProvider("github"); setMethod("device"); setLabel("");
    setToken(""); setPrivateRepositories(false); setAdvanced(false); setError(""); setNotice(""); setAdding(true);
  };
  const update = (id: string, action: "rename" | "check" | "disconnect", nextLabel?: string) => run(async () => {
    try {
      await send(`${endpoint}/${id}${action === "check" ? "/check" : ""}`,
        action === "rename" ? { label: nextLabel } : undefined, action === "rename" ? "PUT" : action === "disconnect" ? "DELETE" : "POST");
      setNotice(action === "check" ? "Connection verified." : action === "rename" ? "Connection renamed." : "Connection removed from Hosty.");
    } finally { setProfile(await load()); }
  });
  const configured = profile?.providers.find(p => p.id === provider)?.authenticationMethods.includes("device");
  return <section className="flex max-w-2xl flex-col gap-6" aria-label="Source connections">
    <div><h2 className="text-lg font-medium">Source connections</h2><p className="text-sm text-muted-foreground">Your GitHub connections for repositories and pull requests.</p></div>
    {error && !adding && <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{error}</p>{permissionMissing && <SourcePermissionHelp coreOrigin={coreOrigin} />}</div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!profile && !error && <p>Loading source providers…</p>}
    {profile && <>
      <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void saveIdentity(); }}>
        <p className="text-sm text-muted-foreground">Git author (optional). Leave both empty to use a verified email from the selected provider account.</p>
        <Field><FieldLabel htmlFor="git-name">Git author name</FieldLabel><Input id="git-name" value={gitName} onChange={e => setGitName(e.target.value)} maxLength={200} /></Field>
        <Field><FieldLabel htmlFor="git-email">Git author email</FieldLabel><Input id="git-email" type="email" value={gitEmail} onChange={e => setGitEmail(e.target.value)} maxLength={254} /></Field>
        <Button type="submit" disabled={busy}>Save Git identity</Button>
      </form>
      <Dialog open={adding} onOpenChange={changeAdding}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between"><h3 className="font-medium">Connected accounts</h3>
          <DialogTrigger asChild><Button variant="outline" disabled={busy}>Add connection</Button></DialogTrigger></div>
        <p className="text-sm text-muted-foreground">Connect several accounts, including different accounts of the same provider. Connections belong to you and do not change how you sign in to Hosty.</p>
        {!profile.connections.length && <p className="text-sm text-muted-foreground">No connected accounts yet.</p>}
        {profile.connections.map(connection => <ConnectionCard key={connection.id} connection={connection} busy={busy} update={update} />)}
      </div>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Add connection</DialogTitle>
          <DialogDescription>Connect a GitHub account for repositories and pull requests.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void connect(); }}>
        {device ? <div className="flex flex-col gap-3">
          <p>Open the provider page and enter this code:</p>
          <DeviceCode key={device.id} code={device.userCode} />
          <Button asChild variant="outline"><a href={device.verificationUri} target="_blank" rel="noreferrer">Open authorization page</a></Button>
          <p role="status" className="text-sm text-muted-foreground">Waiting for authorization. Use the account you want to connect. Expires {new Date(device.expiresAt).toLocaleTimeString()}.</p>
        </div> : <FieldGroup>
          <Field><FieldLabel htmlFor="connection-provider">Provider</FieldLabel>
            <Select value={provider} disabled={busy} onValueChange={value => { setProvider(value); setToken(""); setError(""); }}>
              <SelectTrigger id="connection-provider" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent position="popper"><SelectGroup>
                {profile.providers.map(p => <SelectItem key={p.id} value={p.id}>{p.displayName}</SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>
          </Field>
          {method === "device" && configured && <p className="text-sm text-muted-foreground">You will confirm a one-time code on {profile.providers.find(p => p.id === provider)?.displayName}. Your account name will be used for this connection.</p>}
          {method === "device" && !configured && <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">Provider sign-in is not configured on this host. You can connect with a personal access token.</p>
            <Button type="button" variant="outline" disabled={busy} onClick={() => { setMethod("pat"); setAdvanced(true); }}>Use a personal access token</Button>
          </div>}
          {method === "device" && provider === "github" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={privateRepositories} onChange={e => setPrivateRepositories(e.target.checked)} />Request access to private repositories too</label>}
          <Collapsible open={advanced} onOpenChange={setAdvanced} className="flex flex-col gap-3">
            <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="self-start" disabled={busy}>Additional options</Button></CollapsibleTrigger>
            <CollapsibleContent>
              <FieldGroup>
                <Field><FieldLabel htmlFor="connection-method">Connection method</FieldLabel>
                  <Select value={method} disabled={busy} onValueChange={value => { setMethod(value); setToken(""); }}>
                    <SelectTrigger id="connection-method" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper"><SelectGroup>
                      <SelectItem value="device">Sign in with provider</SelectItem><SelectItem value="pat">Personal access token</SelectItem>
                    </SelectGroup></SelectContent>
                  </Select>
                </Field>
                <Field><FieldLabel htmlFor="connection-label">Connection name (optional)</FieldLabel><Input id="connection-label" placeholder="Use account name" value={label} onChange={e => setLabel(e.target.value)} maxLength={100} /></Field>
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
          {method === "pat" && <><Field><FieldLabel htmlFor="connection-token">Personal access token</FieldLabel><Input id="connection-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required /></Field><p className="text-xs text-muted-foreground">Core stores the token; it is never shown again. Provider permissions determine what this connection can do.</p></>}
        </FieldGroup>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
          {!device && <Button type="submit" disabled={busy || (method === "device" && !configured)}>{method === "device" ? `Connect ${profile.providers.find(p => p.id === provider)?.displayName ?? provider}` : "Connect account"}</Button>}
        </DialogFooter>
        </form>
      </DialogContent>
      </Dialog>
    </>}
  </section>;
}
function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };
  return <>
    <div className="flex items-center gap-2">
      <code className="select-all font-mono text-xl tracking-widest" aria-label="Verification code">{code}</code>
      <Button type="button" variant="ghost" size="icon-sm" title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy()}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
    <span className="sr-only" role="status">{copied ? "Code copied to clipboard" : ""}</span>
    {copyError && <Alert variant="destructive"><AlertDescription>Could not copy automatically. Select the code and copy it manually.</AlertDescription></Alert>}
  </>;
}
function ConnectionCard({ connection: c, busy, update }: { connection: Connection; busy: boolean; update: (id: string, action: "rename" | "check" | "disconnect", label?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false); const [label, setLabel] = useState(c.label); const [removing, setRemoving] = useState(false);
  return <article className="flex flex-col gap-2 rounded-lg border p-4" aria-label={c.label}>
    <div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium">{c.label}</h4><span className="text-xs text-muted-foreground">{c.status === "connected" ? "Connected" : c.status === "reconnect-required" ? "Reconnect required" : c.status === "unsupported" ? "Provider no longer supported" : "Provider unavailable"}</span></div>
    <p className="text-sm">{c.provider === "github" ? "GitHub" : c.provider === "azure-devops" ? "Azure DevOps (unsupported)" : c.provider} · {c.accountName}{c.organization ? ` · ${c.organization}` : ""}</p>
    {c.status === "unsupported" && <p className="text-sm text-muted-foreground">This saved account is retained but cannot be used. Select a supported connection for affected apps before disconnecting it.</p>}
    {c.checkedAt && <p className="text-xs text-muted-foreground">Last checked {new Date(c.checkedAt).toLocaleString()}</p>}
    {editing ? <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void update(c.id, "rename", label).then(saved => { if (saved) setEditing(false); }); }}>
      <Input aria-label={`Name for ${c.label}`} value={label} onChange={e => setLabel(e.target.value)} maxLength={100} required /><Button disabled={busy}>Save</Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel rename</Button>
    </form> : <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy || c.status === "unsupported"} onClick={() => void update(c.id, "check")}>Check connection</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setLabel(c.label); setEditing(true); }}>Rename</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>Disconnect</Button>
    </div>}
    {removing && <div className="flex flex-col gap-2"><p className="text-sm">Remove this connection from Hosty? To revoke the provider&apos;s authorization too, use the provider&apos;s account settings.</p>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void update(c.id, "disconnect")}>Remove connection</Button>
      <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>Keep connection</Button></div>}
  </article>;
}
