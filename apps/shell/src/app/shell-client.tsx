"use client";


import { fetchCore } from "./shell/core-transport.js";


import { waitForShellUpdateToSettle } from "./shell/self-update";
import { isAppUp } from "./shell/runtime-states";
import { isRoutineUpdate } from "./shell/update-feedback";
import { useAppUpdateNotifications } from "./shell/update-notifications";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { toast, AssistantFeedbackContext, errorReportText, type ErrorReport } from "@/components/reui/operation-toast";
import { useConfirmation } from "@/components/reui/confirmation";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { appSupportsReviewedUpdate, findAppPageLink, getAppPageLinks } from "./shell/app-helpers";
import { CoreRequestError, isAuthRequiredRedirectError, readCoreError, readCoreErrorDetail, redirectToCoreLogin, redirectToCoreLoginIfAuthRequired } from "./shell/core-api";
import { appendThemeLaunchParams, createReissueRateLimiter } from "@hosty-sdk/app/embedder";
import { CoreEventNames, subscribeToCoreEvents } from "./shell/events/core-event-stream";
import { resolveLaunchGate } from "./shell/surfaces/app-surface-tabs";
import { enqueueRoutineUpdate, isStaleUpdatePreparation, prepareAppUpdate, requestAppUpdate, reviewUpdatesInOrder } from "./shell/app-updates";
import { requestAppRemoval, requestCoreApproval } from "./shell/app-removal";
import { readCoreStatus, reconcileCoreUpdate } from "./shell/core-status";
import { reconcileAppList } from "./shell/app-list-snapshot";
import { AppDetailsDialog } from "./shell/dialogs/app-details-dialog";
import { SourceInstallDialog } from "./shell/dialogs/private-source-connections";
import { createInstallationClient, openInstallationConfirmation, type InstallationSource } from "@hosty-sdk/app/install";
import { showCoreConfirmation } from "./shell/core-confirmation";
import { useAssistantSelection } from "./shell/assistant/use-assistant-selection";
import { assistantMessageFor, assistantSupportsContext, createAppSession, createErrorSession, createHandoff, pendingAssistantIntent, assistantOpenUrl } from "./shell/assistant/assistant-client";
import { ShellSidebar } from "./shell/sidebar/shell-sidebar";
import { ShellTopStrip } from "./shell/chrome/shell-top-strip";
import { activatePanel } from "./shell/surfaces/panel-rail-state";
import { ShellRightPanel } from "./shell/surfaces/shell-right-panel";
import { ShellWorkspaceSplit } from "./shell/chrome/shell-workspace-split";
import { getAppPanelTabs, getAppSettingsTabs, resolveSettingsSurface, resolveActiveSurfaceTab } from "./shell/surfaces/app-surface-tabs";
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
  SIDEBAR_COMPACT_PREF_KEY,
  RIGHT_PANEL_OPEN_PREF_KEY,
  SHELL_VIEW_LABELS,
  getHostSettingsSection,
  getSettingsHref,
  readAssistantSessionParam,
  getShellAuthorizationRedirect,
} from "./shell/shell-routes";
import { emptyDetailPanelState } from "./shell/state";
import { appendHostyLaunchParam } from "./shell/launch";
import { normalizeThemePreference, resolveShellTheme } from "./shell/theme";
import { EmptyState } from "./shell/ui";
import { EmbeddedWorkspacePanel } from "./shell/workspace/embedded-workspace-panel";
import { EmbeddedWorkspacePendingPanel } from "./shell/workspace/embedded-workspace-pending-panel";
import type {
  ActivePanel,
  AppAction,
  AppOpenTarget,
  AppPageLink,
  AppPendingUpdatePlanResponse,
  AppsResponse,
  BackupsResponse,
  CoreApp,
  CoreBackup,
  CoreBackupCleanupApplyResponse,
  CoreBackupCleanupPlan,
  CoreSettingsState,
  CoreGlobalMount,
  CoreRemovalImpact,
  CoreRuntimeSwitchPlan,
  CoreStatus,
  CoreUpdatePlan,
  CoreUpdateStatus,
  DetailPanelState,
  DetailView,
  EmbeddedWorkspace,
  MountBindingInput,
  LoadState,
  OpenPanelOptions,
  RemoveOptions,
  SessionResponse,
  WorkspaceRoute,
} from "./shell/types";

/** Per app. A human clicking rows never reaches this; a loop is stopped by it. */
const ASK_MIN_INTERVAL_MS = 1_000;

// Polls this page's own document URL until Shell answers again. Its Core proxy is unavailable while
// the Shell process swaps, but this loaded bundle can wait locally. The new build only reaches
// the browser via a reload — which must wait until Shell is actually listening. Resolves
// false on timeout so the caller keeps the old page alive instead of reloading into a connection
// error.
//
// This answers "is a server accepting connections again", never "is the update done": the old Shell
// answers exactly the same way. After a self-update it is reached only once Core's record says the
// apply settled (waitForShellUpdateToSettle). A self-restart normally drops its own proxy connection:
// probing then recovers the page without claiming the lost request succeeded or replaying it.
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

