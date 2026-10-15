"use client";

import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Runtime = { docker: { available: boolean; reason?: string; image?: string; state?: { phase: string; sessionId: string } | null }; usage?: { memoryBytes: number; peakMemoryBytes: number; diskBytes?: number }; support: string };
export function AgentRuntime({ mode, onMode }: { mode: "native" | "docker"; onMode: (mode: "native" | "docker") => Promise<void> }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const loaded = await (await call("/runtime")).json() as Runtime;
    if (!loaded?.docker) throw new Error("Docker runtime status is unavailable.");
    setRuntime(loaded);
  }, []);
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, [refresh]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Runtime operation failed."); }
    finally { setBusy(false); }
  };
  return <section className="mb-6 space-y-3 rounded-lg border p-4" aria-label="Agent execution">
    <h2 className="font-medium">Agent execution</h2>
    <label className="flex items-center gap-3">New conversations
      <select className="rounded-md border bg-background px-3 py-2" value={mode} disabled={busy}
        onChange={event => void action(() => onMode(event.target.value as "native" | "docker"))}>
        <option value="native">Native on this host</option><option value="docker">Shared Docker container</option>
      </select>
    </label>
    <p className="text-sm text-muted-foreground">Docker runs one agent workload at a time. It shares all Core worktrees between administrators, with read-only Git metadata and internet access. Apps and previews run separately. Existing conversations keep their original runtime.</p>
    <p className="text-sm" role="status">{runtime ? runtime.docker.state ? `Worker: ${runtime.docker.state.phase} · ${runtime.docker.state.sessionId}` : runtime.docker.available ? "Docker ready" : "Docker unavailable" : "Checking Docker…"}</p>
    {runtime?.usage && <p className="text-sm text-muted-foreground">Memory: {(runtime.usage.memoryBytes / 1048576).toFixed(0)} MiB · peak {(runtime.usage.peakMemoryBytes / 1048576).toFixed(0)} MiB{runtime.usage.diskBytes !== undefined ? ` · disk ${(runtime.usage.diskBytes / 1073741824).toFixed(2)} GiB` : ""}</p>}
    {runtime && <p className="text-xs text-muted-foreground">{runtime.support}</p>}
    {runtime?.docker.reason && <p className="text-sm text-muted-foreground">{runtime.docker.reason}</p>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy} onClick={() => void action(() => call("/runtime/image", { method: "POST" }))}>Install worker image</Button>
      <Button variant="outline" disabled={busy || !runtime?.docker.state} onClick={() => void action(() => call("/runtime/stop", { method: "POST" }))}>Stop / recover worker</Button>
      <Button variant="outline" disabled={busy} onClick={() => void action(refresh)}>Refresh</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
