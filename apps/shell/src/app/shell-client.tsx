"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { findAppPageLink, getAppPageLinks } from "./shell/app-helpers";
import { CoreRequestError, isAuthRequiredRedirectError, readCoreError, readCoreErrorDetail, redirectToCoreLogin, redirectToCoreLoginIfAuthRequired } from "./shell/core-api";
import { createReissueRateLimiter } from "@hosty-sdk/app/embedder";
import { CoreEventNames, subscribeToCoreEvents } from "./shell/events/core-event-stream";
import { AppDetailsDialog } from "./shell/dialogs/app-details-dialog";
import { InstallReviewDialog } from "./shell/dialogs/install-review-dialog";
import { AssistantPanel } from "./shell/assistant/assistant-panel";
import { findAssistantGateway } from "./shell/assistant/assistant-client";
import { ShellSidebar } from "./shell/sidebar/shell-sidebar";
import { ShellTopStrip } from "./shell/chrome/shell-top-strip";
import { ShellRightPanel } from "./shell/surfaces/shell-right-panel";
import { getAppPanelTabs, getAppSettingsTabs, resolveActiveSurfaceTab } from "./shell/surfaces/app-surface-tabs";
import { ShellActionsContext, ShellStateContext } from "./shell/shell-context";
import {
  getAuthorizedShellView,
  getShellViewHref,
  getWorkspaceHref,
  getWorkspaceRouteKey,
  normalizeAppPath,
  normalizeShellPath,
  readCanonicalRedirect,
  readShellRoute,
  SIDEBAR_COMPACT_STORAGE_KEY,
  RIGHT_PANEL_OPEN_STORAGE_KEY,
  SHELL_VIEW_LABELS,
  shellViewRequiresAdmin,
} from "./shell/shell-routes";
import { emptyDetailPanelState, emptyInstallPanelState } from "./shell/state";
import { appendHostyLaunchParam } from "./shell/launch";
import { appendHostyThemeParams, normalizeThemePreference, resolveShellTheme } from "./shell/theme";
import { EmptyState } from "./shell/ui";
import { EmbeddedWorkspacePanel } from "./shell/workspace/embedded-workspace-panel";
import { EmbeddedWorkspacePendingPanel } from "./shell/workspace/embedded-workspace-pending-panel";
import { appMayRequestFeedInstall, type InstallFeedIntent } from "./shell/workspace/install-intent";
import {
  appMayReceiveDelegatedToken,
  createDelegatedTokenCache,
  type DelegatedTokenCache,
  type DelegatedTokenGrant,
} from "./shell/workspace/delegated-token-intent";
import type {
  ActivePanel,
  AppAction,
  AppLaunchResponse,
  AppOpenTarget,
  AppPageLink,
  AppPendingUpdatePlanResponse,
  AppsResponse,
  BackupsResponse,
  CoreApp,
  CoreAppLifecycleResult,
  CoreBackup,
  CoreBackupCleanupApplyResponse,
  CoreBackupCleanupPlan,
  CoreSettingsState,
  CoreGlobalMount,
  CoreFeedInstallPlan,
  CoreInstallPlan,
  CoreRemovalImpact,
  CoreRuntimeSwitchPlan,
  CoreStatus,
  CoreUpdatePlan,
  CoreUpdateStatus,
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
// re-posting hosty:auth-required. Enforced by the SDK's per-app rate limiter.
const AUTH_REISSUE_MIN_INTERVAL_MS = 3_000;

// Polls this page's own document URL until the restarted Shell answers again. Used after a Shell
// self-update: the already-loaded bundle keeps working against Core while the Shell container
// swaps, but the new build only reaches the browser via a reload — which must wait until the new
// Shell is actually up. Resolves false on timeout so the caller keeps the old page alive instead
// of reloading into a connection error.
async function waitForOwnOrigin(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Per-probe timeout so a single hung request (connection accepted but no response mid-restart)
    // cannot stall past the overall deadline, which is only re-checked between probes.
    const controller = new AbortController();
    const probeTimeout = setTimeout(() => controller.abort(), 5_000);
    try {
      // Probe the exact document URL, not "/", so the check stays correct when the Shell is served
      // under a subpath (reverse proxy / Next basePath).
      const response = await fetch(window.location.href, { method: "HEAD", cache: "no-store", signal: controller.signal });
      if (response.ok) {
        return true;
      }
    } catch {
      // Shell still restarting (connection refused) or the probe timed out; keep polling.
    } finally {
      clearTimeout(probeTimeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return false;
}

export function ShellClient({
  coreOrigin,
  shellAppId,
  children,
}: {
  coreOrigin: string;
  shellAppId: string;
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
  const [coreSettings, setCoreSettings] = useState<CoreSettingsState | null>(null);
  const [coreSettingsError, setCoreSettingsError] = useState<string | null>(null);
  const [coreUpdate, setCoreUpdate] = useState<CoreUpdateStatus | null>(null);
  const [coreUpdating, setCoreUpdating] = useState(false);
  // Tracks the post-update re-probe timer so it can be cancelled on unmount / re-trigger.
  const coreUpdateProbeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Applying an update / switching runtime resets Core's artifact locks, so the cached update-status
  // owned by the Installed Apps page goes stale (it would keep showing "Update available"). We can't
  // reach into that page's state from here, so we bump a per-app counter it watches to re-probe.
  const [updateStatusInvalidations, setUpdateStatusInvalidations] = useState<Record<string, number>>({});
  const [workspace, setWorkspace] = useState<EmbeddedWorkspace | null>(null);
  const [optimisticWorkspaceRoute, setOptimisticWorkspaceRoute] = useState<WorkspaceRoute | null>(null);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  // Which panel tab was last chosen. A key rather than an index: an app being stopped or removed
  // reorders the strip, and an index would then point at somebody else's tool.
  const [activePanelKey, setActivePanelKey] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // Structured page context ("app", "page") the contextual entry points seed a session with.
  const [assistantContext, setAssistantContext] = useState<Record<string, string> | null>(null);
  // Survives panel close so reopening reattaches to the still-running session instead of
  // orphaning it; a contextual entry always starts fresh (its context belongs to a new session).
  const [assistantSessionId, setAssistantSessionId] = useState<string | null>(null);
  const activeWorkspaceRoute = shellRoute.workspace ?? optimisticWorkspaceRoute;
  const workspaceRouteKey = getWorkspaceRouteKey(activeWorkspaceRoute);
  const pendingWorkspaceRoute = useRef<string | null>(null);
  // Stale async resolutions must not overwrite newer shared state, so each load takes a token.
  const refreshRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const installRequestRef = useRef(0);
  // Last launch-code reissue per app id, so a chatty frame cannot storm Core with reissues.
  const authReissueLimiter = useRef(createReissueRateLimiter(AUTH_REISSUE_MIN_INTERVAL_MS));
  // Core CSRF is a cookie/header pair, so token refresh + mutation must stay ordered.
  const csrfOperationQueue = useRef<Promise<void>>(Promise.resolve());
  const shellThemePreference = normalizeThemePreference(theme);
  const shellResolvedTheme = resolveShellTheme(resolvedTheme);
  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";
  // The assistant surface exists only for admins and only when an installed app declares the
  // ai-gateway interface (docs/features/ai-gateway/plan.md): no provider ⇒ no launcher, no panel.
  const assistantGateway = useMemo(() => findAssistantGateway(state.apps), [state.apps]);
  const assistantAvailable = Boolean(canManageApps && assistantGateway);
  const openAssistant = useCallback((context: Record<string, string> | null = null) => {
    setAssistantContext(context);
    if (context) {
      setAssistantSessionId(null);
    }
    setAssistantOpen(true);
  }, []);

  useEffect(() => {
    setSidebarCompact(window.localStorage.getItem(SIDEBAR_COMPACT_STORAGE_KEY) === "true");
    setRightPanelOpen(window.localStorage.getItem(RIGHT_PANEL_OPEN_STORAGE_KEY) === "true");
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
        // The cast above cannot catch a Core that answers without an `apps` field, and every
        // consumer of state.apps assumes an array — normalize once here rather than in each page.
        apps: apps.apps ?? [],
        session,
        updatedAt: new Date().toISOString(),
        updateCheck: apps.updateCheck ?? null,
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

  // Light re-read of just the apps list, for Core's event stream. Everything a domain event can
  // change lives on this one response; re-running the full refresh would turn every hint into four
  // requests and flip `loading`, making the list flicker on someone else's action.
  const refreshApps = useCallback(async () => {
    const requestToken = refreshRequestRef.current;
    const response = await fetch(`${coreOrigin}/api/apps`, { credentials: "include" });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) {
      return;
    }

    const apps = (await response.json()) as AppsResponse;
    // A full refresh started meanwhile owns the state; its response is the fresher one.
    if (requestToken !== refreshRequestRef.current) {
      return;
    }

    setState((current) =>
      current.session?.authenticated
        ? {
            ...current,
            apps: apps.apps ?? [],
            updateCheck: apps.updateCheck ?? null,
            updatedAt: new Date().toISOString(),
          }
        : current,
    );
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
          // A CoreRequestError is still an ordinary Error carrying the same message, so every caller that
          // only shows `err.message` is unaffected; the ones that need to branch read `code`/`body`.
          const detail = await readCoreErrorDetail(response);
          throw new CoreRequestError(detail.message, detail.code, response.status, detail.body);
        }

        return response;
      } finally {
        releaseOperation();
      }
    },
    [coreOrigin, loadCsrfToken],
  );

  const mintDelegatedToken = useCallback(
    async (appId: string): Promise<DelegatedTokenGrant> => {
      // sendCsrfJson already throws on non-2xx; this guards the shape so a drifted Core response
      // can never seed the cache with undefined fields.
      const response = await sendCsrfJson(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/delegated-token`);
      const issued = (await response.json().catch(() => null)) as {
        token?: unknown;
        expiresAt?: unknown;
      } | null;
      if (typeof issued?.token !== "string" || typeof issued.expiresAt !== "string") {
        throw new Error("Core returned an unexpected delegated-token response.");
      }

      return { token: issued.token, expiresAt: issued.expiresAt };
    },
    [coreOrigin, sendCsrfJson],
  );

  // Delegated tokens Shell mints for an embedded app. The reuse window, the forced re-mint after a
  // 401, and the session-change invalidation live in the cache rather than here: they are decisions
  // about handing over a credential, and they are covered by their own tests. Built once and reached
  // through a ref so a rebuilt mint callback is what actually runs.
  const mintDelegatedTokenRef = useRef(mintDelegatedToken);
  useEffect(() => {
    mintDelegatedTokenRef.current = mintDelegatedToken;
  }, [mintDelegatedToken]);
  const delegatedTokens = useRef<DelegatedTokenCache | null>(null);
  if (!delegatedTokens.current) {
    delegatedTokens.current = createDelegatedTokenCache((appId) => mintDelegatedTokenRef.current(appId));
  }

  const issueDelegatedToken = useCallback(
    (appId: string, refresh = false): Promise<DelegatedTokenGrant> =>
      delegatedTokens.current!.issue(appId, refresh),
    [],
  );

  // A token names the user it was minted for, so a session change must not leave one reusable —
  // including a mint that is still in flight and would otherwise resolve into the cleared cache.
  const activeUserId = activeUser?.id ?? null;
  useEffect(() => {
    delegatedTokens.current?.invalidateAll();
  }, [activeUserId]);

  // Best-effort Core update-available probe (admin-only endpoint). A failure clears the badge rather
  // than leaving a stale "Update available" showing (auth expiry, Core mid-restart, transient error),
  // and never breaks the shell load. Pass force to bypass Core's TTL cache (e.g. right after a hotfix
  // release) so the operator never has to drop to the CLI to re-check. An optional AbortSignal lets a
  // superseding call / unmount cancel the in-flight request without touching state.
  const loadCoreUpdateStatus = useCallback(async (force = false, signal?: AbortSignal) => {
    try {
      const url = `${coreOrigin}/api/core/update-status${force ? "?refresh=true" : ""}`;
      const response = await fetch(url, { credentials: "include", signal });
      setCoreUpdate(response.ok ? ((await response.json()) as CoreUpdateStatus) : null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      setCoreUpdate(null);
    }
  }, [coreOrigin]);

  const updateCore = useCallback(async () => {
    if (coreUpdating) {
      return;
    }

    if (!window.confirm("Update Core now? Core restarts on the new version; running apps keep running.")) {
      return;
    }

    setCoreUpdating(true);
    try {
      // Fire-and-forget on Core's side: it spawns `hosty update` detached and restarts. Give Core time to
      // self-update and come back, then re-probe — the badge clears itself when the new binary matches.
      await sendCsrfJson(`${coreOrigin}/api/core/update`, {});
      if (coreUpdateProbeTimer.current !== null) {
        clearTimeout(coreUpdateProbeTimer.current);
      }
      coreUpdateProbeTimer.current = setTimeout(() => {
        coreUpdateProbeTimer.current = null;
        setCoreUpdating(false);
        void loadCoreUpdateStatus(true);
      }, 20000);
    } catch (error) {
      if (!isAuthRequiredRedirectError(error)) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Could not start the Core update.",
        }));
      }
      setCoreUpdating(false);
    }
  }, [coreOrigin, coreUpdating, loadCoreUpdateStatus, sendCsrfJson]);

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
            ? `System app '${app.displayName}' is ${app.runtimeState || app.operationStatus}. Manage it from Dashboard.`
            : "App must be running before it can be opened.",
        }));
        return;
      }

      if (target === "tab") {
        window.open(getStandaloneAppHref(app, page), "_blank", "noreferrer");
        return;
      }

      const routePath = normalizeAppPath(page.path);
      const embeddedRedirectUri = appendHostyLaunchParam(
        appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference),
      );
      // One workspace route for every app. A system app used to get its own admin-gated path; the
      // gate it expressed is Core's, not the client's.
      const workspaceHref = getWorkspaceHref(app.id, routePath);
      const nextWorkspaceRoute: WorkspaceRoute = { appId: app.id, path: routePath };
      setState((current) => ({ ...current, error: null }));
      setOptimisticWorkspaceRoute(nextWorkspaceRoute);
      if (workspace?.appId === app.id) {
        setWorkspace({
          appId: app.id,
          title: app.displayName,
          pageLabel: page.label,
          path: routePath,
          src: embeddedRedirectUri,
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
        const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: embeddedRedirectUri });
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
          // The standalone href, never the frame's own URL: that one declares the embedded mode,
          // and a new tab opened on it would be an app hiding the navigation nothing else renders.
          externalUrl: getStandaloneAppHref(app, page),
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

  // Probe for a newer Core once we know the session is an admin (the endpoint is admin-only). Core
  // TTL-caches the result, so this stays cheap across reloads. Aborts the in-flight probe on unmount /
  // dependency change so a late response can't overwrite fresher state.
  useEffect(() => {
    if (!canManageApps) {
      return;
    }

    const controller = new AbortController();
    void loadCoreUpdateStatus(false, controller.signal);
    return () => controller.abort();
  }, [canManageApps, loadCoreUpdateStatus]);

  // Live app state, replacing the old poll-while-update-work-is-in-flight interval: Core commits and
  // update-check verdicts now arrive as hints on the shared event stream, and the reaction is always
  // to re-read the list. Admin-gated because Core fans domain events out to admin sessions only —
  // a non-admin would hold a subscription that never fires (the launcher list still refreshes on
  // navigation and on demand).
  useEffect(() => {
    if (!state.session?.authenticated || !canManageApps) {
      return;
    }

    return subscribeToCoreEvents(coreOrigin, {
      names: [
        CoreEventNames.appChanged,
        CoreEventNames.appRemoved,
        CoreEventNames.appUpdateCheckChanged,
        CoreEventNames.fleetUpdateCheckChanged,
      ],
      onSync: refreshApps,
    });
  }, [canManageApps, coreOrigin, refreshApps, state.session?.authenticated]);

  // Cancel a pending post-update re-probe timer when the shell unmounts.
  useEffect(
    () => () => {
      if (coreUpdateProbeTimer.current !== null) {
        clearTimeout(coreUpdateProbeTimer.current);
      }
    },
    [],
  );

  const runAppAction = useCallback(
    async (app: CoreApp, action: AppAction) => {
      // Stopping or restarting the Shell acts on the app serving this very UI. The already-loaded
      // page keeps working against Core either way (its Start button included), but new page loads
      // fail while the Shell is down — name the blast radius and get an explicit go-ahead first.
      if (app.id === shellAppId && (action === "stop" || action === "restart")) {
        const confirmed = window.confirm(
          action === "stop"
            ? "Stop the Shell? Loading this UI in a new tab or reload will fail until it is started again — from this already-open page, `hosty apps start`, or a Core restart."
            : "Restart the Shell? This page reloads once the Shell answers again.",
        );
        if (!confirmed) {
          return;
        }
      }

      const actionKey = `${app.id}:${action}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const endpoint = action === "backup" ? appEndpoint(app, "/backups") : appEndpoint(app, `/${action}`);
        await sendCsrfJson(endpoint, action === "backup" ? { reason: "manual" } : {});

        // Shell self-restart: as with a self-update, the old bundle keeps working against Core, but
        // reconnect the browser to the fresh Shell once it answers instead of leaving a page whose
        // next navigation would land on a half-restarted server.
        if (app.id === shellAppId && action === "restart") {
          toast.success("Shell restarting", { description: "Waiting for the Shell, then reloading this page…" });
          void refresh();
          if (await waitForOwnOrigin()) {
            window.location.reload();
          } else {
            toast.warning("Shell is not answering yet", {
              description: "Keep this tab open and reload manually once the Shell is reachable again.",
            });
          }
          return;
        }

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
    [appEndpoint, refresh, sendCsrfJson, shellAppId],
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
    async (app: CoreApp, manifestPath?: string, options?: { rebuild?: boolean }) => {
      const requestToken = ++detailRequestRef.current;
      setActivePanel({ appId: app.id, view: "update" });
      setDetailPanel({ loading: true, error: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const source = manifestPath?.trim();
        let payload: CoreUpdatePlan | null = null;
        // The fleet check (or an earlier dialog open) usually left a fresh plan cached on Core —
        // render it instantly instead of rebuilding. An explicit source, or a caller that knows the
        // cached plan is stale (a feed change), skips the cache and rebuilds.
        if (!source && !options?.rebuild) {
          const pending = await fetch(appEndpoint(app, "/update/plan"), { credentials: "include" });
          redirectToCoreLoginIfAuthRequired(pending, coreOrigin);
          if (pending.ok) {
            payload = ((await pending.json()) as AppPendingUpdatePlanResponse).plan;
          }
        }

        if (!payload) {
          // Plan routes require the CSRF header like their apply twins (C-M9); sendCsrfJson attaches it.
          const response = await sendCsrfJson(appEndpoint(app, "/update/plan"), { manifestPath: source ? source : null });
          payload = (await response.json()) as CoreUpdatePlan;
        }

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
    [appEndpoint, coreOrigin, sendCsrfJson],
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
        // The cached pending plan was built against the previous feed — force a rebuild.
        void loadUpdatePlan(app, undefined, { rebuild: true });
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

  const revealAppSetting = useCallback(
    async (app: CoreApp, key: string) => {
      // On-demand only: the app summaries never carry a secret's value, so this is the single path
      // that does, gated on the admin session server-side.
      const response = await fetch(appEndpoint(app, `/settings/${encodeURIComponent(key)}/value`), { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      const payload = (await response.json()) as { key: string; value: string | null };
      return payload.value;
    },
    [appEndpoint, coreOrigin],
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

  // Core's own settings, loaded when the Settings page shows the Core tab. This used to be an
  // on-open dialog fetch; the trigger moved to the route, but the "load fresh each time" behavior is
  // deliberately kept — the values are live-applied and another admin may have changed them.
  const loadCoreSettings = useCallback(async () => {
    setCoreSettingsError(null);
    setCoreSettings(null);

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
  }, [coreOrigin]);

  const saveCoreSettings = useCallback(
    async (values: Record<string, string>) => {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/settings`, { settings: values }, "PUT");
      setCoreSettings((await response.json()) as CoreSettingsState);
      setCoreSettingsError(null);
      toast.success("Core settings saved");
    },
    [coreOrigin, sendCsrfJson],
  );

  // Enqueues the update on Core (plan-first updates): the request returns as soon as the apply is
  // accepted, progress lives on the record (operationStatus "updating" drives the row spinner via
  // the update-work poll), and the outcome arrives as a record flip plus a host-admin notification.
  // A rejected enqueue (the plan moved, expired, was consumed, or an apply is already running)
  // answers with an actionable error — surface it and refresh so the row's affordance corrects
  // itself instead of resending a dead digest.
  const enqueueUpdate = useCallback(
    async (app: CoreApp, planDigest: string) => {
      const actionKey = `${app.id}:update`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/update"), { planDigest });
        // Close this app's dialog if it is the one open; another app's panel is left alone.
        setActivePanel((current) => (current?.appId === app.id ? null : current));

        // Shell self-update: the apply now runs detached on Core, so it survives this page going
        // away. Wait for the new Shell to answer on our own origin, then reload so the browser
        // loads the new assets. On timeout keep the (still functional) old page alive.
        if (app.id === shellAppId) {
          toast.success("Shell update started", { description: "Waiting for the new Shell, then reloading this page…" });
          void refresh();
          if (await waitForOwnOrigin()) {
            window.location.reload();
          } else {
            toast.warning("Shell is not answering yet", {
              description: "Keep this tab open and reload manually once the Shell is reachable again.",
            });
          }
          return;
        }

        toast.success("Update started", { description: app.displayName });
        await refresh();
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        toast.error("Update not started", {
          description: error instanceof Error ? error.message : "The update could not be started.",
        });
        // The verdict or pending plan may have moved — refresh so the row renders current reality.
        void refresh();
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, refresh, sendCsrfJson, shellAppId],
  );

  const applyUpdate = useCallback(
    async (app: CoreApp, plan: CoreUpdatePlan) => {
      await enqueueUpdate(app, plan.planDigest);
    },
    [enqueueUpdate],
  );

  // Row one-click apply from the fleet-check verdict: the cached pending plan is applied by digest,
  // no dialog involved. Only offered for routine verdicts (the page gates on requiresReview).
  const applyUpdateFromRow = useCallback(
    async (app: CoreApp) => {
      const planDigest = app.updateCheck?.planDigest;
      if (!planDigest) {
        return;
      }

      await enqueueUpdate(app, planDigest);
    },
    [enqueueUpdate],
  );

  // Starts (or joins) the Core fleet update check; progress is server state on the apps list, so the
  // spinner survives reloads and shows for every admin, not just the one who clicked.
  const startUpdateCheck = useCallback(async () => {
    try {
      await sendCsrfJson(`${coreOrigin}/api/apps/update-check`, {});
      await refresh();
    } catch (error) {
      if (isAuthRequiredRedirectError(error)) {
        return;
      }

      toast.error("Update check failed to start", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }, [coreOrigin, refresh, sendCsrfJson]);

  // Applies every routine verdict in one action; review-class updates are left for a human and
  // counted in the summary. Shell's own app goes last: its apply restarts the Shell serving this
  // page, so every other enqueue must already be accepted by then (enqueueUpdate then owns the
  // wait-for-new-Shell reload).
  const updateAllApps = useCallback(async () => {
    const routine = state.apps.filter(
      (app) =>
        app.updateCheck?.updateAvailable === true &&
        app.updateCheck.requiresReview !== true &&
        Boolean(app.updateCheck.planDigest) &&
        app.operationStatus !== "updating",
    );
    const reviewCount = state.apps.filter(
      (app) => app.updateCheck?.updateAvailable === true && app.updateCheck.requiresReview === true,
    ).length;
    const reviewNote = reviewCount > 0 ? `${reviewCount} update${reviewCount === 1 ? "" : "s"} need review.` : undefined;
    if (routine.length === 0) {
      toast.info("No routine updates to apply", { description: reviewNote });
      return;
    }

    const shellApp = routine.find((app) => app.id === shellAppId);
    let started = 0;
    let failed = 0;
    for (const app of routine.filter((candidate) => candidate.id !== shellAppId)) {
      try {
        await sendCsrfJson(appEndpoint(app, "/update"), { planDigest: app.updateCheck!.planDigest });
        started += 1;
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        failed += 1;
      }
    }

    // Count only what actually got accepted; the Shell's own enqueue runs after this and reports
    // through enqueueUpdate's dedicated toast (or its error path), never pre-counted here. A batch
    // where nothing started is a warning, not a "0 updates started" success.
    const failedNote = failed > 0 ? `${failed} could not be started.` : undefined;
    const notes = [reviewNote, failedNote, shellApp ? "The Shell updates last." : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
    if (started > 0) {
      toast.success(`${started} update${started === 1 ? "" : "s"} started`, { description: notes });
    } else if (failed > 0) {
      toast.warning("No updates could be started", { description: notes });
    }
    await refresh();
    if (shellApp?.updateCheck?.planDigest) {
      await enqueueUpdate(shellApp, shellApp.updateCheck.planDigest);
    }
  }, [appEndpoint, enqueueUpdate, refresh, sendCsrfJson, shellAppId, state.apps]);

  // Advisory preview for the remove panel: what else declares a dependency on this app and who
  // consumes the platform capabilities it provides. A failure here degrades to "no impact shown"
  // rather than blocking the removal — Core never gates on it either.
  const loadRemovalImpact = useCallback(
    async (appId: string): Promise<CoreRemovalImpact | null> => {
      const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/remove-impact`, {
        credentials: "include",
      });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      return (await response.json()) as CoreRemovalImpact;
    },
    [coreOrigin],
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
            // Core installs exactly the manifest bytes this plan was built from; without the id the
            // install is rejected (install_plan_required).
            planId: plan.planId,
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

  // Every app with a UI, ordinary and system together, minus the Shell itself. Core decides who sees
  // a system app at all, so no client-side split is needed; the Shell is excluded because opening it
  // inside itself resolves back to Dashboard, and a row that cannot lead anywhere is worse than no
  // row.
  const uiApps = useMemo(
    () => state.apps.filter((app) => app.id !== shellAppId && getAppPageLinks(app).length > 0),
    [shellAppId, state.apps],
  );
  const effectiveView = getAuthorizedShellView(shellRoute.view, Boolean(canManageApps), shellRoute.settingsTab);
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

  // A path that still resolves but is no longer canonical — /installed-apps, /users, and the
  // /system-apps/<id> deep link — renders its new surface immediately and rewrites the URL. The
  // replacement is always a different path, so this cannot loop.
  useEffect(() => {
    const canonical = readCanonicalRedirect(normalizedRoutePath, searchParams ?? new URLSearchParams());
    if (canonical) {
      router.replace(canonical);
    }
  }, [normalizedRoutePath, router, searchParams]);

  // Core settings load when a tab that renders them is shown, rather than with the page. Two tabs do:
  // Core and Ingress split one settings payload by the group Core tags each item with.
  useEffect(() => {
    const rendersCoreSettings = shellRoute.settingsTab === "core" || shellRoute.settingsTab === "ingress";
    if (!canManageApps || shellRoute.view !== "settings" || !rendersCoreSettings) {
      return;
    }

    void loadCoreSettings();
  }, [canManageApps, loadCoreSettings, shellRoute.settingsTab, shellRoute.view]);

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

    // A system app is not special-cased here any more. Core answers a launch code for one only to an
    // administrator (`system_app_admin_required`) and omits it from `GET /api/apps` for everyone
    // else, so a non-admin reaching this point simply does not find the app below.
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
      resetWorkspaceLaunch({
        error: app.system
          ? `System app '${app.displayName}' is ${app.runtimeState || app.operationStatus}. Manage it from Dashboard.`
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

    const embeddedRedirectUri = appendHostyLaunchParam(
      appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference),
    );
    if (workspace?.appId === app.id) {
      pendingWorkspaceRoute.current = null;
      setBusyAction((current) => current?.endsWith(":open") ? null : current);
      setState((current) => ({ ...current, error: null }));
      setWorkspace({
        appId: app.id,
        title: app.displayName,
        pageLabel: page.label,
        path: routePath,
        src: embeddedRedirectUri,
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
        const response = await sendCsrfJson(appEndpoint(workspaceApp, "/launch-code"), { redirectUri: embeddedRedirectUri });
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
          externalUrl: getStandaloneAppHref(workspaceApp, workspacePage),
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

  function setPanelOpen(open: boolean) {
    setRightPanelOpen(open);
    window.localStorage.setItem(RIGHT_PANEL_OPEN_STORAGE_KEY, String(open));
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
      if (!authReissueLimiter.current.tryAcquire(appId)) {
        return;
      }

      void (async () => {
        try {
          // Reuse the current frame URL as the redirect target, minus the spent code, so the theme,
          // launch-mode and page params are preserved and Core appends a fresh code.
          const base = new URL(current.src);
          base.searchParams.delete("code");
          const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: base.toString() });
          const launch = (await response.json()) as AppLaunchResponse;
          const stillCurrent = workspace;
          if (!stillCurrent || stillCurrent.appId !== appId || stillCurrent.path !== current.path) {
            return;
          }

          // Only the frame moves. The standalone href is unaffected by a reissue, and the frame's
          // own URL is not a substitute for it: it declares the embedded mode.
          setWorkspace({ ...stillCurrent, src: launch.redirectUri });
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

  // Which embedded frame Shell will answer with a delegated token: the assistant gateway's own
  // pages, and nothing else. Shell already mints tokens for that app whenever the chat panel is
  // open, so its settings page gains no reach it did not have — whereas answering every frame would
  // hand a user-scoped credential to whatever the operator happened to install.
  const handleDelegatedTokenRequest = useMemo(() => {
    const gatewayAppId = assistantGateway?.appId;
    if (!gatewayAppId || !appMayReceiveDelegatedToken(workspace?.appId, gatewayAppId)) {
      return undefined;
    }

    return (refresh: boolean) => issueDelegatedToken(gatewayAppId, refresh);
  }, [assistantGateway?.appId, workspace?.appId, issueDelegatedToken]);

  const closeInstallDialog = useCallback(() => {
    installRequestRef.current += 1;
    setInstallOpen(false);
  }, []);

  // Apps that declared a settings surface, as Settings tabs. Core resolved the URL, so a stopped
  // app arrives with none — the tab still exists and says so.
  const appSettingsTabs = useMemo(() => getAppSettingsTabs(state.apps), [state.apps]);
  const appPanelTabs = useMemo(() => getAppPanelTabs(state.apps), [state.apps]);

  // The rail exists only while something declares a panel; opening it is then the operator's choice.
  const rightPanelVisible = appPanelTabs.length > 0 && rightPanelOpen;
  const activePanelTab = useMemo(
    () => resolveActiveSurfaceTab(appPanelTabs, activePanelKey),
    [appPanelTabs, activePanelKey],
  );

  // What the strip names: the app whose page fills the content area, or the Shell page itself.
  const stripTitle = workspace?.title ?? SHELL_VIEW_LABELS[effectiveView] ?? "Hosty";
  const stripSubtitle = workspace?.pageLabel ?? null;

  // Passes through the existing rule rather than restating it: only an app that already qualifies is
  // answered, in this context as in the workspace.
  const requestDelegatedTokenFor = useCallback(
    (appId: string) =>
      appMayReceiveDelegatedToken(appId, assistantGateway?.appId)
        ? (refresh: boolean) => issueDelegatedToken(appId, refresh)
        : undefined,
    [assistantGateway?.appId, issueDelegatedToken],
  );

  // Mints a launch code for a placed surface and returns the URL to embed, so the frame lands with a
  // real Hosty app session rather than as an anonymous visitor to the app's origin.
  //
  // Takes the resolved surface URL rather than a surface kind: Core already resolved it, and a
  // function that branched on "settings or panel" would have to be edited for every surface added
  // later. One opener serves every placed surface.
  const openSurfaceFrame = useCallback(
    async (appId: string, embeddedUrl: string) => {
      const app = state.apps.find((candidate) => candidate.id === appId);
      if (!app) {
        throw new Error("This app is no longer installed.");
      }

      const redirectUri = appendHostyLaunchParam(
        appendHostyThemeParams(embeddedUrl, shellResolvedTheme, shellThemePreference),
      );
      const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri });
      const launch = (await response.json()) as AppLaunchResponse;
      return launch.redirectUri;
    },
    [appEndpoint, sendCsrfJson, shellResolvedTheme, shellThemePreference, state.apps],
  );

  const startAppById = useCallback(
    (appId: string) => {
      const app = state.apps.find((candidate) => candidate.id === appId);
      if (app) {
        void runAppAction(app, "start");
      }
    },
    [state.apps, runAppAction],
  );

  const shellStateContextValue = useMemo(
    () => ({
      state,
      uiApps,
      activeUser,
      canManageApps: Boolean(canManageApps),
      busyAction,
      updateStatusInvalidations,
      settingsTab: shellRoute.settingsTab,
      appSettingsTabs,
      shellTheme: shellResolvedTheme,
      shellThemePreference,
      coreSettings,
      coreSettingsError,
      globalMounts,
      coreUpdate,
      coreUpdating,
    }),
    [
      activeUser,
      appSettingsTabs,
      busyAction,
      canManageApps,
      shellResolvedTheme,
      shellThemePreference,
      coreSettings,
      coreSettingsError,
      coreUpdate,
      coreUpdating,
      globalMounts,
      shellRoute.settingsTab,
      state,
      uiApps,
      updateStatusInvalidations,
    ],
  );

  const shellActionsContextValue = useMemo(
    () => ({
      coreOrigin,
      shellAppId,
      refresh,
      sendCsrfJson,
      onEmbeddedAuthRequired: handleAuthRequired,
      requestDelegatedTokenFor,
      openSurfaceFrame,
      startAppById,
      launchAppPage,
      getStandaloneAppHref,
      openInstallDialog,
      runAppAction,
      switchAppRuntime,
      configureAppDevelopmentMode,
      createManualBackup,
      openAppPanel,
      applyUpdateFromRow,
      startUpdateCheck,
      updateAllApps,
      saveCoreSettings,
      saveGlobalMount,
      deleteGlobalMount,
      updateCore,
    }),
    [
      handleAuthRequired,
      requestDelegatedTokenFor,
      openSurfaceFrame,
      startAppById,
      updateCore,
      applyUpdateFromRow,
      configureAppDevelopmentMode,
      coreOrigin,
      createManualBackup,
      deleteGlobalMount,
      getStandaloneAppHref,
      launchAppPage,
      openAppPanel,
      openInstallDialog,
      refresh,
      runAppAction,
      saveCoreSettings,
      saveGlobalMount,
      sendCsrfJson,
      shellAppId,
      startUpdateCheck,
      updateAllApps,
      switchAppRuntime,
    ],
  );

  return (
    <ShellActionsContext.Provider value={shellActionsContextValue}>
      <ShellStateContext.Provider value={shellStateContextValue}>
      <div className="flex h-dvh flex-col bg-muted/30">
        <ShellTopStrip
          title={stripTitle}
          subtitle={stripSubtitle}
          leftRailExpanded={!sidebarCompact}
          onToggleLeftRail={() => setCompact(!sidebarCompact)}
          // Null while no installed app declares a panel surface: there is no rail to toggle, and a
          // control for chrome that does not exist is worse than no control.
          rightRailExpanded={appPanelTabs.length > 0 ? rightPanelOpen : null}
          onToggleRightRail={() => setPanelOpen(!rightPanelOpen)}
          showNotifications={Boolean(activeUser)}
        />

      <div
        className={cn(
          "grid min-h-0 flex-1 transition-[grid-template-columns] duration-200",
          rightPanelVisible
            ? sidebarCompact
              ? "grid-cols-[72px_minmax(0,1fr)_360px]"
              : "grid-cols-[280px_minmax(0,1fr)_360px]"
            : sidebarCompact
              ? "grid-cols-[72px_minmax(0,1fr)]"
              : "grid-cols-[280px_minmax(0,1fr)]",
        )}
      >
        <aside className="z-30 h-full overflow-visible border-r bg-sidebar text-sidebar-foreground">
          <ShellSidebar
            compact={sidebarCompact}
            activeView={effectiveView}
            workspace={workspace}
            coreOrigin={coreOrigin}
            activeUser={activeUser}
            canManageApps={Boolean(canManageApps)}
            uiApps={uiApps}
            busyAction={busyAction}
            onNavigate={(view) => {
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getShellViewHref(view));
            }}
            onOpenApps={() => {
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getShellViewHref("available-apps"));
            }}
            onLaunchApp={launchAppPage}
            getStandaloneHref={getStandaloneAppHref}
            onOpenAssistant={assistantAvailable ? () => openAssistant(null) : undefined}
          />
        </aside>

        <div className={cn("h-full min-w-0", workspaceSurfaceActive ? "overflow-hidden bg-background" : "overflow-y-auto")}>
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
                onDelegatedTokenRequest={handleDelegatedTokenRequest}
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

        {rightPanelVisible && (
          <ShellRightPanel
            tabs={appPanelTabs}
            activeTab={activePanelTab}
            theme={shellResolvedTheme}
            themePreference={shellThemePreference}
            onSelectTab={setActivePanelKey}
            onCollapse={() => setPanelOpen(false)}
            onAuthRequired={handleAuthRequired}
            resolveDelegatedTokenRequest={requestDelegatedTokenFor}
            onOpenSurfaceFrame={openSurfaceFrame}
            onStartApp={startAppById}
          />
        )}
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
            isShell={selectedApp.id === shellAppId}
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
            onLoadRemovalImpact={loadRemovalImpact}
            onRevealSetting={revealAppSetting}
            onAskAssistant={assistantAvailable
              ? () => openAssistant({ app: selectedApp.id, page: activePanel.view })
              : undefined}
          />
        )}

        {assistantOpen && assistantAvailable && assistantGateway && (
          <AssistantPanel
            gateway={assistantGateway}
            coreOrigin={coreOrigin}
            context={assistantContext}
            sessionId={assistantSessionId}
            onSessionId={setAssistantSessionId}
            onClose={() => setAssistantOpen(false)}
            sendCsrfJson={sendCsrfJson}
          />
        )}

      </div>
      </ShellStateContext.Provider>
    </ShellActionsContext.Provider>
  );
}
