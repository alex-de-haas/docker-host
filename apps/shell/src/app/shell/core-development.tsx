"use client";

import { fetchCore } from "./core-transport.js";


import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, Check, ChevronDown, FolderGit2, GitBranch, LoaderCircle, Lock, Radio } from "lucide-react";
import { toast } from "@/components/reui/operation-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useShellActions } from "./shell-context";
import { readCoreError } from "./core-api";
import { InlineError } from "./ui";
import type { WorkspaceSource } from "./workspace-sources";
import { SourceChangeSummary } from "./source/source-change-summary";

export type CoreLaunch = { mode: string; projectPath: string | null; generationPath: string | null; processId: number; startedAt: string };
export type CoreDevelopment = {
  launch: CoreLaunch; instance: string; manageable: boolean;
  source: { overridePath: string | null; revision: string; repositoryUrl?: string | null; ref?: string | null; projectPath?: string; connectionId?: string | null };
  build?: { repository?: string | null; commit?: string | null; dirty?: boolean | null }; updateRepository?: string; managedPath: string; sourcePath: string; selectedProjectPath: string;
  restartRequired: boolean; branch: string | null; commit: string | null;
  changedFiles: number | null; additions: number | null; deletions: number | null; gitError: string | null; gitTruncated?: boolean;
};
export type CoreSourceRepository = { repositoryUrl: string; ref: string | null; projectPath: string; connectionId: string | null };
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
    const response = await fetchCore(`${coreOrigin}/api/core/development`, { credentials: "include", cache: "no-store", signal });
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
          const response = await fetchCore(`${coreOrigin}/api/core/operations/${operation.current}`, { credentials: "include", cache: "no-store", signal: controller.signal });
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
  const save = async (overridePath: string | null, repository?: CoreSourceRepository, expectedRevision?: string) => {
    if (!state) return;
    await sendCsrfJson(`${coreOrigin}/api/core/source`, { overridePath, revision: expectedRevision ?? state.source.revision, repository }, "PUT");
    await refresh();
    toast.success("Core source saved");
  };
  return { state, phase, busy, restart, save };
}

