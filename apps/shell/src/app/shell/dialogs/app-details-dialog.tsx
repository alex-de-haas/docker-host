"use client";

import { AppPermissions } from "./app-permissions";
import { ConsoleLogsPanel } from "./app-console-logs";
import { AppUpdatesPanel } from "./app-updates-panel";
import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { PrivateSourceConnections } from "./private-source-connections";

import { SourceChangesButton } from "../source/source-changes";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Boxes, Ellipsis, Play, Square, ExternalLink, Archive, FileText, FolderGit2, HardDrive, Info, LoaderCircle, Lock, Plus, Radio, RefreshCw, Rss, Settings, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppIcon } from "../app-icon";
import { resolveAssetSrc } from "../app-helpers";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AppLaunchSummary } from "../pages/app-launch-summary";
import { AppNetworkSummary } from "../pages/app-network-summary";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { detailTitle, formatBytes, isAppAutostartEnabled } from "../app-helpers";
import { getAppFeeds, isAuthRequiredRedirectError } from "../core-api";
import {
  buildPublicOriginGroups,
  isPublicOriginSettingKey,
  PublicOriginInput,
  SettingInput,
} from "../settings";
import type { AppSettingsDraft } from "../settings-draft";
import { buildAppSettingsDraft, buildAppSettingsPayload } from "../settings-draft";
import type {
  CoreApp,
  CoreAppFeedsResponse,
  CoreBackup,
  CoreBackupCleanupPlan,
  CoreGlobalMount,
  CoreMountSlot,
  CoreUpdatePlan,
  DetailPanelState,
  DetailView,
  MountBindingInput,
  SettingsTab,
} from "../types";
import { Alert, CheckboxRow, EmptyState, IconButton, InlineError, StatusBadge } from "../ui";
import { isAppIdle, isAppUp } from "../runtime-states";
import { appReadinessProblem, collectAppProblems } from "../app-problems";
import type { ManagedPublicOriginReason } from "../use-managed-public-origins";
import { useManagedPublicOrigins } from "../use-managed-public-origins";

