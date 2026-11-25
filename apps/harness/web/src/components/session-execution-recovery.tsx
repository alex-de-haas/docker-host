"use client";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AssistantApiError } from "@/lib/assistant-api";

export type RecoveryIssue = { code?: string; message: string };
export const recoveryIssue = (cause: unknown): RecoveryIssue => ({
  code: cause instanceof AssistantApiError ? cause.code : undefined,
  message: cause instanceof Error ? cause.message : String(cause),
});

export function SessionExecutionRecovery({ sessionId, refreshKey, blocker, stopIssue, authorize }: {
  sessionId: string;
  refreshKey: string;
  blocker?: RecoveryIssue;
  stopIssue?: RecoveryIssue;
  authorize?: () => Promise<void>;
}) {
  const [dismissed, setDismissed] = useState<string>();
  const [authorizing, setAuthorizing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const issue = stopIssue ?? blocker;
  const key = JSON.stringify([sessionId, refreshKey, issue?.code, issue?.message]);
  const storageKey = "hosty.execution-notice." + sessionId;
  let previouslyDismissed: string | null = null;
  try { previouslyDismissed = sessionStorage.getItem(storageKey); } catch { /* The local view can still dismiss its notice. */ }
  if (!issue || !authorize && (dismissed === key || previouslyDismissed === key)) return null;
  const dismiss = () => {
    setDismissed(key);
    try { sessionStorage.setItem(storageKey, key); } catch { /* Keep the in-memory preference. */ }
  };
  return <div className="shrink-0 px-3 py-2">
    <Alert aria-label="Execution status" role="status" variant="warning">
      <TriangleAlert aria-hidden />
      <AlertTitle>{stopIssue ? "Waiting for stop confirmation" : issue.code?.startsWith("session_storage") ? "Conversation storage unavailable" : "Waiting for message confirmation"}</AlertTitle>
      <AlertDescription>{(failure ?? issue.message).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)}</AlertDescription>
      <AlertAction>{authorize ? <Button type="button" size="sm" disabled={authorizing} onClick={async () => {
        setAuthorizing(true); setFailure(undefined);
        try { await authorize(); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
        finally { setAuthorizing(false); }
      }}>Authorize original message</Button> : <Button type="button" size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>}</AlertAction>
    </Alert>
  </div>;
}
