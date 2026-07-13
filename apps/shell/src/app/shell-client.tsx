"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { findAppPageLink, getAppPageLinks } from "./shell/app-helpers";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLogin, redirectToCoreLoginIfAuthRequired } from "./shell/core-api";
import { AppDetailsDialog } from "./shell/dialogs/app-details-dialog";
import { InstallReviewDialog } from "./shell/dialogs/install-review-dialog";
import { PlatformDialog } from "./shell/dialogs/platform-dialog";
import { SharedMountsDialog } from "./shell/dialogs/shared-mounts-dialog";
import { ShellSidebar } from "./shell/sidebar/shell-sidebar";
import { ShellActionsContext, ShellStateContext } from "./shell/shell-context";
import {
  getAuthorizedShellView,
  getShellViewHref,
  getSystemAppHref,
  getWorkspaceHref,
  getWorkspaceRouteKey,
  normalizeAppPath,
  normalizeShellPath,
  readShellRoute,
  SIDEBAR_COMPACT_STORAGE_KEY,
  shellViewRequiresAdmin,
} from "./shell/shell-routes";
import { emptyDetailPanelState, emptyInstallPanelState } from "./shell/state";
import { appendHostyThemeParams, normalizeThemePreference, resolveShellTheme } from "./shell/theme";
import { EmptyState } from "./shell/ui";
import { EmbeddedWorkspacePanel } from "./shell/workspace/embedded-workspace-panel";
import { EmbeddedWorkspacePendingPanel } from "./shell/workspace/embedded-workspace-pending-panel";
import { appMayRequestFeedInstall, type InstallFeedIntent } from "./shell/workspace/install-intent";
import type {
  ActivePanel,
  AppAction,
  AppLaunchResponse,
  AppOpenTarget,
  AppPageLink,
  AppsResponse,
  BackupsResponse,
  CoreApp,
  CoreAppLifecycleResult,
  CoreBackup,
  CoreBackupCleanupApplyResponse,
  CoreBackupCleanupPlan,
  CoreBootstrapState,
  CoreSettingsState,
  CoreGlobalMount,
  CoreFeedInstallPlan,
  CoreInstallPlan,
  CoreRuntimeSwitchPlan,
  CoreStatus,
  CoreUpdatePlan,
  DetailPanelState,
  DetailView,
  EmbeddedWorkspace,
  MountBindingInput,
  InstallPanelState,
  LoadState,
  OpenPanelOptions,
  RemoveOptions,
  SessionResponse,
  WorkspaceRoute,
} from "./shell/types";

// Minimum spacing between launch-code reissues for one app, a loop guard against a frame that keeps
// re-posting hosty:auth-required.
const AUTH_REISSUE_MIN_INTERVAL_MS = 3_000;

