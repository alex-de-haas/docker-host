"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssistantApiError, getExecutionRecovery, recoverExecution, type ExecutionRecoveryRequest, type ExecutionRecoveryReview } from "@/lib/assistant-api";

export function SessionExecutionRecovery({ sessionId, refreshKey, onRecovered }: { sessionId: string; refreshKey: string; onRecovered: () => Promise<void> }) {
  const [review, setReview] = useState<ExecutionRecoveryReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ExecutionRecoveryRequest | null>(null);
  const executing = useRef(false);
  const key = `hosty.execution-recovery.${sessionId}`;
  useEffect(() => {
    let cancelled = false;
    void getExecutionRecovery(sessionId).then(value => {
      if (cancelled) return;
      setReview(value); setError(null); setConfirmed(false); setPending(null);
      // A server-retained request is authoritative after a lost response or browser restart.
      if (value?.pending) setPending(value.pending);
      else try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null") as ExecutionRecoveryRequest | null;
        if (saved?.runId === value?.runId && saved?.generation === value?.generation && saved?.expectedRevision === value?.expectedRevision
          && typeof saved?.requestId === "string" && saved?.consumerExitConfirmed === true)
          setPending(saved);
      } catch { /* The server still retains accepted recovery requests. */ }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, key]);
  const recover = async () => {
    if (!review || executing.current || !confirmed && !pending) return;
    executing.current = true; setBusy(true); setError(null);
    const input = pending ?? { requestId: crypto.randomUUID(), runId: review.runId, generation: review.generation,
      expectedRevision: review.expectedRevision, consumerExitConfirmed: true as const };
    setPending(input);
    try {
      localStorage.setItem(key, JSON.stringify(input));
      await recoverExecution(sessionId, input);
      localStorage.removeItem(key); setPending(null);
      await onRecovered(); setReview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof AssistantApiError && ["recovery_active", "recovery_stale", "recovery_invalid"].includes(cause.code ?? "")) {
        localStorage.removeItem(key); setPending(null); setConfirmed(false);
        setReview(await getExecutionRecovery(sessionId).catch(() => null));
      }
    }
    finally { executing.current = false; setBusy(false); }
  };
  if (!review) return error ? <p role="alert" className="px-3 text-sm text-destructive-foreground">{error}</p> : null;
  return <section aria-label="Interrupted execution recovery" className="shrink-0 space-y-2 border-b p-3 text-sm">
    <p>This execution was interrupted and its process exit is unconfirmed. Retry Stop first. Recover only after verifying that the old agent and all commands it started have stopped.</p>
    <p>Recovery preserves this chat and its source files. It does not stop processes or repeat work.</p>
    {!pending && <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy}
      onChange={event => setConfirmed(event.target.checked)} />I verified that the agent and its commands have stopped.</label>}
    <Button size="sm" variant="outline" disabled={busy || !confirmed && !pending} onClick={() => void recover()}>
      {busy ? "Recovering…" : pending ? "Retry recovery" : "Recover stopped execution"}
    </Button>
    {error && <p role="alert" className="text-destructive-foreground">{error}</p>}
  </section>;
}
