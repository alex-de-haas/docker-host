"use client";

import { useEffect, useRef, useState } from "react";
import { useConfirmation } from "@/components/reui/confirmation";
import { toast } from "@/components/reui/operation-toast";
import { CoreRequestError, isAuthRequiredRedirectError, readCoreErrorDetail, redirectToCoreLoginIfAuthRequired } from "./core-api";
import type { CoreDevelopment } from "./core-development";
import { fetchCore } from "./core-transport.js";
import { useShellActions } from "./shell-context";

type StopState = { scope: string; busy: boolean; phase: string | null; error: string | null };
type StopAttempt = { controller: AbortController; submitted: boolean };

/** Stop only the reviewed Core process; runtime applications remain under their existing runners. */
export function useCoreStop(coreOrigin: string, state: CoreDevelopment | null, disabled: boolean) {
  const { sendCsrfJson } = useShellActions();
  const scope = JSON.stringify([coreOrigin, state?.instance ?? null, disabled]);
  const { confirm, dialog } = useConfirmation(scope);
  const attempt = useRef<StopAttempt | null>(null);
  const [result, setResult] = useState<StopState>({ scope, busy: false, phase: null, error: null });

  useEffect(() => () => {
    attempt.current?.controller.abort();
    attempt.current = null;
    setResult(current => ({ ...current, busy: false, phase: null, error: null }));
  }, [scope]);

  const stop = async () => {
    if (disabled || !state?.manageable || attempt.current) return;
    const own: StopAttempt = { controller: new AbortController(), submitted: false };
    attempt.current = own;
    const signal = own.controller.signal;
    const update = (value: Omit<StopState, "scope">) => {
      if (!signal.aborted && attempt.current === own) setResult({ scope, ...value });
    };
    update({ busy: true, phase: "Checking Core…", error: null });
    try {
      const response = await fetchCore(`${coreOrigin}/api/core/development`, { credentials: "include", cache: "no-store", signal });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) throw new Error((await readCoreErrorDetail(response)).message);
      const current = await response.json() as CoreDevelopment;
      signal.throwIfAborted();
      if (current.instance !== state.instance) throw new Error("Core changed. Refresh its launch status before stopping it.");
      if (!current.manageable) throw new Error("This Core process cannot be stopped from Shell. Use its local launcher.");
      update({ busy: true, phase: "Waiting for confirmation", error: null });
      const accepted = await confirm({
        title: "Stop Hosty Core?", action: "Stop Core", destructive: true,
        description: "Core APIs and Shell management will go offline. Runtime applications keep running. Restart Core with the local Hosty CLI to manage this host again.",
      });
      signal.throwIfAborted();
      if (!accepted) {
        update({ busy: false, phase: null, error: null });
        attempt.current = null;
        return;
      }
      update({ busy: true, phase: "Stopping Core…", error: null });
      own.submitted = true;
      const stopped = await sendCsrfJson(`${coreOrigin}/api/core/stop`, { instance: current.instance }, "POST", signal);
      signal.throwIfAborted();
      if (!stopped.ok) {
        const detail = await readCoreErrorDetail(stopped);
        throw new CoreRequestError(detail.message, detail.code, stopped.status, detail.body);
      }
      const receipt = await stopped.json() as { status?: string; instance?: string; keepApps?: boolean };
      signal.throwIfAborted();
      if (stopped.status !== 202 || receipt.status !== "accepted" || receipt.instance !== current.instance || receipt.keepApps !== true)
        throw new Error("Core returned an unrecognized stop response.");
      update({ busy: true, phase: "Stop requested", error: null });
    } catch (error) {
      if (signal.aborted || attempt.current !== own) return;
      if (isAuthRequiredRedirectError(error)) {
        update({ busy: false, phase: null, error: null });
        attempt.current = null;
        return;
      }
      const message = error instanceof Error ? error.message : "Unable to stop Core.";
      const uncertain = own.submitted && !(error instanceof CoreRequestError && error.status >= 400 && error.status < 500);
      update({ busy: uncertain, phase: uncertain ? "Stop not confirmed" : null, error: message });
      toast.error(uncertain ? "Core stop could not be confirmed" : "Core stop failed", {
        description: uncertain ? `${message} Check Core with the local Hosty CLI before trying again. The request is not retried automatically.` : message,
      });
      if (!uncertain) attempt.current = null;
    }
  };

  return { stop, busy: result.scope === scope && result.busy, phase: result.scope === scope ? result.phase : null,
    error: result.scope === scope ? result.error : null, dialog };
}