export function ShellClient({
  coreOrigin,
  shellAppId,
  shellVersion,
  children,
}: {
  coreOrigin: string;
  shellAppId: string;
  shellVersion: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { theme, resolvedTheme } = useTheme();
  const shellRoute = useMemo(
    () => readShellRoute(pathname || "/", searchParams ?? new URLSearchParams()),
    [pathname, searchParams],
  );
  const normalizedRoutePath = normalizeShellPath(pathname || "/");
  const [state, setState] = useState<LoadState>({
    loading: true,
    error: null,
    status: null,
    apps: [],
    session: null,
    updatedAt: null,
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const [detailPanel, setDetailPanel] = useState<DetailPanelState>(emptyDetailPanelState);
  const [installOpen, setInstallOpen] = useState(false);
  const [installInitialManifest, setInstallInitialManifest] = useState<string | null>(null);
  const [installFeedIntent, setInstallFeedIntent] = useState<InstallFeedIntent | null>(null);
  // Bumped on every openInstallDialog and folded into the dialog's key, so each open remounts a fresh
  // instance. The manifest alone is not enough: reopening the same manifestRef would keep the key,
  // skip the mount-only auto-review, and (with the panel state wiped on open) render an empty dialog.
  const [installNonce, setInstallNonce] = useState(0);
  const [installPanel, setInstallPanel] = useState<InstallPanelState>(emptyInstallPanelState);
  const [globalMounts, setGlobalMounts] = useState<CoreGlobalMount[]>([]);
  const [sharedMountsOpen, setSharedMountsOpen] = useState(false);
  const [platformOpen, setPlatformOpen] = useState(false);
  const [platformState, setPlatformState] = useState<CoreBootstrapState | null>(null);
  const [platformLoading, setPlatformLoading] = useState(false);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [coreSettings, setCoreSettings] = useState<CoreSettingsState | null>(null);
  const [coreSettingsError, setCoreSettingsError] = useState<string | null>(null);
  // Applying an update / switching runtime resets Core's artifact locks, so the cached update-status
  // owned by the Installed Apps page goes stale (it would keep showing "Update available"). We can't
  // reach into that page's state from here, so we bump a per-app counter it watches to re-probe.
  const [updateStatusInvalidations, setUpdateStatusInvalidations] = useState<Record<string, number>>({});
  const [workspace, setWorkspace] = useState<EmbeddedWorkspace | null>(null);
  const [optimisticWorkspaceRoute, setOptimisticWorkspaceRoute] = useState<WorkspaceRoute | null>(null);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const activeWorkspaceRoute = shellRoute.workspace ?? optimisticWorkspaceRoute;
  const workspaceRouteKey = getWorkspaceRouteKey(activeWorkspaceRoute);
  const pendingWorkspaceRoute = useRef<string | null>(null);
  // Stale async resolutions must not overwrite newer shared state, so each load takes a token.
  const refreshRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const installRequestRef = useRef(0);
  // Last launch-code reissue per app id, so a chatty frame cannot storm Core with reissues.
  const authReissueAtRef = useRef<Map<string, number>>(new Map());
  // Core CSRF is a cookie/header pair, so token refresh + mutation must stay ordered.
  const csrfOperationQueue = useRef<Promise<void>>(Promise.resolve());
  const shellThemePreference = normalizeThemePreference(theme);
  const shellResolvedTheme = resolveShellTheme(resolvedTheme);
  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";

  useEffect(() => {
    setSidebarCompact(window.localStorage.getItem(SIDEBAR_COMPACT_STORAGE_KEY) === "true");
  }, []);

  const refresh = useCallback(async () => {
    const requestToken = ++refreshRequestRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [statusResponse, sessionResponse] = await Promise.all([
        fetch(`${coreOrigin}/api/core/status`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/session`, { credentials: "include" }),
      ]);

      redirectToCoreLoginIfAuthRequired(statusResponse, coreOrigin);
      if (!statusResponse.ok) {
        throw new Error(`Core status returned ${statusResponse.status}.`);
      }

      const status = (await statusResponse.json()) as CoreStatus;
      redirectToCoreLoginIfAuthRequired(sessionResponse, coreOrigin);
      if (!sessionResponse.ok) {
        throw new Error(await readCoreError(sessionResponse));
      }

      const session = (await sessionResponse.json()) as SessionResponse;
      if (requestToken !== refreshRequestRef.current) {
        return;
      }

      if (!session.authenticated) {
        setState({
          loading: false,
          error: null,
          status,
          apps: [],
          session,
          updatedAt: new Date().toISOString(),
        });
        redirectToCoreLogin(coreOrigin);
      }

      let apps: AppsResponse = { apps: [] };
      let nextGlobalMounts: CoreGlobalMount[] = [];
      if (session?.authenticated) {
        const appsResponse = await fetch(`${coreOrigin}/api/apps`, { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(appsResponse, coreOrigin);
        if (!appsResponse.ok) {
          throw new Error(`Apps API returned ${appsResponse.status}.`);
        }

        apps = (await appsResponse.json()) as AppsResponse;

        // The shared-mounts library is admin-only; non-admins simply get an empty list (the picker
        // and Shared mounts button are gated to admins anyway).
        if (session.user?.role === "host.admin") {
          const mountsResponse = await fetch(`${coreOrigin}/api/global-mounts`, { credentials: "include" });
          if (mountsResponse.ok) {
            nextGlobalMounts = ((await mountsResponse.json()) as { mounts?: CoreGlobalMount[] }).mounts ?? [];
          }
        }
      }

      if (requestToken !== refreshRequestRef.current) {
        return;
      }

      setGlobalMounts(nextGlobalMounts);
      setState({
        loading: false,
        error: null,
        status,
        apps: apps.apps,
        session,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (isAuthRequiredRedirectError(error) || requestToken !== refreshRequestRef.current) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Core is unavailable.",
      }));
    }
  }, [coreOrigin]);

  const loadCsrfToken = useCallback(async () => {
    const response = await fetch(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) {
      throw new Error(`CSRF endpoint returned ${response.status}.`);
    }

    return ((await response.json()) as { token: string }).token;
  }, [coreOrigin]);

  const sendCsrfJson = useCallback(
    async (endpoint: string, body?: unknown, method = "POST") => {
      const previousOperation = csrfOperationQueue.current;
      let releaseOperation = () => {};
      csrfOperationQueue.current = new Promise<void>((resolve) => {
        releaseOperation = () => resolve();
      });

      await previousOperation.catch(() => undefined);

      try {
        const csrf = await loadCsrfToken();
        const response = await fetch(endpoint, {
          method,
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Hosty-CSRF": csrf,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        return response;
      } finally {
        releaseOperation();
      }
    },
    [coreOrigin, loadCsrfToken],
  );

  const appEndpoint = useCallback(
    (app: CoreApp, suffix: string) => `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}${suffix}`,
    [coreOrigin],
  );

  const getStandaloneAppHref = useCallback(
    (app: CoreApp, page: AppPageLink) => {
      const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
      const url = new URL(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/open`);
      url.searchParams.set("redirectUri", themedRedirectUri);
      return url.toString();
    },
    [coreOrigin, shellResolvedTheme, shellThemePreference],
  );

  const launchAppPage = useCallback(
    async (app: CoreApp, page: AppPageLink, target: AppOpenTarget = "workspace") => {
      if (app.id === shellAppId) {
        setWorkspace(null);
        setOptimisticWorkspaceRoute(null);
        router.push(getShellViewHref(canManageApps ? "dashboard" : "available-apps"));
        return;
      }

      if (app.runtimeState !== "running") {
        setState((current) => ({
          ...current,
          error: app.system
            ? `System app '${app.displayName}' is ${app.runtimeState || app.operationStatus}. Manage it from Installed Apps.`
            : "App must be running before it can be opened.",
        }));
        return;
      }

      if (target === "tab") {
        window.open(getStandaloneAppHref(app, page), "_blank", "noreferrer");
        return;
      }

      const routePath = normalizeAppPath(page.path);
      const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
      // System apps use the canonical admin-only deep link; both routes share the workspace engine.
      const isSystemApp = Boolean(app.system);
      const workspaceHref = isSystemApp ? getSystemAppHref(app.id, routePath) : getWorkspaceHref(app.id, routePath);
      const nextWorkspaceRoute: WorkspaceRoute = isSystemApp
        ? { appId: app.id, path: routePath, system: true }
        : { appId: app.id, path: routePath };
      setState((current) => ({ ...current, error: null }));
      setOptimisticWorkspaceRoute(nextWorkspaceRoute);
      if (workspace?.appId === app.id) {
        setWorkspace({
          appId: app.id,
          title: app.displayName,
          pageLabel: page.label,
          path: routePath,
          src: themedRedirectUri,
          externalUrl: getStandaloneAppHref(app, page),
        });
        router.push(workspaceHref);
        return;
      }

      const routeKey = getWorkspaceRouteKey(nextWorkspaceRoute);
      pendingWorkspaceRoute.current = routeKey;
      setWorkspace(null);
      setBusyAction(`${app.id}:open`);
      router.push(workspaceHref);

      try {
        const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: themedRedirectUri });
        const launch = (await response.json()) as AppLaunchResponse;
        const currentUrl = new URL(window.location.href);
        const expectedPathname = isSystemApp ? `/system-apps/${encodeURIComponent(app.id)}` : "/workspace";
        if (
          normalizeShellPath(currentUrl.pathname) !== expectedPathname ||
          (!isSystemApp && currentUrl.searchParams.get("app") !== app.id) ||
          normalizeAppPath(currentUrl.searchParams.get("path")) !== routePath
        ) {
          return;
        }

        setWorkspace({
          appId: app.id,
          title: app.displayName,
          pageLabel: page.label,
          path: routePath,
          src: launch.redirectUri,
          externalUrl: launch.redirectUri,
        });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unable to create app launch link.";
        setWorkspace(null);
        setState((current) => ({ ...current, error: message }));
        toast.error("App launch failed", { description: message });
      } finally {
        if (pendingWorkspaceRoute.current === routeKey) {
          pendingWorkspaceRoute.current = null;
        }
        setBusyAction((current) => (current === `${app.id}:open` ? null : current));
      }
    },
    [appEndpoint, canManageApps, getStandaloneAppHref, router, sendCsrfJson, shellAppId, shellResolvedTheme, shellThemePreference, workspace?.appId],
  );

  const invalidateUpdateStatus = useCallback((appId: string) => {
    setUpdateStatusInvalidations((current) => ({ ...current, [appId]: (current[appId] ?? 0) + 1 }));
  }, []);

  // Keep the invalidation map bounded: drop counters for apps that no longer exist (removed, or gone
  // after a refresh) so it does not accumulate stale keys over a long-lived session. Only rewrites
  // state when something actually needs pruning, so it never loops.
  useEffect(() => {
    setUpdateStatusInvalidations((current) => {
      const liveIds = new Set(state.apps.map((app) => app.id));
      const kept = Object.entries(current).filter(([appId]) => liveIds.has(appId));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [state.apps]);

  const runAppAction = useCallback(
    async (app: CoreApp, action: AppAction) => {
      const actionKey = `${app.id}:${action}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const endpoint = action === "backup" ? appEndpoint(app, "/backups") : appEndpoint(app, `/${action}`);
        await sendCsrfJson(endpoint, action === "backup" ? { reason: "manual" } : {});
        await refresh();
        toast.success(`${app.displayName}: ${action} complete`);
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Core lifecycle action failed.";
        setState((current) => ({ ...current, error: message }));
        toast.error("App action failed", { description: message });
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const switchAppRuntime = useCallback(
    async (app: CoreApp, targetRuntime: string) => {
      if (!targetRuntime || targetRuntime === app.selectedRuntime) {
        return;
      }

      const actionKey = `${app.id}:switch-runtime:${targetRuntime}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        // Plan routes are session-authenticated POSTs and now require the CSRF header like their apply
        // twins (C-M9); sendCsrfJson attaches it and throws on !ok.
        const planResponse = await sendCsrfJson(appEndpoint(app, "/switch-runtime/plan"), { targetRuntime });
        const plan = (await planResponse.json()) as CoreRuntimeSwitchPlan;
        await sendCsrfJson(appEndpoint(app, "/switch-runtime"), {
          targetRuntime: plan.targetRuntime,
          planDigest: plan.planDigest,
        });
        await refresh();
        invalidateUpdateStatus(app.id);
        toast.success("Runtime switched", {
          description: `${app.displayName}: ${plan.currentRuntime || "none"} to ${plan.targetRuntime}`,
        });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Runtime switch failed.";
        setState((current) => ({ ...current, error: message }));
        toast.error("Runtime switch failed", { description: message });
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, invalidateUpdateStatus, refresh, sendCsrfJson],
  );

  const loadAppBackups = useCallback(
    async (app: CoreApp, activate = true) => {
      const requestToken = ++detailRequestRef.current;
      if (activate) {
        setActivePanel({ appId: app.id, view: "backups" });
      }
      setDetailPanel({ loading: true, error: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetch(appEndpoint(app, "/backups"), { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as BackupsResponse;
        if (requestToken !== detailRequestRef.current) {
          return;
        }

        setDetailPanel({ loading: false, error: null, backups: payload.backups, backupCleanupPlan: null, updatePlan: null });
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || requestToken !== detailRequestRef.current) {
          return;
        }

        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core backups are unavailable.", backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint, coreOrigin],
  );

  const loadUpdatePlan = useCallback(
    async (app: CoreApp, manifestPath?: string) => {
      const requestToken = ++detailRequestRef.current;
      setActivePanel({ appId: app.id, view: "update" });
      setDetailPanel({ loading: true, error: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const source = manifestPath?.trim();
        // Plan routes require the CSRF header like their apply twins (C-M9); sendCsrfJson attaches it.
        const response = await sendCsrfJson(appEndpoint(app, "/update/plan"), { manifestPath: source ? source : null });
        const payload = (await response.json()) as CoreUpdatePlan;
        if (requestToken !== detailRequestRef.current) {
          return;
        }

        setDetailPanel({ loading: false, error: null, backups: null, backupCleanupPlan: null, updatePlan: payload });
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || requestToken !== detailRequestRef.current) {
          return;
        }

        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Update plan is unavailable.", backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint, sendCsrfJson],
  );

  // Points an installed app at one of its app-owned feeds. Core resolves the stored FeedsUrl and
  // re-points ManifestUrl at the feed head, so the update plan is rebuilt against the new selection.
  const setAppFeed = useCallback(
    async (app: CoreApp, feedId: string) => {
      setBusyAction(`${app.id}:feed`);
      try {
        await sendCsrfJson(appEndpoint(app, "/feed"), { feedId });
        await refresh();
        toast.success("Feed updated", {
          description: feedId.length > 0 ? `Now following '${feedId}'.` : "No longer following a feed.",
        });
        void loadUpdatePlan(app);
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }
        toast.error("Failed to set the feed", {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        setBusyAction((current) => (current === `${app.id}:feed` ? null : current));
      }
    },
    [appEndpoint, loadUpdatePlan, refresh, sendCsrfJson],
  );

  const openAppPanel = useCallback(
    (app: CoreApp, view: DetailView, options?: OpenPanelOptions) => {
      if (view === "backups") {
        void loadAppBackups(app);
        return;
      }
      if (view === "update") {
        void loadUpdatePlan(app);
        return;
      }
      detailRequestRef.current += 1;
      setActivePanel({ appId: app.id, view, settingsTab: options?.settingsTab });
      setDetailPanel(emptyDetailPanelState());
    },
    [loadAppBackups, loadUpdatePlan],
  );

  const closeAppPanel = useCallback(() => {
    detailRequestRef.current += 1;
    setActivePanel(null);
  }, []);

  const createManualBackup = useCallback(
    async (app: CoreApp) => {
      const actionKey = `${app.id}:backup`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/backups"), { reason: "manual" });
        await refresh();
        if (activePanel?.appId === app.id && activePanel.view === "backups") {
          await loadAppBackups(app, false);
        }
        toast.success("Backup created", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Backup failed.";
        if (activePanel?.appId === app.id && activePanel.view === "backups") {
          setDetailPanel((current) => ({ ...current, loading: false, error: message }));
        }
        toast.error("Backup failed", { description: message });
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [activePanel, appEndpoint, loadAppBackups, refresh, sendCsrfJson],
  );

  const restoreBackup = useCallback(
    async (app: CoreApp, backup: CoreBackup) => {
      if (!window.confirm(`Restore backup ${backup.backupId}?`)) {
        return;
      }

      const actionKey = `${app.id}:restore:${backup.backupId}`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, `/backups/${encodeURIComponent(backup.backupId)}/restore`), { createPreRestoreBackup: true });
        await refresh();
        await loadAppBackups(app, false);
        toast.success("Backup restored", { description: backup.backupId });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Restore failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, loadAppBackups, refresh, sendCsrfJson],
  );

  const deleteBackup = useCallback(
    async (app: CoreApp, backup: CoreBackup) => {
      if (!window.confirm(`Delete backup ${backup.backupId}?`)) {
        return;
      }

      const actionKey = `${app.id}:delete-backup:${backup.backupId}`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, `/backups/${encodeURIComponent(backup.backupId)}`), undefined, "DELETE");
        await loadAppBackups(app, false);
        toast.success("Backup deleted", { description: backup.backupId });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup delete failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const previewBackupCleanup = useCallback(
    async (app: CoreApp) => {
      const actionKey = `${app.id}:backup-cleanup-plan`;
      setBusyAction(actionKey);
      try {
        const response = await fetch(appEndpoint(app, "/backups/cleanup/plan"), { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as CoreBackupCleanupPlan;
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: null,
          backupCleanupPlan: payload,
        }));
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup cleanup preview failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, coreOrigin],
  );

  const applyBackupCleanup = useCallback(
    async (app: CoreApp, plan: CoreBackupCleanupPlan) => {
      if (!window.confirm(`Delete ${plan.candidates.length} backup cleanup candidates?`)) {
        return;
      }

      const actionKey = `${app.id}:backup-cleanup`;
      setBusyAction(actionKey);
      try {
        const response = await sendCsrfJson(appEndpoint(app, "/backups/cleanup"), { planDigest: plan.planDigest });
        const result = (await response.json()) as CoreBackupCleanupApplyResponse;
        await loadAppBackups(app, false);
        if (result.skipped.length > 0) {
          setDetailPanel((current) => ({
            ...current,
            loading: false,
            error: `${result.skipped.length} backup cleanup candidates were skipped; refresh and preview again.`,
            backupCleanupPlan: null,
          }));
        } else {
          toast.success("Backup cleanup complete", { description: `${result.deleted.length} deleted` });
        }
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup cleanup failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const configureApp = useCallback(
    async (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => {
      const actionKey = `${app.id}:configure`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/configure"), { settings, autostart });
        await refresh();
        setActivePanel(null);
        toast.success("Settings saved", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Configure failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const configureMounts = useCallback(
    async (app: CoreApp, mounts: MountBindingInput[]) => {
      const actionKey = `${app.id}:mounts`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/mounts"), { mounts });
        await refresh();
        setActivePanel(null);
        toast.success("Mounts saved", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Saving mounts failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  // Source override: point an app's live source at a custom folder, or clear it to fall back to the
  // standard Hosty-managed source. Unlike configure/mounts we keep the panel open so the Source tab
  // re-derives selectedApp from refreshed state and shows the new override state.
  const configureAppSource = useCallback(
    async (app: CoreApp, path: string) => {
      const actionKey = `${app.id}:source`;
      setBusyAction(actionKey);
      // The panel stays open on success, so clear any stale error from a prior failed attempt.
      setDetailPanel((current) => ({ ...current, error: null }));
      try {
        await sendCsrfJson(appEndpoint(app, "/source/override"), { path });
        await refresh();
        toast.success("Source updated", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Updating source failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const clearAppSource = useCallback(
    async (app: CoreApp) => {
      const actionKey = `${app.id}:source`;
      setBusyAction(actionKey);
      // The panel stays open on success, so clear any stale error from a prior failed attempt.
      setDetailPanel((current) => ({ ...current, error: null }));
      try {
        await sendCsrfJson(appEndpoint(app, "/source/override"), undefined, "DELETE");
        await refresh();
        toast.success("Source reset to standard", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Resetting source failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  // Per-runtime Development Mode toggle. Core owns the stop/backup/flip/restart cycle now, so the
  // client only reacts to the outcome: it flips the flag (Core restarts the selected running runtime
  // to apply), and on a risky disable Core leaves the app stopped and returns a rollback recommendation.
  // Keeps the detail panel open (like source) so the Source tab re-derives the refreshed effective mode.
  const configureAppDevelopmentMode = useCallback(
    async (app: CoreApp, runtime: string, enabled: boolean) => {
      const actionKey = `${app.id}:development-mode`;
      setBusyAction(actionKey);
      setDetailPanel((current) => ({ ...current, error: null }));
      try {
        const response = await sendCsrfJson(appEndpoint(app, "/development-mode"), { runtime, enabled });
        const result = (await response.json().catch(() => null)) as CoreAppLifecycleResult | null;
        await refresh();
        toast.success(enabled ? "Development Mode on" : "Development Mode off", {
          description: `${app.displayName} · ${runtime}`,
        });

        // Risky disable: the app ran a newer version live that may have migrated its data one-way, so
        // Core left it stopped and handed back the pre-development-mode snapshot. Offer to roll back
        // before the reviewed version starts; declining leaves it stopped so the operator can start it
        // as-is (accepting the migrated data) or restore later from the Backups tab.
        const hint = result?.developmentModeRestore;
        if (hint?.recommended && hint.backupId) {
          const restore = window.confirm(
            `${app.displayName} ran version ${hint.currentVersion} in development mode, but the reviewed ` +
              `version is ${hint.baselineVersion}. Its data may have been migrated and may not work with ` +
              `${hint.baselineVersion}.\n\nRestore the pre-development-mode snapshot and start the app?\n\n` +
              `Cancel leaves the app stopped — you can start it as-is or restore later from Backups.`,
          );
          if (restore) {
            await sendCsrfJson(
              appEndpoint(app, `/backups/${encodeURIComponent(hint.backupId)}/restore`),
              { createPreRestoreBackup: true },
            );
            await sendCsrfJson(appEndpoint(app, "/start"), {});
            await refresh();
            toast.success("Snapshot restored", { description: `${app.displayName} · ${hint.backupId}` });
          }
        }
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Updating Development Mode failed.";
        setDetailPanel((current) => ({ ...current, loading: false, error: message }));
        toast.error("Development Mode change failed", { description: message });
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  // Shared-mounts library (host-level). The endpoints return the full updated list, so each call
  // refreshes globalMounts directly; the SharedMountsDialog surfaces any thrown error inline.
  const saveGlobalMount = useCallback(
    async (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => {
      const response = await sendCsrfJson(`${coreOrigin}/api/global-mounts`, input, "POST");
      setGlobalMounts(((await response.json()) as { mounts?: CoreGlobalMount[] }).mounts ?? []);
    },
    [coreOrigin, sendCsrfJson],
  );

  const deleteGlobalMount = useCallback(
    async (name: string, force = false) => {
      const url = `${coreOrigin}/api/global-mounts/${encodeURIComponent(name)}${force ? "?force=true" : ""}`;
      const response = await sendCsrfJson(url, undefined, "DELETE");
      setGlobalMounts(((await response.json()) as { mounts?: CoreGlobalMount[] }).mounts ?? []);
    },
    [coreOrigin, sendCsrfJson],
  );

  const openSharedMounts = useCallback(() => setSharedMountsOpen(true), []);

  // Platform panel (Extensions): the state loads on open and every toggle returns the full updated
  // snapshot, so the dialog always renders Core's authoritative view.
  const openPlatform = useCallback(async () => {
    setPlatformOpen(true);
    setPlatformError(null);
    setPlatformLoading(true);
    setCoreSettingsError(null);
    setCoreSettings(null);

    // The Extensions list and Core settings load independently — one failing must not blank the other.
    const loadBootstrap = (async () => {
      try {
        const response = await fetch(`${coreOrigin}/api/core/bootstrap`, { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        setPlatformState((await response.json()) as CoreBootstrapState);
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setPlatformState(null);
        setPlatformError(error instanceof Error ? error.message : "Unable to load the distribution list.");
      }
    })();

    const loadSettings = (async () => {
      try {
        const response = await fetch(`${coreOrigin}/api/core/settings`, { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        setCoreSettings((await response.json()) as CoreSettingsState);
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setCoreSettings(null);
        setCoreSettingsError(error instanceof Error ? error.message : "Unable to load Core settings.");
      }
    })();

    await Promise.allSettled([loadBootstrap, loadSettings]);
    setPlatformLoading(false);
  }, [coreOrigin]);

  const togglePlatformApp = useCallback(
    async (appId: string, enabled: boolean) => {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/bootstrap/choices`, { appId, enabled });
      setPlatformState((await response.json()) as CoreBootstrapState);
    },
    [coreOrigin, sendCsrfJson],
  );

  const saveCoreSettings = useCallback(
    async (values: Record<string, string>) => {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/settings`, { settings: values }, "PUT");
      setCoreSettings((await response.json()) as CoreSettingsState);
      setCoreSettingsError(null);
      toast.success("Core settings saved");
    },
    [coreOrigin, sendCsrfJson],
  );

  const applyUpdate = useCallback(
    async (app: CoreApp, plan: CoreUpdatePlan, manifestPath?: string) => {
      const actionKey = `${app.id}:update`;
      setBusyAction(actionKey);
      try {
        const source = manifestPath?.trim();
        await sendCsrfJson(appEndpoint(app, "/update"), {
          planDigest: plan.planDigest,
          manifestPath: source ? source : plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
        });
        await refresh();
        invalidateUpdateStatus(app.id);
        setActivePanel(null);
        toast.success("Update applied", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Update failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, invalidateUpdateStatus, refresh, sendCsrfJson],
  );

  const removeApp = useCallback(
    // The RemovePanel is itself the confirmation (it names the app, lists the delete-data/backups/source
    // options, and gates behind a destructive "Remove app" button), so no extra window.confirm here.
    async (app: CoreApp, options: RemoveOptions) => {
      const actionKey = `${app.id}:remove`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/remove"), {
          deleteRuntimeState: true,
          deleteData: options.deleteData,
          deleteBackups: options.deleteBackups,
          deleteSource: options.deleteSource,
          ignoreRuntimeErrors: options.ignoreRuntimeErrors,
        });
        await refresh();
        setActivePanel(null);
        if (workspace?.appId === app.id) {
          setWorkspace(null);
        }
        toast.success("App removed", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Remove failed.",
        }));
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson, workspace?.appId],
  );

  const loadInstallPlan = useCallback(
    async (manifestPath: string, selectedRuntime?: string | null) => {
      const requestToken = ++installRequestRef.current;
      setInstallPanel((current) => ({ loading: true, error: null, plan: current.plan, feedPlan: null }));
      try {
        // Plan routes require the CSRF header like their apply twins (C-M9); sendCsrfJson attaches it.
        const response = await sendCsrfJson(`${coreOrigin}/api/apps/install/plan`, {
          manifestPath,
          selectedRuntime: selectedRuntime?.trim() || null,
          system: false,
        });
        const plan = (await response.json()) as CoreInstallPlan;
        if (requestToken === installRequestRef.current) {
          setInstallPanel({ loading: false, error: null, plan, feedPlan: null });
        }
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || requestToken !== installRequestRef.current) {
          return;
        }

        setInstallPanel({
          loading: false,
          error: error instanceof Error ? error.message : "Install review is unavailable.",
          plan: null,
          feedPlan: null,
        });
      }
    },
    [coreOrigin, sendCsrfJson],
  );

  const loadFeedInstallPlan = useCallback(
    async (intent: InstallFeedIntent, selectedRuntime?: string | null, autostart?: boolean | null) => {
      const requestToken = ++installRequestRef.current;
      setInstallPanel((current) => ({ loading: true, error: null, plan: current.plan, feedPlan: current.feedPlan }));
      try {
        const response = await sendCsrfJson(`${coreOrigin}/api/apps/install/feed/plan`, {
          feedsUrl: intent.feedsUrl,
          feedId: intent.feedId,
          selectedRuntime: selectedRuntime?.trim() || null,
          autostart: autostart ?? null,
        });
        const feedPlan = (await response.json()) as CoreFeedInstallPlan;
        if (requestToken === installRequestRef.current) {
          setInstallPanel({ loading: false, error: null, plan: feedPlan.install, feedPlan });
        }
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || requestToken !== installRequestRef.current) {
          return;
        }

        setInstallPanel({
          loading: false,
          error: error instanceof Error ? error.message : "Feed install review is unavailable.",
          plan: null,
          feedPlan: null,
        });
      }
    },
    [coreOrigin, sendCsrfJson],
  );

  const applyInstall = useCallback(
    async (plan: CoreInstallPlan, settings: Record<string, string | null>, autostart: boolean) => {
      setBusyAction("install");
      try {
        const feedPlan = installPanel.feedPlan;
        if (feedPlan && installFeedIntent) {
          await sendCsrfJson(`${coreOrigin}/api/apps/install/feed`, {
            feedsUrl: feedPlan.feedsUrl,
            feedId: feedPlan.feedId,
            selectedRuntime: plan.targetRuntime,
            settings,
            autostart,
            planDigest: feedPlan.planDigest,
            startOnInstall: true,
          });
        } else {
          await sendCsrfJson(`${coreOrigin}/api/apps/install`, {
            manifestPath: plan.manifestPath,
            selectedRuntime: plan.targetRuntime,
            system: false,
            settings,
            autostart,
          });
        }
        await refresh();
        setInstallOpen(false);
        setInstallPanel(emptyInstallPanelState());
        toast.success("App installed", { description: plan.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setInstallPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Install failed.",
        }));
      } finally {
        setBusyAction((current) => (current === "install" ? null : current));
      }
    },
    [coreOrigin, installFeedIntent, installPanel.feedPlan, refresh, sendCsrfJson],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const systemApps = useMemo(() => state.apps.filter((app) => app.system), [state.apps]);
  const uiRuntimeApps = useMemo(() => runtimeApps.filter((app) => getAppPageLinks(app).length > 0), [runtimeApps]);
  // UI-capable system apps for the sidebar System group. Core already filters system apps out of
  // non-admin listings; the extra canManageApps gate keeps the group provably admin-only client-side.
  const uiSystemApps = useMemo(
    () => (canManageApps ? systemApps.filter((app) => getAppPageLinks(app).length > 0) : []),
    [canManageApps, systemApps],
  );
  const effectiveView = getAuthorizedShellView(shellRoute.view, Boolean(canManageApps));
  const workspaceSurfaceActive = Boolean(workspace || activeWorkspaceRoute);
  const selectedApp = activePanel ? state.apps.find((app) => app.id === activePanel.appId) ?? null : null;
  const resetWorkspaceLaunch = useCallback(
    (options: { clearOptimisticRoute?: boolean; error?: string } = {}) => {
      pendingWorkspaceRoute.current = null;
      setWorkspace(null);
      if (options.clearOptimisticRoute) {
        setOptimisticWorkspaceRoute(null);
      }
      if (options.error) {
        setState((current) => ({ ...current, error: options.error ?? null }));
      }
      setBusyAction((current) => current?.endsWith(":open") ? null : current);
    },
    [],
  );

  useEffect(() => {
    if (!state.session?.authenticated || canManageApps || shellRoute.workspace || !shellViewRequiresAdmin(shellRoute.view)) {
      return;
    }

    router.replace(getShellViewHref("available-apps"));
  }, [canManageApps, router, shellRoute.view, shellRoute.workspace, state.session?.authenticated]);

  useEffect(() => {
    if (normalizedRoutePath === "/workspace" && !shellRoute.workspace) {
      router.replace(getShellViewHref("available-apps"));
    }
  }, [normalizedRoutePath, router, shellRoute.workspace]);

  useEffect(() => {
    const routeWorkspace = activeWorkspaceRoute;
    if (!routeWorkspace) {
      const browserPath = typeof window === "undefined" ? normalizedRoutePath : normalizeShellPath(window.location.pathname);
      if (browserPath === "/workspace" || browserPath.startsWith("/system-apps/") || pendingWorkspaceRoute.current) {
        return;
      }

      resetWorkspaceLaunch({ clearOptimisticRoute: Boolean(optimisticWorkspaceRoute) });
      return;
    }

    if (state.loading || !state.session?.authenticated) {
      return;
    }

    // Navigation hiding is not the boundary (Core enforces host.admin server-side), but a non-admin
    // landing on a /system-apps deep link gets a clean redirect instead of a launch-code failure.
    if (routeWorkspace.system && !canManageApps) {
      resetWorkspaceLaunch();
      router.replace(getShellViewHref("available-apps"));
      return;
    }

    const app = state.apps.find((candidate) => candidate.id === routeWorkspace.appId);
    if (!app) {
      resetWorkspaceLaunch({ error: `App '${routeWorkspace.appId}' is not installed or not visible to this user.` });
      return;
    }

    if (routeWorkspace.system && !app.system) {
      resetWorkspaceLaunch({ error: `App '${app.displayName}' is not a system app. Open it from the Apps section.` });
      return;
    }

    if (app.id === shellAppId) {
      resetWorkspaceLaunch();
      router.replace(getShellViewHref(canManageApps ? "dashboard" : "available-apps"));
      return;
    }

    // Canonicalize a legacy /workspace?app=<system-app-id> link onto /system-apps/<id>. After the
    // replace the route re-parses with the system flag set, so this cannot loop. Placed after the
    // Shell self-open special case so hosty.shell keeps its direct dashboard redirect.
    if (!routeWorkspace.system && app.system) {
      resetWorkspaceLaunch();
      router.replace(getSystemAppHref(app.id, routeWorkspace.path));
      return;
    }

    if (app.runtimeState !== "running") {
      resetWorkspaceLaunch({
        error: app.system
          ? `System app '${app.displayName}' is ${app.runtimeState || app.operationStatus}. Manage it from Installed Apps.`
          : "App must be running before it can be opened.",
      });
      return;
    }

    const page = findAppPageLink(app, routeWorkspace.path);
    if (!page) {
      resetWorkspaceLaunch({ error: `App '${app.displayName}' does not expose '${routeWorkspace.path}'.` });
      return;
    }

    const routePath = normalizeAppPath(page.path);
    if (workspace?.appId === app.id && workspace.path === routePath) {
      pendingWorkspaceRoute.current = null;
      setBusyAction((current) => current === `${app.id}:open` ? null : current);
      return;
    }

    const routeKey = getWorkspaceRouteKey({ appId: app.id, path: routePath });
    if (pendingWorkspaceRoute.current === routeKey) {
      return;
    }

    const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
    if (workspace?.appId === app.id) {
      pendingWorkspaceRoute.current = null;
      setBusyAction((current) => current?.endsWith(":open") ? null : current);
      setState((current) => ({ ...current, error: null }));
      setWorkspace({
        appId: app.id,
        title: app.displayName,
        pageLabel: page.label,
        path: routePath,
        src: themedRedirectUri,
        externalUrl: getStandaloneAppHref(app, page),
      });
      return;
    }

    let cancelled = false;
    const workspaceApp = app;
    const workspacePage = page;
    pendingWorkspaceRoute.current = routeKey;
    setBusyAction(`${app.id}:open`);
    setState((current) => ({ ...current, error: null }));

    async function openWorkspace() {
      try {
        const response = await sendCsrfJson(appEndpoint(workspaceApp, "/launch-code"), { redirectUri: themedRedirectUri });
        const launch = (await response.json()) as AppLaunchResponse;
        if (cancelled) {
          return;
        }

        setWorkspace({
          appId: workspaceApp.id,
          title: workspaceApp.displayName,
          pageLabel: workspacePage.label,
          path: routePath,
          src: launch.redirectUri,
          externalUrl: launch.redirectUri,
        });
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unable to create app launch link.";
        setWorkspace(null);
        setState((current) => ({ ...current, error: message }));
        toast.error("App launch failed", { description: message });
      } finally {
        if (!cancelled) {
          pendingWorkspaceRoute.current = null;
          setBusyAction((current) => (current === `${workspaceApp.id}:open` ? null : current));
        }
      }
    }

    void openWorkspace();

    return () => {
      cancelled = true;
      if (pendingWorkspaceRoute.current === routeKey) {
        pendingWorkspaceRoute.current = null;
      }
    };
  }, [
    activeWorkspaceRoute,
    appEndpoint,
    canManageApps,
    getStandaloneAppHref,
    normalizedRoutePath,
    optimisticWorkspaceRoute,
    resetWorkspaceLaunch,
    router,
    sendCsrfJson,
    shellAppId,
    shellResolvedTheme,
    shellThemePreference,
    state.apps,
    state.loading,
    state.session?.authenticated,
    workspace,
    workspaceRouteKey,
  ]);

  function setCompact(compact: boolean) {
    setSidebarCompact(compact);
    window.localStorage.setItem(SIDEBAR_COMPACT_STORAGE_KEY, String(compact));
  }

  const openInstallDialog = useCallback((manifestPath?: string) => {
    installRequestRef.current += 1;
    setInstallFeedIntent(null);
    setInstallInitialManifest(typeof manifestPath === "string" ? manifestPath : null);
    setInstallNonce((nonce) => nonce + 1);
    setInstallOpen(true);
    setInstallPanel(emptyInstallPanelState());
  }, []);

  const openFeedInstallDialog = useCallback(
    (intent: InstallFeedIntent) => {
      if (!canManageApps) {
        toast.error("Administrator access is required to install apps.");
        return;
      }

      installRequestRef.current += 1;
      setInstallInitialManifest(null);
      setInstallFeedIntent(intent);
      setInstallNonce((nonce) => nonce + 1);
      setInstallOpen(true);
      setInstallPanel(emptyInstallPanelState());
    },
    [canManageApps],
  );

  const handleAuthRequired = useCallback(
    (appId: string) => {
      const current = workspace;
      if (!current || current.appId !== appId) {
        return;
      }

      const app = state.apps.find((candidate) => candidate.id === appId);
      if (!app || app.runtimeState !== "running") {
        return;
      }

      // Loop guard: a frame that keeps re-posting (e.g. it never accepts the new code) must not
      // drive an unbounded reissue storm. One reissue per app per interval is plenty for recovery.
      const now = Date.now();
      const last = authReissueAtRef.current.get(appId) ?? 0;
      if (now - last < AUTH_REISSUE_MIN_INTERVAL_MS) {
        return;
      }
      authReissueAtRef.current.set(appId, now);

      void (async () => {
        try {
          // Reuse the current frame URL as the redirect target, minus the spent code, so theme and
          // page params are preserved and Core appends a fresh code.
          const base = new URL(current.src);
          base.searchParams.delete("code");
          const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: base.toString() });
          const launch = (await response.json()) as AppLaunchResponse;
          const stillCurrent = workspace;
          if (!stillCurrent || stillCurrent.appId !== appId || stillCurrent.path !== current.path) {
            return;
          }

          setWorkspace({ ...stillCurrent, src: launch.redirectUri, externalUrl: launch.redirectUri });
        } catch (error) {
          if (isAuthRequiredRedirectError(error)) {
            return;
          }
          // A failed reissue leaves the app's own fallback UI in place; do not surface a toast for a
          // background recovery attempt the user did not explicitly trigger.
        }
      })();
    },
    [workspace, state.apps, sendCsrfJson, appEndpoint],
  );

  const closeInstallDialog = useCallback(() => {
    installRequestRef.current += 1;
    setInstallOpen(false);
  }, []);

  const openInstalledApps = useCallback(() => {
    setOptimisticWorkspaceRoute(null);
    router.push(getShellViewHref("installed-apps"));
  }, [router]);

  const shellStateContextValue = useMemo(
    () => ({
      state,
      runtimeApps,
      systemApps,
      uiRuntimeApps,
      uiSystemApps,
      activeUser,
      canManageApps: Boolean(canManageApps),
      busyAction,
      updateStatusInvalidations,
    }),
    [
      activeUser,
      busyAction,
      canManageApps,
      state,
      runtimeApps,
      systemApps,
      uiRuntimeApps,
      uiSystemApps,
      updateStatusInvalidations,
    ],
  );

  const shellActionsContextValue = useMemo(
    () => ({
      coreOrigin,
      shellAppId,
      refresh,
      sendCsrfJson,
      launchAppPage,
      getStandaloneAppHref,
      openInstallDialog,
      runAppAction,
      switchAppRuntime,
      configureAppDevelopmentMode,
      createManualBackup,
      openAppPanel,
      openInstalledApps,
      openSharedMounts,
    }),
    [
      configureAppDevelopmentMode,
      coreOrigin,
      createManualBackup,
      getStandaloneAppHref,
      launchAppPage,
      openAppPanel,
      openInstalledApps,
      openInstallDialog,
      openSharedMounts,
      refresh,
      runAppAction,
      sendCsrfJson,
      shellAppId,
      switchAppRuntime,
    ],
  );

  return (
    <ShellActionsContext.Provider value={shellActionsContextValue}>
      <ShellStateContext.Provider value={shellStateContextValue}>
      <div
        className={cn(
          "grid min-h-dvh bg-muted/30 transition-[grid-template-columns] duration-200",
          sidebarCompact ? "grid-cols-[72px_minmax(0,1fr)]" : "grid-cols-[280px_minmax(0,1fr)]",
        )}
      >
        <aside className="sticky top-0 z-30 h-dvh overflow-visible border-r bg-sidebar text-sidebar-foreground">
          <ShellSidebar
            compact={sidebarCompact}
            activeView={effectiveView}
            workspace={workspace}
            coreOrigin={coreOrigin}
            coreOnline={state.status !== null}
            coreVersion={state.status?.version ?? null}
            activeUser={activeUser}
            canManageApps={Boolean(canManageApps)}
            runtimeApps={uiRuntimeApps}
            systemApps={uiSystemApps}
            busyAction={busyAction}
            onCompactChange={setCompact}
            onNavigate={(view) => {
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getShellViewHref(view));
            }}
            onLaunchApp={launchAppPage}
            getStandaloneHref={getStandaloneAppHref}
            onOpenPlatform={canManageApps ? openPlatform : undefined}
          />
        </aside>

        <div className={cn("h-dvh min-w-0", workspaceSurfaceActive ? "overflow-hidden bg-background" : "overflow-y-auto")}>
          <main className={cn("w-full", workspaceSurfaceActive ? "h-full" : "mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8")}>
            {workspace ? (
              <EmbeddedWorkspacePanel
                workspace={workspace}
                theme={shellResolvedTheme}
                themePreference={shellThemePreference}
                // Only the Marketplace frame may hand Shell an install intent; every other embedded
                // app gets no handler, so its messages are never listened for.
                onInstallFeedIntent={appMayRequestFeedInstall(workspace.appId) ? openFeedInstallDialog : undefined}
                onAuthRequired={handleAuthRequired}
              />
            ) : activeWorkspaceRoute ? (
              <EmbeddedWorkspacePendingPanel
                error={state.error}
              />
            ) : (
              <>
                {state.error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {state.error}
                  </div>
                )}

                {state.status?.warnings?.length ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                    {state.status.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                ) : null}

                {state.loading && !state.status ? (
                  <EmptyState icon={LoaderCircle} title="Loading Core state" description="Waiting for Core status and current session." iconClassName="animate-spin" />
                ) : (
                  children
                )}
              </>
            )}
          </main>
        </div>

        <InstallReviewDialog
          key={`${installNonce}:${installInitialManifest ?? installFeedIntent?.feedsUrl ?? "manual"}`}
          opened={installOpen}
          initialManifestPath={installInitialManifest ?? ""}
          initialFeedIntent={installFeedIntent}
          detail={installPanel}
          busyAction={busyAction}
          onClose={closeInstallDialog}
          onReview={loadInstallPlan}
          onReviewFeed={loadFeedInstallPlan}
          onApply={applyInstall}
        />

        {selectedApp && activePanel && (
          <AppDetailsDialog
            app={selectedApp}
            view={activePanel.view}
            settingsTab={activePanel.settingsTab}
            coreOrigin={coreOrigin}
            globalMounts={globalMounts}
            canManageApps={Boolean(canManageApps)}
            busyAction={busyAction}
            detail={detailPanel}
            onClose={closeAppPanel}
            onRefreshBackups={loadAppBackups}
            onCreateBackup={createManualBackup}
            onRestoreBackup={restoreBackup}
            onDeleteBackup={deleteBackup}
            onPreviewBackupCleanup={previewBackupCleanup}
            onApplyBackupCleanup={applyBackupCleanup}
            onConfigure={configureApp}
            onConfigureMounts={configureMounts}
            onConfigureSource={configureAppSource}
            onClearSource={clearAppSource}
            onSetDevelopmentMode={configureAppDevelopmentMode}
            onApplyUpdate={applyUpdate}
            onSetFeed={setAppFeed}
            onRemove={removeApp}
          />
        )}

        <PlatformDialog
          open={platformOpen}
          coreVersion={state.status?.version ?? null}
          shellVersion={shellVersion}
          state={platformState}
          loading={platformLoading}
          error={platformError}
          settings={coreSettings}
          settingsError={coreSettingsError}
          onSaveSettings={saveCoreSettings}
          onToggle={togglePlatformApp}
          onClose={() => setPlatformOpen(false)}
        />

        <SharedMountsDialog
          open={sharedMountsOpen}
          globalMounts={globalMounts}
          canManageApps={Boolean(canManageApps)}
          onClose={() => setSharedMountsOpen(false)}
          onSave={saveGlobalMount}
          onDelete={deleteGlobalMount}
        />
      </div>
      </ShellStateContext.Provider>
    </ShellActionsContext.Provider>
  );
}
