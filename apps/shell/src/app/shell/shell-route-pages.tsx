"use client";

import type { ReactNode } from "react";
import { AvailableAppsPage } from "./pages/available-apps-page";
import { DashboardPage } from "./pages/dashboard-page";
import { InstalledAppsPage } from "./pages/installed-apps-page";
import { ObservabilityConsoleLogsPage } from "./pages/observability/console-logs-page";
import { ObservabilityMetricsPage } from "./pages/observability/metrics-page";
import { ObservabilityStructuredLogsPage } from "./pages/observability/structured-logs-page";
import { ObservabilityTracesPage } from "./pages/observability/traces-page";
import { UserManagementPanel } from "./pages/user-management-page";
import { useShellActions, useShellState } from "./shell-context";

function AdminShellRoute({ children }: { children: ReactNode }) {
  const shell = useShellState();
  return shell.canManageApps ? children : <ShellAvailableAppsRoute />;
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
    <AdminShellRoute>
      <ObservabilityMetricsPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </AdminShellRoute>
  );
}

export function ShellObservabilityConsoleRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <ObservabilityConsoleLogsPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </AdminShellRoute>
  );
}

export function ShellObservabilityLogsRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <ObservabilityStructuredLogsPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </AdminShellRoute>
  );
}

export function ShellObservabilityTracesRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <ObservabilityTracesPage
        runtimeApps={shell.runtimeApps}
        systemApps={shell.systemApps}
        coreOrigin={shellActions.coreOrigin}
      />
    </AdminShellRoute>
  );
}

export function ShellWorkspaceRoute() {
  // Active workspace URLs are rendered by the persistent Shell layout from query state.
  // A bare /workspace route falls back here while the client-side route normalization runs.
  return <ShellAvailableAppsRoute />;
}
