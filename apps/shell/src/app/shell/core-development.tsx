"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Radio } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useShellActions } from "./shell-context";
import { readCoreError } from "./core-api";

export type CoreLaunch = { mode: string; projectPath: string | null; generationPath: string | null; processId: number; startedAt: string };
export type CoreDevelopment = {
  launch: CoreLaunch; instance: string; manageable: boolean;
  source: { overridePath: string | null; revision: string }; managedPath: string; sourcePath: string; selectedProjectPath: string;
  restartRequired: boolean; branch: string | null; commit: string | null;
  changedFiles: number | null; additions: number | null; deletions: number | null; gitError: string | null;
};
type Operation = { id: string; status: string; error?: string; logPath?: string };

export function useCoreDevelopment(coreOrigin: string, enabled: boolean) {
  const { sendCsrfJson } = useShellActions();
  const [state, setState] = useState<CoreDevelopment | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const operation = useRef<string | null>(null);
  const submitting = useRef(false);
  const key = `hosty:core-operation:${coreOrigin}`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${coreOrigin}/api/core/development`, { credentials: "include", cache: "no-store", signal });
    if (!response.ok) throw new Error(await readCoreError(response));
    const value = await response.json() as CoreDevelopment;
    if (!signal?.aborted) setState(value);
    return value;
  }, [coreOrigin]);

  useEffect(() => {
    if (!enabled) return;
    operation.current = sessionStorage.getItem(key);
    setBusy(!!operation.current);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(controller.signal);
        if (operation.current && !submitting.current) {
          const response = await fetch(`${coreOrigin}/api/core/operations/${operation.current}`, { credentials: "include", cache: "no-store", signal: controller.signal });
          if (response.ok) {
            const value = await response.json() as Operation;
            if (controller.signal.aborted) return;
            if (value.status === "completed" || value.status === "failed") {
              operation.current = null;
              setBusy(false);
              sessionStorage.removeItem(key);
              setPhase(null);
              if (value.status === "completed") toast.success("Core restarted");
              else toast.error("Core restart failed", { description: [value.error, value.logPath && `Log: ${value.logPath}`].filter(Boolean).join(" "), duration: 15000 });
            } else setPhase(value.status === "building" ? "Building" : value.status === "starting" ? "Starting" : "Preparing");
          } else if (response.status === 404) {
            // A lost response may mean the request never arrived. Never replay it automatically.
            setPhase("Restart not confirmed — check Core logs");
            operation.current = null;
            setBusy(false);
            sessionStorage.removeItem(key);
          }
        }
      } catch { if (operation.current && !controller.signal.aborted) setPhase("Reconnecting"); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [coreOrigin, enabled, key, refresh]);

  const restart = async (mode?: "release" | "dev") => {
    if (!state?.manageable || operation.current) return;
    const requestId = crypto.randomUUID().replaceAll("-", "");
    operation.current = requestId;
    setBusy(true);
    sessionStorage.setItem(key, requestId);
    setPhase("Preparing");
    submitting.current = true;
    try {
      await sendCsrfJson(`${coreOrigin}/api/core/restart`, { requestId, instance: state.instance, mode, sourceRevision: state.source.revision });
    } catch (error) {
      // Keep the id for reconciliation if the transport disappeared after the helper was started.
      toast.error("Core restart could not be confirmed", { description: error instanceof Error ? error.message : "Checking operation status…" });
    } finally { submitting.current = false; }
  };
  const save = async (overridePath: string | null) => {
    if (!state) return;
    await sendCsrfJson(`${coreOrigin}/api/core/source`, { overridePath, revision: state.source.revision }, "PUT");
    await refresh();
    toast.success("Core source saved");
  };
  return { state, phase, busy, restart, save };
}

export function CoreModeControl({ state, disabled, onChange }: { state: CoreDevelopment | null; disabled: boolean; onChange: (mode: "release" | "dev") => void }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-1 font-mono text-xs" disabled={disabled || !state?.manageable} title={state?.manageable ? "Core launch mode" : "Restart with the Hosty CLI to manage this Core"}>
    {state?.launch.mode ?? "unknown"}{state?.launch.mode === "dev" && <Radio className={state.gitError ? "size-3 text-amber-600" : "size-3 text-emerald-600"} />}<span aria-hidden>⌄</span>
  </Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem disabled={state?.launch.mode === "release"} onSelect={() => onChange("release")}>release</DropdownMenuItem><DropdownMenuItem disabled={state?.launch.mode === "dev"} onSelect={() => onChange("dev")}>dev</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}

export function CoreGitCell({ state }: { state: CoreDevelopment | null }) {
  return <div className="min-w-0 text-xs" title={state?.gitError ?? `${state?.launch.projectPath ?? ""}\n${state?.commit ?? ""}`}>
    <div className="flex items-center gap-1"><GitBranch className="size-3.5 shrink-0" /><span className="truncate border-b border-dotted font-mono">{state?.branch ?? state?.commit?.slice(0, 10) ?? "Source unavailable"}</span></div>
    <div className="text-muted-foreground">{state?.changedFiles == null ? "Git status unavailable" : state.changedFiles === 0 ? "No changes" : <>{state.changedFiles} files <span className="text-green-700">+{state.additions}</span> <span className="text-red-600">−{state.deletions}</span></>}</div>
  </div>;
}

export function CoreSourceDialog({ open, onOpenChange, state, disabled, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; state: CoreDevelopment | null; disabled: boolean; onSave: (path: string | null) => Promise<void> }) {
  const [override, setOverride] = useState(false);
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mount a fresh form for each opening (the parent keys it by the opening state).
  useEffect(() => { if (open) { setOverride(!!state?.source.overridePath); setPath(state?.source.overridePath ?? ""); setError(null); } }, [open, state?.source.overridePath]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Hosty Core</DialogTitle><DialogDescription>Configure the source checkout used for development.</DialogDescription></DialogHeader><DialogBody className="space-y-4">
    <div className="border-b pb-2 text-sm font-medium">Source</div>
    <p className="text-xs text-muted-foreground">Repository: <a className="underline" href="https://github.com/alex-de-haas/docker-host" target="_blank" rel="noreferrer">alex-de-haas/docker-host</a></p>
    {state && <p className="break-all text-xs text-muted-foreground">Selected project: {state.selectedProjectPath}</p>}
    {state?.launch.projectPath && <p className="break-all text-xs text-muted-foreground">Running from: {state.launch.projectPath}</p>}
    <fieldset className="space-y-3" disabled={disabled || saving || !state}>
      <Label className="flex items-center gap-2"><input type="radio" name="core-source" checked={!override} onChange={() => setOverride(false)} />Standard</Label>
      {!override && <p className="break-all text-xs text-muted-foreground">{state?.managedPath}<br />The default branch is cloned when dev mode is first started.</p>}
      <Label className="flex items-center gap-2"><input type="radio" name="core-source" checked={override} onChange={() => setOverride(true)} />Override</Label>
      {override && <><Label htmlFor="core-source-path">Repository folder on this host</Label><Input id="core-source-path" value={path} onChange={event => setPath(event.target.value)} placeholder="Absolute path to the repository" /></>}
      {state?.launch.mode === "dev" && <p className="text-xs text-muted-foreground">Changing Source requires a Core restart. Save now and use Restart when ready.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={override && !path.trim()} onClick={async () => { setSaving(true); setError(null); try { await onSave(override ? path.trim() : null); onOpenChange(false); } catch (e) { setError(e instanceof Error ? e.message : "Could not save source."); } finally { setSaving(false); } }}>{saving ? "Saving…" : "Save"}</Button>
    </fieldset>
  </DialogBody></DialogContent></Dialog>;
}
