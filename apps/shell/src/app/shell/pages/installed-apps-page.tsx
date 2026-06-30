"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Database,
  ExternalLink,
  FileText,
  HardDrive,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  appHasMissingRequiredSettings,
  buildRuntimeServiceRows,
  formatRuntimeProfileLabel,
  formatUpdateChange,
  getEndpointPublicOrigin,
  isAppAutostartEnabled,
  shortDigest,
} from "../app-helpers";
import { copyTextToClipboard } from "../clipboard";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type {
  AppAction,
  AppHealthResponse,
  AppUpdateStatusResponse,
  CoreApp,
  OpenAppPanel,
  RuntimeHealthState,
  UpdateStatusState,
} from "../types";
import { EmptyState, IconButton, PageHeader, StatusBadge } from "../ui";

export function InstalledAppsPage({
  coreOrigin,
  runtimeApps,
  systemApps,
  shellAppId,
  canManageApps,
  loading,
  busyAction,
  onRefresh,
  onInstall,
  onAction,
  onSwitchRuntime,
  onOpenPanel,
  onOpenSharedMounts,
}: {
  coreOrigin: string;
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  loading: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onInstall: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onOpenPanel: OpenAppPanel;
  onOpenSharedMounts: () => void;
}) {
  const isRefreshing = loading;
  const hasAnyApps = runtimeApps.length > 0 || systemApps.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installed Apps"
        description="App state is resolved through the Core backend API and runtime state."
        actions={(
          <>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={isRefreshing} aria-label="Refresh apps">
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </Button>
            {canManageApps && (
              <Button variant="outline" onClick={onOpenSharedMounts}>
                <HardDrive className="h-4 w-4" />
                Shared mounts
              </Button>
            )}
            {canManageApps && (
              <Button onClick={onInstall}>
                <Plus className="h-4 w-4" />
                Install App
              </Button>
            )}
          </>
        )}
      />

      {loading && !hasAnyApps ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !hasAnyApps ? (
        <EmptyState icon={Boxes} title="No installed apps" description="Install a runtime app to make it available in the shell." />
      ) : (
        <div className="space-y-6">
          <InstalledAppTableSection
            coreOrigin={coreOrigin}
            title="Runtime Apps"
            description="User-installed runtime apps and their lifecycle state."
            emptyTitle="No runtime apps installed"
            emptyDescription="Install a runtime app to make it available in the shell."
            apps={runtimeApps}
            shellAppId={shellAppId}
            canManageApps={canManageApps}
            busyAction={busyAction}
            onAction={onAction}
            onSwitchRuntime={onSwitchRuntime}
            onOpenPanel={onOpenPanel}
          />
          <InstalledAppTableSection
            coreOrigin={coreOrigin}
            title="System Apps"
            description="Core-managed Shell and platform runtime apps. Runtime switching and inspection are available to administrators."
            emptyTitle="No system apps registered"
            emptyDescription="Core has not registered a system app yet."
            apps={systemApps}
            shellAppId={shellAppId}
            canManageApps={canManageApps}
            busyAction={busyAction}
            onAction={onAction}
            onSwitchRuntime={onSwitchRuntime}
            onOpenPanel={onOpenPanel}
          />
        </div>
      )}
    </div>
  );
}

// Reduces any image reference to its bare `sha256:...` digest (handles `repo@sha256:...` from
// health as well as a bare lock digest); null when there is no digest.
function normalizeDigest(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const index = value.indexOf("sha256:");
  return index === -1 ? null : value.slice(index);
}