export function AppDetailsDialog({
  app,
  page = false,
  onTabChange,
  view,
  settingsTab,
  serviceRevision,
  coreOrigin,
  globalMounts,
  canManageApps,
  isShell,
  busyAction,
  detail,
  onClose,
  onRefreshBackups,
  onCreateBackup,
  onRestoreBackup,
  onDeleteBackup,
  onPreviewBackupCleanup,
  onApplyBackupCleanup,
  onConfigure,
  onConfigureMounts,
  onConfigureSource,
  onClearSource,
  onSetFeed,
  onRevealSetting,
  onAskAssistant,
  onManageAction, onOpenApp, onShowLogs, onShowRemoval, onCheckUpdate, onUpdate,
}: {
  app: CoreApp;
  onCheckUpdate?: (app: CoreApp) => Promise<CoreUpdatePlan>;
  onUpdate?: (app: CoreApp) => void;
  page?: boolean;
  onManageAction?: (action: "start" | "restart" | "stop") => void;
  onOpenApp?: () => void; onShowLogs?: () => void; onShowRemoval?: () => void;
  onTabChange?: (tab: SettingsTab) => void;
  view: Exclude<DetailView, "remove">;
  settingsTab?: SettingsTab;
  serviceRevision?: number;
  coreOrigin: string;
  globalMounts: CoreGlobalMount[];
  canManageApps: boolean;
  // True when this app is the Shell serving the current page — its update view carries a
  // self-update warning (the Shell restarts under the operator, then the page reloads).
  isShell: boolean;
  busyAction: string | null;
  detail: DetailPanelState;
  onClose: () => void;
  onRefreshBackups: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
  onPreviewBackupCleanup: (app: CoreApp) => void;
  onApplyBackupCleanup: (app: CoreApp, plan: CoreBackupCleanupPlan) => void;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void | boolean | Promise<boolean | void>;
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
  onConfigureSource: (app: CoreApp, path: string) => void;
  onClearSource: (app: CoreApp) => void;
  onSetFeed: (app: CoreApp, feedId: string) => void;
  // Fetches one setting's stored value on the operator's explicit reveal click (admin-gated in Core).
  onRevealSetting?: (app: CoreApp, key: string) => Promise<string | null>;
  // Opens the assistant panel seeded with this app + view as context. Undefined when no ai-gateway
  // provider is installed (or the viewer is not an admin), which leaves no trace of the feature.
  onAskAssistant?: () => void;
}) {
  const canConfigureApp = canManageApps;

  if (page) return <section className="flex min-h-[32rem] flex-col gap-5">
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"><Button asChild variant="ghost" size="sm"><Link href={canManageApps ? "/dashboard" : "/"}>{canManageApps ? "Dashboard" : "Home"}</Link></Button><ChevronRight className="size-3.5 shrink-0" aria-hidden /><span className="truncate" aria-current="page">{app.displayName}</span></nav>
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3"><AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} name={app.icon} fallback={Boxes} className="size-12 rounded-xl" />
        <div className="min-w-0 space-y-1.5"><h1 className="break-words text-2xl font-semibold tracking-tight">{app.displayName}</h1><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">{app.version}</span><Badge variant="outline">{app.selectedRuntime || "Runtime unavailable"}</Badge><StatusBadge value={app.runtimeState || app.operationStatus} health={isAppUp(app.runtimeState) ? app.health?.status : null} /></div><p className="break-all font-mono text-xs text-muted-foreground">{app.id}</p></div></div>
      <div className="flex flex-wrap items-center gap-2">
        {onOpenApp && <Button variant="outline" size="sm" onClick={onOpenApp}><ExternalLink className="size-4" />Open app</Button>}
        {onManageAction && <><Button variant="outline" size="sm" disabled={!!busyAction} onClick={() => onManageAction(isAppUp(app.runtimeState) ? "restart" : "start")}>{isAppUp(app.runtimeState) ? <RefreshCw className="size-4" /> : <Play className="size-4" />}{isAppUp(app.runtimeState) ? "Restart" : "Start"}</Button>
          {isAppUp(app.runtimeState) && <Button variant="outline" size="sm" disabled={!!busyAction} onClick={() => onManageAction("stop")}><Square className="size-4" />Stop</Button>}</>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More app actions"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">{onShowLogs && <DropdownMenuItem onSelect={onShowLogs}>Logs</DropdownMenuItem>}{onAskAssistant && <DropdownMenuItem onSelect={onAskAssistant}>Ask assistant</DropdownMenuItem>}{canManageApps && onShowRemoval && <DropdownMenuItem onSelect={onShowRemoval}>Remove app…</DropdownMenuItem>}</DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    {app.restartRequired && <p role="status" className="rounded-lg border border-brand-strong/30 bg-brand-soft px-4 py-3 text-sm">Configuration changed. Restart this app explicitly to apply it to running services.</p>}
    {detail.error && <InlineError message={detail.error} />}
    {collectAppProblems(app).map(problem => <Alert key={problem.title} severity={problem.severity} title={problem.title} detail={problem.detail} />)}
    {appReadinessProblem(app) && onShowLogs && <Button type="button" variant="outline" size="sm" className="self-start" onClick={onShowLogs}><FileText className="size-4" />Open console logs</Button>}
    {canConfigureApp ? <SettingsDialog app={app} serviceRevision={serviceRevision} isShell={isShell} onCheckUpdate={onCheckUpdate} onUpdate={onUpdate} busyAction={busyAction} canManageApps={canConfigureApp} globalMounts={globalMounts} initialTab={settingsTab} onTabChange={onTabChange} coreOrigin={coreOrigin} onSetFeed={onSetFeed} onConfigure={onConfigure} onConfigureMounts={onConfigureMounts} onConfigureSource={onConfigureSource} onClearSource={onClearSource} onRevealSetting={onRevealSetting}
      backups={app.capabilities.includes("backup") ? <BackupsPanel app={app} detail={detail} busyAction={busyAction} onRefresh={onRefreshBackups} onCreateBackup={onCreateBackup} onRestoreBackup={onRestoreBackup} onDeleteBackup={onDeleteBackup} onPreviewCleanup={onPreviewBackupCleanup} onApplyCleanup={onApplyBackupCleanup} /> : undefined} />
      : settingsTab === "logs" && app.capabilities.includes("logs") ? <Tabs value="logs" className="min-w-0 gap-5"><TabsList variant="line" aria-label="App details"><TabsTrigger value="logs">Logs</TabsTrigger></TabsList><TabsContent value="logs"><ConsoleLogsPanel key={app.id} app={app} coreOrigin={coreOrigin} /></TabsContent></Tabs>
        : <InlineError message="You do not have permission to manage this application." />}
  </section>;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={view === "logs" ? "w-[calc(100%-2rem)] sm:max-w-7xl" : "sm:max-w-3xl"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="min-w-0 truncate">{detailTitle(view)} · {app.displayName}</span>
            {onAskAssistant && (
              <Button type="button" variant="outline" size="sm" className="mr-6 ml-auto" onClick={onAskAssistant}>
                <Sparkles /> Ask assistant
              </Button>
            )}
          </DialogTitle>
          <DialogDescription>{app.id}</DialogDescription>
        </DialogHeader>
        {detail.error && <InlineError message={detail.error} />}
        {view === "backups" && (canManageApps ? (
          <BackupsPanel
            app={app}
            detail={detail}
            busyAction={busyAction}
            onRefresh={onRefreshBackups}
            onCreateBackup={onCreateBackup}
            onRestoreBackup={onRestoreBackup}
            onDeleteBackup={onDeleteBackup}
            onPreviewCleanup={onPreviewBackupCleanup}
            onApplyCleanup={onApplyBackupCleanup}
          />
        ) : (
          <InlineError message="You do not have permission to manage app backups." />
        ))}
        {view === "settings" && (canConfigureApp ? (
          <SettingsDialog
            app={app}
            serviceRevision={serviceRevision}
            isShell={isShell}
            onCheckUpdate={onCheckUpdate}
            onUpdate={onUpdate}
            busyAction={busyAction}
            canManageApps={canConfigureApp}
            globalMounts={globalMounts}
            initialTab={settingsTab}
            coreOrigin={coreOrigin}
            onSetFeed={onSetFeed}
            onConfigure={onConfigure}
            onConfigureMounts={onConfigureMounts}
            onConfigureSource={onConfigureSource}
            onClearSource={onClearSource}
            onRevealSetting={onRevealSetting}
          />
        ) : (
          <InlineError message="You do not have permission to manage app settings." />
        ))}
        {view === "logs" && <ConsoleLogsPanel key={app.id} app={app} coreOrigin={coreOrigin} />}
      </DialogContent>
    </Dialog>
  );
}

function BackupsPanel({
  app,
  detail,
  busyAction,
  onRefresh,
  onCreateBackup,
  onRestoreBackup,
  onDeleteBackup,
  onPreviewCleanup,
  onApplyCleanup,
}: {
  app: CoreApp;
  detail: DetailPanelState;
  busyAction: string | null;
  onRefresh: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
  onPreviewCleanup: (app: CoreApp) => void;
  onApplyCleanup: (app: CoreApp, plan: CoreBackupCleanupPlan) => void;
}) {
  const backups = detail.backups || [];
  const cleanupPlan = detail.backupCleanupPlan;
  const isRunning = isAppUp(app.runtimeState);
  // Restore writes over the app's data directory, so it needs the narrowest gate: stopped, not
  // merely "not running". An app still shutting down would pass the latter and race the runtime
  // for those files. Core enforces the same predicate and answers app_must_be_stopped.
  const canRestore = isAppIdle(app.runtimeState);

  return (
    <DialogBody className="space-y-4">
      <section className="rounded-xl border bg-card px-4 py-4" aria-label="Backup coverage"><h3 className="text-sm font-medium">App data</h3><p className="mt-1 text-sm text-muted-foreground">Backups include only this app’s primary data directory. Cache, attached host folders and additional storage mappings are excluded.</p></section>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onCreateBackup(app)} disabled={busyAction === `${app.id}:backup`}>
          {busyAction === `${app.id}:backup` ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Archive className="h-4 w-4" />}
          Create backup
        </Button>
        <Button variant="outline" onClick={() => onRefresh(app, false)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin motion-reduce:animate-none")} />
          Refresh
        </Button>
        <Button variant="outline" onClick={() => onPreviewCleanup(app)} disabled={busyAction === `${app.id}:backup-cleanup-plan`}>
          <FileText className="h-4 w-4" />
          Preview prune
        </Button>
      </div>
      {isRunning && (
        <div className="flex items-start gap-2 rounded-md border p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Creating a backup briefly stops this running app while its data is copied, then restarts it.</span>
        </div>
      )}
      {cleanupPlan && (
        <div className="rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{cleanupPlan.candidates.length} prune candidates</div>
              <code className="block truncate text-xs text-muted-foreground">{cleanupPlan.planDigest}</code>
            </div>
            <Button variant="destructive" onClick={() => onApplyCleanup(app, cleanupPlan)} disabled={cleanupPlan.candidates.length === 0 || busyAction === `${app.id}:backup-cleanup`}>
              <Trash2 className="h-4 w-4" />
              Apply prune
            </Button>
          </div>
        </div>
      )}
      {detail.loading ? (
        <EmptyState loading title="Loading backups" />
      ) : backups.length === 0 ? (
        <EmptyState title="No backups" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Retention</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {backups.map((backup) => (
              <TableRow key={backup.backupId}>
                <TableCell>
                  <div className="font-medium">{backup.reason}</div>
                  <div className="text-xs text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</div>
                  <code className="text-xs text-muted-foreground">{backup.backupId}</code>
                </TableCell>
                <TableCell>{backup.fileCount}</TableCell>
                <TableCell>{formatBytes(backup.archiveSize)}</TableCell>
                <TableCell>{backup.retention?.reason || "unknown"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <IconButton title="Restore" disabled={!canRestore || busyAction === `${app.id}:restore:${backup.backupId}`} onClick={() => onRestoreBackup(app, backup)}><Upload className="h-4 w-4" /></IconButton>
                    <IconButton title="Delete" disabled={busyAction === `${app.id}:delete-backup:${backup.backupId}`} onClick={() => onDeleteBackup(app, backup)} destructive><Trash2 className="h-4 w-4" /></IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DialogBody>
  );
}

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "app", label: "Launch" },
  { id: "logs", label: "Logs" },
  { id: "parameters", label: "Parameters" },
  { id: "mounts", label: "Folders" },
  { id: "publicOrigins", label: "Network" },
  { id: "permissions", label: "Permissions" },
  { id: "source", label: "Updates" },
  { id: "backups", label: "Backups" },
];

// Consolidated runtime-app configuration: App settings, Public origins, and Mounts as tabs. A tab is
// hidden when the app has no matching data; with a single tab the bar is omitted. App settings and
// public origins share one settings form (one configure endpoint); mounts saves separately.
function SettingsDialog({
  app,
  serviceRevision,
  isShell,
  onCheckUpdate,
  onUpdate,
  busyAction,
  canManageApps,
  globalMounts,
  initialTab,
  onTabChange,
  backups,
  coreOrigin,
  onSetFeed,
  onConfigure,
  onConfigureMounts,
  onConfigureSource,
  onClearSource,
  onRevealSetting,
}: {
  app: CoreApp;
  serviceRevision?: number;
  isShell: boolean;
  onCheckUpdate?: (app: CoreApp) => Promise<CoreUpdatePlan>;
  onUpdate?: (app: CoreApp) => void;
  busyAction: string | null;
  canManageApps: boolean;
  globalMounts: CoreGlobalMount[];
  initialTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  backups?: React.ReactNode;
  coreOrigin: string;
  onSetFeed: (app: CoreApp, feedId: string) => void;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void | boolean | Promise<boolean | void>;
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
  onConfigureSource: (app: CoreApp, path: string) => void;
  onClearSource: (app: CoreApp) => void;
  onRevealSetting?: (app: CoreApp, key: string) => Promise<string | null>;
}) {
  const settings = app.settings || [];
  const hasPublicOrigins = settings.some((setting) => isPublicOriginSettingKey(setting.key)) || !!app.endpoints?.length;
  const hasMounts = true;
  const hasSource = Boolean(app.supportsSource) || canManageApps;
  const availableTabs = SETTINGS_TABS.filter((tab) => {
    switch (tab.id) {
      case "logs":
        return app.capabilities.includes("logs");
      case "backups":
        return !!backups;
      case "parameters":
      case "app":
        return true;
      case "permissions":
        return canManageApps;
      case "publicOrigins":
        return hasPublicOrigins;
      case "mounts":
        return hasMounts;
      case "source":
        return hasSource;
    }
  });
  const defaultTab: SettingsTab = initialTab && availableTabs.some((tab) => tab.id === initialTab) ? initialTab : "app";
  const [active, setActive] = useState<SettingsTab>(defaultTab);
  const tabStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabStrip.current;
    if (!strip) return;
    const revealSelectedTab = () => {
      const selected = strip.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (!selected) return;
      const viewport = strip.getBoundingClientRect();
      const trigger = selected.getBoundingClientRect();
      const delta = trigger.left < viewport.left ? trigger.left - viewport.left : trigger.right > viewport.right ? trigger.right - viewport.right : 0;
      if (delta) strip.scrollLeft += delta;
    };
    revealSelectedTab();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(revealSelectedTab);
    observer?.observe(strip);
    if (!observer) window.addEventListener("resize", revealSelectedTab);
    return () => { observer?.disconnect(); window.removeEventListener("resize", revealSelectedTab); };
  }, [active, availableTabs.length]);

  // Reset the active tab while rendering when the app or requested tab changes.
  const resetSignature = `${app.id}|${initialTab ?? ""}`;
  const [prevReset, setPrevReset] = useState<string | null>(null);
  if (prevReset !== resetSignature || !availableTabs.some(tab => tab.id === active)) {
    setPrevReset(resetSignature);
    setActive(defaultTab);
  }

  return (
    <Tabs value={active} onValueChange={value => { setActive(value as SettingsTab); onTabChange?.(value as SettingsTab); }} className="min-h-0 flex-1 gap-5">
      {availableTabs.length > 1 && (
        <div ref={tabStrip} data-slot="manage-tab-strip" className="max-w-full overflow-x-auto border-b pb-1"><TabsList variant="line" aria-label="Manage application">
          {availableTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="px-3">{tab.label}</TabsTrigger>
          ))}
        </TabsList></div>
      )}
      <TabsContent value={active} className="flex min-h-0 flex-1 flex-col gap-4">
      {active === "logs" && app.capabilities.includes("logs") && <ConsoleLogsPanel key={app.id} app={app} coreOrigin={coreOrigin} />}
      {canManageApps && <div className={cn("min-h-0 overflow-y-auto", active !== "permissions" && "hidden")}><AppPermissions key={app.id} app={app} active={active === "permissions"} /></div>}
      {backups && <div className={cn("flex min-h-0 flex-1 flex-col", active !== "backups" && "hidden")}>{backups}</div>}
      {/* All forms stay mounted (toggled with hidden) so drafts survive tab switches. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", active !== "app" && active !== "parameters" && active !== "publicOrigins" && "hidden")}>
        <SettingsForm
          key={app.id}
          app={app}
          section={active === "publicOrigins" ? "publicOrigins" : active === "parameters" ? "parameters" : "app"}
          busyAction={busyAction}
          canManageApps={canManageApps}
          onConfigure={onConfigure}
          onRevealSetting={onRevealSetting}
          coreOrigin={coreOrigin}
          launchVisible={active === "app"}
          serviceRevision={serviceRevision}
        />
      </div>
      {hasMounts && (
        <div className={cn("flex min-h-0 flex-1 flex-col", active !== "mounts" && "hidden")}>
          <MountsForm
            key={app.id}
            app={app}
            busyAction={busyAction}
            canManageApps={canManageApps}
            globalMounts={globalMounts}
            onConfigureMounts={onConfigureMounts}
          />
        </div>
      )}
      {hasSource && (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-5", active !== "source" && "hidden")}>
          <AppUpdatesPanel key={`${app.id}|${app.version}|${app.selectedRuntime}|${app.followedFeedId}`} app={app} coreOrigin={coreOrigin} active={active === "source"} isShell={isShell} busyAction={busyAction} onCheckUpdate={onCheckUpdate} onUpdate={onUpdate} />
          <FeedSection key={`feed:${app.id}`} app={app} active={active === "source"} coreOrigin={coreOrigin} busyAction={busyAction} canManageApps={canManageApps} onSetFeed={onSetFeed} />
          {app.supportsSource && <SourceForm
            key={app.id}
            app={app}
            busyAction={busyAction}
            canManageApps={canManageApps}
            onConfigureSource={onConfigureSource}
            onClearSource={onClearSource}
          />}
          {canManageApps && <PrivateSourceConnections key={`source-connections:${app.id}`} appId={app.id} active={active === "source"} />}
        </div>
      )}
      </TabsContent>
    </Tabs>
  );
}

const MANAGED_ORIGIN_HINTS: Record<ManagedPublicOriginReason, string> = {
  derived: "Derived by the ingress provider from the base domain and this app's subdomain, on every start.",
  published: "Published through Cloudflare. Change or remove it from the endpoint's public-origin control.",
};

// Shown for an origin the operator owns. It is theirs to set, just not from here.
const OPERATOR_ORIGIN_HINT = "Yours to set, from the public-origin control on the endpoint.";

const sameDraft = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function reconcileSavedDraft<T>(draft: Record<string, T>, previous: Record<string, T>, next: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key,
    key in previous && key in draft && !sameDraft(draft[key], previous[key]) ? draft[key] : value]));
}
function hasDraftConflict<T>(draft: Record<string, T>, previous: Record<string, T>, next: Record<string, T>) {
  return Object.keys(next).some(key => key in previous && key in draft && !sameDraft(draft[key], previous[key])
    && !sameDraft(next[key], previous[key]) && !sameDraft(draft[key], next[key]));
}

function SettingsForm({
  app,
  section,
  busyAction,
  canManageApps,
  onConfigure,
  onRevealSetting,
  coreOrigin,
  launchVisible,
  serviceRevision,
}: {
  app: CoreApp;
  coreOrigin: string;
  launchVisible: boolean;
  serviceRevision?: number;
  section: "app" | "parameters" | "publicOrigins";
  busyAction: string | null;
  canManageApps: boolean;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void | boolean | Promise<boolean | void>;
  onRevealSetting?: (app: CoreApp, key: string) => Promise<string | null>;
}) {
  const settings = app.settings || [];
  const appSettings = settings.filter((setting) => !isPublicOriginSettingKey(setting.key) && !setting.key.startsWith("HOSTY_LOCAL_NAME_"));
  const publicOriginSettings = settings.filter((setting) => isPublicOriginSettingKey(setting.key));
  // Which public origins the active ingress provider owns. Rendering only: Core refuses a managed write
  // either way, and the field says why rather than failing on save.
  const managedPublicOrigins = useManagedPublicOrigins(app, publicOriginSettings.length > 0);
  const publicOriginGroups = buildPublicOriginGroups(app, publicOriginSettings);
  const saved = buildAppSettingsDraft(appSettings);
  const settingsSignature = JSON.stringify(appSettings.map(setting => [setting.key, setting.type, setting.secret, setting.required, setting.hasValue, setting.value]));
  const [draft, setDraft] = useState<AppSettingsDraft>(saved);
  const [baseline, setBaseline] = useState({ signature: settingsSignature, values: saved });
  const [savedChanged, setSavedChanged] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const edits = useRef<Record<string, number>>({});
  const submission = useRef({ revision: 0 });
  const mounted = useRef(true);
  useEffect(() => {
    const request = submission.current;
    mounted.current = true;
    return () => { mounted.current = false; ++request.revision; };
  }, []);
  if (baseline.signature !== settingsSignature) {
    const next = reconcileSavedDraft(draft, baseline.values, saved);
    setBaseline({ signature: settingsSignature, values: saved });
    setDraft(next);
    if (hasDraftConflict(draft, baseline.values, saved)) setSavedChanged(true);
    else if (sameDraft(next, saved)) setSavedChanged(false);
  }
  const autostart = isAppAutostartEnabled(app);
  const [autostartDraft, setAutostartDraft] = useState(autostart);
  const [previousAutostart, setPreviousAutostart] = useState(autostart);
  if (previousAutostart !== autostart) {
    setPreviousAutostart(autostart);
    if (autostartDraft === previousAutostart) setAutostartDraft(autostart);
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const request = ++submission.current.revision;
    const sent = { ...draft }, revisions = { ...edits.current };
    const secrets = section === "parameters" ? appSettings.filter(setting => setting.secret && sent[setting.key] !== null && sent[setting.key] !== undefined) : [];
    setSaveError(null);
    // Browser addresses keep their own reviewed control. Only an explicit accepted receipt can
    // retire a submitted secret: masked summaries cannot confirm its replacement value.
    try {
      const result = onConfigure(app, section === "parameters" ? buildAppSettingsPayload(appSettings, sent) : {}, section === "app" ? autostartDraft : undefined);
      void Promise.resolve(result).then(accepted => {
        if (!mounted.current || request !== submission.current.revision || accepted !== true) return;
        setDraft(current => {
          const next = { ...current };
          for (const setting of secrets) if ((edits.current[setting.key] ?? 0) === (revisions[setting.key] ?? 0) && current[setting.key] === sent[setting.key]) next[setting.key] = null;
          return next;
        });
      }, cause => { if (mounted.current && request === submission.current.revision) setSaveError(cause instanceof Error ? cause.message : "Could not save settings."); });
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Could not save settings."); }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        {section !== "publicOrigins" ? (
          <>
            {section === "app" && <>
              <section className="overflow-hidden rounded-xl border bg-card" aria-label="Launch preferences">
                <div className="grid gap-3 border-b px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><div><p className="text-sm font-medium">Start with host</p><p className="mt-1 text-xs text-muted-foreground">The same startup preference as the Dashboard.</p></div><CheckboxRow label="Start at Core startup" checked={autostartDraft} disabled={!canManageApps} onChange={setAutostartDraft} /></div>
                <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><p className="text-sm font-medium">Runtime</p><div className="min-w-0 space-y-2"><Badge variant="outline">{app.selectedRuntime || "Not reported"}</Badge><p className="text-xs text-muted-foreground">Runtime and source can be changed from this app’s More menu on the Dashboard.</p><Button asChild variant="outline" size="sm"><Link href="/dashboard">Open Dashboard</Link></Button></div></div>
              </section>
              {launchVisible && <AppLaunchSummary app={app} coreOrigin={coreOrigin} serviceRevision={serviceRevision} />}
            </>}
            {section === "parameters" && (appSettings.length > 0 ? (
              <div className="divide-y overflow-hidden rounded-xl border bg-card [&>div]:px-4 [&>div]:py-4">
                {appSettings.map((setting) => (
                  <SettingInput
                    key={`${setting.key}:${setting.secret}:${setting.hasValue}`}
                    descriptionMode="inline"
                    setting={setting}
                    value={draft[setting.key] ?? null}
                    disabled={!canManageApps}
                    onChange={(value) => { edits.current[setting.key] = (edits.current[setting.key] ?? 0) + 1; setDraft((current) => ({ ...current, [setting.key]: value })); }}
                    onReveal={onRevealSetting && setting.secret ? () => onRevealSetting(app, setting.key) : undefined}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This app has no additional launch parameters.</p>
            ))}
          </>
        ) : (
          <div className="space-y-4">
            <AppNetworkSummary app={app} />
            {publicOriginGroups.map((group) => ({ ...group, items: group.items.filter(item => !item.endpoint?.public) })).filter(group => group.items.length).map((group) => (
              <div key={group.service} className="space-y-2">
                <h3 className="text-sm font-medium">{group.service}</h3>
                <div className="space-y-2">
                  {group.items.map(({ setting, endpoint }) => {
                    const managed = managedPublicOrigins.get(setting.key);
                    return (
                      <div key={setting.key} className="space-y-1">
                        {/* Read-only everywhere now. One control writes a public origin — the globe on the
                            endpoint row — because what applying it does differs per provider: a local
                            string under `none`, an app subdomain under `cloudflared`, a DNS record and a
                            tunnel route under `cloudflare-remote`. A second editable field here could
                            only ever express the first of the three, which is how the two surfaces came
                            to disagree in the first place. The value stays visible next to the app's
                            other settings. */}
                        <PublicOriginInput
                          setting={setting}
                          endpoint={endpoint}
                          value={endpoint?.browserOrigin ?? setting.value ?? ""}
                          disabled
                          onChange={() => {}}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {managed ? MANAGED_ORIGIN_HINTS[managed] : OPERATOR_ORIGIN_HINT}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      {saveError && <InlineError message={saveError} />}
      {section === "parameters" && savedChanged && <p role="status" className="text-xs text-warning-foreground">Saved parameters changed. Your unsaved edits are retained; review them before saving.</p>}
      {section !== "publicOrigins" && <><p className="text-xs text-muted-foreground">Save applies configuration. Start or restart the app explicitly to apply it to running services.</p>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busyAction === `${app.id}:configure`} onClick={() => { if (section === "parameters") { ++submission.current.revision; setDraft(buildAppSettingsDraft(appSettings)); setSavedChanged(false); setSaveError(null); } else setAutostartDraft(isAppAutostartEnabled(app)); }}>Discard</Button>
        <Button type="submit" disabled={!canManageApps || busyAction === `${app.id}:configure`}>
          {busyAction === `${app.id}:configure` ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Settings className="h-4 w-4" />}
          Save settings
        </Button>
      </DialogFooter></>}
    </form>
  );
}

