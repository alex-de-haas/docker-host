"use client";
import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { InlineError } from "@/components/status";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AssistantApiError, getExecutionRecovery, recoverExecution, type ExecutionRecoveryRequest, type ExecutionRecoveryReview } from "@/lib/assistant-api";

export function SessionExecutionRecovery({ sessionId, refreshKey, onRecovered }: { sessionId: string; refreshKey: string; onRecovered: () => Promise<void> }) {
  const [review, setReview] = useState<ExecutionRecoveryReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ExecutionRecoveryRequest | null>(null);
  const executing = useRef(false);
  const refreshed = useRef(onRecovered);
  useEffect(() => { refreshed.current = onRecovered; }, [onRecovered]);
  const key = `hosty.execution-recovery.${sessionId}`;
  useEffect(() => {
    let cancelled = false;
    void getExecutionRecovery(sessionId).then(async value => {
      if (cancelled) return;
      setReview(value); setError(null); setPending(null);
      // An ordinary admission can settle while this tab holds its earlier fence. A null
      // recovery review requires the current session snapshot, never a local assumption.
      if (value === null) { await refreshed.current(); return; }
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
    if (!review || executing.current) return;
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
        localStorage.removeItem(key); setPending(null);
        setReview(await getExecutionRecovery(sessionId).catch(() => null));
      }
    }
    finally { executing.current = false; setBusy(false); }
  };
  if (!review && !error) return null;
  return <div className="flex shrink-0 flex-col gap-2 px-3 py-2">
    {review && <Alert aria-label="Interrupted execution recovery" role="status" variant="warning">
      <TriangleAlert aria-hidden />
      <AlertTitle>Interrupted execution</AlertTitle>
      <AlertDescription>
        <p>{review.sourceOnly
          ? "Message admission was interrupted before a Worker execution receipt was recorded. Its execution outcome is unconfirmed. Recover only after verifying that no agent or command is still running for this request."
          : "This execution was interrupted and its process exit is unconfirmed. Retry Stop first. Recover only after verifying that the old agent and all commands it started have stopped."}</p>
        <p>Recovery preserves this chat and its source files. It does not stop processes or repeat work.</p>
      </AlertDescription>
      <AlertAction><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void recover()}>
        {busy ? "Recovering…" : pending ? "Retry recovery" : "Recover stopped execution"}
      </Button></AlertAction>
    </Alert>}
    {error && <InlineError message={error} />}
  </div>;
}
