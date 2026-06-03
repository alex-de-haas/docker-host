"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Archive,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  Square,
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

type CoreError = {
  code?: string;
  message?: string;
};

type AppAction = "start" | "stop" | "restart" | "backup";

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

  const runAppAction = useCallback(
    async (app: CoreApp, action: AppAction) => {
      const actionKey = `${app.id}:${action}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const csrf = await loadCsrfToken();
        const endpoint =
          action === "backup"
            ? `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/backups`
            : `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/${action}`;
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Hosty-CSRF": csrf,
          },
          body: action === "backup" ? JSON.stringify({ reason: "manual" }) : "{}",
        });

        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

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
    [coreOrigin, loadCsrfToken, refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const systemApps = useMemo(() => state.apps.filter((app) => app.system), [state.apps]);
  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";

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
            <AppSection
              id="system"
              title="System apps"
              apps={systemApps}
              shellAppId={shellAppId}
              canManageApps={canManageApps}
              busyAction={busyAction}
              onAction={runAppAction}
            />
            <AppSection
              id="runtime"
              title="Runtime apps"
              apps={runtimeApps}
              shellAppId={shellAppId}
              canManageApps={canManageApps}
              busyAction={busyAction}
              onAction={runAppAction}
            />
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
}: {
  id: string;
  title: string;
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
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
}: {
  app: CoreApp;
  isShell: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
}) {
  const running = app.runtimeState === "running";
  const openEndpoint = app.endpoints?.find((endpoint) => endpoint.public && endpoint.url) ?? app.endpoints?.find((endpoint) => endpoint.url);
  const openHref = isShell ? "/" : openEndpoint?.url || "#";
  const canOpen = isShell || (running && Boolean(openEndpoint?.url));
  const canControl = canManageApps && !isShell;
  const canBackup = canControl && app.capabilities.includes("backup");
  const isBusy = (action: AppAction) => busyAction === `${app.id}:${action}`;

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
          {canBackup && (
            <button className="iconButton" type="button" onClick={() => onAction(app, "backup")} disabled={isBusy("backup")}>
              <Archive aria-hidden="true" />
              <span>Backup</span>
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
