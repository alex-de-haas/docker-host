"use client";

import type { ReactNode } from "react";
import { AvailableAppsPage } from "./pages/available-apps-page";
import { DashboardPage } from "./pages/dashboard-page";
import { InstalledAppsPage } from "./pages/installed-apps-page";
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
        onCreateBackup={shellActions.createManualBackup}
        onOpenPanel={shellActions.openAppPanel}
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

export function ShellWorkspaceRoute() {
  // The persistent Shell layout renders active workspaces from the /workspace query state.
  return null;
}
