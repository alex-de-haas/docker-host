"use client";

import { useCallback, useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { fetchCore } from "../core-transport.js";
import { useShellActions, useShellState } from "../shell-context";
import type { CoreApp } from "../types";
import type { SourceLineStats } from "./source-preview-data";

type SourceStatus = {
  appId: string; state: string; scopePath: string | null; branch: string | null; head: string | null;
  fileCount: number; truncated: boolean; observedAt: string; error?: string | null; lineStats?: SourceLineStats | null;
};

function useSourceStatus(endpointPath: string, enabled: boolean, sourceKey = "") {
  const { coreOrigin } = useShellActions();
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const url = `${coreOrigin}${endpointPath}/summary`;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let controller: AbortController | null = null;
    const load = async () => {
      if (controller || document.visibilityState === "hidden") return;
      controller = new AbortController();
      try {
        const response = await fetchCore(url, { credentials: "include", cache: "no-store", signal: controller.signal });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) throw new Error(await readCoreError(response));
        const next = await response.json() as SourceStatus;
        if (active) { setStatus(next); setError(next.error ?? null); }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "Source status unavailable.");
      } finally { controller = null; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [url, coreOrigin, enabled, nonce, sourceKey]);
  return { status, error, refresh };
}

function sourceLabel(status: SourceStatus | null, error: string | null, includeCommit = true) {
  if (error || status?.state === "unavailable") return "Source status unavailable";
  if (!status) return "Reading source…";
  if (status.state === "no-git") return "Local source · no Git";
  if (status.state === "none") return "No source";
  if (status.state === "missing") return "Source missing";
  const branch = status.branch ?? "Detached HEAD";
  return includeCommit ? `${branch} · ${status.head?.slice(0, 8) ?? "no commits"}` : branch;
}

export function SourceVersionCell({ app }: { app: CoreApp }) {
  const { canManageApps } = useShellState();
  const { status, error } = useSourceStatus(`/api/apps/${encodeURIComponent(app.id)}/source`, canManageApps, `${app.sourceOverridePath}:${app.sourceManagedPath}`);
  if (!canManageApps) return <span className="font-mono text-sm" title="Manifest version">{app.version}</span>;
  return <>
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="flex min-w-0 cursor-help items-center gap-1 font-mono text-sm">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate underline decoration-dotted decoration-muted-foreground/70 underline-offset-4">{sourceLabel(status, error, false)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <div className="space-y-1">
            <div className="font-medium">{app.displayName} · source</div>
            <div className="break-all">{sourceLabel(status, error, false)}</div>
            {error && <div>{error}</div>}
            {!error && status && <>
              {status.head && <div>Commit: <span className="break-all font-mono">{status.head}</span></div>}
              {["clean", "changes"].includes(status.state) && <>
                {!status.head && <div>No commits yet</div>}
                <div>Changed files: {status.fileCount}{status.truncated ? "+ (incomplete list)" : ""}</div>
                {status.lineStats
                  ? <div>Lines: +{status.lineStats.additions} / −{status.lineStats.deletions} (HEAD to working tree)</div>
                  : status.fileCount > 0 && <div>Line totals unavailable or incomplete.</div>}
              </>}
              {status.scopePath && <div className="break-all">Scope: {status.scopePath}</div>}
              <div className="opacity-80">Observed {new Date(status.observedAt).toLocaleTimeString()}</div>
            </>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <span className="text-xs text-muted-foreground">
      {!error && status && ["clean", "changes"].includes(status.state)
        ? `${status.fileCount}${status.truncated ? "+" : ""} changed files` : ""}
      {!error && status?.fileCount && status.lineStats ? <LineCounts stats={status.lineStats} /> : null}
    </span>
  </>;
}

export function SourceChangesButton({ app }: { app: CoreApp }) {
  return <SourceToolsLink context={app.displayName} />;
}

export function SourceToolsLink({ context = "source code" }: { context?: string }) {
  const { state } = useShellState();
  const { coreOrigin } = useShellActions();
  const tools = state.apps.filter(app => app.grantedCorePermissions?.includes("apps.sources") && app.embeddedUrl);
  return <div className="space-y-2 text-sm text-muted-foreground">
    <p>Inspect and edit {context} in your source tools.</p>
    {tools.map(app => <a className="block underline" key={app.id} target="_blank" rel="noopener noreferrer"
      href={`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/open?redirectUri=${encodeURIComponent(app.embeddedUrl!)}`}>Open {app.displayName}</a>)}
    {!tools.length && <p>No app with source access is available. Install and authorize Hosty Harness to work with source code.</p>}
  </div>;
}

function LineCounts({ stats }: { stats: SourceLineStats }) {
  return <span className="inline-flex shrink-0 gap-2 whitespace-nowrap font-mono text-xs tabular-nums" role="img" aria-label={`${stats.additions} lines added, ${stats.deletions} lines deleted`}>
    <span aria-hidden="true" className="text-green-700 dark:text-green-400">+{stats.additions}</span>
    <span aria-hidden="true" className="text-red-700 dark:text-red-400">−{stats.deletions}</span>
  </span>;
}
