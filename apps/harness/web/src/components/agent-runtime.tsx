"use client";

import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Runtime = { defaultMode: "native" | "docker"; docker: { available: boolean; reason?: string; image?: string; state?: { phase: string; sessionId: string } | null }; usage?: { memoryBytes: number; peakMemoryBytes: number; diskBytes?: number }; support: string };
async function loadRuntime() {
  const loaded = await (await call("/runtime")).json() as Runtime;
  if (!loaded?.docker) throw new Error("Docker runtime status is unavailable.");
  return loaded;
}
export function AgentRuntime() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => { setRuntime(await loadRuntime()); }, []);
  useEffect(() => {
    let active = true;
    loadRuntime().then(loaded => { if (active) setRuntime(loaded); }, reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Runtime operation failed."); }
    finally { setBusy(false); }
  };
  return <section className="mb-6 space-y-3 rounded-lg border p-4" aria-label="Agent execution">
    <h2 className="font-medium">Application runtime</h2>
    <p>{runtime ? runtime.defaultMode === "docker" ? "Docker" : "Local" : "Loading runtime…"}</p>
    <p className="text-sm text-muted-foreground">Select the application runtime in Core. The selected profile applies to new and existing conversations.</p>
    {runtime?.defaultMode === "docker" && <p className="text-sm text-muted-foreground">One shared agent container serves this installation. Managed workspaces and provider history persist across runtime switches.</p>}
    <p className="text-sm" role="status">{runtime ? runtime.defaultMode !== "docker" && !runtime.docker.state ? "Local ready" : runtime.docker.state ? `Worker: ${runtime.docker.state.phase} · ${runtime.docker.state.sessionId}` : runtime.docker.available ? "Docker ready" : "Docker unavailable" : "Checking Docker…"}</p>
    {runtime?.usage && <p className="text-sm text-muted-foreground">Memory: {(runtime.usage.memoryBytes / 1048576).toFixed(0)} MiB · peak {(runtime.usage.peakMemoryBytes / 1048576).toFixed(0)} MiB{runtime.usage.diskBytes !== undefined ? ` · disk ${(runtime.usage.diskBytes / 1073741824).toFixed(2)} GiB` : ""}</p>}
    {runtime?.defaultMode === "docker" && <p className="text-xs text-muted-foreground">{runtime.support}</p>}
    {runtime?.defaultMode === "docker" && runtime.docker.reason && <p className="text-sm text-muted-foreground">{runtime.docker.reason}</p>}
    <div className="flex flex-wrap gap-2">
      {runtime?.defaultMode === "docker" && <Button variant="outline" disabled={busy} onClick={() => void action(() => call("/runtime/image", { method: "POST" }))}>Prepare worker image</Button>}
      <Button variant="outline" disabled={busy || !runtime?.docker.state} onClick={() => void action(() => call("/runtime/stop", { method: "POST" }))}>Stop / recover worker</Button>
      <Button variant="outline" disabled={busy} onClick={() => void action(refresh)}>Refresh</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