// Chrome preferences live in cookies, not localStorage, so the server can read them and render the
// first paint already expanded/collapsed — see the pref-key constants in shell-routes.ts. Not
// Secure: the Shell also serves over plain http (localhost, LAN), and the value is a layout bit.
function persistChromePref(name: string, value: boolean) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function ShellClient({
  coreOrigin,
  shellAppId,
  // Chrome preferences as the server read them from cookies, so the first paint is already in the
  // stored state. null = no cookie: the mount effect then migrates the legacy localStorage value.
  initialSidebarCompact,
  initialRightPanelOpen,
  initialRightPanelWidth,
  children,
}: {
  coreOrigin: string;
  shellAppId: string;
  initialSidebarCompact: boolean | null;
  initialRightPanelOpen: boolean | null;
  initialRightPanelWidth: number;
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
  const [state, setState] = useState<LoadState & { appsReadId?: number }>({
    loading: true,
    error: null,
    status: null,
    apps: [],
    session: null,
    updatedAt: null,
  });
  const { confirm, dialog: confirmationDialog } = useConfirmation(pathname ?? "");
  const lastGlobalError = useRef<string | null>(null);
  const lastWarnings = useRef(new Set<string>());
  useEffect(() => {
    if (state.error && state.error !== lastGlobalError.current) {
      toast.error("Shell could not complete the request", { description: state.error, id: "shell-request-error" });
    }
    lastGlobalError.current = state.error;
  }, [state.error]);
  useEffect(() => {
    const warnings = new Set(state.status?.warnings ?? []);
    for (const warning of warnings) {
      if (!lastWarnings.current.has(warning)) toast.warning("Host needs attention", { description: warning, duration: 12_000 });
    }
    lastWarnings.current = warnings;
  }, [state.status?.warnings]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const openUpdateLogs = useCallback((app: CoreApp) => setActivePanel({ appId: app.id, view: "logs" }), []);
  useAppUpdateNotifications(state.apps, openUpdateLogs);
  const [detailPanel, setDetailPanel] = useState<DetailPanelState>(emptyDetailPanelState);
  const [installOpen, setInstallOpen] = useState(false);
  const [installConfirmationWindow, setInstallConfirmationWindow] = useState<Window | null>(null);
  const [installInitialManifest, setInstallInitialManifest] = useState<string | null>(null);
  // Bumped on every openInstallDialog and folded into the dialog's key, so each open remounts a fresh
  // instance. The manifest alone is not enough: reopening the same manifestRef would keep the key,
  // skip the mount-only auto-review, and (with the panel state wiped on open) render an empty dialog.
  const updateActivations = useRef(new Set<string>());
  const installActivation = useRef(false);
  const [installNonce, setInstallNonce] = useState(0);
  const [globalMounts, setGlobalMounts] = useState<CoreGlobalMount[]>([]);
  const [coreSettings, setCoreSettings] = useState<CoreSettingsState | null>(null);
  const [coreSettingsError, setCoreSettingsError] = useState<string | null>(null);
  const [coreUpdate, setCoreUpdate] = useState<CoreUpdateStatus | null>(null);
  const [coreUpdating, setCoreUpdating] = useState(false);
  // Tracks the post-update re-probe timer so it can be cancelled on unmount / re-trigger.
  const coreUpdateProbeGeneration = useRef(0);
  const coreUpdateProbeAbort = useRef<AbortController | null>(null);
  const coreUpdateProbeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Applying an update / switching runtime resets Core's artifact locks, so the cached update-status
  // owned by the Installed Apps page goes stale (it would keep showing "Update available"). We can't
  // reach into that page's state from here, so we bump a per-app counter it watches to re-probe.
  const [updateStatusInvalidations, setUpdateStatusInvalidations] = useState<Record<string, number>>({});
  const [workspace, setWorkspace] = useState<EmbeddedWorkspace | null>(null);
  const [optimisticWorkspaceRoute, setOptimisticWorkspaceRoute] = useState<WorkspaceRoute | null>(null);
  const [sidebarCompact, setSidebarCompact] = useState(initialSidebarCompact ?? false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const effectiveSidebarCompact = narrowViewport ? !mobileSidebarOpen : sidebarCompact;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const syncViewport = () => {
      setNarrowViewport(media.matches);
      setMobileSidebarOpen(false);
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [mobileSidebarOpen]);
  const [rightPanelOpen, setRightPanelOpen] = useState(initialRightPanelOpen ?? false);
  // Gates the chrome grid's column transition. Off during the initial settle: the right panel
  // column can only appear once /api/apps names a panel-capable app, and animating that data
  // arrival reads as the panel opening by itself on load.
  const [chromeTransitions, setChromeTransitions] = useState(false);
  // Which panel tab was last chosen. A key rather than an index: an app being stopped or removed
  // reorders the strip, and an index would then point at somebody else's tool.
  const [activePanelKey, setActivePanelKey] = useState<string | null>(null);
  // Bumped when a placed surface reports its session expired; the shared hook re-mints on the change.
  const surfaceAuthNonce = 0;
  // appId → sessions waiting for the operator, as the panel's own page reports it. Shell never asks:
  // the page holding the sessions is the one source, and a poll here would disagree with it.
  const [panelAttention, setPanelAttention] = useState<Record<string, number>>({});
  // What Shell last asked the assistant panel, as a message for its frame. The nonce is the ask:
  // the same text twice is two asks, and the panel must see both.
  const [assistantAsk, setAssistantAsk] = useState<{ userId: string | null; appId: string; message: unknown; nonce: number } | null>(null);
  const activeWorkspaceRoute = shellRoute.workspace ?? optimisticWorkspaceRoute;
  const workspaceRouteKey = getWorkspaceRouteKey(activeWorkspaceRoute);
  const pendingWorkspaceRoute = useRef<string | null>(null);
  // Stale async resolutions must not overwrite newer shared state, so each load takes a token.
  const refreshRequestRef = useRef(0);
  const appsReadSequence = useRef(0);
  const detailRequestRef = useRef(0);
  // An ask is cheap for the app and expensive for the operator: it reveals the rail, switches the
  // tab and moves focus. A mounted app looping on it would make Shell unusable while looking like a
  // supported use of the contract, so it is rate-limited per app exactly as reissues are. One a
  // second is far more than a human clicking rows produces, and far less than a loop needs.
  const askLimiter = useRef(createReissueRateLimiter(ASK_MIN_INTERVAL_MS));
  // Core CSRF is a cookie/header pair, so token refresh + mutation must stay ordered.
  const csrfOperationQueue = useRef<Promise<void>>(Promise.resolve());
  const shellThemePreference = normalizeThemePreference(theme);
  const shellResolvedTheme = resolveShellTheme(resolvedTheme);
  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";
  // Shell entry points use the client preference; confirmed roles gate discovery and token handshakes.
  const { assistants, selected: assistantGateway, selectedId: assistantSelection, select: selectAssistant, choose: chooseAssistant, picker: assistantPicker } =
    useAssistantSelection(state.apps, activeUser ? `${coreOrigin}:${activeUser.id}` : null);
  const assistantIds = useMemo(() => assistants.map(app => app.appId), [assistants]);
  const assistantPermission = state.apps.find(app => app.id === shellAppId)?.grantedCorePermissions?.includes("providers.assistant") === true;
  const assistantAvailable = Boolean(canManageApps && assistants.length && assistantPermission);

  // Migration only: with a cookie present the server already rendered the stored state and this
  // does nothing. Without one (pre-cookie builds), the legacy localStorage value is adopted and
  // re-persisted as the cookie — a one-time post-mount correction instead of one on every load.
  useEffect(() => {
    if (initialSidebarCompact === null) {
      const compact = window.localStorage.getItem(SIDEBAR_COMPACT_PREF_KEY) === "true";
      setSidebarCompact(compact);
      persistChromePref(SIDEBAR_COMPACT_PREF_KEY, compact);
    }
    if (initialRightPanelOpen === null) {
      const open = window.localStorage.getItem(RIGHT_PANEL_OPEN_PREF_KEY) === "true";
      setRightPanelOpen(open);
      persistChromePref(RIGHT_PANEL_OPEN_PREF_KEY, open);
    }
  }, [initialSidebarCompact, initialRightPanelOpen]);

  // One frame after the first load settles (success or error — `loading` starts true and drops on
  // either), so the settled layout paints before transitions can animate; user toggles from then on
  // animate normally.
  useEffect(() => {
    if (chromeTransitions || state.loading) return;
    const frame = window.requestAnimationFrame(() => setChromeTransitions(true));
    return () => window.cancelAnimationFrame(frame);
  }, [chromeTransitions, state.loading]);

  const refresh = useCallback(async () => {
    const requestToken = ++refreshRequestRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [statusResponse, sessionResponse] = await Promise.all([
        fetchCore(`${coreOrigin}/api/core/status`, { credentials: "include" }),
        fetchCore(`${coreOrigin}/api/auth/session`, { credentials: "include" }),
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
      let appsReadId = 0;
      let nextGlobalMounts: CoreGlobalMount[] = [];
      if (session?.authenticated) {
        appsReadId = ++appsReadSequence.current;
        const appsResponse = await fetchCore(`${coreOrigin}/api/apps`, { credentials: "include", cache: "no-store" });
        redirectToCoreLoginIfAuthRequired(appsResponse, coreOrigin);
        if (!appsResponse.ok) {
          throw new Error(`Apps API returned ${appsResponse.status}.`);
        }

        apps = (await appsResponse.json()) as AppsResponse;

        // The shared-mounts library is admin-only; non-admins simply get an empty list (the picker
        // and Shared mounts button are gated to admins anyway).
        if (session.user?.role === "host.admin") {
          const mountsResponse = await fetchCore(`${coreOrigin}/api/global-mounts`, { credentials: "include" });
          if (mountsResponse.ok) {
            nextGlobalMounts = ((await mountsResponse.json()) as { mounts?: CoreGlobalMount[] }).mounts ?? [];
          }
        }
      }

      if (requestToken !== refreshRequestRef.current) {
        return;
      }

      setGlobalMounts(nextGlobalMounts);
      setState((current) => ({
        loading: false,
        error: null,
        status,
        session,
        updatedAt: new Date().toISOString(),
        // An app event can finish a newer list read while this refresh waits for global mounts.
        // Retain that list, but never carry a previous user's apps into a changed session.
        ...reconcileAppList(
          current.session?.user?.id === session.user?.id && current.session?.authenticated === session.authenticated
            ? current
            : { apps: [] },
          apps,
          appsReadId,
        ),
      }));
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
    const appsReadId = ++appsReadSequence.current;
    const response = await fetchCore(`${coreOrigin}/api/apps`, { credentials: "include", cache: "no-store" });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) {
      return;
    }

    const apps = (await response.json()) as AppsResponse;
    // A newer full refresh owns the session; do not apply a read from its predecessor.
    if (requestToken !== refreshRequestRef.current) {
      return;
    }

    setState((current) =>
      current.session?.authenticated
        ? {
            ...current,
            ...reconcileAppList(current, apps, appsReadId),
            updatedAt: new Date().toISOString(),
          }
        : current,
    );
  }, [coreOrigin]);

  const loadCsrfToken = useCallback(async () => {
    const response = await fetchCore(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
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
        const response = await (endpoint === "/api/assistant/handoff" ? fetch : fetchCore)(endpoint, {
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

  const activeUserId = activeUser?.id ?? null;

  // Keep the last successful availability through transient HTTP/network failures.
  const loadCoreUpdateStatus = useCallback(async (force = false, signal?: AbortSignal) => {
    try {
      const live = await readCoreStatus(coreOrigin, signal);
      if (!live || live.launch?.mode === "dev") { setCoreUpdate(null); return; }
      const url = `${coreOrigin}/api/core/update-status${force ? "?refresh=true" : ""}`;
      const response = await fetchCore(url, { credentials: "include", cache: "no-store", signal });
      if (!response.ok) throw new Error(`Core answered HTTP ${response.status}.`);
      const update = await response.json() as CoreUpdateStatus;
      if (!signal?.aborted) setCoreUpdate(previous => update.error && previous && previous.currentVersion === update.currentVersion && previous.releaseTag === update.releaseTag ? {
        ...previous, error: update.error, checkedAt: update.checkedAt,
        lastSuccessfulCheckAt: previous.lastSuccessfulCheckAt ?? (!previous.error ? previous.checkedAt : null),
      } : { ...update, clientPhase: previous?.clientPhase });
    } catch (error) {
      if (signal?.aborted) return;
      setCoreUpdate(previous => previous ? {
        ...previous,
        lastSuccessfulCheckAt: previous.lastSuccessfulCheckAt ?? (!previous.error ? previous.checkedAt : null),
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Could not check Core updates.",
      } : { currentVersion: "", updateAvailable: false, releaseTag: "", checkedAt: new Date().toISOString(), error: "Could not check Core updates." });
    }
  }, [coreOrigin]);

  // Update the installed version independently of app-list refreshes and update availability.
  const refreshCoreStatus = useCallback(async (signal?: AbortSignal) => {
    const status = await readCoreStatus(coreOrigin, signal);
    if (status && !signal?.aborted) {
      setState((current) => ({ ...current, status }));
    }
  }, [coreOrigin]);

  const updateCore = useCallback(async () => {
    if (coreUpdating) {
      return;
    }

    if (!await confirm({ title: "Update Core?", description: "Core restarts on the new version; running apps keep running.", action: "Update Core" })) {
      return;
    }

    setCoreUpdating(true);
    const generation = ++coreUpdateProbeGeneration.current;
    const initialVersion = state.status?.version;
    const startedAt = Date.now();
    const setPhase = (clientPhase: CoreUpdateStatus["clientPhase"]) => setCoreUpdate(previous => ({
      ...(previous ?? { currentVersion: initialVersion ?? "", updateAvailable: false, releaseTag: "", checkedAt: new Date().toISOString() }), clientPhase,
    }));
    setPhase("installing");
    try {
      await sendCsrfJson(`${coreOrigin}/api/core/update`, {});
      const probe = async () => {
        coreUpdateProbeTimer.current = null;
        if (coreUpdateProbeGeneration.current !== generation) return;
        const controller = new AbortController();
        coreUpdateProbeAbort.current = controller;
        const timeout = setTimeout(() => controller.abort(), 10000);
        let completed = false;
        try {
          const status = await readCoreStatus(coreOrigin, controller.signal);
          if (coreUpdateProbeGeneration.current !== generation) return;
          if (!status) setPhase("reconnecting");
          else {
            setState(current => ({ ...current, status }));
            const response = await fetchCore(`${coreOrigin}/api/core/update-status?refresh=true`, { credentials: "include", cache: "no-store", signal: controller.signal });
            if (response.ok) {
              const update = await response.json() as CoreUpdateStatus;
              if (coreUpdateProbeGeneration.current !== generation) return;
              completed = status.status === "running" && !update.error && !update.updateAvailable;
              setCoreUpdate({ ...update, clientPhase: completed ? "completed" : status.version !== initialVersion ? "verifying" : "installing" });
            }
          }
        } catch { /* A restart may interrupt either probe; the next attempt reads fresh state. */ }
        finally { clearTimeout(timeout); }
        if (coreUpdateProbeGeneration.current !== generation) return;
        if (completed) {
          setCoreUpdating(false);
          toast.success("Core updated");
          coreUpdateProbeTimer.current = setTimeout(() => {
            coreUpdateProbeTimer.current = null;
            setCoreUpdate(previous => previous ? { ...previous, clientPhase: undefined } : previous);
          }, 30000);
        } else if (Date.now() - startedAt >= 5 * 60_000) {
          setCoreUpdating(false);
          setPhase("unconfirmed");
          toast.warning("Core update could not be confirmed", { description: "Check Core logs and retry the status check." });
        } else coreUpdateProbeTimer.current = setTimeout(() => void probe(), 5000);
      };
      if (coreUpdateProbeTimer.current !== null) clearTimeout(coreUpdateProbeTimer.current);
      coreUpdateProbeTimer.current = setTimeout(() => void probe(), 2000);
    } catch (error) {
      if (!isAuthRequiredRedirectError(error)) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Could not start the Core update.",
        }));
      }
      setCoreUpdating(false);
      setPhase(undefined);
    }
  }, [confirm, coreOrigin, coreUpdating, state.status?.version, sendCsrfJson]);

  const appEndpoint = useCallback(
    (app: CoreApp, suffix: string) => `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}${suffix}`,
    [coreOrigin],
  );

  const getStandaloneAppHref = useCallback(
    (app: CoreApp, page: AppPageLink) => {
      const themedRedirectUri = appendThemeLaunchParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
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

      // Per service, not per app (app-readiness): a page whose service is alive opens through a
      // sibling's outage, and one whose service is still inside its readiness budget waits.
      const gate = resolveLaunchGate(app, page.service);
      if (!gate.up) {
        setState((current) => ({
          ...current,
          error: app.system
            ? `System app '${app.displayName}' is ${app.runtimeState || app.operationStatus}. Manage it from Dashboard.`
            : "App must be running before it can be opened.",
        }));
        return;
      }

      if (!gate.allowed) {
        setState((current) => ({ ...current, error: `${app.displayName} is starting — it opens when it answers.` }));
        return;
      }

      if (target === "tab") {
        window.open(getStandaloneAppHref(app, page), "_blank", "noreferrer");
        return;
      }

      const routePath = normalizeAppPath(page.path);
      const embeddedRedirectUri = appendHostyLaunchParam(
        appendThemeLaunchParams(page.redirectUri, shellResolvedTheme, shellThemePreference),
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
          src: embeddedRedirectUri,
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

  // A Core restart reconnects the shared stream. Re-read both installed status and availability
  // then, even if the update outlasted the 20-second fallback probe or ran outside this tab.
  // No domain event names: ordinary app changes must not trigger Core release-channel checks.
  useEffect(() => {
    if (!canManageApps) return;

    const controller = new AbortController();
    const unsubscribe = subscribeToCoreEvents(coreOrigin, {
      names: [],
      onSync: async () => {
        await Promise.all([
          refreshCoreStatus(controller.signal),
          loadCoreUpdateStatus(false, controller.signal),
        ]);
      },
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [canManageApps, coreOrigin, loadCoreUpdateStatus, refreshCoreStatus]);

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
      coreUpdateProbeGeneration.current++;
      coreUpdateProbeAbort.current?.abort();
      if (coreUpdateProbeTimer.current !== null) {
        clearTimeout(coreUpdateProbeTimer.current);
      }
    },
    [],
  );

  const runAppAction = useCallback(
    async (app: CoreApp, action: AppAction) => {
      // Stopping or restarting Shell also takes down the Core proxy serving this UI.
      if (app.id === shellAppId && (action === "stop" || action === "restart")) {
        const confirmed = await confirm({
          title: action === "stop" ? "Stop the Shell?" : "Restart the Shell?",
          action: action === "stop" ? "Stop Shell" : "Restart Shell", destructive: action === "stop",
          description: action === "stop"
            ? "Stop the Shell? This UI and its Core connection will be unavailable until Shell is started again with `hosty apps start hosty.shell` or through Core."
            : "Restart the Shell? This page reloads once the Shell answers again.",
        });
        if (!confirmed) {
          return;
        }
      }

      const actionKey = `${app.id}:${action}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const endpoint = action === "backup" ? appEndpoint(app, "/backups") : appEndpoint(app, `/${action}`);
        let restartResponseLost = false;
        try {
          await sendCsrfJson(endpoint, action === "backup" ? { reason: "manual" } : {});
        } catch (error) {
          // Core finishes an admitted restart even when stopping Shell kills this request's proxy.
          // Recover the page after transport loss; explicit Core refusals still surface normally.
          // Never resend: a missing response does not tell us whether Core accepted the operation.
          const connectionLost = error instanceof TypeError || (error instanceof CoreRequestError &&
            (error.code === "core_unavailable" || error.code === "core_request_timeout"));
          if (app.id !== shellAppId || action !== "restart" || !connectionLost) throw error;
          restartResponseLost = true;
        }

        if (app.id === shellAppId && action === "restart") {
          toast.info(restartResponseLost ? "Reconnecting to Shell" : "Shell restarting", {
            description: "Waiting for the Shell, then reloading this page…",
          });
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
        toast.error("App action failed", { description: message, appId: app.id });
        void refreshApps();
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [confirm, appEndpoint, refresh, refreshApps, sendCsrfJson, shellAppId],
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
        toast.error("Runtime switch failed", { description: message, appId: app.id });
        void refreshApps();
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [appEndpoint, invalidateUpdateStatus, refresh, refreshApps, sendCsrfJson],
  );

  const loadAppBackups = useCallback(
    async (app: CoreApp, activate = true) => {
      const requestToken = ++detailRequestRef.current;
      if (activate) {
        setActivePanel({ appId: app.id, view: "backups" });
      }
      setDetailPanel({ loading: true, error: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetchCore(appEndpoint(app, "/backups"), { credentials: "include" });
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

  const installationClient = useMemo(() => createInstallationClient({
    baseUrl: `${coreOrigin}/api/installations`, request: sendCsrfJson,
  }), [coreOrigin, sendCsrfJson]);

  const getUpdatePlan = useCallback(async (app: CoreApp, forceRefresh = false) => prepareAppUpdate(
    async () => {
      const response = await fetchCore(appEndpoint(app, "/update/plan"), { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) throw new Error(await readCoreError(response));
      return ((await response.json()) as AppPendingUpdatePlanResponse).plan;
    },
    async () => {
      const response = await sendCsrfJson(appEndpoint(app, "/update/plan"), {});
      return (await response.json()) as CoreUpdatePlan;
    }, forceRefresh,
  ), [appEndpoint, coreOrigin, sendCsrfJson]);

  const enqueueUpdate = useCallback(
    async (app: CoreApp, planDigest: string, popup = openInstallationConfirmation()) => {
      const actionKey = `${app.id}:update`;
      setBusyAction(actionKey);
      let submitted = false;
      try {
        const result = await requestAppUpdate(installationClient, app.id, planDigest, pending => {
          submitted = true;
          const dismissConfirmation = showCoreConfirmation(popup, pending);
          setActivePanel(current => current?.appId === app.id ? null : current);
          return dismissConfirmation;
        });
        if (result.status === "denied") {
          toast.info("Update cancelled", { description: app.displayName });
          return false;
        }
        // Core reports success after the apply and restart complete. A pending confirmation
        // must never trigger the old Shell's origin probe or reload.
        if (app.id === shellAppId) {
          const response = await fetchCore(`${coreOrigin}/api/apps`, { credentials: "include", cache: "no-store" });
          redirectToCoreLoginIfAuthRequired(response, coreOrigin);
          if (!response.ok) throw new Error(await readCoreError(response));
          const target = ((await response.json()) as AppsResponse).apps.find(item => item.id === app.id);
          if (target?.configurationReadiness?.required && target.runtimeState === "stopped") {
            toast.warning("Shell updated; configuration required", { description: "Configure it through local Core control before starting Shell again." });
            return true;
          }
          if (await waitForOwnOrigin()) window.location.reload();
          else toast.warning("Shell is not answering yet", {
            description: "Keep this tab open and reload manually once the Shell is reachable again.",
          });
          return true;
        }
        await refresh();
        return true;
      } catch (error) {
        if (!submitted && isStaleUpdatePreparation(error)) throw error;
        if (!submitted) popup?.close();
        if (!isAuthRequiredRedirectError(error)) {
          toast.error("Update not completed", {
            id: actionKey,
            appId: app.id,
            description: error instanceof Error ? error.message : "Check the update status in Core.",
          });
          void refresh();
        }
        return false;
      } finally {
        setBusyAction(current => current === actionKey ? null : current);
      }
    },
    [coreOrigin, refresh, shellAppId, installationClient],
  );

  const enqueueRoutine = useCallback(async (app: CoreApp, planDigest: string, propagateStale = false) => {
    const actionKey = `${app.id}:update`;
    setBusyAction(actionKey);
    let queued = false;
    try {
      await enqueueRoutineUpdate(sendCsrfJson, coreOrigin, app.id, planDigest);
      queued = true;
      setActivePanel(current => current?.appId === app.id ? null : current);
      toast.info("Update started", { id: actionKey, description: app.displayName });
      void refresh();
      if (app.id === shellAppId) {
        const outcome = await waitForShellUpdateToSettle({
          coreOrigin, shellAppId, expectRestart: isAppUp(app.runtimeState),
          subscribe: onSync => {
            const unsubscribe = subscribeToCoreEvents(coreOrigin, {
              names: [CoreEventNames.appChanged, CoreEventNames.appRemoved], onSync,
            });
            // Shell's proxy may restart too; a missed hint must not strand this wait.
            const timer = setInterval(() => void onSync(), 5000);
            void onSync();
            return () => { clearInterval(timer); unsubscribe(); };
          },
        });
        if (outcome.kind === "failed") throw new Error(outcome.message);
        if (outcome.kind === "configuration-required") {
          toast.warning("Shell updated; configuration required", { description: "Configure it through local Core control before starting Shell again." });
          return true;
        }
        if (outcome.kind === "settled" && await waitForOwnOrigin()) window.location.reload();
        else toast.warning("Shell update is still settling", { description: "Check its status before reloading this page." });
      }
      return true;
    } catch (error) {
      // Only the row's preparation loop refreshes a definite refusal. Once queued, even a
      // later stale-shaped status error cannot authorize another mutation; bulk keeps going.
      if (!queued && propagateStale && isStaleUpdatePreparation(error)) throw error;
      if (!isAuthRequiredRedirectError(error)) {
        toast.error("Update not completed", { id: actionKey, appId: app.id,
          description: error instanceof Error ? error.message : "Check the update status in Core." });
        void refresh();
      }
      return false;
    } finally {
      setBusyAction(current => current === actionKey ? null : current);
    }
  }, [coreOrigin, refresh, sendCsrfJson, shellAppId]);

  const applyUpdateFromRow = useCallback(async (app: CoreApp) => {
    if (updateActivations.current.has(app.id)) return;
    updateActivations.current.add(app.id);
    // Reserve the window in the click gesture. A fresh routine verdict needs no window;
    // if its refresh discovers a review, Core's explicit confirmation link is available.
    const reserve = app.updateCheck?.requiresReview || app.updateCheck?.error || !app.updateCheck?.planDigest;
    const popup = reserve ? openInstallationConfirmation() : null;
    const actionKey = `${app.id}:update`;
    setBusyAction(actionKey);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const plan = await getUpdatePlan(app, attempt > 0 || Boolean(app.updateCheck?.error));
        if (plan.error) throw new Error(plan.error);
        if (plan.sourceConfigured === false) throw new Error("Configure an update source in app Settings before updating.");
        if (!plan.changes.length) { popup?.close(); toast.info("No update available", { description: app.displayName }); return; }
        try {
          if (plan.requiresReview !== false) await enqueueUpdate(app, plan.planDigest, popup);
          else { popup?.close(); await enqueueRoutine(app, plan.planDigest, true); }
          return;
        } catch (error) {
          if (attempt === 1 || !isStaleUpdatePreparation(error)) throw error;
        }
      }
    } catch (error) {
      popup?.close();
      if (!isAuthRequiredRedirectError(error)) toast.error("Update could not be prepared", {
        description: error instanceof Error ? error.message : "Check the update source and try again.",
      });
    } finally { updateActivations.current.delete(app.id); setBusyAction(current => current === actionKey ? null : current); }
  }, [enqueueRoutine, enqueueUpdate, getUpdatePlan]);

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
        if (appSupportsReviewedUpdate(app)) {
          try { await getUpdatePlan(app, true); }
          catch (error) {
            if (isAuthRequiredRedirectError(error)) return;
            toast.warning("Feed saved; update check failed", { description: error instanceof Error ? error.message : "Check the new source before updating." });
          }
          await refresh();
        }
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
    [appEndpoint, getUpdatePlan, refresh, sendCsrfJson],
  );

  const openAppPanel = useCallback(
    (app: CoreApp, view: DetailView, options?: OpenPanelOptions) => {
      if (view === "backups") {
        void loadAppBackups(app);
        return;
      }
      if (view === "update") {
        void applyUpdateFromRow(app);
        return;
      }
      detailRequestRef.current += 1;
      setActivePanel({ appId: app.id, view, settingsTab: options?.settingsTab });
      setDetailPanel(emptyDetailPanelState());
    },
    [applyUpdateFromRow, loadAppBackups],
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
        toast.error("Backup failed", { description: message, appId: app.id });
      } finally {
        setBusyAction((current) => (current === actionKey ? null : current));
      }
    },
    [activePanel, appEndpoint, loadAppBackups, refresh, sendCsrfJson],
  );

  const restoreBackup = useCallback(
    async (app: CoreApp, backup: CoreBackup) => {
      if (!await confirm({ title: "Restore backup?", description: `${app.displayName} · ${backup.backupId}. Restore this backup, creating a pre-restore backup first.`, action: "Restore backup", destructive: true })) {
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
    [confirm, appEndpoint, loadAppBackups, refresh, sendCsrfJson],
  );

  const deleteBackup = useCallback(
    async (app: CoreApp, backup: CoreBackup) => {
      if (!await confirm({ title: "Delete backup?", description: `${app.displayName} · ${backup.backupId}. This backup will be permanently deleted.`, action: "Delete backup", destructive: true })) {
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
    [confirm, appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const previewBackupCleanup = useCallback(
    async (app: CoreApp) => {
      const actionKey = `${app.id}:backup-cleanup-plan`;
      setBusyAction(actionKey);
      try {
        const response = await fetchCore(appEndpoint(app, "/backups/cleanup/plan"), { credentials: "include" });
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
      if (!await confirm({ title: "Delete backup cleanup candidates?", description: `${app.displayName}: permanently delete ${plan.candidates.length} backups from the reviewed cleanup plan.`, action: "Delete backups", destructive: true })) {
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
    [confirm, appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const revealAppSetting = useCallback(
    async (app: CoreApp, key: string) => {
      // On-demand only: the app summaries never carry a secret's value, so this is the single path
      // that does, gated on the admin session server-side.
      const response = await fetchCore(appEndpoint(app, `/settings/${encodeURIComponent(key)}/value`), { credentials: "include" });
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



  const changeHostPath = useCallback(async (url: string, body: unknown, change: NonNullable<InstallationSource["hostPathChange"]>) => {
    const popup = openInstallationConfirmation();
    let submitted = false;
    try {
      try {
        await sendCsrfJson(url, body);
        return true;
      } catch (error) {
        if (!(error instanceof CoreRequestError) || ![
          "source_override_confirmation_required", "app_mount_confirmation_required", "global_mount_confirmation_required",
        ].includes(error.code ?? "")) throw error;
      }
      const result = await requestCoreApproval(installationClient, { hostPathChange: change }, pending => {
        submitted = true;
        return showCoreConfirmation(popup, pending);
      });
      if (result.status === "denied") toast.info("Change cancelled");
      return result.status === "succeeded";
    } finally {
      if (!submitted) popup?.close();
    }
  }, [installationClient, sendCsrfJson]);

  const configureMounts = useCallback(
    async (app: CoreApp, mounts: MountBindingInput[]) => {
      const actionKey = `${app.id}:mounts`;
      setBusyAction(actionKey);
      try {
        if (!await changeHostPath(appEndpoint(app, "/mounts"), { mounts }, { kind: "app-mounts", appId: app.id, mounts: { mounts } })) return;
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
    [appEndpoint, refresh, changeHostPath],
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
        if (!await changeHostPath(appEndpoint(app, "/source/override"), { path }, { kind: "source-override", appId: app.id, source: { path } })) return;
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
    [appEndpoint, refresh, changeHostPath],
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

  // Shared-mounts library (host-level). The endpoints return the full updated list, so each call
  // refreshes globalMounts directly; the SharedMountsDialog surfaces any thrown error inline.
  const saveGlobalMount = useCallback(
    async (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => {
      if (!await changeHostPath(`${coreOrigin}/api/global-mounts`, input, { kind: "global-mount", globalMount: input })) throw new Error("Change cancelled.");
      const response = await fetchCore(`${coreOrigin}/api/global-mounts`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(await readCoreError(response));
      setGlobalMounts(((await response.json()) as { mounts?: CoreGlobalMount[] }).mounts ?? []);
    },
    [coreOrigin, changeHostPath],
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
      const response = await fetchCore(`${coreOrigin}/api/core/settings`, { credentials: "include" });
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

  // Significant manifest changes and new permissions still use Core confirmation.
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

  // Submit routine updates without popups, with Shell last because it reloads this page.
  const updateAllApps = useCallback(async () => {
    const routine = state.apps.filter(isRoutineUpdate);
    if (routine.length === 0) {
      toast.info("No routine updates available");
      return;
    }
    await reviewUpdatesInOrder(routine, shellAppId, app => enqueueRoutine(app, app.updateCheck!.planDigest!));
  }, [enqueueRoutine, shellAppId, state.apps]);

  // Advisory preview for the remove panel: what else declares a dependency on this app and who
  // consumes the platform capabilities it provides. A failure here degrades to "no impact shown"
  // rather than blocking the removal — Core never gates on it either.
  const loadRemovalImpact = useCallback(
    async (appId: string): Promise<CoreRemovalImpact | null> => {
      const response = await fetchCore(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/remove-impact`, {
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
    // Shell chooses options; only Core's isolated page can authorize their execution.
    async (app: CoreApp, options: RemoveOptions) => {
      const actionKey = `${app.id}:remove`;
      setBusyAction(actionKey);
      const popup = openInstallationConfirmation();
      let submitted = false;
      try {
        const result = await requestAppRemoval(installationClient, app.id, {
          deleteRuntimeState: true,
          deleteData: options.deleteData,
          deleteBackups: options.deleteBackups,
          deleteSource: options.deleteSource,
          ignoreRuntimeErrors: options.ignoreRuntimeErrors,
        }, (pending) => {
          submitted = true;
          return showCoreConfirmation(popup, pending);
        });
        if (result.status === "denied") {
          toast.info("App removal cancelled");
          return;
        }
        await refresh();
        setActivePanel(null);
        if (workspace?.appId === app.id) {
          setWorkspace(null);
        }
        toast.success("App removed", { description: app.displayName });
      } catch (error) {
        if (!submitted) popup?.close();
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
    [installationClient, refresh, workspace?.appId],
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

  const authorizationRedirect = getShellAuthorizationRedirect(
    shellRoute, Boolean(state.session?.authenticated), Boolean(canManageApps),
  );
  useEffect(() => {
    if (authorizationRedirect) router.replace(authorizationRedirect);
  }, [authorizationRedirect, router]);

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

  // Load Core settings when their owning General, Security or Ingress section opens.
  // These sections share one payload and render only the fields they own.
  useEffect(() => {
    const rendersCoreSettings = ["general", "policies", "users", "ingress"].includes(shellRoute.settingsTab);
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

    // Core filters every app, including system apps, using this user's assignments.
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

    const page = findAppPageLink(app, routeWorkspace.path);
    if (!page) {
      resetWorkspaceLaunch({ error: `App '${app.displayName}' does not expose '${routeWorkspace.path}'.` });
      return;
    }

    // Same gate as a sidebar launch; this effect re-runs as the app's reading changes, so a route
    // held at "starting" resolves itself once the service answers.
    const gate = resolveLaunchGate(app, page.service);
    if (!gate.up) {
      resetWorkspaceLaunch({
        error: app.system
          ? `System app '${app.displayName}' is ${app.runtimeState || app.operationStatus}. Manage it from Dashboard.`
          : "App must be running before it can be opened.",
      });
      return;
    }

    if (!gate.allowed) {
      resetWorkspaceLaunch({ error: `${app.displayName} is starting — it opens when it answers.` });
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
      appendThemeLaunchParams(page.redirectUri, shellResolvedTheme, shellThemePreference),
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
        if (cancelled) {
          return;
        }

        setWorkspace({
          appId: workspaceApp.id,
          title: workspaceApp.displayName,
          pageLabel: workspacePage.label,
          path: routePath,
          src: embeddedRedirectUri,
          externalUrl: getStandaloneAppHref(workspaceApp, workspacePage),
        });
      } catch (error) {
        if (isAuthRequiredRedirectError(error) || cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unable to create app launch link.";
        setWorkspace(null);
        setState((current) => ({ ...current, error: message }));
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
    if (narrowViewport) {
      setMobileSidebarOpen(!compact);
      return;
    }
    setSidebarCompact(compact);
    persistChromePref(SIDEBAR_COMPACT_PREF_KEY, compact);
  }

  function setPanelOpen(open: boolean) {
    setRightPanelOpen(open);
    persistChromePref(RIGHT_PANEL_OPEN_PREF_KEY, open);
  }

  const openInstallDialog = useCallback((manifestPath?: string) => {
    if (installActivation.current) return;
    installActivation.current = true;
    setInstallConfirmationWindow(typeof manifestPath === "string" ? openInstallationConfirmation() : null);
    setInstallInitialManifest(typeof manifestPath === "string" ? manifestPath : null);
    setInstallNonce((nonce) => nonce + 1);
    setInstallOpen(true);
  }, []);

  // App-owned recovery never asks Shell to mint credentials or reload another origin.
  const handleAuthRequired = useCallback((_appId: string) => { void _appId; }, []);
  const handleSurfaceAuthRequired = handleAuthRequired;


  // Apps authenticate directly with Core; Shell never distributes another app's credential.
  const handleDelegatedTokenRequest = undefined;

  const closeInstallDialog = useCallback(() => {
    installActivation.current = false;
    setInstallOpen(false);
  }, []);

  // Apps that declared a settings surface, as Settings tabs. Core resolved the URL, so a stopped
  // app arrives with none — the tab still exists and says so.
  const appSettingsTabs = useMemo(() => getAppSettingsTabs(state.apps), [state.apps]);
  const [assistantDestination, setAssistantDestination] = useState<{ appId: string; userId: string | null; result: Parameters<typeof assistantOpenUrl>[1] } | null>(null);
  const appPanelTabs = useMemo(() => getAppPanelTabs(state.apps).map(tab => {
    if (assistantDestination?.appId !== tab.appId || assistantDestination.userId !== activeUserId || !tab.running) return tab;
    const app = state.apps.find(app => app.id === tab.appId);
    try { return app ? { ...tab, embeddedUrl: assistantOpenUrl(app, assistantDestination.result) } : tab; }
    catch { return tab; } // An updated manifest can withdraw or move its UI surface.
  }), [state.apps, assistantDestination, activeUserId]);

  // A notification links here with the session it is about. Revealing the rail and forwarding the id
  // reuses the channel built for asks — the panel owns which session is shown, and Shell only carries
  // the request, which is the same division as everywhere else in the rail.
  const assistantSessionParam = readAssistantSessionParam(searchParams.get("assistantSession"));
  const sessionAssistantId = searchParams.get("assistantApp") ?? (assistants.length === 1 ? assistants[0].appId : null);
  useEffect(() => {
    if (!assistantSessionParam) {
      return;
    }

    // The tab has to be selected as well as the rail revealed: the outbound message is handed only to
    // the *active* tab's frame, so a link arriving while another app's panel was open reached nobody
    // and then stripped its own parameter on the way out.
    const assistantTab = appPanelTabs.find((tab) => tab.appId === sessionAssistantId);
    if (!assistantTab) {
      return;
    }

    setPanelOpen(true);
    setActivePanelKey(assistantTab.key);
    setAssistantAsk((current) => ({
      userId: activeUserId, appId: assistantTab.appId,
      message: { type: "hosty:open-assistant-session", sessionId: assistantSessionParam },
      nonce: (current?.nonce ?? 0) + 1,
    }));
    // Stripped once acted on: a reload should not re-open a session the operator has since left, and
    // a link that keeps reasserting itself is one they cannot navigate away from.
    const next = new URLSearchParams(searchParams.toString());
    next.delete("assistantSession");
    next.delete("assistantApp");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`);
  }, [appPanelTabs, sessionAssistantId, assistantSessionParam, pathname, router, searchParams, activeUserId]);

  const [assistantContextReady, setAssistantContextReady] = useState(false);
  const [assistantSessionPending, setAssistantSessionPending] = useState(false);
  const creatingAssistantSession = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const available = canManageApps && assistantPermission && assistantGateway?.running
        ? await assistantSupportsContext(assistantGateway).catch(() => false)
        : false;
      if (!cancelled) setAssistantContextReady(Boolean(available));
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [assistantGateway, canManageApps, assistantPermission, activeUserId]);

  const newAppAssistantSession = useCallback(async (appId: string) => {
    if (!canManageApps || creatingAssistantSession.current) return;
    const gateway = await chooseAssistant();
    if (!gateway) return;
    if (!gateway.running) { toast.error("Start the selected assistant to continue."); return; }
    const tab = appPanelTabs.find(item => item.appId === gateway.appId);
    if (!tab) { toast.error("The assistant panel is unavailable. Refresh Shell and retry."); return; }
    creatingAssistantSession.current = true;
    setAssistantSessionPending(true);
    try {
      const intent = await pendingAssistantIntent(activeUserId, gateway.appId, "", [appId]);
      const session = await createAppSession(gateway, sendCsrfJson, appId, intent.requestId);
      const app = state.apps.find(app => app.id === gateway.appId)!;
      assistantOpenUrl(app, session.result);
      setAssistantDestination({ appId: gateway.appId, userId: activeUserId, result: session.result });
      setPanelOpen(true);
      setActivePanelKey(tab.key);
      intent.complete();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { creatingAssistantSession.current = false; setAssistantSessionPending(false); }
  }, [canManageApps, chooseAssistant, appPanelTabs, sendCsrfJson, activeUserId, state.apps]);

  const askErrorAssistant = useCallback(async (report: ErrorReport, requestId: string) => {
    if (!canManageApps) return false;
    const gateway = await chooseAssistant();
    if (!gateway) return false;
    if (!gateway.running) throw new Error("Start the selected assistant to continue.");
    const tab = appPanelTabs.find(item => item.appId === gateway.appId);
    if (!tab) throw new Error("The assistant panel is unavailable. Refresh Shell and retry.");
    const session = await createErrorSession(gateway, sendCsrfJson, report.appId, requestId, errorReportText(report));
    setPanelOpen(true);
    setActivePanelKey(tab.key);
    const app = state.apps.find(app => app.id === gateway.appId)!;
    assistantOpenUrl(app, session.result);
      setAssistantDestination({ appId: gateway.appId, userId: activeUserId, result: session.result });
  }, [canManageApps, chooseAssistant, appPanelTabs, sendCsrfJson, activeUserId, state.apps]);

  const askAssistant = useCallback((text: string, sourceAppId: string) => {
    void (async () => {
      if (!askLimiter.current.tryAcquire(sourceAppId)) {
        return;
      }

      const gateway = await chooseAssistant();
      if (!gateway) return;
      if (!gateway.running) { toast.error("Start the selected assistant to continue."); return; }
      const assistantTab = appPanelTabs.find(tab => tab.appId === gateway.appId);
      if (!assistantTab) throw new Error("The assistant panel is unavailable.");
      const intent = await pendingAssistantIntent(activeUserId, gateway.appId, text, [sourceAppId]);
      const session = await createHandoff(gateway, sendCsrfJson, text, [sourceAppId], intent.requestId);
      const app = state.apps.find(app => app.id === gateway.appId)!;
      assistantOpenUrl(app, session.result);
      setAssistantDestination({ appId: gateway.appId, userId: activeUserId, result: session.result });
      setPanelOpen(true); setActivePanelKey(assistantTab.key);
      intent.complete();
    })().catch(error => toast.error(error instanceof Error ? error.message : String(error)));
  }, [appPanelTabs, chooseAssistant, activeUserId, sendCsrfJson, state.apps]);


  // The assistant is meant to be at hand, so it gets a key. Toggles rather than only opening: a
  // shortcut that could not put the panel away would make the rail a trap on a small screen.
  useEffect(() => {
    if (!assistantAvailable) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "a") {
        return;
      }

      event.preventDefault();
      void (async () => {
        const gateway = await chooseAssistant();
        const assistantTab = appPanelTabs.find((tab) => tab.appId === gateway?.appId);
        if (!assistantTab) return;
        // Already looking at it means "put it away"; anything else means "bring it here", including
        // an open rail showing somebody else's panel.
        const showing = rightPanelOpen && resolveActiveSurfaceTab(appPanelTabs, activePanelKey)?.key === assistantTab.key;
        setPanelOpen(!showing);
        if (!showing) {
          setActivePanelKey(assistantTab.key);
        }
      })();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePanelKey, appPanelTabs, assistantAvailable, chooseAssistant, rightPanelOpen]);

  // The rail exists only while something declares a panel; opening it is then the operator's choice.
  // An app's settings page fills the content column the way a workspace app does, so the column
  // takes the same surface. An embedded page paints its own background, and leaving the column
  // muted around it drew a seam under the tab strip that no other tab has.
  const appSettingsSurfaceActive =
    effectiveView === "settings" && Boolean(resolveSettingsSurface(appSettingsTabs, shellRoute.settingsTab));

  const activePanelTab = useMemo(
    () => resolveActiveSurfaceTab(appPanelTabs, activePanelKey),
    [appPanelTabs, activePanelKey],
  );

  // What the strip names: the app whose page fills the content area, or the Shell page itself.
  const stripTitle = workspace?.title ?? SHELL_VIEW_LABELS[effectiveView] ?? "Hosty";
  const selectedSettingsPage = resolveSettingsSurface(appSettingsTabs, shellRoute.settingsTab);
  const stripSubtitle = workspace?.pageLabel ?? (effectiveView === "settings"
    ? selectedSettingsPage ? selectedSettingsPage.label
      : getHostSettingsSection(shellRoute.settingsTab)?.label ?? "Security"
    : null);

  const requestDelegatedTokenFor = useCallback((_appId: string) => {
    void _appId;
    return undefined;
  }, []);

  // Opens the app-owned surface. Its SDK establishes identity directly through Core.
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
        appendThemeLaunchParams(embeddedUrl, shellResolvedTheme, shellThemePreference),
      );
      return redirectUri;
    },
    [shellResolvedTheme, shellThemePreference, state.apps],
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
      assistantSelection,
      shellTheme: shellResolvedTheme,
      shellThemePreference,
      coreSettings,
      coreSettingsError,
      globalMounts,
      coreUpdate: state.status?.launch?.mode === "dev" ? null : reconcileCoreUpdate(coreUpdate, state.status?.version),
      coreUpdating,
    }),
    [
      activeUser,
      assistantSelection,
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
      selectAssistant,
      coreOrigin,
      shellAppId,
      refresh,
      sendCsrfJson,
      onEmbeddedAuthRequired: handleSurfaceAuthRequired,
      surfaceAuthNonce,
      askAssistant: assistantAvailable ? askAssistant : undefined,
      newAppAssistantSession: assistantAvailable && (!assistantGateway || assistantContextReady && assistantGateway.running) ? newAppAssistantSession : undefined,
      assistantSessionPending,
      requestDelegatedTokenFor,
      openSurfaceFrame,
      startAppById,
      launchAppPage,
      getStandaloneAppHref,
      openInstallDialog,
      runAppAction,
      switchAppRuntime,
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
      selectAssistant,
      handleSurfaceAuthRequired,
      surfaceAuthNonce,
      askAssistant,
      assistantAvailable,
      assistantContextReady,
      assistantGateway,
      newAppAssistantSession,
      assistantSessionPending,
      requestDelegatedTokenFor,
      openSurfaceFrame,
      startAppById,
      updateCore,
      applyUpdateFromRow,
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
      <div className="flex h-dvh flex-col overflow-hidden bg-sidebar">
        <ShellTopStrip
          title={stripTitle}
          subtitle={stripSubtitle}
          leftRailExpanded={!effectiveSidebarCompact}
          navigationWidth={narrowViewport || sidebarCompact ? 60 : 280}
          onToggleLeftRail={() => setCompact(!effectiveSidebarCompact)}
          // Null while no installed app declares a panel surface: there is no rail to toggle, and a
          // control for chrome that does not exist is worse than no control.
          rightRailExpanded={appPanelTabs.length > 0 ? rightPanelOpen : null}
          onToggleRightRail={() => setPanelOpen(!rightPanelOpen)}
          showNotifications={Boolean(activeUser)}
          onBrandClick={() => {
            setMobileSidebarOpen(false);
            setWorkspace(null);
            setOptimisticWorkspaceRoute(null);
            router.push(getShellViewHref(canManageApps ? "dashboard" : "available-apps"));
          }}
        />

      <div
        className={cn(
          "relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]",
          chromeTransitions && !narrowViewport && "motion-safe:transition-[grid-template-columns] motion-safe:duration-200",
          (narrowViewport || sidebarCompact)
            ? "grid-cols-[60px_minmax(0,1fr)]"
            : "grid-cols-[280px_minmax(0,1fr)]",
        )}
      >
        {narrowViewport && mobileSidebarOpen && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 left-[min(280px,85vw)] z-20 bg-black/20"
            aria-label="Close navigation"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}
        <aside id="shell-navigation" className={cn(
          "relative z-30 h-full min-h-0 overflow-visible bg-sidebar text-sidebar-foreground",
          narrowViewport && mobileSidebarOpen && "absolute inset-y-0 left-0 w-[280px] max-w-[85vw] shadow-lg",
        )}>
          <ShellSidebar
            compact={effectiveSidebarCompact}
            activeView={effectiveView}
            workspace={workspace}
            coreOrigin={coreOrigin}
            activeUser={activeUser}
            canManageApps={Boolean(canManageApps)}
            settingsPages={appSettingsTabs}
            selectedSettings={shellRoute.settingsTab}
            onOpenSettings={(key) => {
              setMobileSidebarOpen(false);
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getSettingsHref(key));
            }}
            uiApps={uiApps}
            busyAction={busyAction}
            onStartApp={canManageApps ? startAppById : undefined}
            onNavigate={(view) => {
              setMobileSidebarOpen(false);
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getShellViewHref(view));
            }}
            onOpenApps={() => {
              setMobileSidebarOpen(false);
              setWorkspace(null);
              setOptimisticWorkspaceRoute(null);
              router.push(getShellViewHref("available-apps"));
            }}
            onLaunchApp={(app, page, target) => {
              setMobileSidebarOpen(false);
              return launchAppPage(app, page, target);
            }}
            getStandaloneHref={getStandaloneAppHref}
          />
        </aside>
        {narrowViewport && mobileSidebarOpen && <div aria-hidden />}

        <ShellWorkspaceSplit initialPanelWidth={initialRightPanelWidth} expanded={rightPanelOpen} panel={
          appPanelTabs.length > 0 ? (
            <ShellRightPanel
              tabs={appPanelTabs}
              expanded={rightPanelOpen}
              activeTab={activePanelTab}
              theme={shellResolvedTheme}
              themePreference={shellThemePreference}
              onSelectTab={(key) => {
                const next = activatePanel(key, activePanelTab?.key ?? null, rightPanelOpen);
                setActivePanelKey(next.key);
                setPanelOpen(next.expanded);
              }}
              onAuthRequired={handleSurfaceAuthRequired}
              resolveDelegatedTokenRequest={requestDelegatedTokenFor}
              onOpenSurfaceFrame={openSurfaceFrame}
              attention={panelAttention}
              onAttention={(appId, count) =>
                setPanelAttention((current) => (current[appId] === count ? current : { ...current, [appId]: count }))
              }
              onAskAssistant={assistantAvailable ? askAssistant : undefined}
              // Panels are deliberately not administrator-only, but starting an app is: Core refuses a
              // host.user, so offering them the button would promise something guaranteed to fail.
              onStartApp={canManageApps ? startAppById : undefined}
              reloadKey={surfaceAuthNonce}
              // Only the assistant's own tab is handed Shell's ask; another app's panel must not
              // receive a message addressed to the gateway.
              outbound={assistantMessageFor(assistantAsk, activeUserId, activePanelTab?.appId, assistantIds)}
            />
          ) : null
        }>
          <div
            className={cn(
              "h-full min-w-0",
              (workspaceSurfaceActive || appSettingsSurfaceActive) ? "overflow-hidden bg-background" : "overflow-y-auto",
              appSettingsSurfaceActive && "bg-background",
            )}
          >
            <main className={cn("w-full", (workspaceSurfaceActive || appSettingsSurfaceActive) ? "h-full" : effectiveView === "dashboard" ? "mx-auto max-w-7xl space-y-6 px-3 py-4 sm:px-4" : "mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8")}>
              {workspace ? (
                <EmbeddedWorkspacePanel
                  workspace={workspace}
                  grantedCorePermissions={state.apps.find((app) => app.id === workspace.appId)?.grantedCorePermissions}
                  theme={shellResolvedTheme}
                  themePreference={shellThemePreference}
                  onAuthRequired={handleAuthRequired}
                  onDelegatedTokenRequest={handleDelegatedTokenRequest}
                  onAskAssistant={assistantAvailable ? askAssistant : undefined}
                />
              ) : activeWorkspaceRoute ? (
                <EmbeddedWorkspacePendingPanel
                  error={state.error}
                />
              ) : (
                <>
                  {state.loading && !state.status ? (
                    <EmptyState icon={LoaderCircle} title="Loading Core state" description="Waiting for Core status and current session." iconClassName="animate-spin" />
                  ) : (
                    children
                  )}
                </>
              )}
            </main>
          </div>
        </ShellWorkspaceSplit>
      </div>

        {installOpen && <SourceInstallDialog
          key={installNonce}
          client={installationClient}
          coreOrigin={coreOrigin}
          sendCsrfJson={sendCsrfJson}
          source={installInitialManifest ? { manifestPath: installInitialManifest } : undefined}
          confirmationWindow={installConfirmationWindow}
          onClose={closeInstallDialog}
          onInstalled={() => {
            installActivation.current = false;
            setInstallOpen(false);
            toast.success("App installed");
            void refresh();
          }}
        />}

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
            onSetFeed={setAppFeed}
            onRemove={removeApp}
            onLoadRemovalImpact={loadRemovalImpact}
            onRevealSetting={revealAppSetting}
            onAskAssistant={assistantAvailable
              ? () => askAssistant(`About the ${selectedApp.displayName || selectedApp.id} app (${activePanel.view} page): `, shellAppId)
              : undefined}
          />
        )}


      </div>
      {assistantPicker}
      {confirmationDialog}
      <AssistantFeedbackContext.Provider value={{
        installed: assistants.length > 0,
        unavailableReason: !canManageApps ? "Host administrator access is required."
          : !assistantPermission ? "Approve Shell’s optional providers.assistant permission in its app settings."
          : assistantGateway && !assistantGateway.running ? "Start the selected assistant to continue."
          : assistantGateway && !appPanelTabs.some(tab => tab.appId === assistantGateway.appId) ? "The assistant panel is unavailable."
          : undefined,
        ask: askErrorAssistant,
      }}><Toaster /></AssistantFeedbackContext.Provider>
      </ShellStateContext.Provider>
    </ShellActionsContext.Provider>
  );
}
