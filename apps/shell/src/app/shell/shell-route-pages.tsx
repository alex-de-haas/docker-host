"use client";

import { AvailableAppsPage } from "./pages/available-apps-page";
import { DashboardPage } from "./pages/dashboard-page";
import { InstalledAppsPage } from "./pages/installed-apps-page";
import { UserManagementPanel } from "./pages/user-management-page";
import { useShell } from "./shell-context";

export function ShellAvailableAppsRoute() {
  const shell = useShell();

  return (
    <AvailableAppsPage
      apps={shell.uiRuntimeApps}
      loading={shell.state.loading}
      busyAction={shell.busyAction}
      onLaunchApp={shell.launchAppPage}
      getStandaloneHref={shell.getStandaloneAppHref}
    />
  );
}

export function ShellDashboardRoute() {
  const shell = useShell();
  if (!shell.canManageApps) {
    return <ShellAvailableAppsRoute />;
  }

  return (
    <DashboardPage
      state={shell.state}
      runtimeApps={shell.runtimeApps}
      onRefresh={() => void shell.refresh()}
      onOpenInstalledApps={shell.openInstalledApps}
    />
  );
}

export function ShellInstalledAppsRoute() {
  const shell = useShell();
  if (!shell.canManageApps) {
    return <ShellAvailableAppsRoute />;
  }

  return (
    <InstalledAppsPage
      coreOrigin={shell.coreOrigin}
      runtimeApps={shell.runtimeApps}
      systemApps={shell.systemApps}
      shellAppId={shell.shellAppId}
      canManageApps={shell.canManageApps}
      loading={shell.state.loading}
      busyAction={shell.busyAction}
      onRefresh={() => void shell.refresh()}
      onInstall={shell.openInstallDialog}
      onAction={shell.runAppAction}
      onSwitchRuntime={shell.switchAppRuntime}
      onCreateBackup={shell.createManualBackup}
      onOpenPanel={shell.openAppPanel}
    />
  );
}

export function ShellUsersRoute() {
  const shell = useShell();
  if (!shell.canManageApps) {
    return <ShellAvailableAppsRoute />;
  }

  return (
    <UserManagementPanel
      coreOrigin={shell.coreOrigin}
      activeUser={shell.activeUser}
      sendCsrfJson={shell.sendCsrfJson}
    />
  );
}
