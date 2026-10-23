"use client";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { developmentRequest } from "@/lib/development-api";
type Check = { id: string; service: string; digest?: string; state: string; message?: string;
  recipe: { command: string[]; cwd: string; timeoutSeconds: number };
  result?: { state: string; at: string; exitCode?: number; output?: string } };
type Checks = { state: string; message?: string; checks: Check[]; readiness?: { status: string }; readinessError?: string; observedAt?: string };
type Reply<T> = { status: number; body: T & { message?: string } };

export function PreviewChecks({ workspaceId, environmentId, appId, refresh, compact = false }: {
  workspaceId: string; environmentId: string; appId: string; refresh: () => void; compact?: boolean;
}) {
  const path = `/${workspaceId}/previews/${environmentId}/${encodeURIComponent(appId)}`;
  const [checks, setChecks] = useState<Checks | null>(null), [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const [checkRevision, setCheckRevision] = useState(0);
  const request = useRef<{ id: string; digest: string; requestId: string } | null>(null);
  async function call<T>(action: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const reply = await developmentRequest<Reply<T>>(`${path}/${action}`, input, signal);
    if (reply.status < 200 || reply.status >= 300) throw new Error(reply.body?.message ?? `Preview request failed (${reply.status}).`);
    return reply.body;
  }
  useEffect(() => {
    if (!opened || busy) return;
    const abort = new AbortController(); let loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const value = await developmentRequest<Reply<Checks>>(`${path}/checks`, {}, abort.signal);
        if (value.status !== 200) throw new Error(value.body?.message ?? "Check status unavailable.");
        if (!abort.signal.aborted) { setChecks(value.body); setError(""); }
      } catch (e) { if (!abort.signal.aborted) { setChecks(null); setError(e instanceof Error ? e.message : String(e)); } }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [path, opened, busy, checkRevision]);
  async function run(check: Check) {
    if (!check.digest) return;
    setBusy(true); setError("");
    if (request.current?.id !== check.id || request.current?.digest !== check.digest)
      request.current = { id: check.id, digest: check.digest, requestId: crypto.randomUUID() };
    try { setChecks(await call<Checks>("run", request.current)); request.current = null; }
    catch (e) { setChecks(null); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); refresh(); }
  }
  async function restart() {
    setBusy(true); setError(""); setLogs(null);
    try { await call("restart"); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); refresh(); }
  }
  async function showLogs() {
    setBusy(true); setError(""); setLogs(null);
    try { const value = await call<{ text: string }>("logs"); setLogs(value.text.length > 16384 ? "[Earlier output omitted]\n" + value.text.slice(-16384) : value.text || "No service logs are available."); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2" aria-label="Preview actions">
    {compact ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label={`${appId} preview actions`} disabled={busy}><MoreHorizontal className="size-3.5" />App actions</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={busy} onSelect={() => { setOpened(true); setCheckRevision(n => n + 1); refresh(); }}>Check preview</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => void restart()}>Restart app</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => void showLogs()}>Show service logs</DropdownMenuItem>
        {opened && <DropdownMenuItem disabled={busy} onSelect={() => setOpened(false)}>Hide checks</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu> : <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setOpened(true); setCheckRevision(n => n + 1); refresh(); }}>Check preview</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void restart()}>Restart app</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void showLogs()}>Show service logs</Button>
      {opened && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpened(false)}>Hide checks</Button>}
    </div>}
    {busy && <p role="status" className="flex items-center gap-2"><HostyLoader label={null} className="size-3.5" />Working… Source and sandbox data are retained.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {logs !== null && <details open><summary>Service logs snapshot · last 80 lines per service</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{logs}</pre></details>}
    {opened && <div className="space-y-2 rounded border p-2">
      <p>Optional checks. Readiness and browser verification are separate.</p>
      {checks && <p>Readiness: {checks.readiness?.status ?? "unknown"}{checks.observedAt ? ` · ${new Date(checks.observedAt).toLocaleTimeString()}` : ""}</p>}
      {checks?.readinessError && <p role="status">{checks.readinessError}</p>}
      {checks?.message && <p>{checks.message}</p>}
      {!checks && !error && <p>Reading check recipes…</p>}
      {checks?.checks.map(check => <div key={check.id} className="space-y-1 border-t pt-2">
        <p className="font-medium">{check.id} · {check.state.replaceAll("_", " ")}</p>
        <p>Service: {check.service} · Folder: {check.recipe.cwd} · Timeout: {check.recipe.timeoutSeconds}s</p>
        <pre className="overflow-auto whitespace-pre-wrap break-all">{check.recipe.command.map(arg => JSON.stringify(arg)).join(" ")}</pre>
        <p>Runs in this service container. On timeout or cancellation it stops the service and all check processes. Outputs use its existing caches, temporary directory and test data. Restart is manual.</p>
        {check.message && <p role="status">{check.message}</p>}
        {check.result && <details><summary>Last result: {check.result.state.replaceAll("_", " ")}{check.result.exitCode != null ? ` · exit ${check.result.exitCode}` : ""} · {new Date(check.result.at).toLocaleTimeString()}</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{check.result.output || "No command output."}</pre></details>}
        <Button type="button" variant="outline" size="sm" disabled={busy || !check.digest} onClick={() => void run(check)}>Run reviewed check</Button>
      </div>)}
    </div>}
  </div>;
}
