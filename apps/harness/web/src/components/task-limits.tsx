"use client";
import { useEffect, useEffectEvent, useState } from "react";
import { subscribeWorkspaceEvents } from "@/lib/workspace-events";
import { call, ApiError } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Limits = { maxConcurrentExecutions: number; maxDelegationDepth: number; maxDescendants: number; maxRetriesPerTask: number; maxActiveSeconds: number | null; maxCost: null };
type Root = { revision: number; limitsRevision: number; limits: Limits; paused: boolean; modePaused?: boolean; stopRequested: boolean;
  descendantCount: number; reservations: Record<string, { held: boolean; activeMs: number; usageUnknown?: boolean }> };
const fields = [
  ["maxConcurrentExecutions", "Concurrent executions", 1], ["maxDelegationDepth", "Delegation depth", 0],
  ["maxDescendants", "Total subtasks", 0], ["maxRetriesPerTask", "Retries per task", 0], ["maxActiveSeconds", "Active execution seconds (optional)", 1],
] as const;
export function TaskLimits({ rootId }: { rootId?: string }) {
  const rootEndpoint = rootId ? `/task-orchestration/v1/roots/${encodeURIComponent(rootId)}` : null;
  const endpoint = rootEndpoint ? rootEndpoint + "/limits" : "/task-orchestration/v1/settings";
  const [values, setValues] = useState<Limits | null>(null), [revision, setRevision] = useState(0), [root, setRoot] = useState<Root | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ path: string; method: string; input: object } | null>(null);
  const updateUsage = useEffectEvent((value: Root) => {
    setRoot(value);
    if (!dirty && !pending) { setValues(value.limits); setRevision(value.limitsRevision); }
  });
  const read = async () => {
    const result = await (await call(endpoint)).json() as Root & { values?: Limits };
    setValues(result.values ?? result.limits); setRevision(result.limitsRevision ?? result.revision); setRoot(rootId ? result : null); setDirty(false);
  };
  useEffect(() => { let live = true; void (async () => {
    try { const result = await (await call(endpoint)).json() as Root & { values?: Limits }; if (live) { setValues(result.values ?? result.limits); setRevision(result.limitsRevision ?? result.revision); setRoot(rootId ? result : null); } }
    catch (failure) { if (live) setError(failure instanceof Error ? failure.message : "Execution limits are unavailable."); }
  })(); return () => { live = false; }; }, [endpoint, rootId]);
  useEffect(() => {
    if (!rootId) return;
    let disposed = false, generation = 0;
    const stop = subscribeWorkspaceEvents("/api/tasks/v1/events", async () => {
      const own = ++generation;
      try {
        const value = await (await call(endpoint)).json() as Root;
        if (disposed || own !== generation) return;
        updateUsage(value);
      } catch { /* Explicit refresh retains the actionable error and unsaved form. */ }
    }, () => {});
    return () => { disposed = true; generation++; stop(); };
  }, [endpoint, rootId]);
  const send = async (action?: "pause" | "resume" | "stop") => {
    setBusy(true); setError("");
    let request = pending;
    try {
      if (!request) {
        const current = action ? await (await call(endpoint)).json() as Root : null;
        request = action ? { path: rootEndpoint! + "/control", method: "POST", input: { requestId: crypto.randomUUID(), expectedRevision: current!.revision, action } }
          : { path: endpoint, method: "PUT", input: { requestId: crypto.randomUUID(), expectedRevision: revision, values } };
        setPending(request);
      }
      await call(request.path, { method: request.method, body: JSON.stringify(request.input) }); setPending(null); await read();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) setPending(null);
      setError(failure instanceof Error ? failure.message : "Execution policy update could not be confirmed.");
    } finally { setBusy(false); }
  };
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{rootId ? "Root execution limits" : "Task execution defaults"}</summary>
    <div className="mt-3 space-y-3"><p className="text-sm text-muted-foreground">Task sessions run autonomously. Limits are shared by the coordinator and all subtasks. Changing defaults affects new roots.</p>
      {root && <p className="text-xs text-muted-foreground">{root.stopRequested ? "Stopped" : root.paused || root.modePaused ? "Paused" : root.limits.maxActiveSeconds !== null && Object.values(root.reservations).reduce((sum, r) => sum + r.activeMs, 0) >= root.limits.maxActiveSeconds * 1000 ? "Time budget reached" : "Active"} · {root.descendantCount} subtasks · {Object.values(root.reservations).filter(r => r.held).length} reserved executions · {Math.ceil(Object.values(root.reservations).reduce((sum, r) => sum + r.activeMs, 0) / 1000)} active seconds{Object.values(root.reservations).some(r => r.usageUnknown) ? " · Usage needs recovery" : ""}</p>}
      {values && <div className="grid gap-3 sm:grid-cols-2">{fields.map(([key, label, min]) => <label key={key} className="space-y-1 text-sm"><span>{label}</span><Input type="number" min={min} step={1} value={values[key] ?? ""} disabled={busy || !!pending} onChange={event => { const value = event.target.value; setValues({ ...values, [key]: key === "maxActiveSeconds" && !value ? null : Number(value) }); setDirty(true); }} /></label>)}</div>}
      <p className="text-xs text-muted-foreground">A monetary cap is unavailable for the current providers.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">{pending ? <Button size="sm" disabled={busy} onClick={() => void send()}>Check original update</Button> : <>
        <Button size="sm" disabled={busy || !values || !dirty} onClick={() => void send()}>Save limits</Button>
        <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => { setError(""); void read().catch(e => setError(e.message)); }}>Refresh</Button>
        {root && !root.stopRequested && <><Button size="sm" variant="outline" disabled={busy} onClick={() => void send(root.paused ? "resume" : "pause")}>{root.paused ? "Resume" : "Pause"}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void send("stop")}>Stop root and subtasks</Button></>}
      </>}</div>
    </div></details>;
}
