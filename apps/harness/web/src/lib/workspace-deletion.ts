"use client";

import { useRef, useState } from "react";
import { developmentRequest, DevelopmentRequestError } from "./development-api";

export type DeleteCommand = { requestId: string; captureSessions?: true; returnTargets?: string[] };
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
        return { requestId: value.requestId, ...(value.captureSessions === true ? { captureSessions: true } : {}),
          ...(Array.isArray(value.returnTargets) && value.returnTargets.every((key: unknown) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)) ? { returnTargets: value.returnTargets } : {}) };
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

export function useWorkspaceDeletion(refresh: () => void) {
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
    storeDeleteCommand(workspaceId, command);
    void (async () => {
      let retry = command;
      try {
        const path = "/" + workspaceId + "/delete";
        let progress: DeleteProgress;
        try {
          progress = await developmentRequest<DeleteProgress>(path, { requestId: command.requestId, ...(command.captureSessions ? { removeAttachedSessions: true } : {}), ...(command.returnTargets ? { returnTargets: command.returnTargets } : {}) });
        } catch (error) {
          if (error instanceof DevelopmentRequestError && error.status && error.status < 500 && ![408, 429].includes(error.status)) throw error;
          // A lost response can follow a committed removal. Verify the original receipt.
          const observed = await developmentRequest<DeleteProgress>(
            path + "/status?requestId=" + encodeURIComponent(command.requestId), undefined, AbortSignal.timeout(8_000),
          ).catch(() => null);
          if (!observed || observed.state === "review-required") throw error;
          progress = observed;
        }
        if (progress.requestId !== retry.requestId) {
          // Core may resume an existing deletion admitted for this operator.
          retry = { ...retry, requestId: progress.requestId };
          storeDeleteCommand(workspaceId, retry);
        }
        if (progress.state === "review-required") throw new Error(progress.error || "Workspace deletion needs review.");
        if (progress.state === "removed") clearDeleteCommand(workspaceId);
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