function AppServiceDetailsPanel({
  app,
  healthState,
  updateStatusState,
  canConfigurePublicOrigins,
  onConfigurePublicOrigins,
  canUpdate,
  onOpenUpdate,
  onRecheckUpdate,
}: {
  app: CoreApp;
  healthState?: RuntimeHealthState;
  updateStatusState?: UpdateStatusState;
  canConfigurePublicOrigins: boolean;
  onConfigurePublicOrigins: () => void;
  canUpdate: boolean;
  onOpenUpdate: () => void;
  onRecheckUpdate: () => void;
}) {
  const serviceRows = buildRuntimeServiceRows(app, healthState?.health);
  const copyEndpointUrl = async (url: string) => {
    try {
      await copyTextToClipboard(url);
      toast.success("URL copied", { description: url });
    } catch {
      toast.error("Copy failed", { description: "Clipboard access is unavailable." });
    }
  };

  // Per-service version legibility: locked digest (from the app record), running digest (from
  // health), and the remotely-resolved candidate (from the update-status probe). Compiled docker
  // services carry locks; source/localCommand services have none, so the section stays hidden.
  const lockedByService = app.artifactLocks ?? {};
  const runningByService = new Map(
    (healthState?.health?.services ?? []).map((service) => [service.service, normalizeDigest(service.image)]),
  );
  const statusByService = new Map(
    (updateStatusState?.status?.services ?? []).map((service) => [service.service, service]),
  );
  // Per-service health detail (container HEALTHCHECK result, restart count, uptime) keyed by service.
  const healthByService = new Map(
    (healthState?.health?.services ?? []).map((service) => [service.service, service]),
  );
  const hasImageInfo =
    Object.keys(lockedByService).length > 0 ||
    [...runningByService.values()].some((digest) => digest) ||
    statusByService.size > 0;
  const updateStatus = updateStatusState?.status;

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      {app.live && (
        <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
            <Radio className="h-3.5 w-3.5" />
            Live source runtime
          </div>
          <p className="text-muted-foreground">
            Core runs this app from your source folder and adopts manifest edits on restart — there is no reviewed update. Switch to a compiled runtime for locked, reviewed updates.
          </p>
          {app.manifestError && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-900 dark:text-amber-200">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Last start kept the previous manifest because the folder manifest was invalid: {app.manifestError}</span>
            </div>
          )}
          {app.liveChanges && app.liveChanges.length > 0 && (
            <div className="text-muted-foreground">
              <span className="text-[11px] uppercase tracking-wide">Adopted at last start</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {app.liveChanges.map((change) => (
                  <li key={change}>{formatUpdateChange(change)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {hasImageInfo && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <UpdatePolicyBadge policy={app.updatePolicy} />
            <UpdateAvailabilityIndicator state={updateStatusState} />
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={updateStatusState?.loading}
              onClick={onRecheckUpdate}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", updateStatusState?.loading && "animate-spin")} />
              Check for updates
            </Button>
            {canUpdate && updateStatus?.updateAvailable && (
              <Button type="button" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onOpenUpdate}>
                <Upload className="h-3.5 w-3.5" />
                Update
              </Button>
            )}
          </div>
        </div>
      )}
      {healthState?.loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading services
        </div>
      )}
      {healthState?.error && <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">{healthState.error}</div>}

      {serviceRows.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">No services reported</div>
      ) : (
        <div className="grid gap-2">
          {serviceRows.map((service) => {
            const locked = normalizeDigest(lockedByService[service.service]?.imageDigest);
            const running = runningByService.get(service.service) ?? null;
            const serviceStatus = statusByService.get(service.service);
            const serviceHealth = healthByService.get(service.service);
            const drift = Boolean(locked && running && locked !== running);
            const hasServiceImage = Boolean(locked || running || serviceStatus);
            return (
            <div key={service.service} className="rounded-md bg-muted/30 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div
                    className="truncate text-xs font-medium"
                    title={serviceHealth?.startedAt ? `Started ${serviceHealth.startedAt}` : undefined}
                  >
                    {service.service}
                  </div>
                  {service.message && <div className="truncate text-xs text-muted-foreground">{service.message}</div>}
                  {serviceHealth?.restartCount ? (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {serviceHealth.restartCount} restart{serviceHealth.restartCount === 1 ? "" : "s"}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  {serviceHealth?.health && <StatusBadge value={serviceHealth.health} />}
                  <StatusBadge value={service.status} />
                </div>
              </div>
              {hasServiceImage && (
                <div className="mt-2 grid gap-1 rounded-md border bg-background px-2 py-1.5 text-xs">
                  {locked && <ServiceDigestRow label="Locked" digest={locked} />}
                  {running && <ServiceDigestRow label="Running" digest={running} tone={drift ? "warning" : undefined} />}
                  {drift && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300">
                      Running a different build than the recorded lock.
                    </div>
                  )}
                  {serviceStatus?.updateAvailable && serviceStatus.candidateDigest && (
                    <ServiceDigestRow label="Available" digest={serviceStatus.candidateDigest} tone="update" />
                  )}
                  {serviceStatus?.unknown && (
                    <div className="text-[11px] text-muted-foreground">Update check unavailable (registry unreachable).</div>
                  )}
                </div>
              )}
              {service.endpoints.length === 0 ? (
                <div className="mt-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">No endpoints</div>
              ) : (
                <div className="mt-2 grid gap-1.5">
                  {service.endpoints.map((endpoint) => {
                    const publicOrigin = getEndpointPublicOrigin(app, endpoint);
                    return (
                      <div key={endpoint.key} className={cn("grid gap-2 text-xs", endpoint.public && "md:grid-cols-2")}>
                        <EndpointUrlBlock
                          url={endpoint.url}
                          missingText="not assigned"
                          copyTitle="Copy local endpoint URL"
                          openTitle="Open local endpoint URL"
                          onCopy={copyEndpointUrl}
                        />
                        {endpoint.public && (
                          <EndpointUrlBlock
                            url={publicOrigin}
                            missingText="not configured"
                            copyTitle="Copy public origin"
                            openTitle="Open public origin"
                            onCopy={copyEndpointUrl}
                            configureTitle="Configure public origin"
                            onConfigure={canConfigurePublicOrigins ? onConfigurePublicOrigins : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UpdatePolicyBadge({ policy }: { policy?: string | null }) {
  // updatePolicy is optional for backwards compatibility with older Core builds; only render the
  // badge when Core reported an explicit policy so an absent value is not mislabelled as "Pinned".
  if (policy !== "pinned" && policy !== "rolling") {
    return null;
  }
  const rolling = policy === "rolling";
  return (
    <Badge variant={rolling ? "secondary" : "outline"} className="gap-1" title={rolling ? "Re-resolves the tag on every restart (drift accepted)" : "Runs the locked digest; advancing it needs a reviewed update"}>
      {rolling ? <RefreshCw className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
      {rolling ? "Rolling" : "Pinned"}
    </Badge>
  );
}

function UpdateAvailabilityIndicator({ state }: { state?: UpdateStatusState }) {
  if (state?.loading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        Checking for updates
      </span>
    );
  }
  if (state?.error) {
    return <span className="text-xs text-amber-700 dark:text-amber-300">Update check failed</span>;
  }
  const status = state?.status;
  if (!status) {
    return null;
  }
  if (status.updateAvailable) {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300">
        <ArrowUpCircle className="h-3 w-3" />
        Update available
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5" />
      Up to date
    </span>
  );
}

function ServiceDigestRow({ label, digest, tone }: { label: string; digest: string; tone?: "warning" | "update" }) {
  const toneClass =
    tone === "warning"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "update"
        ? "text-emerald-700 dark:text-emerald-300"
        : "text-foreground";
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("truncate font-mono", toneClass)} title={digest}>{shortDigest(digest) ?? digest}</span>
    </div>
  );
}

function EndpointUrlBlock({
  url,
  missingText,
  copyTitle,
  openTitle,
  configureTitle,
  onCopy,
  onConfigure,
}: {
  url?: string | null;
  missingText: string;
  copyTitle: string;
  openTitle: string;
  configureTitle?: string;
  onCopy: (url: string) => void | Promise<void>;
  onConfigure?: () => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className={cn("truncate font-mono", url ? "text-foreground" : "text-muted-foreground")}>{url || missingText}</span>
      {url ? (
        <span className="flex items-center gap-1">
          <IconButton title={copyTitle} onClick={() => void onCopy(url)}>
            <Copy className="h-4 w-4" />
          </IconButton>
          <Button type="button" variant="ghost" size="icon-sm" title={openTitle} aria-label={openTitle} asChild>
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </span>
      ) : onConfigure ? (
        <IconButton title={configureTitle || "Configure"} onClick={onConfigure}>
          <Settings2 className="h-4 w-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

function InstalledAppTableSection({
  coreOrigin,
  title,
  description,
  emptyTitle,
  emptyDescription,
  apps,
  shellAppId,
  canManageApps,
  busyAction,
  onAction,
  onSwitchRuntime,
  onOpenPanel,
}: {
  coreOrigin: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const [expandedAppIds, setExpandedAppIds] = useState<Set<string>>(() => new Set());
  const [healthByApp, setHealthByApp] = useState<Record<string, RuntimeHealthState>>({});
  const [updateStatusByApp, setUpdateStatusByApp] = useState<Record<string, UpdateStatusState>>({});

  useEffect(() => {
    const appIds = new Set(apps.map((app) => app.id));
    setExpandedAppIds((current) => {
      const next = new Set([...current].filter((appId) => appIds.has(appId)));
      return next.size === current.size ? current : next;
    });
    setHealthByApp((current) => {
      const entries = Object.entries(current).filter(([appId]) => appIds.has(appId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    setUpdateStatusByApp((current) => {
      const entries = Object.entries(current).filter(([appId]) => appIds.has(appId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [apps]);

  const loadAppHealth = useCallback(async (app: CoreApp) => {
    setHealthByApp((current) => ({
      ...current,
      [app.id]: {
        loading: true,
        error: null,
        health: current[app.id]?.health ?? null,
      },
    }));

    try {
      const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/health`, { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }
      const health = (await response.json()) as AppHealthResponse;
      setHealthByApp((current) => ({
        ...current,
        [app.id]: {
          loading: false,
          error: null,
          health,
        },
      }));
    } catch (error) {
      if (isAuthRequiredRedirectError(error)) {
        return;
      }

      setHealthByApp((current) => ({
        ...current,
        [app.id]: {
          loading: false,
          error: error instanceof Error ? error.message : "Health is unavailable.",
          health: current[app.id]?.health ?? null,
        },
      }));
    }
  }, [coreOrigin]);

  // Read-only update-available probe (light registry lookup in Core). Run on demand when a row is
  // expanded — never for every row on load — so the N registry lookups stay opt-in.
  const loadUpdateStatus = useCallback(async (app: CoreApp) => {
    setUpdateStatusByApp((current) => ({
      ...current,
      [app.id]: {
        loading: true,
        error: null,
        status: current[app.id]?.status ?? null,
      },
    }));

    try {
      const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/update-status`, { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }
      const status = (await response.json()) as AppUpdateStatusResponse;
      setUpdateStatusByApp((current) => ({
        ...current,
        [app.id]: { loading: false, error: null, status },
      }));
    } catch (error) {
      if (isAuthRequiredRedirectError(error)) {
        return;
      }

      setUpdateStatusByApp((current) => ({
        ...current,
        [app.id]: {
          loading: false,
          error: error instanceof Error ? error.message : "Update status is unavailable.",
          status: current[app.id]?.status ?? null,
        },
      }));
    }
  }, [coreOrigin]);

  const toggleAppExpanded = (app: CoreApp) => {
    const shouldExpand = !expandedAppIds.has(app.id);
    setExpandedAppIds((current) => {
      const next = new Set(current);
      if (shouldExpand) {
        next.add(app.id);
      } else {
        next.delete(app.id);
      }
      return next;
    });

    if (shouldExpand) {
      void loadAppHealth(app);
      void loadUpdateStatus(app);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">{apps.length}</Badge>
      </div>
      {apps.length === 0 ? (
        <EmptyState icon={Boxes} title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[240px]">App</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Autostart</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const expanded = expandedAppIds.has(app.id);
                const healthState = healthByApp[app.id];
                const updateStatusState = updateStatusByApp[app.id];
                // A live source runtime adopts its manifest on restart and has no reviewed-update path,
                // so the Update affordance is hidden in favour of the "Live" badge (see CoreApp.live).
                const canUpdate = canManageApps && !app.system && !app.live && app.capabilities.includes("update");

                return (
                  <Fragment key={app.id}>
                    <InstalledAppRow
                      app={app}
                      isShell={app.id === shellAppId}
                      expanded={expanded}
                      healthLoading={healthState?.loading ?? false}
                      canManageApps={canManageApps}
                      busyAction={busyAction}
                      onToggleExpanded={() => toggleAppExpanded(app)}
                      onAction={onAction}
                      onSwitchRuntime={onSwitchRuntime}
                      onOpenPanel={onOpenPanel}
                    />
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/20 px-4 py-3">
                          <AppServiceDetailsPanel
                            app={app}
                            healthState={healthState}
                            updateStatusState={updateStatusState}
                            canConfigurePublicOrigins={canManageApps && !app.system}
                            onConfigurePublicOrigins={() => onOpenPanel(app, "settings", { settingsTab: "publicOrigins" })}
                            canUpdate={canUpdate}
                            onOpenUpdate={() => onOpenPanel(app, "update")}
                            onRecheckUpdate={() => void loadUpdateStatus(app)}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function InstalledAppRow({
  app,
  isShell,
  expanded,
  healthLoading,
  canManageApps,
  busyAction,
  onToggleExpanded,
  onAction,
  onSwitchRuntime,
  onOpenPanel,
}: {
  app: CoreApp;
  isShell: boolean;
  expanded: boolean;
  healthLoading: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  onToggleExpanded: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const running = app.runtimeState === "running";
  const canControl = canManageApps && !app.system;
  const canSwitchRuntime = canManageApps;
  const canInspect = canManageApps;
  const canBackup = canControl && app.capabilities.includes("backup");
  const canConfigure = canControl;
  // Live source runtimes have no reviewed-update path (the manifest is adopted on restart), so the
  // Update menu item is hidden and the "Live" badge is shown instead. See CoreApp.live.
  const canUpdate = canControl && !app.live && app.capabilities.includes("update");
  const canRemove = canControl && app.capabilities.includes("remove");
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;
  const autostartEnabled = isAppAutostartEnabled(app);
  const needsRequiredSettings = !running && appHasMissingRequiredSettings(app);

  return (
    <TableRow data-testid={`app-row-${app.id}`}>
      <TableCell>
        <div className="flex min-w-0 items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mt-0.5 shrink-0"
            title={expanded ? "Hide services" : "Show services"}
            aria-label={expanded ? "Hide services" : "Show services"}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            {healthLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{app.displayName}</span>
              {app.system && <Badge variant="secondary">System</Badge>}
              {isShell && <Badge variant="outline">Shell</Badge>}
              {needsRequiredSettings && (
                <span title="Configure required settings before starting" className="inline-flex shrink-0">
                  <TriangleAlert className="h-4 w-4 text-amber-500" aria-label="Configure required settings before starting" />
                </span>
              )}
              {app.lastError && <CircleAlert className="h-4 w-4 text-destructive" />}
            </div>
            <div className="truncate text-xs text-muted-foreground">{app.id}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <RuntimeSwitcher
          app={app}
          canSwitch={canSwitchRuntime}
          busyAction={busyAction}
          onSwitchRuntime={onSwitchRuntime}
        />
      </TableCell>
      <TableCell>{app.version}</TableCell>
      <TableCell><Badge variant={autostartEnabled ? "outline" : "secondary"}>{autostartEnabled ? "On" : "Off"}</Badge></TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge value={app.runtimeState || app.operationStatus} />
          {app.live && (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
              title="Runs live from your source folder; the manifest is adopted on restart. Switch to a compiled runtime for reviewed updates."
            >
              <Radio className="h-3 w-3" />
              Live
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {canControl && (running ? (
            <IconButton title="Stop app" disabled={isBusy("stop")} onClick={() => onAction(app, "stop")}>
              {isBusy("stop") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            </IconButton>
          ) : (
            <IconButton title="Start app" disabled={isBusy("start")} onClick={() => onAction(app, "start")}>
              {isBusy("start") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </IconButton>
          ))}
          {canControl && (
            <IconButton title="Restart app" disabled={isBusy("restart")} onClick={() => onAction(app, "restart")}>
              {isBusy("restart") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            </IconButton>
          )}
          <InstalledAppActionsMenu
            app={app}
            canInspect={canInspect}
            canBackup={canBackup}
            canConfigure={canConfigure}
            canUpdate={canUpdate}
            canRemove={canRemove}
            onOpenPanel={onOpenPanel}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function RuntimeSwitcher({
  app,
  canSwitch,
  busyAction,
  onSwitchRuntime,
}: {
  app: CoreApp;
  canSwitch: boolean;
  busyAction: string | null;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
}) {
  const runtimeProfiles = app.runtimeProfiles ?? [];
  const currentRuntime = app.selectedRuntime || "none";
  const switchable = canSwitch && runtimeProfiles.length > 1;
  const switching = busyAction?.startsWith(`${app.id}:switch-runtime:`) ?? false;

  if (!switchable) {
    return <span className="font-mono text-sm">{currentRuntime}</span>;
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate font-mono text-sm">{currentRuntime}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Switch runtime for ${app.displayName}`}
            title="Switch runtime"
            disabled={switching}
          >
            {switching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Runtime</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {runtimeProfiles.map((profile) => {
            const selected = profile.key === app.selectedRuntime;
            const targetBusy = busyAction === `${app.id}:switch-runtime:${profile.key}`;
            return (
              <DropdownMenuItem
                key={profile.key}
                disabled={switching}
                onClick={() => onSwitchRuntime(app, profile.key)}
              >
                {targetBusy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className={cn("h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
                )}
                <span className="min-w-0 flex-1 truncate">{formatRuntimeProfileLabel(profile)}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InstalledAppActionsMenu({
  app,
  canInspect,
  canBackup,
  canConfigure,
  canUpdate,
  canRemove,
  onOpenPanel,
}: {
  app: CoreApp;
  canInspect: boolean;
  canBackup: boolean;
  canConfigure: boolean;
  canUpdate: boolean;
  canRemove: boolean;
  onOpenPanel: OpenAppPanel;
}) {
  const hasLogs = canInspect && app.capabilities.includes("logs");
  // Observability (metrics + OTLP logs) is host-collected and available for any inspectable app; the
  // panel shows an empty state when observability is disabled or the app has emitted nothing yet.
  const hasObservability = canInspect;
  const hasMenuActions = hasLogs || hasObservability || canBackup || canConfigure || canUpdate || canRemove;

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
      <DropdownMenuContent align="end" className="w-48">
        {hasLogs && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "logs")}>
            <FileText className="h-4 w-4" />
            Logs
          </DropdownMenuItem>
        )}
        {hasObservability && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "observability")}>
            <Activity className="h-4 w-4" />
            Observability
          </DropdownMenuItem>
        )}
        {canBackup && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "backups")}>
            <Database className="h-4 w-4" />
            Backups
          </DropdownMenuItem>
        )}
        {(canConfigure || canUpdate) && <DropdownMenuSeparator />}
        {canConfigure && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "settings")}>
            <Settings2 className="h-4 w-4" />
            Settings
          </DropdownMenuItem>
        )}
        {canUpdate && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "update")}>
            <Upload className="h-4 w-4" />
            Update
          </DropdownMenuItem>
        )}
        {canRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onOpenPanel(app, "remove")}>
              <Trash2 className="h-4 w-4" />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
