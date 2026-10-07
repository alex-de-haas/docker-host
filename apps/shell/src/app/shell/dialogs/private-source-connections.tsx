"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InstallDialog, useInstallation } from "@hosty-sdk/app/install/react";
import { createInstallationClient, openInstallationConfirmation, type InstallationClient, type InstallationSource } from "@hosty-sdk/app/install";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useShellActions } from "../shell-context";
import { createSourceConnectionsApi, type SourceConnection, type SourceProfile, type SourceSend } from "../source/source-connections";
import { SourcePermissionHelp, isSourcePermissionError } from "../source/source-permission-help";
import { showCoreConfirmation } from "../core-confirmation";

type SourceAccess = { status: string; hasGitSource: boolean; access?: { manifest?: { connectionId: string }; git?: { connectionId: string } } };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function ConnectionSelect({ label, value, onChange, connections, current, disabled }: {
  label: string; value: string; onChange: (value: string) => void; connections: SourceConnection[]; current?: string; disabled?: boolean;
}) {
  return <div className="space-y-1 text-sm"><span>{label}</span>
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent position="popper">
        {current !== undefined && <SelectItem value="keep">Keep current ({current})</SelectItem>}
        <SelectItem value="public">Public / no connection</SelectItem>
        {connections.filter(c => c.status !== "unsupported").map(c => <SelectItem key={c.id} value={c.id}>{c.label}{c.status !== "connected" ? " — reconnect required" : ""}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

// The SDK may review again after runtime selection. Retain the selected accounts on every review.
export function withSourceConnections(client: InstallationClient, sourceConnections: InstallationSource["sourceConnections"]): InstallationClient {
  return { ...client, prepare: source => client.prepare({ ...source, ...(sourceConnections ? { sourceConnections } : {}) }) };
}

export function SourceInstallDialog({ client, source, onClose, onInstalled, coreOrigin, sendCsrfJson }: {
  client: InstallationClient; source?: InstallationSource; coreOrigin: string; sendCsrfJson: SourceSend;
  onClose: () => void; onInstalled: () => void;
}) {
  const api = useMemo(() => createSourceConnectionsApi(coreOrigin, sendCsrfJson), [coreOrigin, sendCsrfJson]);
  const [manifest, setManifest] = useState(source?.manifestPath ?? "");
  const [reviewing, setReviewing] = useState(false);
  const [connections, setConnections] = useState<SourceConnection[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [manifestConnection, setManifestConnection] = useState(source?.sourceConnections?.manifestConnectionId ?? "public");
  const [gitConnection, setGitConnection] = useState(source?.sourceConnections?.gitConnectionId ?? "public");
  useEffect(() => {
    const controller = new AbortController();
    void api.call("/source-connections", { signal: controller.signal }).then(r => r.json()).then((p: SourceProfile) => { if (!controller.signal.aborted) setConnections(p.connections); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [api]);
  const selectedClient = useMemo(() => withSourceConnections(client,
    manifestConnection === "public" && gitConnection === "public" ? undefined : {
      ...(manifestConnection === "public" ? {} : { manifestConnectionId: manifestConnection }),
      ...(gitConnection === "public" ? {} : { gitConnectionId: gitConnection }),
    }), [client, manifestConnection, gitConnection]);
  if (reviewing) return <InstallDialog client={selectedClient}
    source={{ ...source, manifestPath: manifest.trim() }} onClose={() => setReviewing(false)} onInstalled={onInstalled} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>Install app</DialogTitle><DialogDescription>Choose a manifest and, for private sources, one of your connected accounts. Core reviews the installation.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); setReviewing(true); }}>
      <label className="block space-y-1 text-sm">Manifest path or URL<Input required value={manifest} onChange={event => setManifest(event.target.value)} /></label>
      <ConnectionSelect label="Manifest connection" value={manifestConnection} onChange={setManifestConnection} connections={connections} />
      <ConnectionSelect label="Git source connection" value={gitConnection} onChange={setGitConnection} connections={connections} />
      {error ? <div className="space-y-2"><p className="text-sm text-muted-foreground">Private connections unavailable: {message(error)} Public installation is still available.</p>{isSourcePermissionError(error) && <SourcePermissionHelp coreOrigin={coreOrigin} />}</div>
        : <p className="text-sm text-muted-foreground">Manage accounts in Settings → Source connections.</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!manifest.trim()}>Review installation</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

export function PrivateSourceConnections({ appId }: { appId: string }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const api = useMemo(() => createSourceConnectionsApi(coreOrigin, sendCsrfJson), [coreOrigin, sendCsrfJson]);
  const client = useMemo(() => createInstallationClient({ baseUrl: `${coreOrigin}/api/installations`, request: sendCsrfJson }), [coreOrigin, sendCsrfJson]);
  const { flow, request, busy, error } = useInstallation(client);
  const [connections, setConnections] = useState<SourceConnection[]>([]);
  const [access, setAccess] = useState<SourceAccess | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [manifestConnection, setManifestConnection] = useState("keep");
  const [gitConnection, setGitConnection] = useState("keep");
  const dismiss = useRef<(() => void) | undefined>(undefined);
  const load = useCallback(async (signal?: AbortSignal) => {
    const [profile, source] = await Promise.all([
      api.call("/source-connections", { signal }).then(r => r.json()) as Promise<SourceProfile>,
      api.call(`/apps/${encodeURIComponent(appId)}/source-access`, { signal }).then(r => r.json()) as Promise<SourceAccess>,
    ]);
    return { profile, source };
  }, [api, appId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(({ profile, source }) => { if (!controller.signal.aborted) { setConnections(profile.connections); setAccess(source); setLoadError(null); } }).catch(cause => { if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause : new Error(String(cause))); });
    return () => { controller.abort(); dismiss.current?.(); };
  }, [load]);
  useEffect(() => { if (request?.status !== "pending") { dismiss.current?.(); dismiss.current = undefined; } }, [request?.status]);
  const frozen = !!request && request.status !== "draft";
  const current = (id?: string) => id ? connections.find(c => c.id === id)?.label ?? "saved account unavailable" : "public";
  const review = () => flow.review({ updateAppId: appId, sourceConnections: {
    ...(manifestConnection === "keep" ? {} : manifestConnection === "public" ? { clearManifestConnection: true } : { manifestConnectionId: manifestConnection }),
    ...(gitConnection === "keep" || !access?.hasGitSource ? {} : gitConnection === "public" ? { clearGitConnection: true } : { gitConnectionId: gitConnection }),
  } });
  const confirm = async () => {
    const popup = openInstallationConfirmation();
    const submitted = await flow.submit({}, false);
    if (submitted) dismiss.current = showCoreConfirmation(popup, submitted); else popup?.close();
  };
  return <section className="space-y-3 border-t p-4" aria-label="Source connections">
    <h3 className="font-medium">Source connections</h3>
    <p className="text-sm text-muted-foreground">Change the accounts used to read this app’s private sources. Core reviews and applies the update.</p>
    {loadError && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{message(loadError)}</p>{isSourcePermissionError(loadError) && <SourcePermissionHelp coreOrigin={coreOrigin} />}</div>}
    {!access && !loadError && <p role="status">Loading source connections…</p>}
    {access && <>
      {access.status !== "available" && access.status !== "public" && <p className="text-sm text-muted-foreground">Saved connections may need to be replaced. Unsupported providers cannot be used.</p>}
      <ConnectionSelect label="Manifest connection" value={manifestConnection} current={current(access.access?.manifest?.connectionId)} connections={connections} disabled={busy || frozen} onChange={value => { setManifestConnection(value); flow.clearReview(); }} />
      {access.hasGitSource && <ConnectionSelect label="Git source connection" value={gitConnection} current={current(access.access?.git?.connectionId)} connections={connections} disabled={busy || frozen} onChange={value => { setGitConnection(value); flow.clearReview(); }} />}
      {!frozen && <Button variant="outline" disabled={busy || (manifestConnection === "keep" && gitConnection === "keep")} onClick={() => void review()}>Review source update</Button>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {request?.updatePlan && !frozen && <div className="space-y-2 text-sm"><p>{request.updatePlan.displayName} · {request.updatePlan.targetVersion} · {request.updatePlan.targetRuntime}</p><Button disabled={busy} onClick={() => void confirm()}>Continue to Core confirmation</Button></div>}
    {frozen && <div className="space-y-2 text-sm" role="status">
      <p>{request.status === "pending" ? "Waiting for confirmation in Core." : request.status === "executing" ? "Applying source update…" : request.status === "succeeded" ? "Source update completed." : request.status === "denied" ? "Source update cancelled." : "Source update failed."}</p>
      {["succeeded", "denied", "failed"].includes(request.status) && <Button variant="outline" disabled={busy} onClick={() => { flow.clearReview(); setManifestConnection("keep"); setGitConnection("keep"); void load().then(({ profile, source }) => { setConnections(profile.connections); setAccess(source); setLoadError(null); }).catch(cause => setLoadError(cause instanceof Error ? cause : new Error(String(cause)))); }}>Refresh connections</Button>}
    </div>}
  </section>;
}
