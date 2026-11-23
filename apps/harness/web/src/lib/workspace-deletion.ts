"use client";

import { useRef, useState } from "react";
import { developmentRequest, DevelopmentRequestError, type WorkspaceParticipation } from "./development-api";
import { attachedWorkspaceSessionIds } from "./workspace-navigation";

export type DeleteCommand = { requestId: string; captureSessions?: true; sessionIds?: string[] };
export type DeleteProgress = {
  workspaceId: string; requestId: string; state: "pending" | "removed" | "review-required"; error?: string;
  trees: { id: string; state: string }[]; resources: { id: string; kind: string; state: string }[];
  activity?: { kind: string; reference: string; state: string; detail?: string }[];
};

const deletePrefix = "hosty.workspace.delete.";
const prefixes = [deletePrefix, "hosty.workspace.discard."];

export function storedCommand(workspaceId: string): DeleteCommand | null {
  for (const prefix of prefixes) {
    try {
      const value = JSON.parse(localStorage.getItem(prefix + workspaceId) ?? "null");
      if (typeof value?.requestId === "string" && /^[a-f0-9-]{36}$/i.test(value.requestId)) {
        const sessionIds: unknown = value.sessionIds;
        return {
          requestId: value.requestId,
          ...(Array.isArray(sessionIds) && sessionIds.every(id => typeof id === "string" && id)
            ? { sessionIds: [...new Set<string>(sessionIds)] } : {}),
        };
      }
    } catch { /* A corrupt or unavailable browser receipt does not override Core. */ }
  }
  return null;
}

function storeDeleteCommand(workspaceId: string, command: DeleteCommand) {
  try { localStorage.setItem(deletePrefix + workspaceId, JSON.stringify(command)); }
  catch { /* The in-memory command can still be retried in this page. */ }
}

export function clearDeleteCommand(workspaceId: string) {
  try { for (const prefix of prefixes) localStorage.removeItem(prefix + workspaceId); }
  catch { /* Core preserves the deletion receipt independently. */ }
}

type Failure = { label: string; error: string; retry: DeleteCommand };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useWorkspaceDeletion(removeSession: ((id: string) => Promise<void>) | undefined, refresh: () => void) {
  const running = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlyMap<string, DeleteCommand>>(() => new Map());
  const [failures, setFailures] = useState<ReadonlyMap<string, Failure>>(() => new Map());

  function run(workspaceId: string, label: string, command: DeleteCommand) {
    if (running.current.has(workspaceId)) return;
    running.current.add(workspaceId);
    setPending(current => new Map(current).set(workspaceId, command));
    setFailures(current => {
      const next = new Map(current);
      next.delete(workspaceId);
      return next;
    });
    // Persist the selected targets before the first mutation. A failed roster read
    // must leave the dialog free to review the checkbox again.
    if (!command.captureSessions) storeDeleteCommand(workspaceId, command);

    void (async () => {
      let retry = command;
      try {
        if (command.captureSessions) {
          let participation: WorkspaceParticipation;
          try {
            participation = await developmentRequest<WorkspaceParticipation>(`/${workspaceId}/participants`);
          } catch (error) {
            throw new Error("Could not verify attached sessions. " + message(error));
          }
          const verified = { requestId: command.requestId, sessionIds: attachedWorkspaceSessionIds(participation) };
          retry = verified;
          setPending(current => new Map(current).set(workspaceId, verified));
          storeDeleteCommand(workspaceId, verified);
        }
        const path = "/" + workspaceId + "/delete";
        let progress: DeleteProgress;
        try {
          progress = await developmentRequest<DeleteProgress>(path, { requestId: command.requestId });
        } catch (error) {
          if (error instanceof DevelopmentRequestError && error.status && error.status < 500 && ![408, 429].includes(error.status)) throw error;
          // A lost response can follow a committed removal. Verify the original receipt.
          const observed = await developmentRequest<DeleteProgress>(
            path + "/status?requestId=" + encodeURIComponent(command.requestId), undefined, AbortSignal.timeout(8_000),
          ).catch(() => null);
          if (observed?.state !== "removed") throw error;
          progress = observed;
        }
        if (progress.requestId !== retry.requestId) {
          // Core may resume an existing deletion admitted for this operator.
          retry = { ...retry, requestId: progress.requestId };
          storeDeleteCommand(workspaceId, retry);
        }
        if (progress.state !== "removed") throw new Error(progress.error || "Workspace deletion is incomplete. Retry uses the same request.");
        if (removeSession && retry.sessionIds?.length) {
          refresh();
          const sessionIds = retry.sessionIds;
          const results = await Promise.allSettled(sessionIds.map(id => removeSession(id)));
          const failed = results.flatMap((result, index) => result.status === "rejected"
            ? [{ id: sessionIds[index], reason: result.reason }] : []);
          if (failed.length) {
            retry = { requestId: progress.requestId, sessionIds: failed.map(result => result.id) };
            storeDeleteCommand(workspaceId, retry);
            const count = failed.length === 1 ? "1 session was" : failed.length + " sessions were";
            throw new Error("Workspace deleted. " + count + " retained. " + message(failed[0].reason));
          }
        }
        clearDeleteCommand(workspaceId);
      } catch (error) {
        setFailures(current => new Map(current).set(workspaceId, { label, error: message(error), retry }));
      } finally {
        running.current.delete(workspaceId);
        setPending(current => {
          const next = new Map(current);
          next.delete(workspaceId);
          return next;
        });
        refresh();
      }
    })();
  }

  return { run, pending, failures };
}

export type WorkspaceDeletion = ReturnType<typeof useWorkspaceDeletion>;