export function CoreModeControl({ state, workspace, disabled, onChange }: { state: CoreDevelopment | null; workspace?: WorkspaceSource; disabled: boolean; onChange: (mode: "release" | "dev") => void }) {
  const mode = state?.launch.mode;
  const external = mode === "unmanaged";
  const sourceLabel = mode === "dev" && workspace ? "workspace" : "source";
  const label = external ? "external" : mode === "dev" ? sourceLabel : mode ?? "unknown";
  const description = external
    ? "Core was started outside the Hosty CLI, for example from an IDE or with dotnet run. Its launch mode is unknown, so Shell cannot switch or restart it. Start Core through the Hosty CLI to enable these controls."
    : !state
      ? "Core launch information is unavailable."
      : !state.manageable
        ? "The Hosty CLI is unavailable. Restore CLI access to switch or restart Core."
        : mode === "dev"
          ? `Core runs a build from ${workspace ? "a registered workspace" : "source"}. Restart to rebuild and apply changes; there is no hot reload.`
          : "Core runs the installed release. Switching runtime restarts Core.";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-w-0 items-center gap-x-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="shrink-0 cursor-help whitespace-nowrap text-sm">
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{description}{state?.gitError && ` Git warning: ${state.gitError}`}</TooltipContent>
        </Tooltip>
        {state?.manageable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Switch runtime for Hosty Core" title="Switch runtime" disabled={disabled}>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuGroup>
                {(["release", "dev"] as const).map(target => (
                  <DropdownMenuItem key={target} disabled={disabled || mode === target} onSelect={() => onChange(target)}>
                    <Check className={cn("h-4 w-4", mode === target ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1 truncate">{target === "dev" ? sourceLabel : target}</span>
                    {target === "release" && <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <Lock className="size-3" />Locked
                    </span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </TooltipProvider>
  );
}

export function CoreGitCell({ state, workspace }: { state: CoreDevelopment | null; workspace?: WorkspaceSource }) {
  return <div className="flex min-w-0 flex-col gap-1 text-xs">
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={workspace ? `Workspace: ${workspace.label}` : undefined}
            className="flex min-w-0 cursor-help items-center gap-1 text-sm">
            {workspace ? <Boxes aria-hidden="true" className="size-3.5 shrink-0" />
              : <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />}
            <span className={cn("truncate underline decoration-dotted decoration-muted-foreground/70 underline-offset-4", !workspace && "font-mono")}>
              {workspace?.label ?? state?.branch ?? state?.commit?.slice(0, 10) ?? "Source unavailable"}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <div className="space-y-1">
            <div className="font-medium">Hosty Core · source</div>
            {workspace && <div className="break-all">Workspace: {workspace.label}</div>}
            {state?.branch && <div className="break-all">Branch: {state.branch}</div>}
            {state?.commit && <div>Commit: <span className="break-all font-mono">{state.commit}</span></div>}
            {state?.changedFiles != null && <div>Changed files: {state.changedFiles}{state.gitTruncated ? "+ (incomplete list)" : ""}</div>}
            {state?.additions != null && state.deletions != null && <div>Lines: +{state.additions} / −{state.deletions} (HEAD to working tree)</div>}
            {state?.launch.projectPath && <div className="break-all">Project: {state.launch.projectPath}</div>}
            {state?.gitError && <div>{state.gitError}</div>}
            {!state && <div>Source unavailable</div>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    {state?.changedFiles != null && <SourceChangeSummary fileCount={state.changedFiles} truncated={state.gitTruncated}
      lineStats={state.additions != null && state.deletions != null ? { additions: state.additions, deletions: state.deletions } : null} />}
  </div>;
}

export function CoreSourceDialog({ open, onOpenChange, state, disabled, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; state: CoreDevelopment | null; disabled: boolean; onSave: (path: string | null, repository?: CoreSourceRepository, expectedRevision?: string) => Promise<void> }) {
  const [override, setOverride] = useState(false);
  const [path, setPath] = useState("");
  const [repository, setRepository] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [project, setProject] = useState("");
  const [connection, setConnection] = useState("");
  const [draftRevision, setDraftRevision] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refresh the draft when the dialog opens or the saved source changes, in the same render.
  const draftKey = open && state ? "open" : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (draftKey !== seededKey) {
    setSeededKey(draftKey);
    if (draftKey !== null) { setOverride(!!state?.source.overridePath); setPath(state?.source.overridePath ?? ""); setRepository(state?.source.repositoryUrl ?? ""); setSourceRef(state?.source.ref ?? ""); setProject(state?.source.projectPath ?? "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj"); setConnection(state?.source.connectionId ?? ""); setDraftRevision(state?.source.revision); setError(null); }
  }
  const unavailable = disabled || saving || !state;
  const trimmedPath = path.trim();
  const repositoryDirty = repository.trim() !== (state?.source.repositoryUrl ?? "") || sourceRef.trim() !== (state?.source.ref ?? "") || project.trim() !== (state?.source.projectPath ?? "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj") || connection.trim() !== (state?.source.connectionId ?? "");
  const dirty = repositoryDirty || (override ? trimmedPath !== (state?.source.overridePath ?? "") : !!state?.source.overridePath);
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
              await onSave(override ? trimmedPath : null, repositoryDirty ? { repositoryUrl: repository.trim(), ref: sourceRef.trim() || null, projectPath: project.trim(), connectionId: connection.trim() || null } : undefined, draftRevision);
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
                <p className="text-sm text-muted-foreground">Use the Dashboard runtime menu to switch between the installed release and a source build.</p>
                <label className="block text-sm">Development repository URL<Input value={repository} disabled={unavailable} onChange={e => setRepository(e.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
                <label className="block text-sm">Tracked branch or ref<Input value={sourceRef} disabled={unavailable} onChange={e => setSourceRef(e.target.value)} placeholder="Repository default branch" /></label>
                <label className="block text-sm">Project path relative to repository<Input value={project} disabled={unavailable} onChange={e => setProject(e.target.value)} /></label>
                <label className="block text-sm">Private source connection ID (optional)<Input value={connection} disabled={unavailable} onChange={e => setConnection(e.target.value)} placeholder="Existing authorized connection" /></label>
                <p className="break-all text-xs text-muted-foreground">Running build repository: {state?.build?.repository ?? "Unknown"} · commit {state?.build?.commit ?? "Unknown"}</p>
                <p className="break-all text-xs text-muted-foreground">Release update origin: {state?.updateRepository ?? "Unknown"}. Development source does not change release downloads.</p>
                {state?.source.repositoryUrl && state.updateRepository && state.source.repositoryUrl.replace(/\.git$/, "").replace(/\/$/, "") !== state.updateRepository.replace(/\/$/, "") && <p className="text-xs">Development and release repositories differ. Returning or updating retains the existing release distribution.</p>}
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
                    <div className="text-sm font-medium">Configured repository</div>
                    <div className="text-xs text-muted-foreground">
                      Use the managed checkout of the configured repository/ref. Preparing source preserves existing work.
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
