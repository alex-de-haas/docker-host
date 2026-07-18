"use client";

import { createContext, useContext } from "react";
import type {
  AppAction,
  AppOpenTarget,
  AppPageLink,
  CoreApp,
  LoadState,
  OpenAppPanel,
  SessionResponse,
} from "./types";

export type ShellContextValue = {
  state: LoadState;
  // Non-system apps only (the dashboard's counters); the Installed Apps page renders state.apps —
  // runtime and system apps as one list.
  runtimeApps: CoreApp[];
  uiRuntimeApps: CoreApp[];
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  busyAction: string | null;
  // Per-app counter bumped whenever a mutation resets an app's artifact locks (apply update, switch
  // runtime), which makes any cached "update available" verdict stale. The Installed Apps page watches
  // it to re-probe the affected app so the row Update icon does not linger after the update lands.
  updateStatusInvalidations: Record<string, number>;
};

export type ShellActionsContextValue = {
  coreOrigin: string;
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
  openInstalledApps: () => void;
  openSharedMounts: () => void;
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
