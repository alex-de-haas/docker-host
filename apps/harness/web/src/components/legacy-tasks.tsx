"use client";
import { useState } from "react";
import { call, ApiError } from "@/lib/api";
import { Button } from "./ui/button";
type Legacy = { id: string; title: string; number: string; status: string; removed: boolean };
export function LegacyTasks() {
  const [rows, setRows] = useState<Legacy[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<{ id: string; requestId: string; action: "remove" | "restore" } | null>(null);
  const refresh = async () => {
    setBusy(true); setError("");
    try {
      const tasks: Legacy[] = []; let cursor: number | null = 0;
      do { const page: { tasks: Legacy[]; nextCursor: number | null } = await (await call(`/task-orchestration/v1/legacy-tasks?cursor=${cursor}`)).json(); tasks.push(...page.tasks); cursor = page.nextCursor; } while (cursor !== null);
      setRows(tasks); setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Retained tasks unavailable."); }
    finally { setBusy(false); }
  };
  const change = async (row?: Legacy) => {
    const op = pending ?? (row ? { id: row.id, requestId: crypto.randomUUID(), action: row.removed ? "restore" as const : "remove" as const } : null);
    if (!op) return; setPending(op); setBusy(true); setError("");
    try {
      const result: Legacy = await (await call(`/task-orchestration/v1/legacy-tasks/${op.id}/actions`, { method: "POST", body: JSON.stringify(op) })).json();
      setRows(current => current.map(row => row.id === result.id ? result : row)); setPending(null);
    } catch (e) { if (e instanceof ApiError && e.status < 500) setPending(null); setError(e instanceof Error ? e.message : "Removal outcome unknown."); }
    finally { setBusy(false); }
  };
  return <details className="space-y-2 rounded-md border p-3 text-sm"><summary>Retained legacy records</summary>
    <p className="my-2">These records cannot execute. Removing them is reversible and preserves their original data.</p>
    <Button variant="outline" size="sm" disabled={busy || !!pending} onClick={() => void refresh()}>{loaded ? "Refresh retained records" : "Load retained records"}</Button>
    {error && <p role="alert">{error}</p>}{pending && <Button disabled={busy} onClick={() => void change()}>Retry original operation</Button>}
    {rows.map(row => <div key={row.id} className="mt-2 space-y-1"><p>{row.number} · {row.title} · {row.removed ? "Removed" : row.status}</p><Button size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void change(row)}>{row.removed ? "Restore retained record" : "Remove retained record"}</Button></div>)}
    {loaded && !rows.length && <p>No retained legacy records.</p>}
  </details>;
}
