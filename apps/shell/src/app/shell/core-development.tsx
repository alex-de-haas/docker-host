"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderGit2, GitBranch, LoaderCircle, Lock, Radio } from "lucide-react";
import { toast } from "@/components/reui/operation-toast";
import { CoreSourceChangesDialog } from "./source/source-changes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useShellActions } from "./shell-context";
import { readCoreError } from "./core-api";
import { InlineError } from "./ui";

export type CoreLaunch = { mode: string; projectPath: string | null; generationPath: string | null; processId: number; startedAt: string };
export type CoreDevelopment = {
  launch: CoreLaunch; instance: string; manageable: boolean;
  source: { overridePath: string | null; revision: string }; managedPath: string; sourcePath: string; selectedProjectPath: string;
  restartRequired: boolean; branch: string | null; commit: string | null;
  changedFiles: number | null; additions: number | null; deletions: number | null; gitError: string | null; gitTruncated?: boolean;
};
type Operation = { id: string; status: string; error?: string; logPath?: string };

export function useCoreDevelopment(coreOrigin: string, enabled: boolean) {
  const { sendCsrfJson } = useShellActions();
  const [state, setState] = useState<CoreDevelopment | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const operation = useRef<string | null>(null);
  const submitting = useRef(false);
  const pollNow = useRef<(() => Promise<void>) | null>(null);
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
    let polling = false;
    const poll = async () => {
      if (controller.signal.aborted || polling || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      polling = true;
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
      polling = false;
      // Match app source polling while idle; only an active restart needs rapid reconciliation.
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), operation.current ? 3000 : 15000);
    };
    const visible = () => { if (document.visibilityState === "visible") void poll(); };
    pollNow.current = poll;
    document.addEventListener("visibilitychange", visible);
    void poll();
    return () => {
      controller.abort(); clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      if (pollNow.current === poll) pollNow.current = null;
    };
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
    } finally { submitting.current = false; void pollNow.current?.(); }
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
  const mode = state?.launch.mode;
  const external = mode === "unmanaged";
  const description = external
    ? "Core was started outside the Hosty CLI, for example from an IDE or with dotnet run. Its launch mode is unknown, so Shell cannot switch or restart it. Start Core through the Hosty CLI to enable these controls."
    : !state
      ? "Core launch information is unavailable."
      : !state.manageable
        ? "The Hosty CLI is unavailable. Restore CLI access to switch or restart Core."
        : mode === "dev"
          ? "Core runs a build from source. Restart to rebuild and apply changes; there is no hot reload."
          : "Core runs the installed release. Switching runtime restarts Core.";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-w-0 items-center gap-x-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="min-w-0 cursor-help truncate font-mono text-sm">
              {external ? "external" : mode ?? "unknown"}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{description}</TooltipContent>
        </Tooltip>
        {mode === "dev" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                role="img"
                aria-label={state?.gitError ? `Development runtime — Git warning: ${state.gitError}` : "Development runtime"}
                className={cn("inline-flex shrink-0 cursor-help", state?.gitError ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}
              >
                <Radio aria-hidden="true" className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              {state?.gitError ? `Git warning: ${state.gitError}` : "Core runs a build from source. Restart to rebuild and apply changes; there is no hot reload."}
            </TooltipContent>
          </Tooltip>
        )}
        {state?.manageable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Switch runtime for Hosty Core" title="Switch runtime" disabled={disabled}>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Runtime</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(["release", "dev"] as const).map(target => (
                <DropdownMenuItem key={target} disabled={disabled || mode === target} onSelect={() => onChange(target)}>
                  <Check className={cn("h-4 w-4", mode === target ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">{target}</span>
                  <span className={cn("ml-auto inline-flex shrink-0 items-center gap-1 text-[11px]", target === "dev" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                    {target === "dev" ? <Radio className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                    {target === "dev" ? "Source" : "Locked"}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </TooltipProvider>
  );
}

export function CoreGitCell({ state }: { state: CoreDevelopment | null }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="min-w-0 text-xs" title={state?.gitError ?? `${state?.launch.projectPath ?? ""}\n${state?.commit ?? ""}`}>
      <div className="flex min-w-0 cursor-help items-center gap-1 font-mono text-sm"><GitBranch className="size-3.5 shrink-0" /><span className="truncate underline decoration-dotted decoration-muted-foreground/70 underline-offset-4">{state?.branch ?? state?.commit?.slice(0, 10) ?? "Source unavailable"}</span></div>
      <button type="button" className="flex max-w-full flex-wrap items-center gap-x-2 text-left text-xs text-muted-foreground hover:underline" aria-label="Source changes for Hosty Core" onClick={() => setOpen(true)}>
        {state?.changedFiles == null ? "Inspect source" : state.changedFiles === 0 && !state.gitTruncated ? "No changes" : <>
          <span>{state.changedFiles}{state.gitTruncated ? "+" : ""} {state.changedFiles === 1 && !state.gitTruncated ? "file" : "files"}</span>
          {state.additions != null && state.deletions != null && <>
            <span className="text-green-700 dark:text-green-400">+{state.additions}</span>
            <span className="text-red-700 dark:text-red-400">−{state.deletions}</span>
          </>}
        </>}
      </button>
    </div>
    {open && <CoreSourceChangesDialog onClose={() => setOpen(false)} />}
  </>;
}

export function CoreSourceDialog({ open, onOpenChange, state, disabled, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; state: CoreDevelopment | null; disabled: boolean; onSave: (path: string | null) => Promise<void> }) {
  const [override, setOverride] = useState(false);
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refresh the draft when the dialog opens or the saved source changes.
  useEffect(() => { if (open) { setOverride(!!state?.source.overridePath); setPath(state?.source.overridePath ?? ""); setError(null); } }, [open, state?.source.overridePath]);
  const unavailable = disabled || saving || !state;
  const trimmedPath = path.trim();
  const dirty = override ? trimmedPath !== (state?.source.overridePath ?? "") : !!state?.source.overridePath;
  const canSave = !unavailable && dirty && (!override || trimmedPath.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settings · Hosty Core</DialogTitle>
          <DialogDescription>hosty-core</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex gap-1 border-b">
            <div className="-mb-px border-b-2 border-foreground px-3 py-2 text-sm font-medium text-foreground">Source</div>
          </div>
          <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={async event => {
            event.preventDefault();
            if (!canSave) return;
            setSaving(true);
            setError(null);
            try {
              await onSave(override ? trimmedPath : null);
              onOpenChange(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save source.");
            } finally {
              setSaving(false);
            }
          }}>
            <DialogBody className="space-y-4">
              {error && <div role="alert"><InlineError message={error} /></div>}
              <div className="space-y-2">
                <div className="text-sm font-medium">Development profiles</div>
                <p className="text-sm text-muted-foreground">Select dev from the dashboard runtime menu to develop Core.</p>
                <p className="text-xs text-muted-foreground">Repository: <a className="underline" href="https://github.com/alex-de-haas/docker-host" target="_blank" rel="noreferrer">alex-de-haas/docker-host</a></p>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
                <Radio className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="text-muted-foreground">Core builds from the selected source folder. Restart to rebuild and apply source changes; there is no hot reload.</p>
              </div>
              <fieldset className="min-w-0 space-y-2" disabled={unavailable}>
                <legend className="sr-only">Source folder</legend>
                <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3", !override && "border-foreground")}>
                  <input type="radio" name="core-source" className="mt-1" checked={!override} onChange={() => setOverride(false)} />
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-sm font-medium">Standard Hosty source</div>
                    <div className="text-xs text-muted-foreground">
                      Use Hosty&apos;s managed checkout. The default branch is cloned when dev mode is first started.
                      {state?.managedPath && <> · <code className="break-all font-mono">{state.managedPath}</code></>}
                    </div>
                  </div>
                </label>
                <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3", override && "border-foreground")}>
                  <input type="radio" name="core-source" className="mt-1" checked={override} onChange={() => setOverride(true)} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="text-sm font-medium">Custom source folder</div>
                    <div className="text-xs text-muted-foreground">Point Core at a repository folder on the host.</div>
                    <Input id="core-source-path" aria-label="Repository folder on this host" className="font-mono text-xs" value={path} disabled={!override} onChange={event => setPath(event.target.value)} placeholder="Absolute path to the repository" />
                  </div>
                </label>
              </fieldset>
              <div className="space-y-1 text-xs text-muted-foreground">
                {state && <p className="break-all">Selected project: <code className="font-mono">{state.selectedProjectPath}</code></p>}
                {state?.launch.projectPath && <p className="break-all">Running from: <code className="font-mono">{state.launch.projectPath}</code></p>}
                {state?.launch.mode === "dev" && <p>Changing Source requires a Core restart. Save now and use Restart when ready.</p>}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="submit" disabled={!canSave}>
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderGit2 className="h-4 w-4" />}
                Save source
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
