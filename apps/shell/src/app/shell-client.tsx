"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  Copy,
  Database,
  ExternalLink,
  FileText,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  UserCog,
  UserPlus,
  Users,
  UserX,
  X,
} from "lucide-react";

type CoreStatus = {
  status: string;
  component: string;
  dataRoot: string;
  listenUrl: string;
  corePublicOrigin?: string | null;
  shellPublicOrigin?: string | null;
  runtimePublicHost?: string | null;
  serverTime: string;
};

type CoreSetting = {
  key: string;
  type: string;
  value?: string | null;
  secret: boolean;
};

type CoreApp = {
  id: string;
  displayName: string;
  description?: string | null;
  version: string;
  kind: string;
  system: boolean;
  source: string;
  selectedChannel?: string | null;
  selectedRuntime?: string | null;
  operationStatus: string;
  runtimeState: string;
  lastOperation?: string | null;
  lastError?: string | null;
  capabilities: string[];
  settings?: CoreSetting[];
  endpoints?: CoreEndpoint[];
};

type AppsResponse = {
  apps: CoreApp[];
};

type CoreEndpoint = {
  key: string;
  protocol: string;
  url?: string | null;
  public: boolean;
};

type CoreBackup = {
  appId: string;
  backupId: string;
  reason: string;
  createdAt: string;
  dataPath: string;
  archivePath: string;
  archiveSha256: string;
  archiveSize: number;
  fileCount: number;
};

type BackupsResponse = {
  backups: CoreBackup[];
};

type LogsResponse = {
  appId: string;
  text: string;
};

type CoreUpdatePlan = {
  appId: string;
  currentVersion: string;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetChannel?: string | null;
  manifestPath: string;
  manifestDigest: string;
  planDigest: string;
  willCreatePreUpdateBackup: boolean;
  changes: string[];
};

type CoreInstallSetting = {
  key: string;
  type: string;
  defaultValue?: string | null;
  secret: boolean;
};

type CoreInstallPlan = {
  appId: string;
  displayName: string;
  description?: string | null;
  action: string;
  currentVersion?: string | null;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetRuntimeType: string;
  manifestPath: string;
  currentManifestDigest?: string | null;
  targetManifestDigest: string;
  selectedChannel?: string | null;
  settings: CoreInstallSetting[];
};

type CoreError = {
  code?: string;
  message?: string;
};

type AppAction = "start" | "stop" | "restart" | "backup";
type DetailView = "logs" | "backups" | "configure" | "update" | "remove";
type ShellView = "apps" | "users";

type SessionResponse = {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    disabled: boolean;
  } | null;
};

type AppLaunchResponse = {
  code: string;
  redirectUri: string;
  expiresAt: string;
};

type HostUserSummary = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  authProvider?: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  assignedModuleIds: string[];
  lastSeenAt?: string | null;
};

type UserInvitationSummary = {
  id: string;
  email: string;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  assignedModuleIds: string[];
  createdByUserId?: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
  revokedAt?: string | null;
  status: "pending" | "expired" | "used" | "revoked";
};

type AssignableAppSummary = {
  id: string;
  name: string;
  version: string;
  operationStatus: string;
};

type InviteTtlOption = {
  label: string;
  ttlMs: number;
};

type UserManagementResponse = {
  users: HostUserSummary[];
  invitations: UserInvitationSummary[];
  apps?: AssignableAppSummary[];
  modules?: AssignableAppSummary[];
  inviteTtlOptions: InviteTtlOption[];
};

type LoadState = {
  loading: boolean;
  error: string | null;
  status: CoreStatus | null;
  apps: CoreApp[];
  session: SessionResponse | null;
  updatedAt: string | null;
};

type DetailPanelState = {
  loading: boolean;
  error: string | null;
  logs: string | null;
  backups: CoreBackup[] | null;
  updatePlan: CoreUpdatePlan | null;
};

type InstallPanelState = {
  loading: boolean;
  error: string | null;
  plan: CoreInstallPlan | null;
};

type ActivePanel = {
  appId: string;
  view: DetailView;
};

type RemoveOptions = {
  deleteData: boolean;
  deleteBackups: boolean;
  deleteSource: boolean;
  ignoreRuntimeErrors: boolean;
};

const emptyDetailPanelState = (): DetailPanelState => ({
  loading: false,
  error: null,
  logs: null,
  backups: null,
  updatePlan: null,
});

const emptyInstallPanelState = (): InstallPanelState => ({
  loading: false,
  error: null,
  plan: null,
});

async function readCoreError(response: Response) {
  try {
    const error = (await response.json()) as CoreError;
    return error.message || error.code || `Core returned ${response.status}.`;
  } catch {
    return `Core returned ${response.status}.`;
  }
}

