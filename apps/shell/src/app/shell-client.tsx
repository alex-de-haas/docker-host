"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  Server,
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
};

type AppsResponse = {
  apps: CoreApp[];
};

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

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [statusResponse, appsResponse, sessionResponse] = await Promise.all([
        fetch(`${coreOrigin}/api/core/status`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/apps`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/session`, { credentials: "include" }),
      ]);

      if (!statusResponse.ok) {
        throw new Error(`Core status returned ${statusResponse.status}.`);
      }
      if (!appsResponse.ok) {
        throw new Error(`Apps API returned ${appsResponse.status}.`);
      }

      const status = (await statusResponse.json()) as CoreStatus;
      const apps = (await appsResponse.json()) as AppsResponse;
      const session = sessionResponse.ok ? ((await sessionResponse.json()) as SessionResponse) : null;
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const systemApps = useMemo(() => state.apps.filter((app) => app.system), [state.apps]);
  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const activeUser = state.session?.authenticated ? state.session.user : null;

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
            <AppSection id="system" title="System apps" apps={systemApps} shellAppId={shellAppId} />
            <AppSection id="runtime" title="Runtime apps" apps={runtimeApps} shellAppId={shellAppId} />
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
}: {
  id: string;
  title: string;
  apps: CoreApp[];
  shellAppId: string;
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
            <AppCard key={app.id} app={app} isShell={app.id === shellAppId} />
          ))}
        </div>
      )}
    </section>
  );
}

function AppCard({ app, isShell }: { app: CoreApp; isShell: boolean }) {
  const running = app.runtimeState === "running";

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
        <a className="openLink" href={`${app.id === "hosty.shell" ? "/" : "#"}`} aria-disabled={!running || isShell}>
          <ExternalLink aria-hidden="true" />
          Open
        </a>
      </div>
    </article>
  );
}
