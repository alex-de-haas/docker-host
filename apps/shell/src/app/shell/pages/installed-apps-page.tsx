"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Database,
  ExternalLink,
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
  Terminal,
  Trash2,
  TriangleAlert,
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
  appSupportsReviewedUpdate,
  buildRuntimeServiceRows,
  formatRuntimeProfileLabel,
  formatUpdateChange,
  getEndpointPublicOrigin,
  isAppAutostartEnabled,
  resolveAssetSrc,
  shortDigest,
} from "../app-helpers";
import { collectAppProblems } from "../app-problems";
import { AppIcon } from "../app-icon";
import { copyTextToClipboard } from "../clipboard";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type {
  AlertSeverity,
  AppAction,
  AppHealthResponse,
  AppProblem,
  AppUpdateCheckStatus,
  AppUpdateStatusResponse,
  CoreApp,
  CoreRuntimeProfile,
  OpenAppPanel,
  RuntimeHealthState,
  UpdateStatusState,
} from "../types";
import { Alert, EmptyState, IconButton, PageHeader, StatusBadge } from "../ui";
import { EndpointAvailabilityMarker, PortReassignControl } from "./port-reassign-control";
import { CloudflarePublishControl } from "./cloudflare-publish-control";

export function InstalledAppsPage({
  coreOrigin,
  apps,
  shellAppId,
  canManageApps,
  loading,
  busyAction,
  updateCheck,
  updateStatusInvalidations,
  onRefresh,
  onInstall,
  onAction,
  onSwitchRuntime,
  onSetDevelopmentMode,
  onUpdateApp,
  onCheckUpdates,
  onUpdateAll,
  onOpenPanel,
  onOpenSharedMounts,
}: {
  coreOrigin: string;
  // Runtime and system apps together, in Core's id order: one list with one command set, where a
  // system app is told apart by its badge — not by which table it sits in.
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  loading: boolean;
  busyAction: string | null;
  // Server-side fleet-check status: drives the header "Check updates" spinner from server state.
  updateCheck: AppUpdateCheckStatus | null;
  // Per-app counter (owned by ShellClient) that advances when a mutation resets an app's artifact
  // locks (runtime switch); watched below to re-probe update-status so the expanded row's
  // per-service digest panel does not keep stale locked/candidate digests. Row affordances read the
  // summary verdict (app.updateCheck) instead and are not driven by this.
  updateStatusInvalidations: Record<string, number>;
  onRefresh: () => void;
  onInstall: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
  onUpdateApp: (app: CoreApp) => void;
  onCheckUpdates: () => void;
  onUpdateAll: () => void;
  onOpenPanel: OpenAppPanel;
  onOpenSharedMounts: () => void;
}) {
  const isRefreshing = loading;
  const hasAnyApps = apps.length > 0;

  // Per-app per-service digest detail for the expanded row (GET /api/apps/{id}/update-status,
  // served from Core's cached plan). The row Update/Review affordances read the fleet-check verdict
  // on the app summary instead — this state only feeds the expanded services panel.
  const [updateStatusByApp, setUpdateStatusByApp] = useState<Record<string, UpdateStatusState>>({});
  // Apps whose digest detail the operator explicitly asked for this session; gates the stale-digest
  // re-read below so it can refresh what was requested without ever initiating a check itself.
  const statusRequestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const appIds = new Set(apps.map((app) => app.id));
    setUpdateStatusByApp((current) => {
      const entries = Object.entries(current).filter(([appId]) => appIds.has(appId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [apps]);

  // Returns both halves so a caller can tell a real failure from an auth redirect: the latter yields
  // no status *and* no error, because the page is already navigating to the login screen and has
  // nothing to report.
  const loadUpdateStatus = useCallback(
    async (app: CoreApp, options?: { refresh?: boolean }): Promise<{ status: AppUpdateStatusResponse | null; error: string | null }> => {
      setUpdateStatusByApp((current) => ({
        ...current,
        [app.id]: { loading: true, error: null, status: current[app.id]?.status ?? null },
      }));

      try {
        // Without `refresh` Core answers from its cached plan (no network work); refresh=true forces
        // a single-app rebuild — the actions menu's explicit "Check for updates" uses it.
        const response = await fetch(
          `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/update-status${options?.refresh ? "?refresh=true" : ""}`,
          { credentials: "include" },
        );
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }
        const status = (await response.json()) as AppUpdateStatusResponse;
        setUpdateStatusByApp((current) => ({ ...current, [app.id]: { loading: false, error: null, status } }));
        return { status, error: null };
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return { status: null, error: null };
        }
        const message = error instanceof Error ? error.message : "Update status is unavailable.";
        setUpdateStatusByApp((current) => ({
          ...current,
          [app.id]: {
            loading: false,
            error: message,
            status: current[app.id]?.status ?? null,
          },
        }));
        return { status: null, error: message };
      }
    },
    [coreOrigin],
  );

  // ShellClient bumps an app's counter after a mutation that resets its artifact locks (apply update,
  // switch runtime), which makes this panel's per-service digests stale. Only apps whose digests the
  // operator actually asked for are re-read — nothing here may start a check on its own. `refresh()`
  // has already reloaded the app list by the time the counter advances, so the app is present here.
  // Seed the ref with the counters as they stand on mount, so only new bumps while this page is
  // mounted are acted on.
  const probedInvalidationsRef = useRef<Record<string, number>>({ ...updateStatusInvalidations });
  useEffect(() => {
    const appsById = new Map<string, CoreApp>(apps.map((app) => [app.id, app]));
    for (const [appId, nonce] of Object.entries(updateStatusInvalidations)) {
      if (probedInvalidationsRef.current[appId] === nonce) {
        continue;
      }
      probedInvalidationsRef.current[appId] = nonce;
      const app = appsById.get(appId);
      if (!app || !statusRequestedRef.current.has(appId)) {
        continue;
      }
      void loadUpdateStatus(app);
    }
  }, [updateStatusInvalidations, apps, loadUpdateStatus]);

  // Explicit per-app check from the row's actions menu: rebuilds this app's plan on Core
  // (?refresh=true), which both fills the expanded panel's per-service digests and refreshes Core's
  // stored verdict — so pull the app list afterwards to bring the row's own Update/Review
  // affordance in line with what was just found.
  const checkAppUpdate = useCallback(
    async (app: CoreApp) => {
      statusRequestedRef.current.add(app.id);
      const { status, error } = await loadUpdateStatus(app, { refresh: true });
      if (status) {
        toast.success(status.updateAvailable ? "Update available" : "Up to date", { description: app.displayName });
      } else if (error) {
        // The operator asked for this check, so its failure is theirs to see; an auth redirect
        // reports neither and is left to the login navigation already under way.
        toast.error("Update check failed", { description: `${app.displayName}: ${error}` });
      }
      onRefresh();
    },
    [loadUpdateStatus, onRefresh],
  );

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
    const failed = apps.filter((app) => app.updateCheck?.error).length;
    const failedNote = failed > 0 ? `${failed} app${failed === 1 ? "" : "s"} could not be checked.` : undefined;
    if (available > 0) {
      const review = apps.filter((app) => app.updateCheck?.updateAvailable && app.updateCheck.requiresReview).length;
      const reviewNote = review > 0 ? `${review} need${review === 1 ? "s" : ""} review.` : undefined;
      toast.success(`${available} update${available === 1 ? "" : "s"} available`, {
        description: [reviewNote, failedNote].filter(Boolean).join(" ") || undefined,
      });
    } else if (failed > 0) {
      toast.warning("No updates found", { description: failedNote });
    } else {
      toast.success("All apps up to date");
    }
  }, [checkingUpdates, apps]);

  // Routine verdicts the header "Update all" would apply (review-class ones stay on their rows).
  // Mirrors updateAllApps' own filter — including the planDigest requirement, so N never counts an
  // app the action could not actually enqueue.
  const routineUpdateCount = apps.filter(
    (app) =>
      app.updateCheck?.updateAvailable === true &&
      app.updateCheck.requiresReview !== true &&
      Boolean(app.updateCheck.planDigest) &&
      app.operationStatus !== "updating",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installed Apps"
        description="Runtime and system apps on this host, in one list — system apps carry a badge. App state is resolved through the Core backend API and runtime state."
        actions={(
          <>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={isRefreshing} aria-label="Refresh apps">
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </Button>
            {canManageApps && (
              <Button variant="outline" onClick={onCheckUpdates} disabled={checkingUpdates}>
                {checkingUpdates ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
                Check updates
              </Button>
            )}
            {canManageApps && routineUpdateCount > 0 && (
              <Button
                variant="outline"
                className="text-sky-600 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-400"
                onClick={onUpdateAll}
              >
                <ArrowUpCircle className="h-4 w-4" />
                Update all ({routineUpdateCount})
              </Button>
            )}
            {canManageApps && (
              <Button variant="outline" onClick={onOpenSharedMounts}>
                <HardDrive className="h-4 w-4" />
                Shared mounts
              </Button>
            )}
            {canManageApps && (
              <Button onClick={() => onInstall()}>
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
        <InstalledAppsTable
          coreOrigin={coreOrigin}
          apps={apps}
          shellAppId={shellAppId}
          canManageApps={canManageApps}
          busyAction={busyAction}
          updateStatusByApp={updateStatusByApp}
          onAction={onAction}
          onSwitchRuntime={onSwitchRuntime}
          onSetDevelopmentMode={onSetDevelopmentMode}
          onUpdateApp={onUpdateApp}
          onCheckUpdate={(target) => void checkAppUpdate(target)}
          onOpenPanel={onOpenPanel}
        />
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
}: {
  app: CoreApp;
  healthState?: RuntimeHealthState;
  // Per-service digest detail, populated only once the operator explicitly runs "Check for updates"
  // from the row's actions menu. Expanding a row does not probe: whether an update exists is the
  // row's own Update/Review affordance (the fleet-check verdict), not this panel's job.
  updateStatusState?: UpdateStatusState;
  canConfigurePublicOrigins: boolean;
  onConfigurePublicOrigins: () => void;
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
  // With "rolling" removed every app runs pinned, so a policy badge would say the same thing on
  // every row and is gone; the bar that used to host it now only appears while the health probe runs.
  const healthLoading = healthState?.loading ?? false;

  // The same derivation the collapsed row's icons use, so expanding an app explains exactly the problems
  // its icons warned about — no more, no less.
  const problems = collectAppProblems(app);

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      {problems.map((problem) => (
        <Alert key={problem.title} severity={problem.severity} title={problem.title} detail={problem.detail} />
      ))}
      {app.live && (
        <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
            <Radio className="h-3.5 w-3.5" />
            Live source runtime
          </div>
          <p className="text-muted-foreground">
            Core runs this app from your source folder and adopts manifest edits on restart — there is no reviewed update. Switch to a compiled runtime for locked, reviewed updates.
          </p>
          {/* The manifest error is raised as a top-level alert (and a row icon) instead, so it is not
              repeated here. */}
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
      {healthLoading && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Loading services
          </span>
        </div>
      )}
      {/* Only ever set for an app whose digests the operator explicitly checked, so this reports a
          check they asked for — including one that failed after they closed the toast, or a
          re-read that went stale-quiet after a runtime switch. */}
      {updateStatusState?.error && (
        <Alert severity="warning" title="Digest check failed" detail={updateStatusState.error} />
      )}
      {healthState?.error && <Alert severity="warning" title="Service health is unavailable" detail={healthState.error} />}

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
            // Locked and running agree in every healthy case, so the digest rides in the service header as
            // a badge and the box below disappears entirely. The two-row split is spent only on drift —
            // the state actually worth reading.
            const matchedDigest = locked && running && locked === running ? locked : null;
            const hasServiceImage = Boolean(locked || running || serviceStatus);
            const candidateDigest = serviceStatus?.updateAvailable ? serviceStatus.candidateDigest ?? null : null;
            // The header badge can only carry the matched digest, so the box still has to appear for a
            // locked/running split, an available candidate, or a check that could not reach the registry —
            // an available update is reported precisely when the digests DO match, so it must not be
            // collapsed away with them.
            const showsDigestRows = hasServiceImage && !matchedDigest;
            const showsDigestBox = showsDigestRows || Boolean(candidateDigest) || Boolean(serviceStatus?.unknown);
            return (
            <div key={service.service} className="rounded-md bg-muted/30 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate text-xs font-medium"
                      title={serviceHealth?.startedAt ? `Started ${serviceHealth.startedAt}` : undefined}
                    >
                      {service.service}
                    </span>
                    {matchedDigest && (
                      <Badge
                        variant="outline"
                        className="shrink-0 font-mono text-[10px] font-normal text-muted-foreground"
                        title={`Running the locked build — ${matchedDigest}`}
                      >
                        {shortDigest(matchedDigest) ?? matchedDigest}
                      </Badge>
                    )}
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
              {showsDigestBox && (
                <div className="mt-2 grid gap-1 rounded-md border bg-background px-2 py-1.5 text-xs">
                  {showsDigestRows && (
                    <>
                      {locked && <ServiceDigestRow label="Locked" digest={locked} />}
                      {running && <ServiceDigestRow label="Running" digest={running} tone={drift ? "warning" : undefined} />}
                    </>
                  )}
                  {drift && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300">
                      Running a different build than the recorded lock.
                    </div>
                  )}
                  {candidateDigest && (
                    <ServiceDigestRow label="Available" digest={candidateDigest} tone="update" />
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
                      <div key={endpoint.key} className="grid gap-1 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-muted-foreground">{endpoint.key}</span>
                          <EndpointAvailabilityMarker availability={endpoint.availability} />
                        </div>
                        <div className={cn("grid gap-2", endpoint.public && "md:grid-cols-2")}>
                          <EndpointUrlBlock
                            url={endpoint.url}
                            missingText="not assigned"
                            copyTitle="Copy local endpoint URL"
                            openTitle="Open local endpoint URL"
                            onCopy={copyEndpointUrl}
                            actions={<PortReassignControl app={app} endpoint={endpoint} />}
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
                              actions={<CloudflarePublishControl app={app} endpoint={endpoint} />}
                            />
                          )}
                        </div>
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
  actions,
}: {
  url?: string | null;
  missingText: string;
  copyTitle: string;
  openTitle: string;
  configureTitle?: string;
  onCopy: (url: string) => void | Promise<void>;
  // Rendered independently of `url`: an origin that is already set still needs an edit affordance, not
  // just a way to fill an empty one.
  onConfigure?: () => void;
  // Endpoint-scoped controls (port reassignment on the local URL, Cloudflare publishing on the public
  // origin) rendered beside copy/open so they sit with the URL they act on. Deliberately independent of
  // `url`: an unassigned port — or an origin not published yet — is exactly when they matter most.
  actions?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className={cn("truncate font-mono", url ? "text-foreground" : "text-muted-foreground")}>{url || missingText}</span>
      <span className="flex items-center gap-1">
        {url && (
          <>
            <IconButton title={copyTitle} onClick={() => void onCopy(url)}>
              <Copy className="h-4 w-4" />
            </IconButton>
            <Button type="button" variant="ghost" size="icon-sm" title={openTitle} aria-label={openTitle} asChild>
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </>
        )}
        {onConfigure && (
          <IconButton title={configureTitle || "Configure"} onClick={onConfigure}>
            <Settings2 className="h-4 w-4" />
          </IconButton>
        )}
        {actions}
      </span>
    </div>
  );
}

function InstalledAppsTable({
  coreOrigin,
  apps,
  shellAppId,
  canManageApps,
  busyAction,
  updateStatusByApp,
  onAction,
  onSwitchRuntime,
  onSetDevelopmentMode,
  onUpdateApp,
  onCheckUpdate,
  onOpenPanel,
}: {
  coreOrigin: string;
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  busyAction: string | null;
  // Per-service digest detail for expanded rows, owned by the page; the section only reads it.
  updateStatusByApp: Record<string, UpdateStatusState>;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
  onUpdateApp: (app: CoreApp) => void;
  onCheckUpdate: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const [expandedAppIds, setExpandedAppIds] = useState<Set<string>>(() => new Set());
  const [healthByApp, setHealthByApp] = useState<Record<string, RuntimeHealthState>>({});

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

    // Health only: expanding a row must not probe for updates. Availability is the row's own
    // affordance, fed by the fleet check; the panel's per-service digests are opt-in through the
    // actions menu's "Check for updates".
    if (shouldExpand) {
      void loadAppHealth(app);
    }
  };

  return (
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

            return (
              <Fragment key={app.id}>
                <InstalledAppRow
                  app={app}
                  coreOrigin={coreOrigin}
                  isShell={app.id === shellAppId}
                  expanded={expanded}
                  healthLoading={healthState?.loading ?? false}
                  canManageApps={canManageApps}
                  busyAction={busyAction}
                  checkingUpdate={updateStatusState?.loading ?? false}
                  onToggleExpanded={() => toggleAppExpanded(app)}
                  onAction={onAction}
                  onSwitchRuntime={onSwitchRuntime}
                  onSetDevelopmentMode={onSetDevelopmentMode}
                  onUpdateApp={onUpdateApp}
                  onCheckUpdate={onCheckUpdate}
                  onOpenPanel={onOpenPanel}
                />
                {expanded && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-muted/20 px-4 py-3">
                      <AppServiceDetailsPanel
                        app={app}
                        healthState={healthState}
                        updateStatusState={updateStatusState}
                        canConfigurePublicOrigins={canManageApps}
                        onConfigurePublicOrigins={() => onOpenPanel(app, "settings", { settingsTab: "publicOrigins" })}
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
  );
}

function InstalledAppRow({
  app,
  coreOrigin,
  isShell,
  expanded,
  healthLoading,
  canManageApps,
  busyAction,
  checkingUpdate,
  onToggleExpanded,
  onAction,
  onSwitchRuntime,
  onSetDevelopmentMode,
  onUpdateApp,
  onCheckUpdate,
  onOpenPanel,
}: {
  app: CoreApp;
  coreOrigin: string;
  isShell: boolean;
  expanded: boolean;
  healthLoading: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  checkingUpdate: boolean;
  onToggleExpanded: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
  onUpdateApp: (app: CoreApp) => void;
  onCheckUpdate: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const running = app.runtimeState === "running";
  // Lifecycle (start/stop/restart) is not system-gated: Core's endpoints never were, reviewed updates
  // already cycle system apps, and a stopped one recovers from this page or the CLI. Stopping or
  // restarting the Shell itself takes this UI down with it, so the action handler confirms that case.
  const canControl = canManageApps;
  const canSwitchRuntime = canManageApps;
  // `backup` and `logs` are the only genuine capability gates left: unlike the lifecycle verbs, they
  // are optional *features* that depend on the app itself (does it have data worth snapshotting?),
  // which is why Core's canonical vocabulary is now just those two. Restore lives inside this panel.
  const canBackup = canControl && app.capabilities.includes("backup");
  const canConfigure = canManageApps;
  // Live source runtimes have no reviewed-update path (the manifest is adopted on restart), so the
  // Update affordance is hidden and the live-source status icon is shown instead — that live check is
  // all appSupportsReviewedUpdate does. System apps go through the same reviewed plan/apply flow as
  // every other runtime app (docs/ideas/system-app-updates.md).
  const canUpdate = canManageApps && appSupportsReviewedUpdate(app);
  // The row's update affordance renders from the fleet-check verdict on the app summary (plan-first
  // updates), as one icon among the other row actions: blue applies the cached plan straight away,
  // amber means the plan must be read first and opens the review dialog. Either way the actions menu
  // offers "Review and update" for the full plan. Progress is the record's operationStatus — server
  // state, so it survives reloads and shows for every admin.
  const updating = app.operationStatus === "updating";
  const verdict = canUpdate && !updating ? app.updateCheck : null;
  const updateVisible = Boolean(verdict?.updateAvailable && !verdict.error);
  // A verdict with no cached plan digest cannot be applied in one click (the plan expired or was
  // consumed), so it takes the review path too — the dialog rebuilds the plan.
  const needsReview = Boolean(verdict?.requiresReview || !verdict?.planDigest);
  // Removal, like start/stop/restart/update, is an inherent Core operation: the endpoint authorizes on
  // the admin session, never on the manifest `capabilities` list, so an app cannot decline to be
  // uninstalled by omitting a token. System apps are removable too — "system" governs who may see and
  // reach an app, not whether it can be uninstalled; the remove panel explains the consequences.
  const canRemove = canManageApps;
  // Development Mode is a per-source-runtime toggle (localCommand + Core reports developmentMode).
  // Surface it in the actions menu only for the *selected* source runtime, so an operator can flip
  // live/reviewed without opening Settings → Source. See runtime-artifact-model.md.
  const selectedDevRuntime = (app.runtimeProfiles ?? []).find(
    (profile) =>
      profile.key === app.selectedRuntime &&
      profile.type === "localCommand" &&
      profile.developmentMode !== undefined,
  );
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;
  const autostartEnabled = isAppAutostartEnabled(app);
  // Same call the details panel makes, so the row's icons and the panel's alerts always describe the
  // same set of problems.
  const problems = collectAppProblems(app);

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
          <AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} fallback={Boxes} className="h-8 w-8 self-center rounded-md" alt="" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{app.displayName}</span>
              {app.system && <Badge variant="secondary">System</Badge>}
              {isShell && <Badge variant="outline">Shell</Badge>}
              <AppProblemIcons problems={problems} />
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
              className="size-6 gap-0 border-emerald-500/40 p-0 text-emerald-700 dark:text-emerald-300 [&>svg]:size-3.5"
              aria-label="Live source runtime"
              title={
                app.sourceLivePath
                  ? `Runs live from ${app.sourceLivePath}; the manifest is adopted on restart. Switch to a compiled runtime for reviewed updates.`
                  : "Runs live from your source folder; the manifest is adopted on restart. Switch to a compiled runtime for reviewed updates."
              }
            >
              <Radio />
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {updating && (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title="An update is being applied on Core; this row settles when it finishes."
            >
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              Updating
            </span>
          )}
          {verdict?.error && (
            <span title={`Update check failed: ${verdict.error}`} className="inline-flex shrink-0">
              <CircleAlert className="h-4 w-4 text-amber-500" aria-label="Update check failed" />
            </span>
          )}
          {updateVisible && (needsReview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-500 dark:hover:text-amber-500"
              title="Update available — changes more than the app's build, so review it before applying"
              aria-label="Update available — review before applying"
              onClick={() => onOpenPanel(app, "update")}
            >
              <ArrowUpCircle className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-sky-600 hover:bg-sky-500/10 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-400"
              title="Routine update available — apply it (use the actions menu to review the changes first)"
              aria-label="Routine update available — apply"
              disabled={isBusy("update")}
              onClick={() => onUpdateApp(app)}
            >
              {isBusy("update") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
            </Button>
          ))}
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
            canBackup={canBackup}
            canConfigure={canConfigure}
            canRemove={canRemove}
            canCheckUpdate={canUpdate}
            canReviewUpdate={updateVisible}
            checkingUpdate={checkingUpdate}
            devRuntime={canManageApps ? selectedDevRuntime : undefined}
            devWillRestart={!app.system && running}
            devBusy={isBusy("development-mode")}
            onCheckUpdate={() => onCheckUpdate(app)}
            onReviewUpdate={() => onOpenPanel(app, "update")}
            onSetDevelopmentMode={onSetDevelopmentMode}
            onOpenPanel={onOpenPanel}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

// At most two icons — one per severity, worst first — rather than one glyph per problem type. A distinct
// glyph reads better at a glance, but does not scale: an app with a failed start, an unbound port, and
// missing settings would carry three icons and stop being scannable. The tooltip carries the specifics,
// and the panel's alerts carry the full explanation.
function AppProblemIcons({ problems }: { problems: AppProblem[] }) {
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");

  return (
    <>
      {errors.length > 0 && <AppProblemIcon severity="error" problems={errors} />}
      {warnings.length > 0 && <AppProblemIcon severity="warning" problems={warnings} />}
    </>
  );
}

function AppProblemIcon({ severity, problems }: { severity: AlertSeverity; problems: AppProblem[] }) {
  const Icon = severity === "error" ? CircleAlert : TriangleAlert;
  const label = severity === "error"
    ? `${problems.length} problem${problems.length === 1 ? "" : "s"} stopping this app`
    : `${problems.length} problem${problems.length === 1 ? "" : "s"} needing attention`;
  // Titles alone: the details belong in the panel, and a multi-paragraph tooltip is unreadable.
  const summary = problems.map((problem) => problem.title).join("\n");

  return (
    <span title={`${label}:\n${summary}`} className="inline-flex shrink-0">
      <Icon className={cn("h-4 w-4", severity === "error" ? "text-destructive" : "text-amber-500")} aria-label={label} />
    </span>
  );
}

// Per-runtime mode marker in the switcher, so an operator sees which target runs live from source
// vs. runs a locked build before switching. Driven by the effective Development Mode (the operator's
// per-runtime toggle over the manifest default), falling back to the raw flag for older Core builds.
// See runtime-artifact-model.md.
function RuntimeModeBadge({ profile }: { profile: CoreRuntimeProfile }) {
  const live = (profile.developmentMode ?? profile.development) === true;
  return (
    <span
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-1 text-[11px]",
        live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
      )}
      title={
        live
          ? "Development Mode on: runs live from your source folder; the manifest is adopted on restart (no reviewed update)."
          : "Development Mode off: uses the reviewed manifest/contract — a fixed image/build, or a source runtime not run live — advanced by a reviewed update."
      }
    >
      {live ? <Radio className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
      {live ? "Live" : "Locked"}
    </span>
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
                <RuntimeModeBadge profile={profile} />
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
  canBackup,
  canConfigure,
  canRemove,
  canCheckUpdate,
  canReviewUpdate,
  checkingUpdate,
  devRuntime,
  devWillRestart,
  devBusy,
  onCheckUpdate,
  onReviewUpdate,
  onSetDevelopmentMode,
  onOpenPanel,
}: {
  app: CoreApp;
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
  // The selected source runtime whose Development Mode can be toggled here (undefined when the
  // selected runtime is not a source runtime, or the operator cannot manage apps).
  devRuntime?: CoreRuntimeProfile;
  // True when toggling will auto-restart the app (a running, non-system app); drives the caption.
  devWillRestart: boolean;
  devBusy: boolean;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
  onOpenPanel: OpenAppPanel;
}) {
  // Console logs (docker logs) are served on-demand by Core, so the action shows for any app that
  // declares the `logs` capability — independent of the telemetry backend.
  const canViewLogs = app.capabilities.includes("logs");
  const hasMenuActions =
    canCheckUpdate || canReviewUpdate || Boolean(devRuntime) || canViewLogs || canBackup || canConfigure || canRemove;

  if (!hasMenuActions) {
    return null;
  }

  const devOn = devRuntime ? (devRuntime.developmentMode ?? devRuntime.development) === true : false;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {canReviewUpdate && (
          <DropdownMenuItem onClick={onReviewUpdate}>
            <ArrowUpCircle className="h-4 w-4" />
            Review and update
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
            {checkingUpdate ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check for updates
          </DropdownMenuItem>
        )}
        {(canCheckUpdate || canReviewUpdate) &&
          (Boolean(devRuntime) || canViewLogs || canBackup || canConfigure || canRemove) && <DropdownMenuSeparator />}
        {devRuntime && (
          <>
            <DropdownMenuLabel>Development mode</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={devBusy}
              onClick={() => onSetDevelopmentMode(app, devRuntime.key, !devOn)}
            >
              {devBusy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : devOn ? (
                <Lock className="h-4 w-4" />
              ) : (
                <Radio className="h-4 w-4" />
              )}
              <div className="min-w-0 flex-1">
                <div>{devOn ? "Disable development mode" : "Enable development mode"}</div>
                <div className="text-[11px] text-muted-foreground">
                  {devWillRestart ? "Restarts the app now" : "Applies on next start"}
                </div>
              </div>
            </DropdownMenuItem>
            {(canViewLogs || canBackup || canConfigure || canRemove) && <DropdownMenuSeparator />}
          </>
        )}
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
        {canConfigure && (
          <>
            {canBackup && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => onOpenPanel(app, "settings")}>
              <Settings2 className="h-4 w-4" />
              Settings
            </DropdownMenuItem>
          </>
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
