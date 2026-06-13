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
  coreOrigin: string;
  shellAppId: string;
  state: LoadState;
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  uiRuntimeApps: CoreApp[];
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  busyAction: string | null;
  refresh: () => Promise<void>;
  sendCsrfJson: (endpoint: string, body?: unknown, method?: string) => Promise<Response>;
  launchAppPage: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneAppHref: (app: CoreApp, page: AppPageLink) => string;
  openInstallDialog: () => void;
  runAppAction: (app: CoreApp, action: AppAction) => Promise<void>;
  switchAppRuntime: (app: CoreApp, targetRuntime: string) => Promise<void>;
  createManualBackup: (app: CoreApp) => Promise<void>;
  openAppPanel: OpenAppPanel;
  openInstalledApps: () => void;
};

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const context = useContext(ShellContext);
  if (!context) {
    throw new Error("useShell must be used within ShellClient.");
  }

  return context;
}