export function ShellClient({
  coreOrigin,
  shellAppId,
}: {
  coreOrigin: string;
  shellAppId: string;
}) {
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
  const [activeView, setActiveView] = useState<ShellView>("apps");

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [statusResponse, sessionResponse] = await Promise.all([
        fetch(`${coreOrigin}/api/core/status`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/session`, { credentials: "include" }),
      ]);

      if (!statusResponse.ok) {
        throw new Error(`Core status returned ${statusResponse.status}.`);
      }

      const status = (await statusResponse.json()) as CoreStatus;
      const session = sessionResponse.ok ? ((await sessionResponse.json()) as SessionResponse) : null;
      let apps: AppsResponse = { apps: [] };
      if (session?.authenticated) {
        const appsResponse = await fetch(`${coreOrigin}/api/apps`, { credentials: "include" });
        if (!appsResponse.ok) {
          throw new Error(`Apps API returned ${appsResponse.status}.`);
        }

        apps = (await appsResponse.json()) as AppsResponse;
      }

      setState({
        loading: false,
        error: null,
        status,
        apps: apps.apps,
        session,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Core is unavailable.",
      }));
    }
  }, [coreOrigin]);

  const loadCsrfToken = useCallback(async () => {
    const response = await fetch(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`CSRF endpoint returned ${response.status}.`);
    }

    return ((await response.json()) as { token: string }).token;
  }, [coreOrigin]);

  const sendCsrfJson = useCallback(
    async (endpoint: string, body?: unknown, method = "POST") => {
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

      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      return response;
    },
    [loadCsrfToken],
  );

  const appEndpoint = useCallback(
    (app: CoreApp, suffix: string) => `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}${suffix}`,
    [coreOrigin],
  );

  const openApp = useCallback(
    async (app: CoreApp) => {
      if (app.id === shellAppId) {
        window.location.href = "/";
        return;
      }

      const openEndpoint = app.endpoints?.find((endpoint) => endpoint.public && endpoint.url) ?? app.endpoints?.find((endpoint) => endpoint.url);
      if (!openEndpoint?.url || app.runtimeState !== "running") {
        setState((current) => ({ ...current, error: "App must be running before it can be opened." }));
        return;
      }

      const actionKey = `${app.id}:open`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: openEndpoint.url });
        const launch = (await response.json()) as AppLaunchResponse;
        window.open(launch.redirectUri, "_blank", "noreferrer");
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to create app launch link.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, sendCsrfJson, shellAppId],
  );

  const runAppAction = useCallback(
    async (app: CoreApp, action: AppAction) => {
      const actionKey = `${app.id}:${action}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const endpoint = action === "backup" ? appEndpoint(app, "/backups") : appEndpoint(app, `/${action}`);
        await sendCsrfJson(endpoint, action === "backup" ? { reason: "manual" } : {});
        await refresh();
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Core lifecycle action failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const loadAppLogs = useCallback(
    async (app: CoreApp) => {
      setActivePanel({ appId: app.id, view: "logs" });
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, updatePlan: null });
      try {
        const response = await fetch(`${appEndpoint(app, "/logs")}?tail=200`, { credentials: "include" });
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as LogsResponse;
        setDetailPanel({ loading: false, error: null, logs: payload.text || "", backups: null, updatePlan: null });
      } catch (error) {
        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core logs are unavailable.", logs: null, backups: null, updatePlan: null });
      }
    },
    [appEndpoint],
  );

  const loadAppBackups = useCallback(
    async (app: CoreApp, activate = true) => {
      if (activate) {
        setActivePanel({ appId: app.id, view: "backups" });
      }
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, updatePlan: null });
      try {
        const response = await fetch(appEndpoint(app, "/backups"), { credentials: "include" });
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as BackupsResponse;
        setDetailPanel({ loading: false, error: null, logs: null, backups: payload.backups, updatePlan: null });
      } catch (error) {
        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core backups are unavailable.", logs: null, backups: null, updatePlan: null });
      }
    },
    [appEndpoint],
  );

  const loadUpdatePlan = useCallback(
    async (app: CoreApp) => {
      setActivePanel({ appId: app.id, view: "update" });
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, updatePlan: null });
      try {
        const response = await fetch(appEndpoint(app, "/update/plan"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as CoreUpdatePlan;
        setDetailPanel({ loading: false, error: null, logs: null, backups: null, updatePlan: payload });
      } catch (error) {
        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Update plan is unavailable.", logs: null, backups: null, updatePlan: null });
      }
    },
    [appEndpoint],
  );

  const openAppPanel = useCallback(
    (app: CoreApp, view: DetailView) => {
      if (view === "logs") {
        void loadAppLogs(app);
        return;
      }

      if (view === "backups") {
        void loadAppBackups(app);
        return;
      }

      if (view === "update") {
        void loadUpdatePlan(app);
        return;
      }

      setActivePanel({ appId: app.id, view });
      setDetailPanel(emptyDetailPanelState());
    },
    [loadAppBackups, loadAppLogs, loadUpdatePlan],
  );

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
      } catch (error) {
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup failed.",
        }));
      } finally {
        setBusyAction(null);
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
      } catch (error) {
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Restore failed.",
        }));
      } finally {
        setBusyAction(null);
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
      } catch (error) {
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup delete failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const configureApp = useCallback(
    async (app: CoreApp, settings: Record<string, string | null>) => {
      const actionKey = `${app.id}:configure`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/configure"), { settings });
        await refresh();
        setActivePanel(null);
      } catch (error) {
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Configure failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const applyUpdate = useCallback(
    async (app: CoreApp, plan: CoreUpdatePlan) => {
      if (!window.confirm(`Apply update for ${app.displayName}?`)) {
        return;
      }

      const actionKey = `${app.id}:update`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/update"), {
          planDigest: plan.planDigest,
          manifestPath: plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
          targetChannel: plan.targetChannel,
        });
        await refresh();
        setActivePanel(null);
      } catch (error) {
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Update failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
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
      } catch (error) {
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Remove failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const loadInstallPlan = useCallback(
    async (manifestPath: string, selectedRuntime: string) => {
      setInstallPanel({ loading: true, error: null, plan: null });
      try {
        const response = await fetch(`${coreOrigin}/api/apps/install/plan`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifestPath,
            selectedRuntime: selectedRuntime.trim() || null,
            system: false,
          }),
        });
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const plan = (await response.json()) as CoreInstallPlan;
        setInstallPanel({ loading: false, error: null, plan });
      } catch (error) {
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
    async (plan: CoreInstallPlan, settings: Record<string, string | null>) => {
      if (!window.confirm(`Install ${plan.displayName}?`)) {
        return;
      }

      setBusyAction("install");
      try {
        await sendCsrfJson(`${coreOrigin}/api/apps/install`, {
          manifestPath: plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
          selectedChannel: plan.selectedChannel,
          system: false,
          settings,
        });
        await refresh();
        setInstallOpen(false);
        setInstallPanel(emptyInstallPanelState());
      } catch (error) {
        setInstallPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Install failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [coreOrigin, refresh, sendCsrfJson],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const systemApps = useMemo(() => state.apps.filter((app) => app.system), [state.apps]);
  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";
  const selectedApp = activePanel ? state.apps.find((app) => app.id === activePanel.appId) ?? null : null;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">
            <Server aria-hidden="true" />
          </div>
          <div>
            <strong>Hosty Shell</strong>
            <span>{state.status?.status || "connecting"}</span>
          </div>
        </div>

        <nav className="nav" aria-label="Shell sections">
          <button
            type="button"
            className={activeView === "apps" ? "active" : undefined}
            onClick={() => {
              setActiveView("apps");
              setActivePanel(null);
            }}
          >
            <LayoutGrid aria-hidden="true" />
            Apps
          </button>
          {canManageApps && (
            <button
              type="button"
              className={activeView === "users" ? "active" : undefined}
              onClick={() => {
                setActiveView("users");
                setActivePanel(null);
                setInstallOpen(false);
              }}
            >
              <Users aria-hidden="true" />
              Users
            </button>
          )}
        </nav>

        <div className="sidebarFooter">
          <span>Core</span>
          <code>{coreOrigin}</code>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h1>Apps</h1>
            <p>{activeUser ? `${activeUser.displayName} · ${activeUser.role}` : "No active Core session"}</p>
          </div>
          <div className="actions">
            {activeUser ? (
              <a className="button ghost" href={`${coreOrigin}/logout`}>
                <LogOut aria-hidden="true" />
                Logout
              </a>
            ) : (
              <a className="button ghost" href={`${coreOrigin}/login`}>
                <LogIn aria-hidden="true" />
                Login
              </a>
            )}
            {canManageApps && (
              <button
                className="button"
                type="button"
                hidden={activeView !== "apps"}
                onClick={() => {
                  setInstallOpen(true);
                  setInstallPanel(emptyInstallPanelState());
                }}
              >
                <Plus aria-hidden="true" />
                Install app
              </button>
            )}
            <button className="button" type="button" onClick={() => void refresh()} disabled={state.loading}>
              <RefreshCw aria-hidden="true" className={state.loading ? "spin" : ""} />
              Refresh
            </button>
          </div>
        </header>

        <section className="statusGrid" aria-label="Core status">
          <StatusTile label="Core status" value={state.status?.status || (state.loading ? "loading" : "unavailable")} />
          <StatusTile label="Core listen URL" value={state.status?.listenUrl || "unknown"} />
          <StatusTile label="Shell origin" value={state.status?.shellPublicOrigin || "not configured"} />
          <StatusTile label="Runtime host" value={state.status?.runtimePublicHost || "unknown"} />
          <StatusTile label="Last refresh" value={state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "pending"} />
        </section>

        {state.error && (
          <section className="notice error">
            <CircleAlert aria-hidden="true" />
            <span>{state.error}</span>
          </section>
        )}

        {state.loading && !state.status ? (
          <section className="emptyState">
            <LoaderCircle aria-hidden="true" className="spin" />
            <span>Loading Core state</span>
          </section>
        ) : (
          <>
            {activeView === "users" && canManageApps ? (
              <UserManagementPanel coreOrigin={coreOrigin} sendCsrfJson={sendCsrfJson} />
            ) : (
              <>
                {installOpen && (
                  <InstallReviewPanel
                    detail={installPanel}
                    busyAction={busyAction}
                    onClose={() => setInstallOpen(false)}
                    onReview={loadInstallPlan}
                    onApply={applyInstall}
                  />
                )}
                <AppSection
                  id="system"
                  title="System apps"
                  apps={systemApps}
                  shellAppId={shellAppId}
                  canManageApps={canManageApps}
                  busyAction={busyAction}
                  onAction={runAppAction}
                  onCreateBackup={createManualBackup}
                  onOpenPanel={openAppPanel}
                  onOpenApp={openApp}
                />
                <AppSection
                  id="runtime"
                  title="Runtime apps"
                  apps={runtimeApps}
                  shellAppId={shellAppId}
                  canManageApps={canManageApps}
                  busyAction={busyAction}
                  onAction={runAppAction}
                  onCreateBackup={createManualBackup}
                  onOpenPanel={openAppPanel}
                  onOpenApp={openApp}
                />
                {selectedApp && activePanel && (
                  <AppDetailsPanel
                    app={selectedApp}
                    view={activePanel.view}
                    isShell={selectedApp.id === shellAppId}
                    canManageApps={canManageApps}
                    busyAction={busyAction}
                    detail={detailPanel}
                    onClose={() => setActivePanel(null)}
                    onRefreshLogs={loadAppLogs}
                    onRefreshBackups={loadAppBackups}
                    onCreateBackup={createManualBackup}
                    onRestoreBackup={restoreBackup}
                    onDeleteBackup={deleteBackup}
                    onConfigure={configureApp}
                    onReloadUpdatePlan={loadUpdatePlan}
                    onApplyUpdate={applyUpdate}
                    onRemove={removeApp}
                  />
                )}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function StatusTile({ label, value }: { label: string; value: string }) {
  return (
    <article className="statusTile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AppSection({
  id,
  title,
  apps,
  shellAppId,
  canManageApps,
  busyAction,
  onAction,
  onCreateBackup,
  onOpenPanel,
  onOpenApp,
}: {
  id: string;
  title: string;
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: (app: CoreApp, view: DetailView) => void;
  onOpenApp: (app: CoreApp) => void;
}) {
  return (
    <section className="section" id={id}>
      <div className="sectionHeader">
        <h2>{title}</h2>
        <span>{apps.length}</span>
      </div>
      {apps.length === 0 ? (
        <div className="emptyList">No apps</div>
      ) : (
        <div className="appGrid">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              isShell={app.id === shellAppId}
              canManageApps={canManageApps}
              busyAction={busyAction}
              onAction={onAction}
              onCreateBackup={onCreateBackup}
              onOpenPanel={onOpenPanel}
              onOpenApp={onOpenApp}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AppCard({
  app,
  isShell,
  canManageApps,
  busyAction,
  onAction,
  onCreateBackup,
  onOpenPanel,
  onOpenApp,
}: {
  app: CoreApp;
  isShell: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: (app: CoreApp, view: DetailView) => void;
  onOpenApp: (app: CoreApp) => void;
}) {
  const running = app.runtimeState === "running";
  const openEndpoint = app.endpoints?.find((endpoint) => endpoint.public && endpoint.url) ?? app.endpoints?.find((endpoint) => endpoint.url);
  const canOpen = isShell || (running && Boolean(openEndpoint?.url));
  const canControl = canManageApps && !isShell;
  const canInspect = canManageApps;
  const canBackup = canManageApps && app.capabilities.includes("backup");
  const canConfigure = canControl && Boolean(app.settings?.length);
  const canUpdate = canControl && app.capabilities.includes("update");
  const canRemove = canControl && app.capabilities.includes("remove");
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;

  return (
    <article className="appCard">
      <div className="appHeader">
        <div>
          <h3>{app.displayName}</h3>
          <p>{app.description || app.id}</p>
        </div>
        <span className={running ? "pill success" : "pill"}>{app.runtimeState}</span>
      </div>
      <dl className="appFacts">
        <div>
          <dt>Version</dt>
          <dd>{app.version}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{app.selectedRuntime || "none"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{app.operationStatus}</dd>
        </div>
      </dl>
      {app.lastError && (
        <p className="inlineError">
          <CircleAlert aria-hidden="true" />
          {app.lastError}
        </p>
      )}
      <div className="appActions">
        <span className="check">
          <CheckCircle2 aria-hidden="true" />
          {isShell ? "Shell" : app.kind}
        </span>
        <div className="lifecycleActions">
          {canControl &&
            (running ? (
              <>
                <button className="iconButton" type="button" onClick={() => onAction(app, "stop")} disabled={isBusy("stop")}>
                  <Square aria-hidden="true" />
                  <span>Stop</span>
                </button>
                <button className="iconButton" type="button" onClick={() => onAction(app, "restart")} disabled={isBusy("restart")}>
                  <RotateCw aria-hidden="true" className={isBusy("restart") ? "spin" : ""} />
                  <span>Restart</span>
                </button>
              </>
            ) : (
              <button className="iconButton" type="button" onClick={() => onAction(app, "start")} disabled={isBusy("start")}>
                <Play aria-hidden="true" />
                <span>Start</span>
              </button>
            ))}
          {canInspect && app.capabilities.includes("logs") && (
            <button className="iconButton" type="button" onClick={() => onOpenPanel(app, "logs")}>
              <FileText aria-hidden="true" />
              <span>Logs</span>
            </button>
          )}
          {canBackup && (
            <>
              <button className="iconButton" type="button" onClick={() => onCreateBackup(app)} disabled={isBusy("backup")}>
                <Archive aria-hidden="true" />
                <span>Backup</span>
              </button>
              <button className="iconButton" type="button" onClick={() => onOpenPanel(app, "backups")}>
                <Database aria-hidden="true" />
                <span>Backups</span>
              </button>
            </>
          )}
          {canConfigure && (
            <button className="iconButton" type="button" onClick={() => onOpenPanel(app, "configure")}>
              <Settings aria-hidden="true" />
              <span>Configure</span>
            </button>
          )}
          {canUpdate && (
            <button className="iconButton" type="button" onClick={() => onOpenPanel(app, "update")}>
              <Upload aria-hidden="true" />
              <span>Update</span>
            </button>
          )}
          {canRemove && (
            <button className="iconButton danger" type="button" onClick={() => onOpenPanel(app, "remove")}>
              <Trash2 aria-hidden="true" />
              <span>Remove</span>
            </button>
          )}
          <button className="openLink" type="button" onClick={() => onOpenApp(app)} disabled={!canOpen || isBusy("open")}>
            <ExternalLink aria-hidden="true" />
            Open
          </button>
        </div>
      </div>
    </article>
  );
}

function InstallReviewPanel({
  detail,
  busyAction,
  onClose,
  onReview,
  onApply,
}: {
  detail: InstallPanelState;
  busyAction: string | null;
  onClose: () => void;
  onReview: (manifestPath: string, selectedRuntime: string) => void;
  onApply: (plan: CoreInstallPlan, settings: Record<string, string | null>) => void;
}) {
  const [manifestPath, setManifestPath] = useState("");
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setSettingsDraft(Object.fromEntries((detail.plan?.settings || []).map((setting) => [setting.key, setting.secret ? "" : setting.defaultValue || ""])));
  }, [detail.plan]);

  const submitReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onReview(manifestPath, selectedRuntime);
  };

  const apply = () => {
    if (!detail.plan) {
      return;
    }

    const settings: Record<string, string | null> = {};
    for (const setting of detail.plan.settings) {
      const value = settingsDraft[setting.key] ?? "";
      if (!setting.secret || value.length > 0) {
        settings[setting.key] = value;
      }
    }

    onApply(detail.plan, settings);
  };

  return (
    <section className="detailPanel" aria-label="Install app">
      <div className="detailHeader">
        <div>
          <span>Install</span>
          <h2>Install app</h2>
        </div>
        <button className="iconOnly" type="button" onClick={onClose} aria-label="Close install">
          <X aria-hidden="true" />
        </button>
      </div>

      <form className="installForm" onSubmit={submitReview}>
        <label>
          <span>Manifest path</span>
          <input value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} required />
        </label>
        <label>
          <span>Runtime</span>
          <input value={selectedRuntime} onChange={(event) => setSelectedRuntime(event.target.value)} placeholder="default" />
        </label>
        <div className="detailToolbar">
          <button className="button" type="submit" disabled={detail.loading || manifestPath.trim().length === 0}>
            <RefreshCw aria-hidden="true" className={detail.loading ? "spin" : ""} />
            Review
          </button>
        </div>
      </form>

      {detail.error && (
        <div className="notice error">
          <CircleAlert aria-hidden="true" />
          <span>{detail.error}</span>
        </div>
      )}

      {detail.loading && <div className="emptyList">Loading install review</div>}

      {detail.plan && (
        <div className="detailBody">
          <dl className="planFacts">
            <div>
              <dt>App</dt>
              <dd>{detail.plan.displayName}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{detail.plan.currentVersion ? `${detail.plan.currentVersion} to ${detail.plan.targetVersion}` : detail.plan.targetVersion}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{detail.plan.targetRuntime}</dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd>{detail.plan.targetManifestDigest.slice(0, 16)}</dd>
            </div>
          </dl>
          {detail.plan.settings.length > 0 && (
            <div className="settingsForm">
              {detail.plan.settings.map((setting) => (
                <label key={setting.key}>
                  <span>
                    {setting.key}
                    <small>{setting.secret ? "secret" : setting.type}</small>
                  </span>
                  <input
                    type={setting.secret ? "password" : "text"}
                    value={settingsDraft[setting.key] ?? ""}
                    placeholder={setting.secret ? "Unchanged" : undefined}
                    onChange={(event) => setSettingsDraft((current) => ({ ...current, [setting.key]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="detailToolbar">
            <button className="button" type="button" onClick={apply} disabled={detail.plan.action !== "install" || busyAction === "install"}>
              <Plus aria-hidden="true" />
              Install app
            </button>
            {detail.plan.action !== "install" && <span className="mutedText">Already installed</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function UserManagementPanel({
  coreOrigin,
  sendCsrfJson,
}: {
  coreOrigin: string;
  sendCsrfJson: (endpoint: string, body?: unknown, method?: string) => Promise<Response>;
}) {
  const [users, setUsers] = useState<HostUserSummary[]>([]);
  const [invitations, setInvitations] = useState<UserInvitationSummary[]>([]);
  const [apps, setApps] = useState<AssignableAppSummary[]>([]);
  const [ttlOptions, setTtlOptions] = useState<InviteTtlOption[]>([
    { label: "15 minutes", ttlMs: 15 * 60 * 1000 },
    { label: "24 hours", ttlMs: 24 * 60 * 60 * 1000 },
    { label: "7 days", ttlMs: 7 * 24 * 60 * 60 * 1000 },
  ]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteRole, setInviteRole] = useState<"host.admin" | "host.user">("host.user");
  const [inviteTtlMs, setInviteTtlMs] = useState(24 * 60 * 60 * 1000);
  const [inviteAppIds, setInviteAppIds] = useState<string[]>([]);
  const [createdInvite, setCreatedInvite] = useState<{ setupUrl: string; token: string } | null>(null);
  const [accessUserId, setAccessUserId] = useState<string | null>(null);
  const [accessAppIds, setAccessAppIds] = useState<string[]>([]);

  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending");
  const accessUser = users.find((user) => user.id === accessUserId) ?? null;

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${coreOrigin}/api/auth/users`, { credentials: "include" });
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      const payload = (await response.json()) as UserManagementResponse;
      setUsers(payload.users || []);
      setInvitations(payload.invitations || []);
      setApps(payload.apps || payload.modules || []);
      if (payload.inviteTtlOptions?.length) {
        setTtlOptions(payload.inviteTtlOptions);
        setInviteTtlMs(payload.inviteTtlOptions[1]?.ttlMs ?? payload.inviteTtlOptions[0].ttlMs);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, [coreOrigin]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const runUserAction = useCallback(
    async (actionKey: string, action: () => Promise<void>) => {
      setPendingAction(actionKey);
      setError(null);
      try {
        await action();
        await loadUsers();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "User action failed.");
      } finally {
        setPendingAction(null);
      }
    },
    [loadUsers],
  );

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runUserAction("invite", async () => {
      const response = await sendCsrfJson(`${coreOrigin}/api/auth/invitations`, {
        email: inviteEmail,
        displayName: inviteDisplayName || null,
        role: inviteRole,
        ttlMs: inviteTtlMs,
        assignedModuleIds: inviteRole === "host.user" ? inviteAppIds : [],
      });
      const payload = (await response.json()) as { setupUrl: string; token: string };
      setCreatedInvite({ setupUrl: payload.setupUrl, token: payload.token });
      setInviteEmail("");
      setInviteDisplayName("");
      setInviteRole("host.user");
      setInviteAppIds([]);
    });
  };

  const updateRole = (user: HostUserSummary) => {
    const nextRole = user.role === "host.admin" ? "host.user" : "host.admin";
    void runUserAction(`role:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}`, { role: nextRole }, "PATCH");
    });
  };

  const disableUser = (user: HostUserSummary) => {
    if (!window.confirm(`Disable ${user.displayName || user.email || user.id}?`)) {
      return;
    }

    void runUserAction(`disable:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}`, undefined, "DELETE");
    });
  };

  const revokeInvite = (invitation: UserInvitationSummary) => {
    void runUserAction(`invite:${invitation.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/invitations/${encodeURIComponent(invitation.id)}`, undefined, "DELETE");
    });
  };

  const openAccessEditor = (user: HostUserSummary) => {
    setAccessUserId(user.id);
    setAccessAppIds(user.assignedModuleIds);
  };

  const saveAccess = () => {
    if (!accessUser) {
      return;
    }

    void runUserAction(`access:${accessUser.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(accessUser.id)}/assignments`, { assignedModuleIds: accessAppIds }, "PUT");
      setAccessUserId(null);
    });
  };

  const toggleAppSelection = (appId: string, selected: boolean, source: "invite" | "access") => {
    const setter = source === "invite" ? setInviteAppIds : setAccessAppIds;
    setter((current) => selected ? Array.from(new Set([...current, appId])).sort() : current.filter((candidate) => candidate !== appId));
  };

  const copyInvite = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Clipboard access failed.");
    }
  };

  return (
    <section className="usersView" aria-label="User management">
      <div className="sectionHeader">
        <h2>Users</h2>
        <button className="button ghost" type="button" onClick={() => void loadUsers()} disabled={loading}>
          <RefreshCw aria-hidden="true" className={loading ? "spin" : ""} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="notice error">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <section className="managementGrid">
        <form className="managementPanel" onSubmit={submitInvite}>
          <div className="panelHeader">
            <UserPlus aria-hidden="true" />
            <h3>Invite user</h3>
          </div>
          <label>
            <span>Email</span>
            <input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
          </label>
          <label>
            <span>Display name</span>
            <input value={inviteDisplayName} onChange={(event) => setInviteDisplayName(event.target.value)} />
          </label>
          <div className="formGrid">
            <label>
              <span>Role</span>
              <select
                value={inviteRole}
                onChange={(event) => {
                  const role = event.target.value === "host.admin" ? "host.admin" : "host.user";
                  setInviteRole(role);
                  if (role === "host.admin") {
                    setInviteAppIds([]);
                  }
                }}
              >
                <option value="host.user">User</option>
                <option value="host.admin">Admin</option>
              </select>
            </label>
            <label>
              <span>Expires</span>
              <select value={inviteTtlMs} onChange={(event) => setInviteTtlMs(Number(event.target.value))}>
                {ttlOptions.map((option) => (
                  <option key={option.ttlMs} value={option.ttlMs}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          {inviteRole === "host.user" && (
            <AppAccessPicker apps={apps} selectedAppIds={inviteAppIds} onToggle={(appId, selected) => toggleAppSelection(appId, selected, "invite")} />
          )}
          <button className="button" type="submit" disabled={pendingAction === "invite"}>
            <UserPlus aria-hidden="true" />
            Generate link
          </button>
        </form>

        <section className="managementPanel">
          <div className="panelHeader">
            <ShieldCheck aria-hidden="true" />
            <h3>Pending invitations</h3>
          </div>
          {pendingInvitations.length === 0 ? (
            <div className="emptyList">No pending invitations</div>
          ) : (
            <div className="compactList">
              {pendingInvitations.map((invitation) => (
                <article className="compactRow" key={invitation.id}>
                  <div>
                    <strong>{invitation.displayName || invitation.email}</strong>
                    <span>{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleString()}</span>
                  </div>
                  <button className="iconButton danger" type="button" onClick={() => revokeInvite(invitation)} disabled={pendingAction === `invite:${invitation.id}`}>
                    <Trash2 aria-hidden="true" />
                    <span>Revoke</span>
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>

      {createdInvite && (
        <section className="detailPanel">
          <div className="detailHeader">
            <div>
              <span>Invitation</span>
              <h2>Setup link generated</h2>
            </div>
            <button className="iconOnly" type="button" onClick={() => setCreatedInvite(null)} aria-label="Close invitation">
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="copyFields">
            <CopyField label="Setup URL" value={createdInvite.setupUrl} onCopy={copyInvite} />
            <CopyField label="Token" value={createdInvite.token} onCopy={copyInvite} />
          </div>
        </section>
      )}

      {loading ? (
        <div className="emptyList">Loading users</div>
      ) : (
        <section className="userList">
          {users.map((user) => (
            <article className="userRow" key={user.id}>
              <div>
                <strong>{user.displayName || user.email || user.id}</strong>
                <span>{user.email || user.id}</span>
              </div>
              <dl>
                <div>
                  <dt>Role</dt>
                  <dd>{user.disabled ? "disabled" : user.role}</dd>
                </div>
                <div>
                  <dt>Access</dt>
                  <dd>{user.role === "host.admin" ? "all apps" : `${user.assignedModuleIds.length} apps`}</dd>
                </div>
                <div>
                  <dt>Sessions</dt>
                  <dd>{user.activeSessionCount}</dd>
                </div>
              </dl>
              <div className="rowActions">
                {user.role === "host.user" && (
                  <button className="iconButton" type="button" onClick={() => openAccessEditor(user)} disabled={user.disabled}>
                    <UserCog aria-hidden="true" />
                    <span>Access</span>
                  </button>
                )}
                <button className="iconButton" type="button" onClick={() => updateRole(user)} disabled={user.disabled || pendingAction === `role:${user.id}`}>
                  <ShieldCheck aria-hidden="true" />
                  <span>{user.role === "host.admin" ? "Make user" : "Make admin"}</span>
                </button>
                <button className="iconButton danger" type="button" onClick={() => disableUser(user)} disabled={user.disabled || pendingAction === `disable:${user.id}`}>
                  <UserX aria-hidden="true" />
                  <span>Disable</span>
                </button>
              </div>
            </article>
          ))}
          {users.length === 0 && <div className="emptyList">No users</div>}
        </section>
      )}

      {accessUser && (
        <section className="detailPanel">
          <div className="detailHeader">
            <div>
              <span>App access</span>
              <h2>{accessUser.displayName || accessUser.email || accessUser.id}</h2>
            </div>
            <button className="iconOnly" type="button" onClick={() => setAccessUserId(null)} aria-label="Close access">
              <X aria-hidden="true" />
            </button>
          </div>
          <AppAccessPicker apps={apps} selectedAppIds={accessAppIds} onToggle={(appId, selected) => toggleAppSelection(appId, selected, "access")} />
          <div className="detailToolbar">
            <button className="button" type="button" onClick={saveAccess} disabled={pendingAction === `access:${accessUser.id}`}>
              <CheckCircle2 aria-hidden="true" />
              Save access
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

function AppAccessPicker({
  apps,
  selectedAppIds,
  onToggle,
}: {
  apps: AssignableAppSummary[];
  selectedAppIds: string[];
  onToggle: (appId: string, selected: boolean) => void;
}) {
  const knownIds = new Set(apps.map((app) => app.id));
  const options = [
    ...apps,
    ...selectedAppIds
      .filter((appId) => !knownIds.has(appId))
      .map((appId) => ({ id: appId, name: appId, version: "", operationStatus: "unavailable" })),
  ];
  const selected = new Set(selectedAppIds);

  return (
    <div className="accessPicker">
      {options.map((app) => (
        <label key={app.id}>
          <input type="checkbox" checked={selected.has(app.id)} onChange={(event) => onToggle(app.id, event.target.checked)} />
          <span>
            <strong>{app.name}</strong>
            <small>{app.id}</small>
          </span>
        </label>
      ))}
      {options.length === 0 && <div className="emptyList">No runtime apps</div>}
    </div>
  );
}

function CopyField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <label className="copyField">
      <span>{label}</span>
      <div>
        <input value={value} readOnly />
        <button className="iconButton" type="button" onClick={() => onCopy(value)}>
          <Copy aria-hidden="true" />
          <span>Copy</span>
        </button>
      </div>
    </label>
  );
}

function AppDetailsPanel({
  app,
  view,
  isShell,
  canManageApps,
  busyAction,
  detail,
  onClose,
  onRefreshLogs,
  onRefreshBackups,
  onCreateBackup,
  onRestoreBackup,
  onDeleteBackup,
  onConfigure,
  onReloadUpdatePlan,
  onApplyUpdate,
  onRemove,
}: {
  app: CoreApp;
  view: DetailView;
  isShell: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  detail: DetailPanelState;
  onClose: () => void;
  onRefreshLogs: (app: CoreApp) => void;
  onRefreshBackups: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>) => void;
  onReloadUpdatePlan: (app: CoreApp) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
}) {
  return (
    <section className="detailPanel" aria-label={`${app.displayName} details`}>
      <div className="detailHeader">
        <div>
          <span>{detailTitle(view)}</span>
          <h2>{app.displayName}</h2>
        </div>
        <button className="iconOnly" type="button" onClick={onClose} aria-label="Close details">
          <X aria-hidden="true" />
        </button>
      </div>

      {detail.error && (
        <div className="notice error">
          <CircleAlert aria-hidden="true" />
          <span>{detail.error}</span>
        </div>
      )}

      {view === "logs" && (
        <LogsPanel app={app} detail={detail} onRefresh={onRefreshLogs} />
      )}
      {view === "backups" && (
        <BackupsPanel
          app={app}
          detail={detail}
          busyAction={busyAction}
          onRefresh={onRefreshBackups}
          onCreateBackup={onCreateBackup}
          onRestoreBackup={onRestoreBackup}
          onDeleteBackup={onDeleteBackup}
        />
      )}
      {view === "configure" && (
        <ConfigurePanel app={app} busyAction={busyAction} canManageApps={canManageApps && !isShell} onConfigure={onConfigure} />
      )}
      {view === "update" && (
        <UpdatePanel app={app} detail={detail} busyAction={busyAction} onReloadPlan={onReloadUpdatePlan} onApplyUpdate={onApplyUpdate} />
      )}
      {view === "remove" && (
        <RemovePanel app={app} busyAction={busyAction} canRemove={canManageApps && !isShell} onRemove={onRemove} />
      )}
    </section>
  );
}

function LogsPanel({
  app,
  detail,
  onRefresh,
}: {
  app: CoreApp;
  detail: DetailPanelState;
  onRefresh: (app: CoreApp) => void;
}) {
  return (
    <div className="detailBody">
      <div className="detailToolbar">
        <button className="button" type="button" onClick={() => onRefresh(app)} disabled={detail.loading}>
          <RefreshCw aria-hidden="true" className={detail.loading ? "spin" : ""} />
          Refresh
        </button>
      </div>
      <pre className="logOutput">{detail.loading ? "Loading logs" : detail.logs || "No logs"}</pre>
    </div>
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
}: {
  app: CoreApp;
  detail: DetailPanelState;
  busyAction: string | null;
  onRefresh: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
}) {
  const backups = detail.backups || [];
  const isRunning = app.runtimeState === "running";

  return (
    <div className="detailBody">
      <div className="detailToolbar">
        <button className="button" type="button" onClick={() => onCreateBackup(app)} disabled={busyAction === `${app.id}:backup`}>
          <Archive aria-hidden="true" />
          Create backup
        </button>
        <button className="button ghost" type="button" onClick={() => onRefresh(app, false)} disabled={detail.loading}>
          <RefreshCw aria-hidden="true" className={detail.loading ? "spin" : ""} />
          Refresh
        </button>
      </div>
      <p className="retentionNote">Manual backups are kept until deleted. Pre-update and pre-restore backups keep the latest five per app.</p>
      {detail.loading ? (
        <div className="emptyList">Loading backups</div>
      ) : backups.length === 0 ? (
        <div className="emptyList">No backups</div>
      ) : (
        <div className="backupList">
          {backups.map((backup) => (
            <article className="backupRow" key={backup.backupId}>
              <div>
                <strong>{backup.reason}</strong>
                <span>{new Date(backup.createdAt).toLocaleString()}</span>
                <code>{backup.backupId}</code>
              </div>
              <dl>
                <div>
                  <dt>Files</dt>
                  <dd>{backup.fileCount}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(backup.archiveSize)}</dd>
                </div>
              </dl>
              <div className="rowActions">
                <button
                  className="iconButton"
                  type="button"
                  onClick={() => onRestoreBackup(app, backup)}
                  disabled={isRunning || busyAction === `${app.id}:restore:${backup.backupId}`}
                >
                  <Upload aria-hidden="true" />
                  <span>Restore</span>
                </button>
                <button
                  className="iconButton danger"
                  type="button"
                  onClick={() => onDeleteBackup(app, backup)}
                  disabled={busyAction === `${app.id}:delete-backup:${backup.backupId}`}
                >
                  <Trash2 aria-hidden="true" />
                  <span>Delete</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigurePanel({
  app,
  busyAction,
  canManageApps,
  onConfigure,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>) => void;
}) {
  const settings = app.settings || [];
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? "" : setting.value || ""])));
  }, [app.id, settings]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: Record<string, string | null> = {};
    for (const setting of settings) {
      const value = draft[setting.key] ?? "";
      if (!setting.secret || value.length > 0) {
        payload[setting.key] = value;
      }
    }

    onConfigure(app, payload);
  };

  if (settings.length === 0) {
    return <div className="emptyList">No settings</div>;
  }

  return (
    <form className="settingsForm" onSubmit={submit}>
      {settings.map((setting) => (
        <label key={setting.key}>
          <span>
            {setting.key}
            <small>{setting.secret ? "secret" : setting.type}</small>
          </span>
          <input
            type={setting.secret ? "password" : "text"}
            value={draft[setting.key] ?? ""}
            placeholder={setting.secret ? "Unchanged" : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))}
            disabled={!canManageApps}
          />
        </label>
      ))}
      <div className="detailToolbar">
        <button className="button" type="submit" disabled={!canManageApps || busyAction === `${app.id}:configure`}>
          <Settings aria-hidden="true" />
          Save settings
        </button>
      </div>
    </form>
  );
}

function UpdatePanel({
  app,
  detail,
  busyAction,
  onReloadPlan,
  onApplyUpdate,
}: {
  app: CoreApp;
  detail: DetailPanelState;
  busyAction: string | null;
  onReloadPlan: (app: CoreApp) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void;
}) {
  const plan = detail.updatePlan;

  return (
    <div className="detailBody">
      <div className="detailToolbar">
        <button className="button ghost" type="button" onClick={() => onReloadPlan(app)} disabled={detail.loading}>
          <RefreshCw aria-hidden="true" className={detail.loading ? "spin" : ""} />
          Recheck
        </button>
      </div>
      {detail.loading ? (
        <div className="emptyList">Loading update plan</div>
      ) : plan ? (
        <>
          <dl className="planFacts">
            <div>
              <dt>Version</dt>
              <dd>
                {plan.currentVersion} to {plan.targetVersion}
              </dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>
                {plan.currentRuntime || "none"} to {plan.targetRuntime}
              </dd>
            </div>
            <div>
              <dt>Backup</dt>
              <dd>{plan.willCreatePreUpdateBackup ? "pre-update" : "none"}</dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd>{plan.planDigest.slice(0, 16)}</dd>
            </div>
          </dl>
          <ul className="changeList">
            {plan.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          <div className="detailToolbar">
            <button className="button" type="button" onClick={() => onApplyUpdate(app, plan)} disabled={busyAction === `${app.id}:update`}>
              <Upload aria-hidden="true" />
              Apply update
            </button>
          </div>
        </>
      ) : (
        <div className="emptyList">No update plan</div>
      )}
    </div>
  );
}

function RemovePanel({
  app,
  busyAction,
  canRemove,
  onRemove,
}: {
  app: CoreApp;
  busyAction: string | null;
  canRemove: boolean;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
}) {
  const [options, setOptions] = useState<RemoveOptions>({
    deleteData: false,
    deleteBackups: false,
    deleteSource: false,
    ignoreRuntimeErrors: false,
  });

  return (
    <div className="dangerZone">
      <label>
        <input
          type="checkbox"
          checked={options.deleteData}
          onChange={(event) => setOptions((current) => ({ ...current, deleteData: event.target.checked }))}
          disabled={!canRemove}
        />
        Delete app data
      </label>
      <label>
        <input
          type="checkbox"
          checked={options.deleteBackups}
          onChange={(event) => setOptions((current) => ({ ...current, deleteBackups: event.target.checked }))}
          disabled={!canRemove}
        />
        Delete backups
      </label>
      <label>
        <input
          type="checkbox"
          checked={options.deleteSource}
          onChange={(event) => setOptions((current) => ({ ...current, deleteSource: event.target.checked }))}
          disabled={!canRemove}
        />
        Delete source checkout
      </label>
      <label>
        <input
          type="checkbox"
          checked={options.ignoreRuntimeErrors}
          onChange={(event) => setOptions((current) => ({ ...current, ignoreRuntimeErrors: event.target.checked }))}
          disabled={!canRemove}
        />
        Ignore runtime errors
      </label>
      <div className="detailToolbar">
        <button className="button danger" type="button" onClick={() => onRemove(app, options)} disabled={!canRemove || busyAction === `${app.id}:remove`}>
          <Trash2 aria-hidden="true" />
          Remove app
        </button>
      </div>
    </div>
  );
}

function detailTitle(view: DetailView) {
  switch (view) {
    case "logs":
      return "Logs";
    case "backups":
      return "Backups";
    case "configure":
      return "Configure";
    case "update":
      return "Update";
    case "remove":
      return "Remove";
  }
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
