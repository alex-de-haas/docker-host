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
import { SharedMountsDialog } from "./shell/dialogs/shared-mounts-dialog";
import { ShellSidebar } from "./shell/sidebar/shell-sidebar";
import { ShellActionsContext, ShellStateContext } from "./shell/shell-context";
import {
  getAuthorizedShellView,
  getShellViewHref,
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
  CoreGlobalMount,
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
  const [installPanel, setInstallPanel] = useState<InstallPanelState>(emptyInstallPanelState);
  const [globalMounts, setGlobalMounts] = useState<CoreGlobalMount[]>([]);
  const [sharedMountsOpen, setSharedMountsOpen] = useState(false);
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
        setState((current) => ({ ...current, error: "App must be running before it can be opened." }));
        return;
      }

      if (target === "tab") {
        window.open(getStandaloneAppHref(app, page), "_blank", "noreferrer");
        return;
      }

      const routePath = normalizeAppPath(page.path);
      const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
      const workspaceHref = getWorkspaceHref(app.id, routePath);
      const nextWorkspaceRoute = { appId: app.id, path: routePath };
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
        if (
          normalizeShellPath(currentUrl.pathname) !== "/workspace" ||
          currentUrl.searchParams.get("app") !== app.id ||
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
        const planResponse = await fetch(appEndpoint(app, "/switch-runtime/plan"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetRuntime }),
        });
        redirectToCoreLoginIfAuthRequired(planResponse, coreOrigin);
        if (!planResponse.ok) {
          throw new Error(await readCoreError(planResponse));
        }

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
    [appEndpoint, coreOrigin, invalidateUpdateStatus, refresh, sendCsrfJson],
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
        const response = await fetch(appEndpoint(app, "/update/plan"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifestPath: source ? source : null }),
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

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
    [appEndpoint, coreOrigin],
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
    async (app: CoreApp, options: RemoveOptions) => {
      if (!window.confirm(`Remove ${app.displayName}?`)) {
        return;
      }

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
      setInstallPanel((current) => ({ loading: true, error: null, plan: current.plan }));
      try {
        const response = await fetch(`${coreOrigin}/api/apps/install/plan`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifestPath,
            selectedRuntime: selectedRuntime?.trim() || null,
            system: false,
          }),
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const plan = (await response.json()) as CoreInstallPlan;
        setInstallPanel({ loading: false, error: null, plan });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setInstallPanel({
          loading: false,
          error: error instanceof Error ? error.message : "Install review is unavailable.",
          plan: null,
        });
      }
    },
    [coreOrigin],
  );

  const applyInstall = useCallback(
    async (plan: CoreInstallPlan, settings: Record<string, string | null>, autostart: boolean) => {
      setBusyAction("install");
      try {
        await sendCsrfJson(`${coreOrigin}/api/apps/install`, {
          manifestPath: plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
          system: false,
          settings,
          autostart,
        });
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
    [coreOrigin, refresh, sendCsrfJson],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const systemApps = useMemo(() => state.apps.filter((app) => app.system), [state.apps]);
  // The Observability section reads from the telemetry backend system app; show it only when that app
  // is installed and running (its Metrics/Structured logs/Traces have nothing to show otherwise).
  const observabilityAvailable = useMemo(
    () => state.apps.some((app) => app.id === "hosty.telemetry" && app.runtimeState === "running"),
    [state.apps],
  );
  const uiRuntimeApps = useMemo(() => runtimeApps.filter((app) => getAppPageLinks(app).length > 0), [runtimeApps]);
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
      if (browserPath === "/workspace" || pendingWorkspaceRoute.current) {
        return;
      }

      resetWorkspaceLaunch({ clearOptimisticRoute: Boolean(optimisticWorkspaceRoute) });
      return;
    }

    if (state.loading || !state.session?.authenticated) {
      return;
    }

    const app = state.apps.find((candidate) => candidate.id === routeWorkspace.appId);
    if (!app) {
      resetWorkspaceLaunch({ error: `App '${routeWorkspace.appId}' is not installed or not visible to this user.` });
      return;
    }

    if (app.id === shellAppId) {
      resetWorkspaceLaunch();
      router.replace(getShellViewHref(canManageApps ? "dashboard" : "available-apps"));
      return;
    }

    if (app.runtimeState !== "running") {
      resetWorkspaceLaunch({ error: "App must be running before it can be opened." });
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

  const openInstallDialog = useCallback(() => {
    setInstallOpen(true);
    setInstallPanel(emptyInstallPanelState());
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
      activeUser,
      canManageApps: Boolean(canManageApps),
      observabilityAvailable,
      busyAction,
      updateStatusInvalidations,
    }),
    [
      activeUser,
      busyAction,
      canManageApps,
      observabilityAvailable,
      state,
      runtimeApps,
      systemApps,
      uiRuntimeApps,
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
            shellVersion={shellVersion}
            activeUser={activeUser}
            canManageApps={Boolean(canManageApps)}
            observabilityAvailable={observabilityAvailable}
            runtimeApps={uiRuntimeApps}
            busyAction={busyAction}
            onCompactChange={setCompact}
            onNavigate={(view) => {
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getShellViewHref(view));
            }}
            onLaunchApp={launchAppPage}
            getStandaloneHref={getStandaloneAppHref}
          />
        </aside>

        <div className={cn("h-dvh min-w-0", workspaceSurfaceActive ? "overflow-hidden bg-background" : "overflow-y-auto")}>
          <main className={cn("w-full", workspaceSurfaceActive ? "h-full" : "mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8")}>
            {workspace ? (
              <EmbeddedWorkspacePanel
                workspace={workspace}
                theme={shellResolvedTheme}
                themePreference={shellThemePreference}
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
          opened={installOpen}
          detail={installPanel}
          busyAction={busyAction}
          onClose={() => setInstallOpen(false)}
          onReview={loadInstallPlan}
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
            onRemove={removeApp}
          />
        )}

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
