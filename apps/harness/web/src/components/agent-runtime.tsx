"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { HostyLoader } from "../../../../../shared/web/hosty-states";

type Runtime = { defaultMode: "native" | "docker"; providers: "independent" };
async function loadRuntime(): Promise<Runtime> { return (await call("/runtime")).json() as Promise<Runtime>; }
export function AgentRuntime() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadRuntime().then(value => { if (active) setRuntime(value); }, cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  async function refresh() {
    setBusy(true); setError(null);
    try { setRuntime(await loadRuntime()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Runtime status unavailable."); }
    finally { setBusy(false); }
  }
  const reading = busy || (!runtime && !error);
  return <section className="mb-6 flex flex-col gap-3 rounded-lg border p-4" aria-label="Agent execution">
    <h2 className="font-medium">Application runtime</h2>
    <p>{runtime ? runtime.defaultMode === "docker" ? "Docker" : "Local" : reading ? "Loading runtime…" : "Runtime unavailable"}</p>
    <p className="text-sm text-muted-foreground">Install and configure agent provider applications in Shell Settings. Each provider owns its execution, connections and capacity.</p>
    <p role="status" className="flex items-center gap-2">{reading && <HostyLoader label={null} className="size-4" />}{reading ? "Checking runtime…" : runtime ? `${error ? "Last observed: " : ""}Independent providers` : "Runtime status unavailable"}</p>
    <div><Button variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh</Button></div>
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
  </section>;
}
