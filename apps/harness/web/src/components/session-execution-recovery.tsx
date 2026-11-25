"use client";
import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AssistantApiError, getExecutionRecovery, recoverExecution, type ExecutionRecoveryRequest, type ExecutionRecoveryReview } from "@/lib/assistant-api";

export type RecoveryIssue = { code?: string; message: string };
export const recoveryIssue = (cause: unknown): RecoveryIssue => ({
  code: cause instanceof AssistantApiError ? cause.code : undefined,
  message: cause instanceof Error ? cause.message : String(cause),
});

function savedRequest(key: string, review: ExecutionRecoveryReview | null): ExecutionRecoveryRequest | null {
  if (review?.pending) return review.pending;
  if (!review?.recoverable) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as ExecutionRecoveryRequest | null;
    if (saved?.runId === review.runId && saved.generation === review.generation && saved.expectedRevision === review.expectedRevision
      && typeof saved.requestId === "string" && saved.consumerExitConfirmed === true) return saved;
  } catch { /* The server still retains accepted recovery requests. */ }
  return null;
}

export function SessionExecutionRecovery({ sessionId, refreshKey, onRecovered, blocker, stopIssue, stopping, onRetryStop }: {
  sessionId: string;
  refreshKey: string;
  onRecovered: (refreshQueue?: boolean) => Promise<void>;
  blocker?: RecoveryIssue;
  stopIssue?: RecoveryIssue;
  stopping?: boolean;
  onRetryStop?: () => Promise<void>;
}) {
  const [result, setResult] = useState<{ key: string; review: ExecutionRecoveryReview | null; issue?: RecoveryIssue }>();
  const [busy, setBusy] = useState<"check" | "recover" | null>(null);
  const [pending, setPending] = useState<ExecutionRecoveryRequest | null>(null);
  const executing = useRef(false);
  const reads = useRef({ revision: 0 });
  const refreshed = useRef(onRecovered);
  useEffect(() => { refreshed.current = onRecovered; }, [onRecovered]);
  const key = `hosty.execution-recovery.${sessionId}`;
  const review = result?.key === refreshKey ? result.review : null;
  const issue = result?.key === refreshKey ? result.issue : undefined;

  useEffect(() => {
    const control = reads.current;
    const revision = ++control.revision;
    void getExecutionRecovery(sessionId).then(async value => {
      if (revision !== control.revision) return;
      setResult({ key: refreshKey, review: value });
      setPending(savedRequest(key, value));
      // An ordinary admission can settle while this tab holds its earlier fence.
      if (value === null) await refreshed.current();
    }).catch(cause => {
      if (revision === control.revision) setResult({ key: refreshKey, review: null, issue: recoveryIssue(cause) });
    });
    return () => { control.revision++; };
  }, [sessionId, refreshKey, key]);

  const checkStatus = async () => {
    if (executing.current || stopping) return;
    executing.current = true;
    setBusy("check");
    const revision = ++reads.current.revision;
    const observed = await getExecutionRecovery(sessionId).then(
      value => ({ review: value }),
      cause => ({ review: null, issue: recoveryIssue(cause) }),
    );
    try {
      await onRecovered(true);
      if (revision === reads.current.revision) {
        setResult({ key: refreshKey, ...observed });
        setPending(savedRequest(key, observed.review));
      }
    } catch (cause) {
      if (revision === reads.current.revision) setResult({ key: refreshKey, review: null, issue: recoveryIssue(cause) });
    } finally {
      executing.current = false;
      setBusy(null);
    }
  };

  const recover = async () => {
    if (!review || (!review.recoverable && !pending) || executing.current || stopping) return;
    executing.current = true;
    setBusy("recover");
    const revision = ++reads.current.revision;
    const input = pending ?? { requestId: crypto.randomUUID(), runId: review.runId, generation: review.generation,
      expectedRevision: review.expectedRevision, consumerExitConfirmed: true as const };
    setPending(input);
    let acknowledged = false;
    try {
      localStorage.setItem(key, JSON.stringify(input));
      await recoverExecution(sessionId, input);
      acknowledged = true;
      localStorage.removeItem(key);
      if (revision === reads.current.revision) {
        setPending(null);
        setResult({ key: refreshKey, review: null });
      }
      await onRecovered(true);
    } catch (cause) {
      const failure = recoveryIssue(cause);
      if (["recovery_active", "recovery_stale", "recovery_invalid"].includes(failure.code ?? "")) {
        localStorage.removeItem(key);
        const latest = await getExecutionRecovery(sessionId).then(
          value => ({ review: value, issue: failure }),
          error => ({ review: null, issue: recoveryIssue(error) }),
        );
        if (revision === reads.current.revision) {
          setResult({ key: refreshKey, ...latest });
          setPending(savedRequest(key, latest.review));
        }
      } else if (revision === reads.current.revision) setResult({ key: refreshKey, review: acknowledged ? null : review, issue: failure });
    } finally {
      executing.current = false;
      setBusy(null);
    }
  };

  if (!review && !issue && !blocker && !stopIssue) return null;
  const failure = issue ?? stopIssue;
  const admissionUnconfirmed = issue?.code === "provider_admission_unconfirmed" || stopIssue?.code === "provider_admission_unconfirmed";
  const providerStorageBlocked = ["storage_uncertain", "storage_unavailable"].includes(failure?.code ?? "");
  const canRecover = !!review && (review.recoverable || !!pending);
  const message = failure?.message || blocker?.message;
  return <div className="shrink-0 px-3 py-2">
    <Alert aria-label={review ? "Interrupted execution recovery" : blocker ? "Session storage recovery" : "Session recovery"} role="status" variant="warning">
      <TriangleAlert aria-hidden />
      <AlertTitle>{review ? "Interrupted execution" : blocker ? "Session needs recovery" : stopIssue ? "Stop not confirmed" : "Session needs attention"}</AlertTitle>
      <AlertDescription>
        {message && (!review || failure) && <p>{message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)}</p>}
        {review && <p>{review.sourceOnly
          ? "Message admission was interrupted before a Worker execution receipt was recorded. Recover only after verifying that no agent or command is still running for this request."
          : "This execution was interrupted and its process exit is unconfirmed. Recover only after verifying that the old agent and all commands it started have stopped."}</p>}
        {review && (review.recoverable || pending) && <p>Recovery preserves this chat and its source files.</p>}
        {blocker && <p>Your draft is preserved. You can send messages and change the queue once the session is ready.</p>}
        {providerStorageBlocked && <p>The provider must restore its stored state before Harness can confirm what happened.</p>}
        {admissionUnconfirmed && <p>If the message is in the queue, you can retry it there once the provider confirms it did not start.</p>}
      </AlertDescription>
      <AlertAction className="justify-end">
        {canRecover && <Button type="button" size="sm" variant="outline" disabled={!!busy || stopping} onClick={() => void recover()}>
          {busy === "recover" ? "Recovering…" : pending ? "Retry recovery" : "Recover stopped execution"}
        </Button>}
        {admissionUnconfirmed && onRetryStop && <Button type="button" size="sm" variant="outline" disabled={!!busy || stopping} onClick={() => void onRetryStop()}>
          {stopping ? "Stopping…" : "Retry Stop"}
        </Button>}
        <Button type="button" size="sm" variant="outline" disabled={!!busy || stopping} onClick={() => void checkStatus()}>
          {busy === "check" ? "Checking…" : "Check status"}
        </Button>
      </AlertAction>
    </Alert>
  </div>;
}
