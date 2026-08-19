"use client";

import type { ReactNode } from "react";
import { AvailableAppsPage } from "./pages/available-apps-page";
import { DashboardPage } from "./pages/dashboard-page";
import { SettingsPage } from "./pages/settings-page";
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
      apps={shell.uiApps}
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
        coreOrigin={shellActions.coreOrigin}
        apps={shell.state.apps}
        status={shell.state.status}
        coreUpdate={shell.coreUpdate}
        coreUpdating={shell.coreUpdating}
        onUpdateCore={() => void shellActions.updateCore()}
        shellAppId={shellActions.shellAppId}
        canManageApps={shell.canManageApps}
        loading={shell.state.loading}
        busyAction={shell.busyAction}
        updateCheck={shell.state.updateCheck ?? null}
        updateStatusInvalidations={shell.updateStatusInvalidations}
        onRefresh={() => void shellActions.refresh()}
        onInstall={shellActions.openInstallDialog}
        onAction={shellActions.runAppAction}
        onSwitchRuntime={shellActions.switchAppRuntime}
        onSetDevelopmentMode={shellActions.configureAppDevelopmentMode}
        onUpdateApp={shellActions.applyUpdateFromRow}
        onCheckUpdates={shellActions.startUpdateCheck}
        onUpdateAll={shellActions.updateAllApps}
        onOpenPanel={shellActions.openAppPanel}
      />
    </AdminShellRoute>
  );
}

export function ShellSettingsRoute() {
  const shell = useShellState();
  const shellActions = useShellActions();

  return (
    <AdminShellRoute>
      <SettingsPage
        activeTab={shell.settingsTab}
        appTabs={shell.appSettingsTabs}
        appTabProps={{
          theme: shell.shellTheme,
          themePreference: shell.shellThemePreference,
          onAuthRequired: shellActions.onEmbeddedAuthRequired,
          resolveDelegatedTokenRequest: shellActions.requestDelegatedTokenFor,
          onOpenSettingsFrame: shellActions.openSettingsFrame,
          onStartApp: shellActions.startAppById,
        }}
        coreOrigin={shellActions.coreOrigin}
        activeUser={shell.activeUser}
        sendCsrfJson={shellActions.sendCsrfJson}
        coreSettings={shell.coreSettings}
        coreSettingsError={shell.coreSettingsError}
        onSaveCoreSettings={shellActions.saveCoreSettings}
        globalMounts={shell.globalMounts}
        canManageApps={shell.canManageApps}
        onSaveMount={shellActions.saveGlobalMount}
        onDeleteMount={shellActions.deleteGlobalMount}
      />
    </AdminShellRoute>
  );
}

export function ShellWorkspaceRoute() {
  // Active workspace URLs are rendered by the persistent Shell layout from query state.
  // A bare /workspace route falls back here while the client-side route normalization runs.
  return <ShellAvailableAppsRoute />;
}
