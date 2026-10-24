"use client";

import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { HostyMark } from "../../../../../../shared/web/hosty-mark";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getManageAppHref } from "../shell-routes";
import { useExecutionTargets } from "../execution-targets";
import { coreWorkspaceSource, useWorkspaceSources, workspaceSource, type ActivationWorkspace, type WorkspaceSource } from "../workspace-sources";

import { DashboardSandboxes } from "./dashboard-sandboxes";
import { fetchCore } from "../core-transport.js";


import { ResourceUsageProvider, ResourceUsage } from "../resources/resource-usage";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { CoreGitCell, useCoreDevelopment } from "../core-development";
import { useCoreStop } from "../core-stop";
import { useCoreWorkspaceControl } from "../core-workspace-control";
import { SourceVersionCell } from "../source/source-changes";
import { AppSessionMenuItem } from "../assistant/app-session-action";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isRoutineUpdate, updateFeedback, updateCheckDescription } from "../update-feedback";
import {
  Activity,
  ArrowUpCircle,
  Boxes,
  Check,
  CircleAlert,
  Cog,
  Database,
  Download,
  LoaderCircle,
  MoreHorizontal,
  Package,
  PanelsTopLeft,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "@/components/reui/operation-toast";
import { CoreLogsDialog } from "../dialogs/core-logs-dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  appSupportsReviewedUpdate,
  isAppAutostartEnabled,
  resolveAssetSrc,
} from "../app-helpers";
import { collectAppProblems } from "../app-problems";
import {
  collectInstalledRevisions,
  collectTargetRevisions,
  resolveAvailableCoreVersion,
  resolveAvailableVersionLabel,
  type AppRevision,
} from "../app-versions";
import { isAppBusy, isAppUp, matchesAppStateFilter, matchesAppSearch, type AppStateFilter } from "../runtime-states";
import { AppIcon } from "../app-icon";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type {
  AlertSeverity,
  AppAction,
  AppProblem,
  AppUpdateAvailability,
  AppUpdateCheckStatus,
  AppUpdateStatusResponse,
  CoreApp,
  AppExecutionTargets,
  AppExecutionChoice,
  AppExecutionSelection,
  CoreStatus,
  CoreUpdateStatus,
  OpenAppPanel,
} from "../types";
import { EmptyState, StatusBadge } from "../ui";

