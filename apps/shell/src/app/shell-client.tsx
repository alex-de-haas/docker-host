"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Boxes,
  CheckCircle2,
  CircleAlert,
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
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

type CoreStatus = {
  status: string;
  component: string;
  dataRoot: string;
  listenUrl: string;
  corePublicOrigin?: string | null;
  shellPublicOrigin?: string | null;
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

  const readCoreError = async (response: Response) => {
    try {
      const error = (await response.json()) as CoreError;
      return error.message || error.code || `Core returned ${response.status}.`;
    } catch {
      return `Core returned ${response.status}.`;
    }
  };

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
          <a href="#system">
            <LayoutGrid aria-hidden="true" />
            System apps
          </a>
          <a href="#runtime">
            <Boxes aria-hidden="true" />
            Runtime apps
          </a>
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
}: {
  app: CoreApp;
  isShell: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: (app: CoreApp, view: DetailView) => void;
}) {
  const running = app.runtimeState === "running";
  const openEndpoint = app.endpoints?.find((endpoint) => endpoint.public && endpoint.url) ?? app.endpoints?.find((endpoint) => endpoint.url);
  const openHref = isShell ? "/" : openEndpoint?.url || "#";
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
          <a className="openLink" href={openHref} aria-disabled={!canOpen} target={isShell ? undefined : "_blank"} rel={isShell ? undefined : "noreferrer"}>
            <ExternalLink aria-hidden="true" />
            Open
          </a>
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
