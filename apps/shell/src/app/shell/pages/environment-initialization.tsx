"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreEnvironment } from "@hosty-sdk/app/sandbox/server";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchCore } from "../core-transport.js";
import { readCoreErrorDetail } from "../core-api";

export type InitializationStatus = { phase: string; hasAdministrator: boolean; recoveryRequired: boolean; shellUrl?: string; error?: string;
  apps: { id: string; title: string; state: string; error?: string }[] };
type SetupLink = { token: string; setupUrl: string; expiresAt: string };
type Request = <T>(path: string, body: unknown) => Promise<T>;
function safeUrl(value?: string) {
  try { const url = new URL(value ?? ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function initializationProblem(status: InitializationStatus | null) {
  const failed = status?.apps.find(app => app.state === "failed");
  return status?.error || (failed ? `${failed.title}: ${failed.error || "Installation failed"}` : undefined);
}

export function initializationSummary(status: InitializationStatus | null) {
  if (!status) return "Checking environment setup…";
  const problem = initializationProblem(status);
  if (problem) return problem;
  const active = status.apps.find(app => ["installing", "starting"].includes(app.state));
  if (active) return `${active.state === "installing" ? "Installing" : "Starting"} ${active.title}…`;
  if (["pending", "preparing"].includes(status.phase)) return "Preparing applications…";
  if (status.recoveryRequired) return "Administrator recovery required";
  if (!status.hasAdministrator) return ["ready", "existing"].includes(status.phase) ? "Administrator setup required" : "Initialization needs attention";
  return undefined;
}

export function useEnvironmentInitialization({ item, origin, pollVersion, request }: {
  item: CoreEnvironment; origin: string; pollVersion: number; request: Request;
}) {
  const enabled = item.state === "running" && !!item.initializationRequested;
  const scope = `${origin}|${item.id}|${item.state}|${item.revision}`;
  const [observation, setObservation] = useState<{ scope: string; status: InitializationStatus | null; error: string } | null>(null);
  const [actionError, setActionError] = useState("");
  const [link, setLink] = useState<SetupLink | null>(null), [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false), [copied, setCopied] = useState<"link" | "token" | null>(null);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const actionEpoch = useRef({ value: 0 }), actionPending = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const [previousScope, setPreviousScope] = useState(scope);
  if (previousScope !== scope) {
    setPreviousScope(scope); setLink(null); setSetupOpen(false); setActionError(""); setBusy(false);
  }
  useEffect(() => {
    const epoch = actionEpoch.current;
    actionPending.current = false;
    return () => { epoch.value++; };
  }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, generation = 0;
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer); controller?.abort();
      if (disposed || document.visibilityState === "hidden") return;
      const current = ++generation, abort = new AbortController(); controller = abort;
      let keepChecking = true;
      try {
        const response = await fetchCore(`${origin}/api/core-environments/${item.id}/initialization`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error((await readCoreErrorDetail(response)).message);
        const status = await response.json() as InitializationStatus;
        if (disposed || abort.signal.aborted || current !== generation) return;
        setObservation({ scope, status, error: "" }); setCheckedAt(Date.now());
        if (status.hasAdministrator) { setLink(null); setSetupOpen(false); setActionError(""); }
        keepChecking = !status.hasAdministrator || !["ready", "existing"].includes(status.phase);
      } catch (cause) {
        if (disposed || abort.signal.aborted || current !== generation) return;
        const error = cause instanceof Error ? cause.message : "Initialization status is unavailable.";
        setObservation(previous => ({ scope, status: previous?.scope === scope ? previous.status : null, error }));
      } finally {
        if (!disposed && !abort.signal.aborted && current === generation && keepChecking) timer = setTimeout(() => void load(), 5000);
      }
    };
    const refresh = () => { void load(); };
    refreshRef.current = refresh;
    refresh();
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true; controller?.abort(); clearTimeout(timer);
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
      if (refreshRef.current === refresh) refreshRef.current = () => {};
    };
  }, [enabled, scope, origin, item.id, pollVersion]);
  const status = enabled && observation?.scope === scope ? observation.status : null;
  const error = actionError || (observation?.scope === scope ? observation.error : "");
  const perform = async (resume: boolean) => {
    if (actionPending.current || !enabled) return;
    actionPending.current = true; setBusy(true); setActionError("");
    const epoch = actionEpoch.current.value;
    try {
      if (resume) {
        const next = await request<InitializationStatus>(`/${item.id}/initialization/resume`, {});
        if (epoch !== actionEpoch.current.value) return;
        setObservation({ scope, status: next, error: "" }); refreshRef.current();
      } else {
        const next = await request<SetupLink>(`/${item.id}/setup-link`, {});
        if (epoch !== actionEpoch.current.value) return;
        setLink(next); setCheckedAt(Date.now()); setCopied(null); setSetupOpen(true);
        const url = safeUrl(next.setupUrl);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (cause) { if (epoch === actionEpoch.current.value) setActionError(cause instanceof Error ? cause.message : "The request failed."); }
    finally { if (epoch === actionEpoch.current.value) { actionPending.current = false; setBusy(false); } }
  };
  const copy = async (value: string, kind: "link" | "token") => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); setActionError(""); }
    catch { setActionError(kind === "link" ? "Clipboard unavailable. Copy the registration link from its Open registration action." : "Clipboard unavailable. Select and copy the token below."); }
  };
  const refresh = useCallback(() => refreshRef.current(), []);
  const setup = link && Date.parse(link.expiresAt) > checkedAt ? safeUrl(link.setupUrl) : undefined;
  return { status, error, busy, link, setup, setupOpen, setSetupOpen, copied, copy, refresh,
    canSetup: !!status && !observation?.error && ["ready", "existing"].includes(status.phase) && !status.hasAdministrator && !status.recoveryRequired,
    canResume: !!status && ["failed", "selection"].includes(status.phase),
    setupAdministrator: () => perform(false), resume: () => perform(true),
  };
}

export function EnvironmentSetupDialog({ initialization }: { initialization: ReturnType<typeof useEnvironmentInitialization> }) {
  const { link, setup, setupOpen, setSetupOpen, busy, error, copied, copy, setupAdministrator } = initialization;
  return <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
    <DialogContent>
      <DialogHeader><DialogTitle>Set up administrator</DialogTitle><DialogDescription>Create the first administrator in the sandbox’s browser window.</DialogDescription></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {setup && link ? <>
          <Button asChild variant="outline"><a href={setup} target="_blank" rel="noreferrer">Open registration</a></Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(setup, "link")}>{copied === "link" ? "Link copied" : "Copy setup link"}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(link.token, "token")}>{copied === "token" ? "Token copied" : "Copy setup token"}</Button>
          </div>
          <p className="break-all text-sm text-muted-foreground">Setup token: <code>{link.token}</code></p>
        </> : <p className="text-sm">This link expired. Request a new registration link.</p>}
      </DialogBody>
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => void setupAdministrator()}>New registration link</Button><Button type="button" onClick={() => setSetupOpen(false)}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
