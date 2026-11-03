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
type SetupLink = { token: string; setupUrl?: string | null; recoveryUrl?: string | null; expiresAt: string };
type Request = <T>(path: string, body: unknown) => Promise<T>;
function safeUrl(value?: string) {
  try { const url = new URL(value ?? ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

function accessUrl(link: SetupLink, previewUrl: string) {
  const value = safeUrl(link.recoveryUrl ?? link.setupUrl ?? undefined);
  try {
    const url = new URL(value ?? ""), target = new URL(previewUrl);
    const recovery = !!link.recoveryUrl;
    return url.origin === target.origin && url.pathname === (recovery ? "/recovery" : "/setup")
      && url.searchParams.get(recovery ? "recoveryToken" : "setupToken") === link.token ? url.href : undefined;
  } catch { return undefined; }
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
  if (status?.hasAdministrator && link?.setupUrl) { setLink(null); setSetupOpen(false); }
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => setLink(null), Math.max(0, Date.parse(link.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [link]);
  const error = actionError || (observation?.scope === scope ? observation.error : "");
  const perform = async (resume: boolean) => {
    if (actionPending.current || item.state !== "running" || resume && !enabled) return;
    actionPending.current = true; setBusy(true); setActionError("");
    const epoch = actionEpoch.current.value;
    try {
      if (resume) {
        const next = await request<InitializationStatus>(`/${item.id}/initialization/resume`, {});
        if (epoch !== actionEpoch.current.value) return;
        setObservation({ scope, status: next, error: "" }); refreshRef.current();
      } else {
        const next = await request<SetupLink>(`/${item.id}/access-link`, {});
        if (epoch !== actionEpoch.current.value) return;
        const url = accessUrl(next, item.previewUrl);
        if (!url || !Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now())
          throw new Error("The environment returned an invalid or expired access link.");
        setLink(next); setCheckedAt(Date.now()); setCopied(null); setSetupOpen(true);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (cause) { if (epoch === actionEpoch.current.value) setActionError(cause instanceof Error ? cause.message : "The request failed."); }
    finally { if (epoch === actionEpoch.current.value) { actionPending.current = false; setBusy(false); } }
  };
  const copy = async (value: string, kind: "link" | "token") => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); setActionError(""); }
    catch { setActionError(kind === "link" ? "Clipboard unavailable. Copy the access link from its Open access page action." : "Clipboard unavailable. Select and copy the token below."); }
  };
  const refresh = useCallback(() => refreshRef.current(), []);
  const setup = link && Date.parse(link.expiresAt) > checkedAt ? accessUrl(link, item.previewUrl) : undefined;
  return { status, error, busy, link, setup, setupOpen, setSetupOpen, copied, copy, refresh,
    canSetup: !!status && !observation?.error && ["ready", "existing"].includes(status.phase) && !status.hasAdministrator && !status.recoveryRequired,
    canResume: !!status && ["failed", "selection"].includes(status.phase),
    setupAdministrator: () => perform(false), resume: () => perform(true),
  };
}

export function EnvironmentAccessDialog({ initialization }: { initialization: ReturnType<typeof useEnvironmentInitialization> }) {
  const { link, setup, setupOpen, setSetupOpen, busy, error, copied, copy, setupAdministrator } = initialization;
  return <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
    <DialogContent>
      <DialogHeader><DialogTitle>Get access</DialogTitle><DialogDescription>{link?.setupUrl
        ? "Create the first administrator in this environment’s browser window."
        : "Use a new email to create another administrator. Using an existing email changes that account’s password and signs out its existing sessions."}</DialogDescription></DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {setup && link ? <>
          <Button asChild variant="outline"><a href={setup} target="_blank" rel="noreferrer">Open access page</a></Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(setup, "link")}>{copied === "link" ? "Link copied" : "Copy access link"}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(link.token, "token")}>{copied === "token" ? "Token copied" : "Copy access token"}</Button>
          </div>
          <p className="break-all text-sm text-muted-foreground">Access token: <code>{link.token}</code></p>
        </> : <p className="text-sm">This link expired. Request a new access link.</p>}
      </DialogBody>
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => void setupAdministrator()}>New access link</Button><Button type="button" onClick={() => setSetupOpen(false)}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
