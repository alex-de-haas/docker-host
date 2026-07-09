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
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  uiRuntimeApps: CoreApp[];
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  // The telemetry backend system app is installed + running, so the backend-backed Observability views
  // have data. Gates both the sidebar section and direct navigation to /observability/*.
  observabilityAvailable: boolean;
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
  // Opens the install review dialog. An optional manifest path/URL pre-fills the review field — the
  // marketplace passes a catalog feed's manifestRef (plus the feed id, recorded as the followed feed)
  // so install flows through the existing reviewed path.
  openInstallDialog: (manifestPath?: string, catalogFeedId?: string) => void;
  runAppAction: (app: CoreApp, action: AppAction) => Promise<void>;
  switchAppRuntime: (app: CoreApp, targetRuntime: string) => Promise<void>;
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
