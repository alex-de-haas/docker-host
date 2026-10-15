"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxInstance, SandboxDiagnostics } from "@hosty-sdk/app/sandbox/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { fetchCore } from "../core-transport.js";
import { readCoreError } from "../core-api";
import { useShellActions } from "../shell-context";

type Pending = { id: string; action: string; requestId: string; expectedRevision: number };
export function SandboxInstances({ coreOrigin }: { coreOrigin: string }) {
  const { sendCsrfJson } = useShellActions();
  const [instances, setInstances] = useState<SandboxInstance[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, SandboxDiagnostics>>({});
  const [embedded, setEmbedded] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  // Mirrors `pending` for rendering: the retry button offers exactly the request the ref holds.
  const [retryable, setRetryable] = useState<Pending | null>(null);
  const key = `hosty:sandbox-operation:${coreOrigin}`;
  const observe = useCallback((instance: SandboxInstance) => {
    const request = pending.current;
    if (!request || request.id !== instance.id) return;
    const operation = instance.operations.find(item => item.id === request.requestId);
    if (!operation) return;
    if (operation.state === "succeeded" || operation.state === "failed") {
      pending.current = null; setRetryable(null); sessionStorage.removeItem(key); setNotice("");
      setError(operation.state === "failed" ? operation.message ?? operation.errorCode ?? "Operation failed." : "");
    } else if (operation.state === "running") {
      setNotice(`Sandbox ${request.action} is in progress.`); setError("");
    } else setError(operation.message ?? "Operation outcome is unknown. Retry the same request to inspect its journal.");
  }, [key]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetchCore(`${coreOrigin}/api/sandbox-instances`, { cache: "no-store", signal });
    if (!response.ok) throw new Error(await readCoreError(response));
    const data = await response.json() as { instances: SandboxInstance[] };
    if (!signal?.aborted) {
      setInstances(data.instances);
      const request = pending.current;
      if (request) {
        const current = data.instances.find(item => item.id === request.id);
        if (current) observe(current);
        else {
          const receipt = await fetchCore(`${coreOrigin}/api/sandbox-instances/${request.id}`, { cache: "no-store", signal });
          if (receipt.ok && !signal?.aborted) observe(await receipt.json() as SandboxInstance);
        }
      }
    }
  }, [coreOrigin, observe]);
  useEffect(() => {
    const controller = new AbortController();
    try { pending.current = JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { pending.current = null; }
    setRetryable(pending.current);
    if (pending.current) setError("A previous operation needs confirmation. Refresh state or retry the same request.");
    const load = () => refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) { setInstances([]); setError(cause instanceof Error ? cause.message : "Sandbox inventory unavailable."); } });
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh, key]);
  async function run(value: Pending) {
    pending.current = value; setRetryable(value); sessionStorage.setItem(key, JSON.stringify(value)); setBusy(true); setError("");
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/sandbox-instances/${value.id}/operations/${value.action}`, {
        requestId: value.requestId, expectedRevision: value.expectedRevision,
      });
      if (!response.ok) {
        // Only a readable Core rejection proves that this request was not accepted. Network,
        // proxy and unknown-outcome errors retain the replay identity until reconciliation.
        const rejected = await response.clone().json().catch(() => null) as { code?: string } | null;
        if (["sandbox_revision_stale", "sandbox_operation_capacity", "sandbox_metadata_quota",
          "sandbox_forbidden", "sandbox_not_found"].includes(rejected?.code ?? "")) {
          pending.current = null; setRetryable(null); sessionStorage.removeItem(key); setNotice("");
        }
        throw new Error(await readCoreError(response));
      }
      const instance = await response.json() as SandboxInstance;
      observe(instance); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation outcome unknown."); }
    finally { setBusy(false); }
  }
  return <Frame role="region" aria-label="Sandbox instances">
    <FrameHeader className="flex items-center justify-between gap-3 p-3"><div><h2 className="font-medium">Individual app sandboxes</h2><p className="text-xs text-muted-foreground">Temporary app instances with their own users and data.</p></div>
      <Button variant="ghost" size="sm" onClick={() => void refresh().then(() => setError("")).catch(cause => setError(String(cause)))}>Refresh</Button></FrameHeader>
    <FramePanel className="space-y-3 p-3">
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error} {retryable && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(retryable)}>Retry same request</Button>}</p>}
      {!instances.length && !error && <p className="text-sm text-muted-foreground">No sandbox instances. Create one through Harness or an authorized QA app.</p>}
      {instances.map(instance => <div key={instance.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
        <div className="min-w-0"><div className="flex flex-wrap gap-2"><span className="font-medium">{instance.appId}</span><Badge variant="outline">Sandbox · {instance.state}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">{instance.context?.workspaceId ? `Workspace ${instance.context.workspaceId.slice(0, 10)}` : "Independent run"} · {instance.source.kind} · {instance.users.length} test users</p>
          {instance.metrics && <p className="mt-1 text-xs text-muted-foreground">RAM {instance.metrics.memoryBytes == null ? "unknown" : `${(instance.metrics.memoryBytes / 1048576).toFixed(1)} MiB`} · Sampled peak {instance.metrics.sampledPeakMemoryBytes == null ? "unknown" : `${(instance.metrics.sampledPeakMemoryBytes / 1048576).toFixed(1)} MiB`}</p>}
          {instance.storage && <p className="mt-1 text-xs text-muted-foreground">Data {(instance.storage.dataBytes / 1048576).toFixed(1)} MiB · Cache {(instance.storage.cacheBytes / 1048576).toFixed(1)} MiB · Evidence {(instance.storage.evidenceBytes / 1048576).toFixed(1)} MiB{instance.storage.warning ? " · Storage near limit" : ""}</p>}
          {instance.errorCode && <p role="status" className="text-xs text-destructive">{instance.errorCode}</p>}</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => {
            setBusy(true); void fetchCore(`${coreOrigin}/api/sandbox-instances/${instance.id}/diagnostics`, { cache: "no-store" })
              .then(async response => { if (!response.ok) throw new Error(await readCoreError(response));
                const value = await response.json() as SandboxDiagnostics; setDiagnostics(old => ({ ...old, [instance.id]: value })); })
              .catch(cause => setError(String(cause))).finally(() => setBusy(false));
          }}>View logs</Button>
          {instance.state === "ready" && instance.previewUrl && <details className="text-sm"><summary className="cursor-pointer p-2">Test personas</summary><div className="flex flex-wrap gap-2">{instance.users.filter(user => user.enabled).map(user => <Button key={user.id} asChild variant="outline" size="sm"><a href={`${instance.previewUrl}?hosty_sandbox_persona=${encodeURIComponent(user.id)}`} target="_blank" rel="noreferrer">{user.displayName} · {user.role}</a></Button>)}</div></details>}
          {instance.state === "ready" && instance.previewUrl && <Button asChild variant="outline" size="sm"><a href={`${instance.previewUrl}?hosty_sandbox_persona=core`} target="_blank" rel="noreferrer">Open preview</a></Button>}
          {instance.state === "ready" && instance.previewUrl && <Button variant="outline" size="sm" onClick={() => setEmbedded(embedded === instance.id ? null : instance.id)}>{embedded === instance.id ? "Hide preview" : "Embed preview"}</Button>}
          {(instance.state === "ready" ? ["stop", "restart"] : ["start"]).map(action => <Button key={action} variant="outline" size="sm" disabled={busy || !!retryable} onClick={() => void run({ id: instance.id, action, requestId: crypto.randomUUID(), expectedRevision: instance.revision })}>{action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"}</Button>)}
          <Button variant="ghost" size="sm" disabled={busy || !!retryable} onClick={() => { if (window.confirm("Finish this sandbox and delete its test users, data, caches and evidence? Export needed results first. Source worktrees are retained.")) void run({ id: instance.id, action: "dispose", requestId: crypto.randomUUID(), expectedRevision: instance.revision }); }}>Finish sandbox</Button></div>
        {diagnostics[instance.id] && <details open className="w-full text-xs"><summary>Service logs · {diagnostics[instance.id].state}</summary>
          {diagnostics[instance.id].errorCode && <p>{diagnostics[instance.id].errorCode}</p>}
          {diagnostics[instance.id].services.map(log => <div key={log.service}><p>{log.service} · {log.state}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{log.text || "No retained output."}</pre></div>)}
        </details>}
        {embedded === instance.id && instance.state === "ready" && instance.previewUrl && <div className="w-full space-y-2">
          <p className="text-xs text-muted-foreground">Use Open preview to sign in with your Core account, then refresh this embedded view.</p>
          <iframe key={`${instance.id}:${instance.generation}:${instance.dataRevision}`} title={`${instance.appId} sandbox preview`} src={instance.previewUrl}
            className="h-[32rem] w-full rounded border" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
        </div>}
      </div>)}
    </FramePanel>
  </Frame>;
}