// The administrator's home: what the host is, and every app on it. Dashboard and Installed Apps used
// to be two pages, and the first was an aggregate of the second — a summary of a screen you had to
// open anyway. The aggregate survives as one line of counts above the table; the facts about Core
// survive as a row-shaped block above that. Editable configuration is not here — that is Settings.
export function DashboardPage({
  coreOrigin,
  apps,
  status,
  coreUpdate,
  coreUpdating,
  onUpdateCore,
  shellAppId,
  canManageApps,
  loading,
  busyAction,
  pendingAppActions,
  updateCheck,
  onRefresh,
  onInstall,
  onAction,
  onSwitchRuntime,
  onUpdateApp,
  onCheckUpdates,
  onUpdateAll,
  onOpenPanel,
}: {
  coreOrigin: string;
  // Runtime and system apps together, in Core's id order: one list with one command set, where a
  // system app is told apart by its badge — not by which table it sits in.
  apps: CoreApp[];
  status: CoreStatus | null;
  coreUpdate: CoreUpdateStatus | null;
  coreUpdating: boolean;
  onUpdateCore: () => void;
  shellAppId: string;
  canManageApps: boolean;
  loading: boolean;
  busyAction: string | null;
  pendingAppActions: Record<string, AppAction>;
  // Server-side fleet-check status: drives the header "Check updates" spinner from server state.
  updateCheck: AppUpdateCheckStatus | null;
  onRefresh: () => void;
  onInstall: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string | AppExecutionSelection) => void;
  onUpdateApp: (app: CoreApp) => void;
  onCheckUpdates: () => void;
  onUpdateAll: () => void;
  onOpenPanel: OpenAppPanel;
}) {
  const workspaces = useWorkspaceSources(coreOrigin, apps, canManageApps, status?.launch);
  const hasAnyApps = apps.length > 0;
  const [appFilter, setAppFilter] = useState<AppStateFilter>("all");
  const [appSearch, setAppSearch] = useState("");
  const visibleApps = apps.filter((app) => matchesAppStateFilter(app, appFilter) && matchesAppSearch(app, appSearch));

  const [checkingApps, setCheckingApps] = useState<Set<string>>(() => new Set());
  const activeUpdateChecks = useRef(new Set<string>());
  // Only the explicit menu action rebuilds a plan; service diagnostics live in App Details.
  const checkAppUpdate = useCallback(async (app: CoreApp) => {
    if (activeUpdateChecks.current.has(app.id)) return;
    activeUpdateChecks.current.add(app.id);
    setCheckingApps(current => new Set(current).add(app.id));
    try {
      const response = await fetchCore(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/update-status?refresh=true`, { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) throw new Error(await readCoreError(response));
      const status = await response.json() as AppUpdateStatusResponse;
      toast.success(status.updateAvailable ? "Update available" : "Up to date", { description: app.displayName });
    } catch (error) {
      if (!isAuthRequiredRedirectError(error)) toast.error("Update check failed", {
        description: `${app.displayName}: ${error instanceof Error ? error.message : "Update status is unavailable."}`, appId: app.id,
      });
    } finally {
      activeUpdateChecks.current.delete(app.id);
      setCheckingApps(current => { const next = new Set(current); next.delete(app.id); return next; });
      onRefresh();
    }
  }, [coreOrigin, onRefresh]);

  // The fleet check runs on Core (plan-first updates): the button just triggers/joins the sweep and
  // the spinner reads the server-side status block, so a page opened mid-sweep — or reloaded — keeps
  // showing the check in progress. Summarise in a toast when a sweep observed running settles.
  const checkingUpdates = updateCheck?.running ?? false;
  const previousCheckingRef = useRef(checkingUpdates);
  useEffect(() => {
    const wasChecking = previousCheckingRef.current;
    previousCheckingRef.current = checkingUpdates;
    if (!wasChecking || checkingUpdates) {
      return;
    }

    const available = apps.filter((app) => app.updateCheck?.updateAvailable).length;
    const failedApps = apps.filter((app) => app.updateCheck?.error);
    if (available > 0) {
      const review = apps.filter((app) => app.updateCheck?.updateAvailable && app.updateCheck.requiresReview).length;
      const reviewNote = review > 0 ? `${review} need${review === 1 ? "s" : ""} review.` : undefined;
      toast.success(`${available} update${available === 1 ? "" : "s"} available`, {
        description: reviewNote,
      });
    } else if (failedApps.length === 0) {
      toast.success("All apps up to date");
    }
    if (failedApps.length > 0) {
      toast.error("Update check incomplete", {
        description: failedApps.map((app) => `${app.displayName}: ${app.updateCheck?.error}`).join("\n"),
        appId: failedApps.length === 1 ? failedApps[0].id : undefined,
      });
    }
  }, [checkingUpdates, apps]);

  // Routine verdicts the header "Update all" would apply (review-class ones stay on their rows).
  // Mirrors updateAllApps' own filter — including the planDigest requirement, so N never counts an
  // app the action could not actually enqueue.
  const routineUpdateCount = apps.filter(isRoutineUpdate).length;

  return (
    <ResourceUsageProvider coreOrigin={coreOrigin}>
    <div className="dashboard-layout space-y-6">
      <h1 className="sr-only">Dashboard</h1>
      <CoreSection
        workspaces={workspaces}
        status={status}
        coreUpdate={coreUpdate}
        coreUpdating={coreUpdating}
        canManageApps={canManageApps}
        coreOrigin={coreOrigin}
        onUpdateCore={onUpdateCore}
      />


      <section className="dashboard-heading grid items-center gap-3">
        <h2 className="text-[22px] font-semibold tracking-tight">Apps</h2>
        <div className="dashboard-header-filters min-w-0"><AppCounts apps={apps} filter={appFilter} onFilterChange={setAppFilter} /></div>
        {canManageApps && <Button className="dashboard-install" onClick={onInstall} aria-label="Install app" title="Install app"><Plus className="size-4" /><span>Install app</span></Button>}
      </section>
      <Frame role="region" aria-label="Installed apps">
        <FrameHeader className="dashboard-apps-toolbar grid items-center gap-0 px-px py-1">
          <div className="dashboard-toolbar-filters flex min-w-0 flex-wrap items-center gap-2 p-2">
            <Input className="w-52 max-w-full" placeholder="Search apps" aria-label="Search apps by name or ID" value={appSearch} onChange={(event) => setAppSearch(event.target.value)} />
            <span className="text-xs text-muted-foreground">{visibleApps.length === apps.length ? `${apps.length} apps` : `${visibleApps.length} of ${apps.length} apps`}</span>
          </div>
          <div className="dashboard-toolbar-resources min-w-0 px-3 py-2"><ResourceUsage label="All apps" /></div>
          <div className="dashboard-toolbar-actions flex min-w-0 flex-wrap items-center justify-end gap-1 px-3 py-2">
            {canManageApps && routineUpdateCount > 0 && <Button variant="outline" size="sm" className="shrink-0 text-info-foreground" onClick={onUpdateAll} title={`Update all (${routineUpdateCount})`}>Update all ({routineUpdateCount})</Button>}
            {canManageApps && (
              <div className="dashboard-toolbar-overflow">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="App actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onInstall()}>
                      <Plus className="h-4 w-4" /> Install app
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={(event) => { event.preventDefault(); onCheckUpdates(); }} disabled={checkingUpdates}>
                      {checkingUpdates ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowUpCircle className="h-4 w-4" />}
                      {checkingUpdates ? "Checking updates…" : "Check updates"}
                    </DropdownMenuItem>
                    {routineUpdateCount > 0 && (
                      <DropdownMenuItem onSelect={onUpdateAll}>
                        <Download className="h-4 w-4" /> Update all ({routineUpdateCount})
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </FrameHeader>
        <FramePanel className="min-w-0 p-0">
          {loading && !hasAnyApps ? (
            <div role="status" className="flex items-center justify-center gap-2 py-12">
              <HostyLoader className="size-8" label="Loading apps" />
            </div>
          ) : !hasAnyApps ? (
            <EmptyState title="No installed apps" description="Install a runtime app to make it available in the shell." />
          ) : visibleApps.length === 0 ? (
            <div className="p-8 text-center" role="status">
              <p className="text-sm text-muted-foreground">No apps match your search and filters.</p>
              <Button variant="outline" className="mt-3" onClick={() => { setAppFilter("all"); setAppSearch(""); }}>Show all apps</Button>
            </div>
          ) : (
            <InstalledAppsTable
              workspaces={workspaces}
              coreOrigin={coreOrigin}
              apps={visibleApps}
              shellAppId={shellAppId}
              canManageApps={canManageApps}
              busyAction={busyAction}
              pendingAppActions={pendingAppActions}
              checkingApps={checkingApps}
              onAction={onAction}
              onSwitchRuntime={onSwitchRuntime}
              onUpdateApp={onUpdateApp}
              onCheckUpdate={(target) => void checkAppUpdate(target)}
              onOpenPanel={onOpenPanel}
            />
          )}
        </FramePanel>
      </Frame>
      {canManageApps && <DashboardSandboxes coreOrigin={coreOrigin} apps={apps} workspaces={workspaces} />}
    </div>
    </ResourceUsageProvider>
  );
}

// Counts always describe the full host, even when the table is filtered.
function AppCounts({ apps, filter, onFilterChange }: {
  apps: CoreApp[];
  filter: AppStateFilter;
  onFilterChange: (filter: AppStateFilter) => void;
}) {
  const counters = [
    { key: "all", label: "total", title: "All", icon: Boxes, accent: "" },
    { key: "running", label: "running", title: "Running", icon: Activity, accent: "text-success-foreground" },
    { key: "transitioning", label: "in progress", title: "In progress", icon: LoaderCircle, accent: "animate-spin motion-reduce:animate-none" },
    { key: "attention", label: "need attention", title: "Attention", icon: CircleAlert, accent: "text-warning-foreground" },
    { key: "updates", label: "updates", title: "Updates", icon: ArrowUpCircle, accent: "text-info-foreground dark:text-sky-400" },
  ] as const;

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter apps by state">
      {counters.map(({ key, label, title }) => {
        const count = apps.filter((app) => matchesAppStateFilter(app, key)).length;
        const description = `${count} ${key === "updates" && count === 1 ? "update" : label}`;
        // An active filter stays reachable if its last matching app changes state.
        if (count === 0 && filter !== key && key === "transitioning") return null;
        return (
          <Button
            key={key}
            variant={filter === key ? "secondary" : "ghost"}
            size="sm"
            className={cn("gap-1.5 text-muted-foreground", filter === key && "bg-accent text-accent-foreground")}
            aria-label={description}
            title={description}
            aria-pressed={filter === key}
            onClick={() => onFilterChange(filter === key ? "all" : key)}
          >
            <span>{title}</span>
            <span className="font-medium text-foreground">{count}</span>
          </Button>
        );
      })}
    </div>
  );
}

// Keep native column semantics without spending a visible row on self-explanatory labels.
function DashboardTableHeader() {
  return (
    <TableHeader role="rowgroup" className="sr-only">
      <TableRow role="row" className="border-0">
        {["App and source", "Status", "Resources", "Actions"].map((label) => (
          <TableHead role="columnheader" key={label} scope="col" className="h-0 border-0 p-0">
            <span className="sr-only">{label}</span>
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

// Facts about Core, beside the table they describe. This is the only place the Core update can be
// started from: it is where an administrator is already reading the host's version, and a fact that
// cannot be acted on beside itself is an odd place to stop.
function CoreSection({
  workspaces,
  coreOrigin,
  status,
  coreUpdate,
  coreUpdating,
  canManageApps,
  onUpdateCore,
}: {
  workspaces: ActivationWorkspace[];
  coreOrigin: string;
  status: CoreStatus | null;
  coreUpdate: CoreUpdateStatus | null;
  coreUpdating: boolean;
  canManageApps: boolean;
  onUpdateCore: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);

  const router = useRouter();
  const development = useCoreDevelopment(coreOrigin, canManageApps);
  const launch = development.state?.launch ?? status?.launch;
  const dev = launch?.mode === "dev";
  const workspace = coreWorkspaceSource(launch, workspaces);
  const runtime = useCoreWorkspaceControl({
    coreOrigin, state: development.state, workspace, workspaces,
    disabled: !canManageApps || development.busy || coreUpdating, menu: true,
    onRelease: async (signal) => {
      // A workspace Return can replace Core before the next ordinary poll. Use
      // its fresh process identity and source revision for the release restart.
      const current = await development.refresh(signal);
      if (signal.aborted) throw new DOMException("The Core selection was cancelled.", "AbortError");
      const requestId = await development.restart("release", current, signal);
      if (!requestId) throw new Error("Core cannot start another restart. Refresh its launch status and retry.");
      return requestId;
    },
  });
  const stopping = useCoreStop(coreOrigin, development.state, !canManageApps || development.busy || runtime.busy || coreUpdating);
  const coreBusy = development.busy || runtime.busy || coreUpdating || stopping.busy;
  const coreActionLabel = stopping.busy ? "Stopping…" : development.busy ? "Restarting…" : runtime.busy ? "Switching…" : "Updating…";
  const showRestartRequired = Boolean(development.state?.restartRequired && !development.busy && !stopping.busy);
  const needsDiagnostics = ["degraded", "unhealthy", "failed"].includes(status?.status ?? "");
  const showUpdate = !dev && canManageApps && (coreUpdate?.updateAvailable === true || coreUpdating);

  return (
    <Frame role="region" aria-label="Hosty Core" className="text-sm">
      <FramePanel className="min-w-0 p-0">
        <Table role="table" className="dashboard-table" aria-label="Hosty Core">
          <DashboardTableHeader />
          <TableBody role="rowgroup">
            <TableRow role="row" className="dashboard-row" data-testid="core-row">
              <TableCell role="cell" className="dashboard-identity">
                <div className="flex min-w-0 items-center gap-2">
                  <HostyMark tile className="dashboard-app-icon size-10 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-medium">Hosty Core</span>
                      {showRestartRequired && <Badge variant="secondary" className="border-warning/30 bg-warning-soft text-warning-foreground" title="Core source or configuration changed. Restart to apply it.">Restart required</Badge>}
                    </div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                  {dev ? <CoreGitCell state={development.state} workspace={workspace} /> : <CoreVersionBlock status={status} coreUpdate={coreUpdate} />}
                  {showUpdate && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-info-foreground hover:bg-sky-500/10 hover:text-info-foreground dark:text-sky-400 dark:hover:text-sky-400"
                      title={coreUpdating ? "Updating Core…" : "Update Core"}
                      aria-label={coreUpdating ? "Updating Core…" : "Update Core"}
                      disabled={coreBusy}
                      onClick={onUpdateCore}
                    >
                      {coreUpdating ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowUpCircle className="h-4 w-4" />}
                    </Button>
                  )}
                </div>

                  </div>
                </div>
              </TableCell>
              <TableCell role="cell" className="dashboard-status"><div className="space-y-1">
                <StatusBadge value={status ? status.status : "offline"} />
                {(stopping.phase || development.phase) && <div role="status" className="text-xs text-muted-foreground">{stopping.phase || development.phase}</div>}
                {!dev && (coreUpdating || coreUpdate?.clientPhase) && <div role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
                  {coreUpdating && <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />}
                  {coreUpdate?.clientPhase === "completed" ? "Updated" : coreUpdate?.clientPhase === "reconnecting" ? "Reconnecting" : coreUpdate?.clientPhase === "verifying" ? "Verifying update" : coreUpdate?.clientPhase === "unconfirmed" ? "Update not confirmed" : "Installing update"}
                </div>}
                {!dev && coreUpdate?.error && <span title={updateCheckDescription(coreUpdate)} className="text-xs text-warning-foreground">Check failed</span>}
              </div></TableCell>
              <TableCell role="cell" className="dashboard-resources"><ResourceUsage appId="hosty.core" label="Hosty Core" /></TableCell>
              <TableCell role="cell" className="dashboard-actions">
                <div className="flex justify-end gap-1">
                  {canManageApps && (
                    <>
                      <div className="dashboard-context-action">
                        {coreBusy ? <Button variant="outline" size="sm" disabled><LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />{coreActionLabel}</Button>
                          : showRestartRequired ? <Button variant="outline" size="sm" disabled={!development.state?.manageable} onClick={() => void development.restart()}>Restart</Button>
                          : needsDiagnostics ? <Button variant="outline" size="sm" onClick={() => setLogsOpen(true)}>Logs</Button>
                          : <Button variant="outline" size="sm" disabled={!status || !development.state?.manageable} onClick={() => void stopping.stop()}>Stop</Button>}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" disabled={stopping.busy} aria-label="More actions for Hosty Core" title="More actions for Hosty Core"><MoreHorizontal /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuLabel>Hosty Core</DropdownMenuLabel>
                          {runtime.control}
                          <DropdownMenuGroup>
                            <DropdownMenuItem disabled={coreBusy || !development.state?.manageable} onClick={() => void development.restart()}><RotateCcw />Restart Core</DropdownMenuItem>
                            <DropdownMenuItem disabled={coreBusy || !status || !development.state?.manageable} onClick={() => void stopping.stop()}><Square />Stop Core</DropdownMenuItem>
                            {showUpdate && <DropdownMenuItem disabled={coreBusy} onClick={onUpdateCore}><ArrowUpCircle />Update Core</DropdownMenuItem>}
                            <DropdownMenuItem onClick={() => setLogsOpen(true)}><Terminal />Console logs</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => router.push("/settings?tab=host&section=source")}><Settings />Source settings</DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        {runtime.dialog}
        {stopping.dialog}
        <CoreLogsDialog open={logsOpen} coreOrigin={coreOrigin} onOpenChange={setLogsOpen} />
      </FramePanel>
    </Frame>
  );
}

function InstalledAppsTable({
  workspaces,
  coreOrigin,
  apps,
  shellAppId,
  canManageApps,
  busyAction,
  pendingAppActions,
  checkingApps,
  onAction,
  onSwitchRuntime,
  onUpdateApp,
  onCheckUpdate,
  onOpenPanel,
}: {
  workspaces: ActivationWorkspace[];
  coreOrigin: string;
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  busyAction: string | null;
  pendingAppActions: Record<string, AppAction>;
  checkingApps: Set<string>;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string | AppExecutionSelection) => void;
  onUpdateApp: (app: CoreApp) => void;
  onCheckUpdate: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const targets = useExecutionTargets(coreOrigin, apps, canManageApps);
  const targetsByApp = new Map(targets.map(target => [target.appId, target]));
  return (
    <div className="min-w-0">
      <Table role="table" className="dashboard-table" aria-label="Installed apps">
        <DashboardTableHeader />
        <TableBody role="rowgroup">
          {apps.map((app) => {
            const execution = targetsByApp.get(app.id);
            return (
                <InstalledAppRow
                  key={app.id}
                  app={app}
                  workspace={execution?.current.kind === "workspace"
                    ? { id: execution.current.workspaceId!, label: execution.current.name || "Workspace" }
                    : workspaceSource(app, workspaces)}
                  executionTargets={execution}
                  coreOrigin={coreOrigin}
                  isShell={app.id === shellAppId}
                  canManageApps={canManageApps}
                  busyAction={busyAction}
                  pendingAction={pendingAppActions[app.id]}
                  checkingUpdate={checkingApps.has(app.id)}
                  onAction={onAction}
                  onSwitchRuntime={onSwitchRuntime}
                  onUpdateApp={onUpdateApp}
                  onCheckUpdate={onCheckUpdate}
                  onOpenPanel={onOpenPanel}
                />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function InstalledAppRow({
  app,
  workspace,
  executionTargets,
  coreOrigin,
  isShell,
  canManageApps,
  busyAction,
  pendingAction,
  checkingUpdate,
  onAction,
  onSwitchRuntime,
  onUpdateApp,
  onCheckUpdate,
  onOpenPanel,
}: {
  app: CoreApp;
  workspace?: WorkspaceSource;
  executionTargets?: AppExecutionTargets;
  coreOrigin: string;
  isShell: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  pendingAction?: AppAction;
  checkingUpdate: boolean;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string | AppExecutionSelection) => void;
  onUpdateApp: (app: CoreApp) => void;
  onCheckUpdate: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const selectedProfile = app.runtimeProfiles?.find(profile => profile.key === app.selectedRuntime);
  const runtimeLabel = workspace || selectedProfile?.development ? null : app.selectedRuntime || "none";
  const running = isAppUp(app.runtimeState);
  // A verb is mid-flight on the server. Distinct from `busyAction`, which is only true in the tab
  // that clicked: this one is true for every admin, in every tab, and survives a page reload.
  const transitioning = isAppBusy(app.runtimeState);
  const lifecyclePending = pendingAction === "start" || pendingAction === "stop" || pendingAction === "restart";
  const lifecycleLabel = app.runtimeState === "stopping" ? "Stopping…"
    : app.runtimeState === "starting" ? "Starting…"
    : pendingAction === "restart" ? "Restarting…"
    : pendingAction === "stop" ? "Stopping…"
    : pendingAction === "start" ? "Starting…" : null;
  const lifecycleDisabled = transitioning || lifecyclePending || app.operationStatus === "updating";
  // Lifecycle (start/stop/restart) is not system-gated: Core's endpoints never were, reviewed updates
  // already cycle system apps, and a stopped one recovers from this page or the CLI. Stopping or
  // restarting the Shell itself takes this UI down with it, so the action handler confirms that case.
  const canControl = canManageApps;
  const canSwitchRuntime = canManageApps;
  // `backup` and `logs` are the only genuine capability gates left: unlike the lifecycle verbs, they
  // are optional *features* that depend on the app itself (does it have data worth snapshotting?),
  // which is why Core's canonical vocabulary is now just those two. Restore lives inside this panel.
  const canBackup = canControl && app.capabilities.includes("backup");
  // Console logs (docker logs) are served on-demand by Core, so the action shows for any app that
  // declares the `logs` capability — independent of the telemetry backend.
  const canViewLogs = app.capabilities.includes("logs");
  const canConfigure = canManageApps;
  // Live source runtimes have no reviewed-update path (the manifest is adopted on restart), so the
  // Update affordance is hidden — that live check is all appSupportsReviewedUpdate does. System apps go through the same reviewed plan/apply flow as
  // every other runtime app (docs/features/runtime-app-update/feature.md).
  const canUpdate = canManageApps && appSupportsReviewedUpdate(app);
  // The row's update affordance renders from the fleet-check verdict on the app summary (plan-first
  // updates), as one icon among the other row actions: blue applies the cached plan straight away,
  // amber opens Core confirmation for changes requiring consent. Progress is operationStatus — server
  // state, so it survives reloads and shows for every admin.
  const updating = app.operationStatus === "updating";
  const verdict = canUpdate && !updating ? app.updateCheck : null;
  const updateVisible = Boolean(verdict?.updateAvailable);
  // A missing cached digest makes the click rebuild the plan and classify the fresh candidate.
  // Only its review-required verdict opens Core confirmation; routine updates queue directly.
  const needsReview = verdict?.requiresReview === true;
  const configurationRequired = app.configurationReadiness?.required === true;
  const showRestartRequired = Boolean(app.restartRequired && !lifecycleLabel);
  // Removal, like start/stop/restart/update, is an inherent Core operation: the endpoint authorizes on
  // the admin session, never on the manifest `capabilities` list, so an app cannot decline to be
  // uninstalled by omitting a token. System apps are removable too; Core confirmation explains
  // the consequences. App permissions and the acting user's role are checked by Core.
  const canRemove = canManageApps;
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;
  // Same call the details panel makes, so the row's icons and the panel's alerts always describe the
  // same set of problems.
  const problems = collectAppProblems(app);
  // Update, permission and manifest alerts are independent of service health.
  const needsDiagnostics = app.health?.status === "degraded" || app.health?.status === "unhealthy";

  return (
    <TableRow role="row" className={cn("dashboard-row", canConfigure && "cursor-pointer")} data-testid={`app-row-${app.id}`}
      onClick={event => {
        if (!canConfigure || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.target;
        // React portals bubble through the row too. Only its own noninteractive surface navigates.
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        const control = target.closest("a, button, input, select, textarea, summary, [tabindex], [contenteditable=true]");
        if (control && event.currentTarget.contains(control)) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
        onOpenPanel(app, "settings");
      }}>
      <TableCell role="cell" className="dashboard-identity">
        <div className="flex min-w-0 items-start gap-2">
          <AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} name={app.icon} fallback={Boxes} className="dashboard-app-icon h-10 w-10 shrink-0 self-center rounded-lg" alt="" />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {canConfigure ? <Link href={getManageAppHref(app.id)} title={`${app.displayName} · ${app.id}`}
                className="truncate rounded-sm font-medium outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand">{app.displayName}</Link>
                : <span className="truncate font-medium" title={`${app.displayName} · ${app.id}`}>{app.displayName}</span>}

              {app.system && !isShell && <AppRoleIcon kind="system" />}
              {isShell && <AppRoleIcon kind="shell" />}
              <AppProblemIcons problems={problems} updateCheck={app.updateCheck} onPermissions={() => onOpenPanel(app, "settings", { settingsTab: "permissions" })} />
              {showRestartRequired && <Badge variant="secondary" className="border-warning/30 bg-warning-soft text-warning-foreground" title="Settings or mounts changed since this app started.">Restart required</Badge>}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
              <div className="dashboard-version contents">
                <AppVersionCell app={app} workspace={workspace} verdict={verdict} updateVisible={updateVisible} />
              </div>
              {runtimeLabel && <><span aria-hidden="true">·</span><span className="dashboard-runtime" title="Runtime">{runtimeLabel}</span></>}
            </div>
            {configurationRequired && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-warning-foreground">
                <span>Configuration required</span>
                {canConfigure && <Button variant="link" size="sm" className="h-auto p-0 text-xs text-inherit"
                  onClick={() => onOpenPanel(app, "settings", { settingsTab: app.configurationReadiness?.mounts.length && !app.configurationReadiness?.missingSettings.length ? "mounts" : "app" })}>Configure</Button>}
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell role="cell" className="dashboard-status">
        <div className="space-y-1">
          <div role={lifecycleLabel ? "status" : undefined} className="flex flex-wrap items-center gap-1.5">
            <StatusBadge value={lifecycleLabel ?? (app.runtimeState || "unknown")} health={!lifecycleLabel && isAppUp(app.runtimeState) ? app.health?.status : null} />
          </div>
          <AppUpdateFeedback app={app} />
        </div>
      </TableCell>
      <TableCell role="cell" className="dashboard-resources">
        {running && app.operationStatus !== "updating" ? <ResourceUsage appId={app.id} label={app.displayName} /> : <span className="px-1.5 text-muted-foreground" aria-label="Resources unavailable">—</span>}
      </TableCell>
      <TableCell role="cell" className="dashboard-actions">
        <div className="flex items-center justify-end gap-1">
          <div className="dashboard-context-action">
            {canControl && lifecycleLabel ? <Button variant="outline" size="sm" disabled><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{lifecycleLabel}</Button>
              : showRestartRequired && canControl ? <Button variant="outline" size="sm" disabled={lifecycleDisabled || Boolean(busyAction?.startsWith(`${app.id}:`))} onClick={() => onAction(app, "restart")}>Restart</Button>
              : running && canViewLogs && needsDiagnostics ? <Button variant="outline" size="sm" onClick={() => onOpenPanel(app, "logs")}>Logs</Button>
              : configurationRequired && canConfigure ? <Button variant="outline" size="sm" onClick={() => onOpenPanel(app, "settings", { settingsTab: app.configurationReadiness?.mounts.length && !app.configurationReadiness?.missingSettings.length ? "mounts" : "app" })}>Configure</Button>
              : updateVisible ? <Button variant="outline" size="sm" disabled={isBusy("update")} onClick={() => needsReview ? onOpenPanel(app, "update") : onUpdateApp(app)}>Update</Button>
              : !running && canControl ? <Button variant="outline" size="sm" disabled={lifecycleDisabled || isBusy("start")} onClick={() => onAction(app, "start")}>Start</Button>
              : canViewLogs && !canControl ? <Button variant="outline" size="sm" onClick={() => onOpenPanel(app, "logs")}>Logs</Button>
              : running && canControl ? <Button variant="outline" size="sm" disabled={lifecycleDisabled || isBusy("stop")} onClick={() => onAction(app, "stop")}>Stop</Button> : null}
          </div>
          <InstalledAppActionsMenu
            app={app}
            runtimeMenu={<RuntimeSwitcher app={app} workspace={workspace} canSwitch={canSwitchRuntime} busyAction={busyAction} onSwitchRuntime={onSwitchRuntime} targets={executionTargets} />}
            canControl={canControl}
            running={running}
            transitioning={lifecycleDisabled}
            startBusy={isBusy("start")}
            stopBusy={isBusy("stop")}
            restartBusy={isBusy("restart")}
            autostartBusy={isBusy("autostart")}
            canViewLogs={canViewLogs}
            canBackup={canBackup}
            canConfigure={canConfigure}
            canRemove={canRemove}
            canCheckUpdate={canUpdate}
            canReviewUpdate={updateVisible}
            checkingUpdate={checkingUpdate}
            onLifecycleAction={(action) => onAction(app, action)}
            onCheckUpdate={() => onCheckUpdate(app)}
            onReviewUpdate={() => onOpenPanel(app, "update")}
            onOpenPanel={onOpenPanel}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function AppUpdateFeedback({ app }: { app: CoreApp }) {
  const label = updateFeedback(app);
  if (!label) return null;
  return <div role="status" className="flex min-w-0 items-start gap-1 text-xs leading-4 text-muted-foreground [&>svg]:mt-0.5 [&>svg]:shrink-0">
    <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /><span className="min-w-0 whitespace-normal wrap-anywhere">{label}</span>
  </div>;
}

// Core's version, and — when an update is offered — the version the channel publishes under it, in the
// same shape the app rows use. That includes a rebuild of the version already installed, which on a
// rolling channel is the ordinary case: the line answers "which version would I get", and the tooltip
// title separates "New build of 0.97.0" from "Update to 0.98.0". Core's own check is a binary-hash
// comparison, so it can name a version only when the release carries the marker; an older release
// leaves the installed version beside the update icon to say the rest.
//
// The tooltips name the release channel, and only that. Unlike an app row there is no revision to
// show — no hash of the published binary is exposed to a client — and `checkedAt` is deliberately left
// out: a timestamp that moves on its own would make the tooltip look like it were reporting progress.
function CoreVersionBlock({ status, coreUpdate }: { status: CoreStatus | null; coreUpdate: CoreUpdateStatus | null }) {
  if (!status?.version) {
    return <span className="font-mono text-xs text-muted-foreground">version unknown</span>;
  }

  const channel: AppRevision[] = coreUpdate ? [{ label: "Release channel", value: coreUpdate.releaseTag }] : [];
  const available = resolveAvailableCoreVersion(coreUpdate);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-0.5 text-xs leading-tight text-muted-foreground">
        <div>
          <VersionLine
            value={status.version}
            title={`Installed ${status.version}`}
            revisions={channel}
            empty="Core has not checked its release channel yet."
          />
        </div>
        {available && (
          <div>
            <VersionLine
              value={available}
              className="text-info-foreground decoration-sky-600/50 dark:text-sky-400 dark:decoration-sky-400/50"
              title={available === status.version ? `New build of ${available}` : `Update to ${available}`}
              revisions={channel}
              empty="Core has not checked its release channel yet."
            />
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// Release versions share the identity block; update feedback belongs beneath the runtime status.
function AppVersionCell({ app, workspace, verdict, updateVisible }: {
  app: CoreApp; workspace?: WorkspaceSource; verdict: AppUpdateAvailability | null | undefined;
  updateVisible: boolean;
}) {
  const profile = app.runtimeProfiles?.find(profile => profile.key === app.selectedRuntime);
  if (workspace || profile?.development) return <SourceVersionCell key={`${app.id}:${app.sourceLivePath}:${app.sourceOverridePath}:${app.sourceManagedPath}`} app={app} workspace={workspace} compact />;
  const available = updateVisible ? resolveAvailableVersionLabel(verdict) : null;
  return <TooltipProvider delayDuration={150}>
    <div className="min-w-0 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <VersionLine value={app.version} title={`Installed ${app.version}`} revisions={collectInstalledRevisions(app)} empty="No pinned revision recorded for this build." />
        {available && <><span aria-hidden="true">→</span><VersionLine value={available} className="text-info-foreground" title={`Update to ${available}`} revisions={collectTargetRevisions(verdict)} empty="This update changes the app's manifest, not a compiled artifact." /></>}
      </div>
    </div>
  </TooltipProvider>;
}

// One version line and the revisions it stands for. The trigger is a span with tabIndex rather than a
// button: it does take a tab stop — a keyboard reader must be able to reach a tooltip that is the only
// place the exact revision appears — but it is a disclosure, not an action, and a button would have
// assistive technology announce each version in the table as something to press.
function VersionLine({
  value,
  title,
  revisions,
  empty,
  className,
}: {
  value: string;
  title: string;
  revisions: AppRevision[];
  empty: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-block max-w-full truncate cursor-help font-mono underline decoration-dotted underline-offset-4 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand",
            className ?? "decoration-muted-foreground/70",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          {revisions.length === 0 ? (
            <div className="opacity-80">{empty}</div>
          ) : (
            revisions.map((revision) => (
              <div key={`${revision.label}:${revision.value}`}>
                <span className="opacity-70">{revision.label}: </span>
                <span className="font-mono break-all">{revision.value}</span>
              </div>
            ))
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function AppRoleIcon({ kind }: { kind: "system" | "shell" }) {
  const Icon = kind === "system" ? Cog : PanelsTopLeft;
  const label = kind === "system" ? "System app" : "Shell interface";
  const description = kind === "system"
    ? "Provides host-level functionality. Access is limited to host administrators."
    : "Provides the Hosty web interface for navigation, app access, and host management.";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} role="img" aria-label={label} className="inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand focus-visible:ring-0">
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 space-y-1" sideOffset={4}>
          <p className="font-medium">{label}</p>
          <p>{description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AppProblemIcons({ problems, updateCheck, onPermissions }: { problems: AppProblem[]; updateCheck?: AppUpdateAvailability | null; onPermissions: () => void }) {
  const permissionProblems = problems.filter(problem => problem.action === "permissions");
  problems = problems.filter(problem => problem.action !== "permissions");
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");

  return (
    <TooltipProvider delayDuration={150}>
      {permissionProblems.map(problem => <Tooltip key={problem.title}>
        <TooltipTrigger asChild>
          <button type="button" onClick={onPermissions} aria-label={problem.title}
            className="inline-flex shrink-0 rounded outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand">
            <CircleAlert aria-hidden="true" className={cn("h-4 w-4", problem.severity === "error" ? "text-destructive-foreground" : "text-warning-foreground")} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-line break-words text-left" sideOffset={4}>
          {`${problem.title}: ${problem.detail}`}
        </TooltipContent>
      </Tooltip>)}
      {errors.length > 0 && <AppProblemIcon severity="error" problems={errors} updateCheck={updateCheck} />}
      {warnings.length > 0 && <AppProblemIcon severity="warning" problems={warnings} updateCheck={updateCheck} />}
    </TooltipProvider>
  );
}

function AppProblemIcon({ severity, problems, updateCheck }: { severity: AlertSeverity; problems: AppProblem[]; updateCheck?: AppUpdateAvailability | null }) {
  const Icon = severity === "error" ? CircleAlert : TriangleAlert;
  const label = severity === "error"
    ? `${problems.length} problem${problems.length === 1 ? "" : "s"} affecting this app`
    : `${problems.length} problem${problems.length === 1 ? "" : "s"} needing attention`;
  const summary = problems.map(problem => problem.title === "Update check failed" && updateCheck?.error
    ? updateCheckDescription(updateCheck)
    : `${problem.title}: ${problem.detail}`).join("\n\n");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} tabIndex={0}
          className="inline-flex shrink-0 rounded outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand">
          <Icon className={cn("h-4 w-4", severity === "error" ? "text-destructive-foreground" : "text-warning-foreground")} aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-line break-words text-left" sideOffset={4}>
        {summary}
      </TooltipContent>
    </Tooltip>
  );
}

function RuntimeSwitcher({ app, workspace, canSwitch, busyAction, onSwitchRuntime, targets }: {
  app: CoreApp;
  workspace?: WorkspaceSource;
  canSwitch: boolean;
  busyAction: string | null;
  targets?: AppExecutionTargets;
  onSwitchRuntime: (app: CoreApp, target: string | AppExecutionSelection) => void;
}) {
  const choices: AppExecutionChoice[] = targets?.choices ?? (app.runtimeProfiles ?? []).filter(profile => !profile.development)
    .map(profile => ({ kind: "package" as const, runtime: profile.key, name: profile.key, available: true }));
  const current = targets?.current;
  const profile = app.runtimeProfiles?.find(profile => profile.key === app.selectedRuntime);
  const fromWorkspace = current?.kind === "workspace" || workspace !== undefined;
  const development = profile?.development === true || fromWorkspace;
  const switching = busyAction?.startsWith(`${app.id}:switch-runtime:`) ?? false;
  const selected = (choice: (typeof choices)[number]) => choice.kind === "workspace"
    ? current?.kind === "workspace" && choice.workspaceId === current.workspaceId && choice.worktreeId === current.worktreeId
    : !development && current?.kind !== "workspace" && choice.runtime === app.selectedRuntime;
  if (!canSwitch || !choices.some(choice => choice.available && !selected(choice))) return null;
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger disabled={switching || isAppBusy(app.runtimeState) || app.operationStatus === "updating"}
      aria-label={`Switch runtime for ${app.displayName}`}>
      {switching ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Boxes className="size-4" />}
      Runtime / workspace
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-2rem)]">
      <DropdownMenuGroup>
        {choices.map(choice => <DropdownMenuItem key={choice.kind === "workspace" ? `workspace:${choice.workspaceId}:${choice.worktreeId}` : `package:${choice.runtime}`}
          disabled={switching || !choice.available} title={choice.unavailable} aria-current={selected(choice) ? true : undefined}
          onSelect={() => { if (!selected(choice)) onSwitchRuntime(app, { kind: choice.kind as "workspace" | "package", runtime: choice.runtime,
            workspaceId: choice.workspaceId, worktreeId: choice.worktreeId }); }}>
          <Check className={cn("size-4 shrink-0", selected(choice) ? "opacity-100" : "opacity-0")} />
          {choice.kind === "workspace" ? <Boxes className="size-4 shrink-0" /> : <Package className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{choice.kind === "workspace" ? choice.name || "Workspace" : choice.runtime}</span>
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
}

function InstalledAppActionsMenu({
  app,
  runtimeMenu,
  canControl,
  running,
  transitioning,
  startBusy,
  stopBusy,
  restartBusy,
  autostartBusy,
  canViewLogs,
  canBackup,
  canConfigure,
  canRemove,
  canCheckUpdate,
  canReviewUpdate,
  checkingUpdate,
  onLifecycleAction,
  onCheckUpdate,
  onReviewUpdate,
  onOpenPanel,
}: {
  app: CoreApp;
  runtimeMenu: ReactNode;
  // The menu is the complete action list; the row exposes one contextual shortcut.
  canControl: boolean;
  running: boolean;
  transitioning: boolean;
  startBusy: boolean;
  stopBusy: boolean;
  restartBusy: boolean;
  autostartBusy: boolean;
  onLifecycleAction: (action: AppAction) => void;
  canViewLogs: boolean;
  canBackup: boolean;
  canConfigure: boolean;
  canRemove: boolean;
  // Same gate as the row's Update affordance: an admin, and an app with a reviewed-update path.
  canCheckUpdate: boolean;
  // True exactly when the row shows its update icon, so the plan is reachable from the menu as well
  // — the only way in for a routine update, whose icon applies straight away.
  canReviewUpdate: boolean;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
  onReviewUpdate: () => void;
  onOpenPanel: OpenAppPanel;
}) {
  const hasMenuActions =
    canControl ||
    canCheckUpdate ||
    canReviewUpdate ||
    canViewLogs ||
    canBackup ||
    canConfigure ||
    canRemove;

  if (!hasMenuActions) {
    return null;
  }


  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {runtimeMenu}
        <AppSessionMenuItem appId={app.id} />
        {canControl && (
          <>
            <DropdownMenuLabel>Lifecycle</DropdownMenuLabel>
            {running ? (
              <DropdownMenuItem disabled={transitioning || stopBusy} onClick={() => onLifecycleAction("stop")}>
                <Square className="h-4 w-4" />
                Stop app
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={app.configurationReadiness?.required || transitioning || startBusy} onClick={() => onLifecycleAction("start")}>
                <Play className="h-4 w-4" />
                Start app
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={app.configurationReadiness?.required || transitioning || restartBusy} onClick={() => onLifecycleAction("restart")}>
              <RotateCcw className="h-4 w-4" />
              Restart app
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {canReviewUpdate && (
          <DropdownMenuItem onClick={onReviewUpdate}>
            <ArrowUpCircle className="h-4 w-4" />
            Update app
          </DropdownMenuItem>
        )}
        {canCheckUpdate && (
          <DropdownMenuItem
            disabled={checkingUpdate}
            // Keep the menu open while the check runs so the spinner is visible.
            onSelect={(event) => {
              event.preventDefault();
              onCheckUpdate();
            }}
          >
            {checkingUpdate ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
            Check for updates
          </DropdownMenuItem>
        )}
        {(canCheckUpdate || canReviewUpdate) &&
          (canViewLogs || canBackup || canConfigure || canRemove) && <DropdownMenuSeparator />}
        {canViewLogs && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "logs")}>
            <Terminal className="h-4 w-4" />
            Console logs
          </DropdownMenuItem>
        )}
        {canBackup && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "backups")}>
            <Database className="h-4 w-4" />
            Backups
          </DropdownMenuItem>
        )}
        {canConfigure && <DropdownMenuCheckboxItem checked={isAppAutostartEnabled(app)} disabled={autostartBusy || transitioning || startBusy || stopBusy || restartBusy} onCheckedChange={() => onLifecycleAction("autostart")}>Autostart</DropdownMenuCheckboxItem>}
        {canRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive-foreground focus:text-destructive-foreground" onClick={() => onOpenPanel(app, "remove")}>
              <Trash2 className="h-4 w-4" />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
