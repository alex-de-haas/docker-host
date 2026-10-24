"use client";
import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Status = { state: string; message: string; dueAt?: string; completedAt?: string; observedAt: string };
export function SessionRetention({ sessionId, revision }: { sessionId: string; revision: string }) {
  const [value, setValue] = useState<{ id: string; status?: Status; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void call(`/sessions/${encodeURIComponent(sessionId)}/retention`).then(r => r.json()).then((status: Status) => {
      if (active) setValue({ id: sessionId, status });
    }).catch(error => { if (active) setValue({ id: sessionId, error: String(error) }); });
    return () => { active = false; };
  }, [sessionId, revision, refresh]);
  const current = value?.id === sessionId ? value : null;
  return <details className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer tabular-nums">Retention{current?.status?.dueAt ? ` · Eligible after ${new Date(current.status.dueAt).toLocaleString()}` : current?.status ? ` · ${current.status.state}` : ""}</summary>
    <p className="mt-2">{current?.error ?? current?.status?.message ?? "Checking Core…"}</p>
    {current?.status?.completedAt && <p className="tabular-nums">Core completion: {new Date(current.status.completedAt).toLocaleString()}</p>}
    <p>Daily cleanup rechecks the current state. An eligibility date does not guarantee deletion.</p>
    {current?.status?.state === "blocked" && <Button size="sm" disabled={busy} variant="outline" onClick={async () => {
      setBusy(true);
      try {
        const result = await (await call(`/sessions/${encodeURIComponent(sessionId)}/retention`, { method: "POST", body: "{}" })).json() as Status;
        setValue({ id: sessionId, status: result.state === "deleted" ? { ...result, message: "Conversation cleanup completed." } : result });
      } catch (error) { setValue({ id: sessionId, error: String(error) }); }
      finally { setBusy(false); }
    }}>Retry eligible cleanup</Button>}
    <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Refresh retention status</Button>
  </details>;
}
