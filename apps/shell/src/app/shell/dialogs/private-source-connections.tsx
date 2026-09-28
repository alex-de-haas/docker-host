"use client";

import { useEffect, useMemo, useState } from "react";
import { InstallDialog } from "@hosty-sdk/app/install/react";
import { createInstallationClient, openInstallationConfirmation, showInstallationConfirmation } from "@hosty-sdk/app/install";
import type { InstallationClient, InstallationSource } from "@hosty-sdk/app/install";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { readCoreError } from "../core-api";
import { useShellActions } from "../shell-context";

type Choice = { manifestConnectionId?: string; gitConnectionId?: string };
type Connection = { id: string; label: string; provider: string; accountName: string; organization: string; status: string };
type Grant = { connectionId: string; label: string; accountName: string; repository: string };
type Access = { manifestUrl?: string; status: string; access?: { manifest?: Grant; git?: Grant } };
type Send = (url: string, body?: unknown, method?: string) => Promise<Response>;
const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value);

function ConnectionFields({ coreOrigin, value, onChange, existing }: {
  coreOrigin: string; value: Choice; onChange: (value: Choice) => void; existing?: Access;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${coreOrigin}/api/profile`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(await readCoreError(response)); return response.json() as Promise<{ connections: Connection[] }>; })
      .then(profile => { if (!controller.signal.aborted) setConnections(profile.connections); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [coreOrigin]);
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Public sources need no connection. For private sources, select your account for each resource. Add accounts in <a className="underline" href="/settings?tab=profile">Profile</a>.</p>
    {error && <p role="alert">{error}</p>}
    {([['manifestConnectionId', 'Manifest', existing?.access?.manifest], ['gitConnectionId', 'Git source', existing?.access?.git]] as const).map(([key, label, grant]) => <label key={key} className="block space-y-1 text-sm">
      <span>{label} connection</span>
      {grant && <p className="text-muted-foreground">Current: {grant.label} ({grant.accountName}) · {grant.repository}</p>}
      <select className="w-full rounded-md border bg-background p-2" value={value[key] ?? ""} onChange={event => onChange({ ...value, [key]: event.target.value || undefined })}>
        <option value="">{grant ? "Keep current connection" : "Public / no connection"}</option>
        {connections.map(c => <option key={c.id} value={c.id}>{c.label} · {c.accountName}{c.organization ? ` · ${c.organization}` : ""} ({c.provider}, {c.status})</option>)}
      </select>
    </label>)}
    <p className="text-xs text-muted-foreground">Core asks you to confirm continued access for installation and background updates. Your credentials stay in Core.</p>
  </div>;
}

export function SourceInstallDialog({ client, source, coreOrigin, sendCsrfJson, onClose, onInstalled }: {
  client: InstallationClient; source?: InstallationSource; coreOrigin: string; sendCsrfJson: Send;
  onClose: () => void; onInstalled: () => void;
}) {
  const [manifest, setManifest] = useState(source?.manifestPath ?? "");
  const [choice, setChoice] = useState<Choice>({});
  const [reviewing, setReviewing] = useState(false);
  const privateClient = useMemo(() => createInstallationClient({ baseUrl: `${coreOrigin}/api/installations`,
    request: (url, body, method) => sendCsrfJson(url, url === `${coreOrigin}/api/installations` ? { ...(body as object), sourceConnections: choice } : body, method),
  }), [choice, coreOrigin, sendCsrfJson]);
  if (reviewing) return <InstallDialog client={choice.manifestConnectionId || choice.gitConnectionId ? privateClient : client}
    source={{ ...source, manifestPath: manifest.trim() }} onClose={() => setReviewing(false)} onInstalled={onInstalled} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>Install app</DialogTitle></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); setReviewing(true); }}>
      <label className="block space-y-1 text-sm">Manifest path or URL<Input required value={manifest} onChange={event => setManifest(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Private manifests: GitHub raw/blob URL, or Azure repository URL with ?path=/manifest.json&amp;version=GBmain.</p>
      <ConnectionFields coreOrigin={coreOrigin} value={choice} onChange={setChoice} />
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!manifest.trim()}>Review installation</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

export function PrivateSourceConnections({ appId }: { appId: string }) {
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const [access, setAccess] = useState<Access | null>(null);
  const [choice, setChoice] = useState<Choice>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const client = useMemo(() => createInstallationClient({ baseUrl: `${coreOrigin}/api/installations`, request: sendCsrfJson }), [coreOrigin, sendCsrfJson]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/source-access`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(await readCoreError(response)); return response.json() as Promise<Access>; })
      .then(value => { if (!controller.signal.aborted) setAccess(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [appId, coreOrigin, revision]);
  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await client.status(pending);
        if (disposed) return;
        if (result.status === "succeeded" || result.status === "failed" || result.status === "denied") {
          setPending(null); setBusy(false);
          if (result.status === "succeeded") { setNotice("Source connections updated."); setChoice({}); setRevision(n => n + 1); void refresh(); }
          else setError(result.error ?? "The source update was cancelled.");
        } else timer = setTimeout(() => void poll(), 1500);
      } catch (cause) { if (!disposed) { setError(errorMessage(cause)); setPending(null); setBusy(false); } }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, pending, refresh]);
  async function review() {
    const popup = openInstallationConfirmation();
    setBusy(true); setError(""); setNotice("");
    try {
      const input = { updateAppId: appId, sourceConnections: choice };
      const draft = await client.prepare(input);
      const submitted = await client.submit(draft.id, {}, true);
      showInstallationConfirmation(popup, submitted);
      setPending(submitted.id); setApprovalUrl(submitted.approvalUrl); setNotice("Confirm the source connections and app update in the Core window.");
    } catch (cause) { popup?.close(); setError(errorMessage(cause)); setBusy(false); }
  }
  return <section className="space-y-3 border-t p-4">
    <h3 className="font-medium">Repository connections</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {pending && approvalUrl && <a href={approvalUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open Core confirmation</a>}
    {access?.status === "reconnect-required" && <p role="alert" className="text-sm">Access is missing. Reconnect in Profile, then select the replacement below. The installed app keeps running.</p>}
    {access?.manifestUrl && <><ConnectionFields coreOrigin={coreOrigin} value={choice} onChange={setChoice} existing={access} />
      <Button type="button" disabled={busy || !(choice.manifestConnectionId || choice.gitConnectionId)} onClick={() => void review()}>Review source connections</Button></>}
    {access && !access.manifestUrl && <p className="text-sm text-muted-foreground">This app uses a local manifest. Private manifest connections apply to URL installations.</p>}
  </section>;
}
