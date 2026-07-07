"use client";

import type { ReactNode } from "react";
import { AvailableAppsPage } from "./pages/available-apps-page";
import { DashboardPage } from "./pages/dashboard-page";
import { InstalledAppsPage } from "./pages/installed-apps-page";
import { MarketplacePage } from "./pages/marketplace-page";
import { ObservabilityMetricsPage } from "./pages/observability/metrics-page";
import { ObservabilityStructuredLogsPage } from "./pages/observability/structured-logs-page";
import { ObservabilityTracesPage } from "./pages/observability/traces-page";
import { UserManagementPanel } from "./pages/user-management-page";
import { useShellActions, useShellState } from "./shell-context";

function AdminShellRoute({ children }: { children: ReactNode }) {
  const shell = useShellState();
  return shell.canManageApps ? children : <ShellAvailableAppsRoute />;
}

// Admin gate + Observability gate: the backend-backed Observability routes need the telemetry backend
// app running. When it is off (or Core is briefly reporting it as not-running — its runtimeState can lag
// reality), show an inline empty state instead of a silent redirect to the dashboard, so a stale-state
// false negative no longer makes the whole section vanish (S-H2). Non-admins are handled by
// AdminShellRoute. Waits for apps to load so a running backend is not briefly treated as absent.
function ObservabilityRoute({ children }: { children: ReactNode }) {
  const shell = useShellState();
  const unavailable = !shell.state.loading && !shell.observabilityAvailable;
  return <AdminShellRoute>{unavailable ? <TelemetryBackendUnavailable /> : children}</AdminShellRoute>;
}

function TelemetryBackendUnavailable() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h2 className="text-lg font-semibold">Telemetry backend is not running</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Observability reads from the telemetry backend system app. Start it from Installed apps to see
          metrics, structured logs, and traces. If you just started it, this refreshes on the next load.
        </p>
      </div>
    </div>
  );
}

export function ShellAvailableAppsRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AvailableAppsPage
      apps={shell.uiRuntimeApps}
      loading={shell.state.loading}
      busyAction={shell.busyAction}
      onLaunchApp={shellActions.launchAppPage}
      getStandaloneHref={shellActions.getStandaloneAppHref}
    />
  );
}

export function ShellDashboardRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <DashboardPage
        state={shell.state}
        runtimeApps={shell.runtimeApps}
        onRefresh={() => void shellActions.refresh()}
        onOpenInstalledApps={shellActions.openInstalledApps}
      />
    </AdminShellRoute>
  );
}

export function ShellInstalledAppsRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <InstalledAppsPage
        coreOrigin={shellActions.coreOrigin}
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        shellAppId={shellActions.shellAppId}
        canManageApps={shell.canManageApps}
        loading={shell.state.loading}
        busyAction={shell.busyAction}
        updateStatusInvalidations={shell.updateStatusInvalidations}
        onRefresh={() => void shellActions.refresh()}
        onInstall={shellActions.openInstallDialog}
        onAction={shellActions.runAppAction}
        onSwitchRuntime={shellActions.switchAppRuntime}
        onSetDevelopmentMode={shellActions.configureAppDevelopmentMode}
        onOpenPanel={shellActions.openAppPanel}
        onOpenSharedMounts={shellActions.openSharedMounts}
      />
    </AdminShellRoute>
  );
}

export function ShellMarketplaceRoute() {
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <MarketplacePage
        coreOrigin={shellActions.coreOrigin}
        onInstall={shellActions.openInstallDialog}
        sendCsrfJson={shellActions.sendCsrfJson}
      />
    </AdminShellRoute>
  );
}

export function ShellUsersRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <UserManagementPanel
        coreOrigin={shellActions.coreOrigin}
        activeUser={shell.activeUser}
        sendCsrfJson={shellActions.sendCsrfJson}
      />
    </AdminShellRoute>
  );
}

export function ShellObservabilityMetricsRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <ObservabilityRoute>
      <ObservabilityMetricsPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </ObservabilityRoute>
  );
}

export function ShellObservabilityLogsRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <ObservabilityRoute>
      <ObservabilityStructuredLogsPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </ObservabilityRoute>
  );
}

export function ShellObservabilityTracesRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <ObservabilityRoute>
      <ObservabilityTracesPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </ObservabilityRoute>
  );
}

export function ShellWorkspaceRoute() {
  // Active workspace URLs are rendered by the persistent Shell layout from query state.
  // A bare /workspace route falls back here while the client-side route normalization runs.
  return <ShellAvailableAppsRoute />;
}