type MountRow = { source: "global" | "local"; globalMountName: string; label: string; hostPath: string };


function mountRowsFromSlots(slots: CoreMountSlot[]): Record<string, MountRow[]> {
  return Object.fromEntries(slots.map((slot) => [
    slot.key,
    slot.bindings.map((binding) => ({
      source: binding.source === "global" ? "global" : "local",
      globalMountName: binding.globalMountName ?? "",
      label: binding.label,
      hostPath: binding.hostPath,
    } satisfies MountRow)),
  ]));
}
function MountsForm({
  app,
  busyAction,
  canManageApps,
  globalMounts,
  onConfigureMounts,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  globalMounts: CoreGlobalMount[];
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
}) {
  const managed = (app.mounts ?? []).filter(slot => slot.kind === "managed-workspaces");
  const slots: CoreMountSlot[] = (app.mounts ?? []).filter(slot => slot.kind !== "managed-workspaces");
  const slotsSignature = JSON.stringify(
    slots.map((slot) => [slot.key, slot.bindings.map((binding) => [binding.source ?? "local", binding.globalMountName ?? "", binding.label, binding.hostPath])]),
  );
  const savedRows = mountRowsFromSlots(slots);
  const [rows, setRows] = useState<Record<string, MountRow[]>>(savedRows);
  const [baseline, setBaseline] = useState({ signature: slotsSignature, rows: savedRows });
  const [savedChanged, setSavedChanged] = useState(false);
  if (baseline.signature !== slotsSignature) {
    const next = reconcileSavedDraft(rows, baseline.rows, savedRows);
    setBaseline({ signature: slotsSignature, rows: savedRows });
    setRows(next);
    if (hasDraftConflict(rows, baseline.rows, savedRows)) setSavedChanged(true);
    else if (sameDraft(next, savedRows)) setSavedChanged(false);
  }

  const globalByName = useMemo(() => new Map(globalMounts.map((mount) => [mount.name, mount])), [globalMounts]);

  const updateRow = (key: string, index: number, patch: Partial<MountRow>) => {
    setRows((current) => {
      const next = (current[key] ?? []).slice();
      next[index] = { ...next[index], ...patch };
      return { ...current, [key]: next };
    });
  };

  const addRow = (key: string) => {
    const source: "global" | "local" = globalMounts.length > 0 ? "global" : "local";
    setRows((current) => ({
      ...current,
      [key]: [...(current[key] ?? []), { source, globalMountName: globalMounts[0]?.name ?? "", label: "", hostPath: "" }],
    }));
  };

  const removeRow = (key: string, index: number) => {
    setRows((current) => ({ ...current, [key]: (current[key] ?? []).filter((_, rowIndex) => rowIndex !== index) }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const mounts: MountBindingInput[] = [];
    for (const slot of slots) {
      for (const row of rows[slot.key] ?? []) {
        if (row.source === "global") {
          if (row.globalMountName) {
            mounts.push({ key: slot.key, globalMountName: row.globalMountName });
          }
        } else {
          const label = row.label.trim();
          const hostPath = row.hostPath.trim();
          if (label.length > 0 && hostPath.length > 0) {
            mounts.push({ key: slot.key, label, hostPath });
          }
        }
      }
    }
    onConfigureMounts(app, mounts);
  };

  const busy = busyAction === `${app.id}:mounts`;

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        <section className="overflow-hidden rounded-xl border bg-card" aria-label="Primary app data"><div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3"><h3 className="text-sm font-medium">App data</h3><Badge variant="outline">{app.capabilities.includes("backup") ? "Included in backups" : "No backup capability"}</Badge></div><div className="space-y-1 px-4 py-4"><p className="text-sm text-muted-foreground">Hosty keeps this app’s primary data separately from attached host folders.</p><p className="text-xs text-muted-foreground">Size unavailable</p></div></section>
        {slots.length === 0 && managed.length === 0 && <p className="rounded-xl border px-4 py-5 text-sm text-muted-foreground">This app does not declare any external mount slots.</p>}
        {(slots.length > 0 || managed.length > 0) && <p className="text-sm text-muted-foreground">
          Global mounts come from Shared mounts — label and path are fixed. Local paths bind a host folder directly; they must be absolute and outside the Hosty data root. External folders are never backed up or deleted by Hosty.
        </p>}
        {managed.map(slot => <div key={slot.key} className="space-y-1 rounded-md border p-3">
          <p className="text-sm font-medium">Managed workspaces · {slot.service ?? "all services"}</p>
          <p className="text-sm text-muted-foreground">Core supplies its worktree collection automatically ({slot.mode}). Repository metadata is read-only. This exposes sibling worktrees; active work still requires a workspace lease.</p>
        </div>)}
        {slots.map((slot) => {
          const slotRows = rows[slot.key] ?? [];
          const canAdd = slot.multiple || slotRows.length === 0;
          return (
            <div key={slot.key} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{slot.key}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {[slot.mode, slot.multiple ? "multiple" : "single", slot.required ? "required" : "optional", slot.service ? `service: ${slot.service}` : null].filter(Boolean).join(" · ")}
                </span>
              </div>
              {slotRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No host paths configured.</p>
              ) : (
                <div className="space-y-2">
                  {slotRows.map((row, index) => (
                    <div key={index} className="flex min-w-0 flex-wrap items-center gap-2">
                      <Select value={row.source} disabled={!canManageApps} onValueChange={value => updateRow(slot.key, index, value === "global" ? { source: "global", globalMountName: row.globalMountName || globalMounts[0]?.name || "" } : { source: "local" })}>
                        <SelectTrigger aria-label={`${slot.key} source`} className="w-28"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="global" disabled={globalMounts.length === 0}>Global</SelectItem><SelectItem value="local">Local</SelectItem></SelectContent>
                      </Select>
                      {row.source === "global" ? (
                        <>
                          <Select value={row.globalMountName} disabled={!canManageApps || globalMounts.length === 0} onValueChange={value => updateRow(slot.key, index, { globalMountName: value })}>
                            <SelectTrigger aria-label={`${slot.key} shared mount`} className="w-44"><SelectValue placeholder="No shared mounts" /></SelectTrigger>
                            <SelectContent>{globalMounts.map(mount => <SelectItem key={mount.name} value={mount.name}>{mount.name}</SelectItem>)}</SelectContent>
                          </Select>
                          <div className="flex h-9 flex-1 items-center gap-1.5 rounded-md border bg-muted/40 px-3 text-muted-foreground">
                            <Lock className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate font-mono text-xs">{globalByName.get(row.globalMountName)?.hostPath ?? "—"}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <Input
                            aria-label={`${slot.key} label`}
                            placeholder="label"
                            className="min-w-0 flex-1 basis-36 sm:w-44 sm:flex-none"
                            value={row.label}
                            disabled={!canManageApps}
                            onChange={(event) => updateRow(slot.key, index, { label: event.target.value })}
                          />
                          <Input
                            aria-label={`${slot.key} host path`}
                            placeholder="/srv/path"
                            className="min-w-0 flex-1 basis-48 font-mono text-xs"
                            value={row.hostPath}
                            disabled={!canManageApps}
                            onChange={(event) => updateRow(slot.key, index, { hostPath: event.target.value })}
                          />
                        </>
                      )}
                      <IconButton title="Remove path" destructive disabled={!canManageApps} onClick={() => removeRow(slot.key, index)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
              {canAdd && (
                <Button type="button" variant="outline" size="sm" disabled={!canManageApps} onClick={() => addRow(slot.key)}>
                  <Plus className="h-4 w-4" />
                  Add path
                </Button>
              )}
            </div>
          );
        })}
      </DialogBody>
      {savedChanged && <p role="status" className="text-xs text-warning-foreground">Saved folders changed. Your unsaved paths are retained; review them before saving.</p>}
      {slots.length > 0 && <DialogFooter>
        <Button type="submit" disabled={busy || !canManageApps}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <HardDrive className="h-4 w-4" />}
          Save mounts
        </Button>
      </DialogFooter>}
    </form>
  );
}

// Source override for apps that can run from a local folder (CoreApp.supportsSource). "Standard"
// clears the override so Core uses its recorded source; "Custom" points the app at an operator
// repo folder. The stored override arrives on the app summary, so saving refreshes it in place.
function SourceForm({
  app,
  busyAction,
  canManageApps,
  onConfigureSource,
  onClearSource,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  onConfigureSource: (app: CoreApp, path: string) => void;
  onClearSource: (app: CoreApp) => void;
}) {
  const sourceRuntimes = (app.runtimeProfiles ?? []).filter((profile) => profile.development === true);
  const overridePath = app.sourceOverridePath ?? "";
  const [mode, setMode] = useState<"standard" | "custom">(overridePath ? "custom" : "standard");
  const [pathDraft, setPathDraft] = useState(overridePath);

  const [previousOverride, setPreviousOverride] = useState(overridePath);
  const [savedChanged, setSavedChanged] = useState(false);
  if (previousOverride !== overridePath) {
    setPreviousOverride(overridePath);
    const selected = mode === "custom" ? pathDraft.trim() : "";
    if (selected === previousOverride || selected === overridePath) {
      setMode(overridePath ? "custom" : "standard");
      setPathDraft(overridePath);
      setSavedChanged(false);
    } else setSavedChanged(true);
  }

  const busy = busyAction === `${app.id}:source`;
  const trimmedPath = pathDraft.trim();
  const customInvalid = mode === "custom" && trimmedPath.length === 0;
  // Only enable Save when it would change something: a new custom path, or clearing an existing override.
  const dirty = mode === "custom" ? trimmedPath !== overridePath : overridePath.length > 0;
  const modeName = `${app.id}-source-mode`;
  const inputId = `${app.id}-source-path`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === "custom") {
      if (trimmedPath.length === 0) {
        return;
      }
      onConfigureSource(app, trimmedPath);
    } else {
      onClearSource(app);
    }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 max-w-[920px] flex-1 flex-col gap-4 rounded-xl border p-4">
      <div className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Source</h3>
          {canManageApps && <SourceChangesButton app={app} />}
          <p className="text-sm text-muted-foreground">
            {sourceRuntimes.length > 0
              ? `Select ${sourceRuntimes.map((profile) => profile.key).join(" or ")} from the dashboard runtime menu to develop this app.`
              : "This app does not declare a development profile."}
          </p>

        </div>
        <div className="flex items-start gap-2 rounded-md border border-info-foreground/20 bg-info-soft px-3 py-2 text-sm">
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-info-foreground" />
          <p className="text-muted-foreground">
            Development profiles run from the selected source folder and adopt manifest edits on restart. Hot reload depends on the profile commands. A local folder without a Git baseline is not an immutable release.
          </p>
        </div>
        <RadioGroup name={modeName} aria-label="Source folder" value={mode} disabled={!canManageApps} onValueChange={value => setMode(value as "standard" | "custom")}>
          <label htmlFor={`${modeName}-standard`} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3", mode === "standard" && "border-foreground")}>
            <RadioGroupItem id={`${modeName}-standard`} value="standard" className="mt-1" aria-labelledby={`${modeName}-standard-label`} aria-describedby={`${modeName}-standard-description`} />
            <div className="flex min-w-0 flex-col gap-1">
              <span id={`${modeName}-standard-label`} className="text-sm font-medium">Standard Hosty source</span>
              <span id={`${modeName}-standard-description`} className="text-xs text-muted-foreground">
                Use the source Core recorded when the app was installed
                {app.sourceManagedPath ? <> · <code className="font-mono">{app.sourceManagedPath}</code></> : null}.
              </span>
            </div>
          </label>
          <div className={cn("flex min-w-0 flex-col gap-3 rounded-md border p-3", mode === "custom" && "border-foreground")}>
            <label htmlFor={`${modeName}-custom`} className="flex cursor-pointer items-start gap-3">
              <RadioGroupItem id={`${modeName}-custom`} value="custom" className="mt-1" aria-labelledby={`${modeName}-custom-label`} aria-describedby={`${modeName}-custom-description`} />
              <div className="flex min-w-0 flex-col gap-1">
                <span id={`${modeName}-custom-label`} className="text-sm font-medium">Custom source folder</span>
                <span id={`${modeName}-custom-description`} className="text-xs text-muted-foreground">Point this app at a repository folder on the host.</span>
              </div>
            </label>
            <Field><FieldLabel htmlFor={inputId} className="sr-only">Repository folder on this host</FieldLabel><Input
              id={inputId}
              placeholder="/srv/apps/my-app"
              className="font-mono text-xs"
              value={pathDraft}
              disabled={!canManageApps || mode !== "custom"}
              onChange={(event) => setPathDraft(event.target.value)}
            /></Field>
          </div>
        </RadioGroup>
      </div>
      {savedChanged && <p role="status" className="text-xs text-warning-foreground">Saved source changed. Your unsaved folder is retained; review it before saving.</p>}
      <DialogFooter>
        <Button type="submit" disabled={!canManageApps || busy || customInvalid || !dirty}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <FolderGit2 className="h-4 w-4" />}
          Save source
        </Button>
      </DialogFooter>
    </form>
  );
}

function FeedSection({ app, coreOrigin, canManageApps, busyAction, onSetFeed, active }: {
  app: CoreApp; coreOrigin: string; canManageApps: boolean; busyAction: string | null;
  onSetFeed: (app: CoreApp, feedId: string) => void; active: boolean;
}) {
  const [feedState, setFeedState] = useState<CoreAppFeedsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [wasActive, setWasActive] = useState(active);
  const [activation, setActivation] = useState(0);
  if (active !== wasActive) { setWasActive(active); if (active) setActivation(value => value + 1); }
  const readKey = `${app.followedFeedId ?? ""}|${reload}|${activation}`;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const validating = active && settledKey !== readKey;
  const [feedChanged, setFeedChanged] = useState(false);
  const feeds = feedState?.feeds ?? null;
  const followed = feedState ? (feedState.followedFeedId ?? null) : (app.followedFeedId ?? null);
  const [selected, setSelected] = useState<string>(followed ?? "");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void getAppFeeds(coreOrigin, app.id, controller.signal).then(payload => {
      if (!controller.signal.aborted) { setFeedState(payload); setError(null); setSettledKey(readKey); }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && !isAuthRequiredRedirectError(cause)) { setError(cause instanceof Error ? cause.message : "Update feeds are unavailable."); setSettledKey(readKey); }
    });
    return () => controller.abort();
  }, [active, coreOrigin, app.followedFeedId, app.id, readKey]);
  const [prevFollowed, setPrevFollowed] = useState<string | null>(followed);
  if (prevFollowed !== followed) {
    setPrevFollowed(followed);
    // A pristine choice follows confirmed state; our own successful save confirms the draft.
    // A concurrent different choice keeps the draft and makes the changed confirmation explicit.
    if (selected === (prevFollowed ?? "") || selected === (followed ?? "")) { setSelected(followed ?? ""); setFeedChanged(false); }
    else setFeedChanged(true);
  }
  const followedMissing = followed !== null && !!feeds && !feeds.some(feed => feed.id === followed);
  const busy = busyAction === `${app.id}:feed`;
  const unavailable = validating || !!error;
  // Radix Select reserves empty values; the UI-only sentinel never reaches Core and cannot collide.
  let emptyValue = "__hosty_no_feed__";
  while (feeds?.some(feed => feed.id === emptyValue)) emptyValue += "_";
  return <section className="max-w-[920px] space-y-3" aria-label="Update feed settings">
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b py-3">
      <h3 className="w-full shrink-0 text-sm text-muted-foreground sm:w-44">Update feed</h3>
      <div className="min-w-0 flex-1 space-y-3">
        {validating && !error && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader label={null} className="size-5" />{feedState ? "Refreshing update feeds…" : "Loading update feeds…"}</p>}
        {error && <div className="space-y-2"><p role="alert" className="break-words text-sm text-destructive-foreground">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => { setError(null); setReload(value => value + 1); }}>Retry feeds</Button></div>}
        {feedState && feeds?.length === 0 && <p className="text-sm text-muted-foreground">No update feeds are declared for this app.</p>}
        {feedState?.feedsUrl && <p className="break-all font-mono text-xs text-muted-foreground">{feedState.feedsUrl}</p>}
        {feedState && <p className="text-xs text-muted-foreground">Confirmed feed: {followed ?? "None"}{unavailable ? " (last observed)" : ""}</p>}
        {feedChanged && <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">The confirmed feed changed. Your unsaved selection is retained; review it before following.</p>}
        {!!feeds?.length && <>
          {(followed === null || followedMissing) && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">{followedMissing ? `The followed feed ‘${followed}’ is no longer declared by the app. Choose another feed.` : "No feed set — feed updates are not detected for this app. Choose a feed to follow."}</p>}
          <div className="flex flex-wrap items-center gap-2"><Select value={selected || emptyValue} onValueChange={value => { setSelected(value === emptyValue ? "" : value); setFeedChanged(false); }} disabled={!canManageApps || busy || unavailable}>
            <SelectTrigger aria-label="Update feed" className="w-full min-w-0 sm:w-64"><SelectValue /></SelectTrigger>
            <SelectContent position="popper"><SelectItem value={emptyValue}>{followed === null ? "Choose a feed…" : "None (stop following)"}</SelectItem>{followedMissing && <SelectItem value={followed}>{followed} (missing)</SelectItem>}{feeds.map(feed => <SelectItem key={feed.id} value={feed.id}>{feed.id}{feed.default && feeds.length > 1 ? " (default)" : ""}</SelectItem>)}</SelectContent>
          </Select><Button type="button" size="sm" variant="outline" onClick={() => onSetFeed(app, selected)} disabled={!canManageApps || busy || unavailable || selected === followed || (followed === null && selected.length === 0)}>{busy ? <HostyLoader label={null} className="size-4" /> : <Rss className="size-4" />}{selected.length === 0 && followed !== null ? "Stop following" : "Follow feed"}</Button></div>
        </>}
      </div>
    </div>
  </section>;
}
