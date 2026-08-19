"use client";

import { createContext, useContext } from "react";
import type {
  AppAction,
  AppOpenTarget,
  AppPageLink,
  CoreApp,
  CoreGlobalMount,
  CoreSettingsState,
  CoreUpdateStatus,
  HostyResolvedTheme,
  HostyThemePreference,
  LoadState,
  OpenAppPanel,
  SessionResponse,
} from "./types";
import type { AppSurfaceTab } from "./surfaces/app-surface-tabs";
import type { DelegatedTokenGrant } from "./workspace/delegated-token-intent";

export type ShellContextValue = {
  state: LoadState;
  // Every app with a UI, ordinary and system alike, minus the Shell itself. Dashboard renders
  // state.apps instead — the full roster it manages.
  uiApps: CoreApp[];
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  busyAction: string | null;
  // Per-app counter bumped whenever a mutation resets an app's artifact locks (apply update, switch
  // runtime), which makes any cached "update available" verdict stale. Dashboard watches it to
  // re-probe the affected app so the row Update icon does not linger after the update lands.
  updateStatusInvalidations: Record<string, number>;
  // Host settings: which tab the URL selected, plus the data the Core and Shared mounts tabs render.
  // A raw string, because the value is either a host tab or the id of an app whose settings page
  // fills the tab (docs/features/app-ui-surfaces/feature.md).
  settingsTab: string;
  // Installed apps declaring `ui.settings`, already resolved to an embeddable URL by Core.
  appSettingsTabs: AppSurfaceTab[];
  shellTheme: HostyResolvedTheme;
  shellThemePreference: HostyThemePreference;
  coreSettings: CoreSettingsState | null;
  coreSettingsError: string | null;
  globalMounts: CoreGlobalMount[];
  // Core's own version verdict, rendered by Dashboard's Core section beside the update action.
  coreUpdate: CoreUpdateStatus | null;
  coreUpdating: boolean;
};

export type ShellActionsContextValue = {
  coreOrigin: string;
  // Embedding callbacks the Settings tabs hand to the shared app frame. The delegated-token one is
  // undefined for every app that does not already qualify, so a new embedding context cannot widen
  // that grant by existing.
  onEmbeddedAuthRequired: (appId: string) => void;
  requestDelegatedTokenFor: (appId: string) => ((refresh: boolean) => Promise<DelegatedTokenGrant>) | undefined;
  openSurfaceFrame: (appId: string, embeddedUrl: string) => Promise<string>;
  startAppById: (appId: string) => void;
  shellAppId: string;
  refresh: () => Promise<void>;
  sendCsrfJson: (endpoint: string, body?: unknown, method?: string) => Promise<Response>;
  launchAppPage: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneAppHref: (app: CoreApp, page: AppPageLink) => string;
  // Opens the direct-manifest install review dialog. Feed intents use the separate iframe handoff
  // and Core's digest-bound feed plan path.
  openInstallDialog: (manifestPath?: string) => void;
  runAppAction: (app: CoreApp, action: AppAction) => Promise<void>;
  switchAppRuntime: (app: CoreApp, targetRuntime: string) => Promise<void>;
  // Plan-first updates: one-click apply of a routine verdict from the row, the fleet update-check
  // trigger, and the apply-everything-routine action.
  applyUpdateFromRow: (app: CoreApp) => Promise<void>;
  startUpdateCheck: () => Promise<void>;
  updateAllApps: () => Promise<void>;
  configureAppDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => Promise<void>;
  createManualBackup: (app: CoreApp) => Promise<void>;
  openAppPanel: OpenAppPanel;
  // Host settings mutations, and the Core self-update Dashboard offers beside the version.
  saveCoreSettings: (values: Record<string, string>) => Promise<void>;
  saveGlobalMount: (input: {
    name: string;
    hostPath: string;
    mode?: string;
    description?: string | null;
  }) => Promise<void>;
  deleteGlobalMount: (name: string, force?: boolean) => Promise<void>;
  updateCore: () => Promise<void>;
};

export const ShellStateContext = createContext<ShellContextValue | null>(null);
export const ShellActionsContext = createContext<ShellActionsContextValue | null>(null);

export function useShellState() {
  const context = useContext(ShellStateContext);
  if (!context) {
    throw new Error("useShellState must be used within ShellClient.");
  }

  return context;
}

export function useShellActions() {
  const context = useContext(ShellActionsContext);
  if (!context) {
    throw new Error("useShellActions must be used within ShellClient.");
  }

  return context;
}
