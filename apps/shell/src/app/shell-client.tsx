"use client";

import { Fragment, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Gauge,
  Home,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Sun,
  Trash2,
  Upload,
  UserCog,
  UserPlus,
  Users,
  UserX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type CoreStatus = {
  status: string;
  component: string;
  dataRoot: string;
  listenUrl: string;
  corePublicOrigin?: string | null;
  shellPublicOrigin?: string | null;
  runtimePublicHost?: string | null;
  warnings?: string[];
  serverTime: string;
};

type CoreSetting = {
  key: string;
  type: string;
  value?: string | null;
  secret: boolean;
  required?: boolean;
};

type CoreEndpoint = {
  key: string;
  protocol: string;
  url?: string | null;
  public: boolean;
  service?: string | null;
  port?: string | null;
  publicOrigin?: string | null;
};

type CoreNavigationItem = {
  label: string;
  path: string;
  entryPath?: string | null;
  embeddedUrl?: string | null;
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
  autostart?: boolean | null;
  operationStatus: string;
  runtimeState: string;
  lastOperation?: string | null;
  lastError?: string | null;
  capabilities: string[];
  settings?: CoreSetting[];
  endpoints?: CoreEndpoint[];
  runtimeProfiles?: CoreRuntimeProfile[];
  navigation?: CoreNavigationItem[];
  entryPath?: string | null;
  embeddedUrl?: string | null;
};

type AppsResponse = {
  apps: CoreApp[];
};

type CoreBackup = {
  appId: string;
  backupId: string;
  reason: string;
  createdAt: string;
  dataPath: string;
  archivePath: string;
  archiveSha256: string;
  archiveSize: number;
  fileCount: number;
  retention?: CoreBackupRetentionStatus | null;
};

type BackupsResponse = {
  backups: CoreBackup[];
};

type CoreBackupRetentionStatus = {
  eligible: boolean;
  reason: string;
  wouldDeleteInCurrentPlan: boolean;
};

type CoreBackupCleanupCandidate = {
  appId: string;
  backupId: string;
  reason: string;
  cleanupReason: string;
  createdAt: string;
  archivePath?: string | null;
  metadataPath?: string | null;
  archiveSha256?: string | null;
  archiveSize?: number | null;
  automatic: boolean;
};

type CoreBackupCleanupPlan = {
  appId?: string | null;
  planDigest: string;
  createdAt: string;
  candidates: CoreBackupCleanupCandidate[];
};

type CoreBackupCleanupApplyResponse = {
  planDigest: string;
  deleted: CoreBackupCleanupCandidate[];
  skipped: CoreBackupCleanupCandidate[];
};

type LogsResponse = {
  appId: string;
  text: string;
};

type CoreRuntimeServiceHealth = {
  service: string;
  status: string;
  processId?: number | null;
  exitCode?: number | null;
  logPath?: string | null;
  workingDirectory?: string | null;
  message?: string | null;
};

type AppHealthResponse = {
  appId: string;
  runtime: string;
  runtimeType: string;
  status: string;
  services: CoreRuntimeServiceHealth[];
};

type CoreUpdatePlan = {
  appId: string;
  currentVersion: string;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetChannel?: string | null;
  manifestPath: string;
  manifestDigest: string;
  planDigest: string;
  willCreatePreUpdateBackup: boolean;
  changes: string[];
};

type CoreRuntimeSwitchPlan = {
  appId: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetRuntimeType: string;
  planDigest: string;
  automaticBackup: boolean;
  changes: string[];
};

type CoreInstallSetting = {
  key: string;
  type: string;
  defaultValue?: string | null;
  secret: boolean;
  required?: boolean;
};

type CoreRuntimeProfile = {
  key: string;
  type: string;
  default: boolean;
};

type CoreInstallRuntimeProfile = CoreRuntimeProfile;

type CoreInstallPlan = {
  appId: string;
  displayName: string;
  description?: string | null;
  action: string;
  currentVersion?: string | null;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetRuntimeType: string;
  manifestPath: string;
  currentManifestDigest?: string | null;
  targetManifestDigest: string;
  selectedChannel?: string | null;
  defaultAutostart?: boolean | null;
  runtimeProfiles?: CoreInstallRuntimeProfile[];
  settings: CoreInstallSetting[];
};

type CoreError = {
  code?: string;
  message?: string;
};

type AppAction = "start" | "stop" | "restart" | "backup";
type DetailView = "logs" | "backups" | "configure" | "update" | "remove";
type ShellView = "available-apps" | "dashboard" | "installed-apps" | "users";
type AppOpenTarget = "workspace" | "tab";
type HostyResolvedTheme = "light" | "dark";
type HostyThemePreference = "light" | "dark" | "system";

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

type AppLaunchResponse = {
  code: string;
  redirectUri: string;
  expiresAt: string;
};

type HostUserSummary = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  authProvider?: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  assignedAppIds: string[];
  lastSeenAt?: string | null;
};

type UserInvitationSummary = {
  id: string;
  email: string;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  assignedAppIds: string[];
  createdByUserId?: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
  revokedAt?: string | null;
  status: "pending" | "expired" | "used" | "revoked";
};

type AssignableAppSummary = {
  id: string;
  name: string;
  version: string;
  operationStatus: string;
};

type InviteTtlOption = {
  label: string;
  ttlMs: number;
};

type UserManagementResponse = {
  users: HostUserSummary[];
  invitations: UserInvitationSummary[];
  apps?: AssignableAppSummary[];
  inviteTtlOptions: InviteTtlOption[];
};

type LoadState = {
  loading: boolean;
  error: string | null;
  status: CoreStatus | null;
  apps: CoreApp[];
  session: SessionResponse | null;
  updatedAt: string | null;
};

type DetailPanelState = {
  loading: boolean;
  error: string | null;
  logs: string | null;
  backups: CoreBackup[] | null;
  backupCleanupPlan: CoreBackupCleanupPlan | null;
  updatePlan: CoreUpdatePlan | null;
};

type InstallPanelState = {
  loading: boolean;
  error: string | null;
  plan: CoreInstallPlan | null;
};

type ActivePanel = {
  appId: string;
  view: DetailView;
  configureSection?: "publicOrigins";
};

type OpenPanelOptions = {
  configureSection?: "publicOrigins";
};

type OpenAppPanel = (app: CoreApp, view: DetailView, options?: OpenPanelOptions) => void;

type RemoveOptions = {
  deleteData: boolean;
  deleteBackups: boolean;
  deleteSource: boolean;
  ignoreRuntimeErrors: boolean;
};

type AppPageLink = {
  label: string;
  path: string;
  redirectUri: string;
};

type EmbeddedWorkspace = {
  appId: string;
  title: string;
  pageLabel: string;
  path: string;
  src: string;
  externalUrl: string;
};

type RuntimeHealthState = {
  loading: boolean;
  error: string | null;
  health: AppHealthResponse | null;
};

type RuntimeServiceRow = {
  service: string;
  status: string;
  message?: string | null;
  endpoints: CoreEndpoint[];
};

const SIDEBAR_COMPACT_STORAGE_KEY = "hosty.shell.sidebar.compact";

const emptyDetailPanelState = (): DetailPanelState => ({
  loading: false,
  error: null,
  logs: null,
  backups: null,
  backupCleanupPlan: null,
  updatePlan: null,
});

const emptyInstallPanelState = (): InstallPanelState => ({
  loading: false,
  error: null,
  plan: null,
});

class AuthRequiredRedirectError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "AuthRequiredRedirectError";
  }
}

function isAuthRequiredRedirectError(error: unknown) {
  return error instanceof AuthRequiredRedirectError;
}

function isAuthRequiredResponse(response: Response) {
  return response.status === 401;
}

function redirectToCoreLogin(coreOrigin: string): never {
  window.location.assign(`${coreOrigin}/login`);
  throw new AuthRequiredRedirectError();
}

function redirectToCoreLoginIfAuthRequired(response: Response, coreOrigin: string) {
  if (isAuthRequiredResponse(response)) {
    redirectToCoreLogin(coreOrigin);
  }
}

async function readCoreError(response: Response) {
  try {
    const error = (await response.json()) as CoreError;
    return error.message || error.code || `Core returned ${response.status}.`;
  } catch {
    return `Core returned ${response.status}.`;
  }
}

function normalizeThemePreference(theme: string | undefined): HostyThemePreference {
  return theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
}

function resolveShellTheme(resolvedTheme: string | undefined): HostyResolvedTheme {
  if (resolvedTheme === "dark") {
    return "dark";
  }

  if (
    resolvedTheme !== "light" &&
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  ) {
    return "dark";
  }

  return "light";
}

function appendHostyThemeParams(
  redirectUri: string,
  theme: HostyResolvedTheme,
  preference: HostyThemePreference,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("hosty_theme", theme);
  url.searchParams.set("hosty_theme_preference", preference);
  return url.toString();
}

function isAppAutostartEnabled(app: CoreApp) {
  return app.autostart ?? true;
}

export function ShellClient({
  coreOrigin,
  shellAppId,
  initialView = "dashboard",
}: {
  coreOrigin: string;
  shellAppId: string;
  initialView?: ShellView;
}) {
  const { theme, resolvedTheme } = useTheme();
  const [state, setState] = useState<LoadState>({
    loading: true,
    error: null,
    status: null,
    apps: [],
    session: null,
    updatedAt: null,
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const [detailPanel, setDetailPanel] = useState<DetailPanelState>(emptyDetailPanelState);
  const [installOpen, setInstallOpen] = useState(false);
  const [installPanel, setInstallPanel] = useState<InstallPanelState>(emptyInstallPanelState);
  const [activeView, setActiveView] = useState<ShellView>(initialView);
  const [workspace, setWorkspace] = useState<EmbeddedWorkspace | null>(null);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const shellThemePreference = normalizeThemePreference(theme);
  const shellResolvedTheme = resolveShellTheme(resolvedTheme);
  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";

  useEffect(() => {
    setSidebarCompact(window.localStorage.getItem(SIDEBAR_COMPACT_STORAGE_KEY) === "true");
  }, []);

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [statusResponse, sessionResponse] = await Promise.all([
        fetch(`${coreOrigin}/api/core/status`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/session`, { credentials: "include" }),
      ]);

      redirectToCoreLoginIfAuthRequired(statusResponse, coreOrigin);
      if (!statusResponse.ok) {
        throw new Error(`Core status returned ${statusResponse.status}.`);
      }

      const status = (await statusResponse.json()) as CoreStatus;
      redirectToCoreLoginIfAuthRequired(sessionResponse, coreOrigin);
      if (!sessionResponse.ok) {
        throw new Error(await readCoreError(sessionResponse));
      }

      const session = (await sessionResponse.json()) as SessionResponse;
      if (!session.authenticated) {
        setState({
          loading: false,
          error: null,
          status,
          apps: [],
          session,
          updatedAt: new Date().toISOString(),
        });
        redirectToCoreLogin(coreOrigin);
      }

      let apps: AppsResponse = { apps: [] };
      if (session?.authenticated) {
        const appsResponse = await fetch(`${coreOrigin}/api/apps`, { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(appsResponse, coreOrigin);
        if (!appsResponse.ok) {
          throw new Error(`Apps API returned ${appsResponse.status}.`);
        }

        apps = (await appsResponse.json()) as AppsResponse;
      }

      setState({
        loading: false,
        error: null,
        status,
        apps: apps.apps,
        session,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (isAuthRequiredRedirectError(error)) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Core is unavailable.",
      }));
    }
  }, [coreOrigin]);

  const loadCsrfToken = useCallback(async () => {
    const response = await fetch(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) {
      throw new Error(`CSRF endpoint returned ${response.status}.`);
    }

    return ((await response.json()) as { token: string }).token;
  }, [coreOrigin]);

  const sendCsrfJson = useCallback(
    async (endpoint: string, body?: unknown, method = "POST") => {
      const csrf = await loadCsrfToken();
      const response = await fetch(endpoint, {
        method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Hosty-CSRF": csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      return response;
    },
    [coreOrigin, loadCsrfToken],
  );

  const appEndpoint = useCallback(
    (app: CoreApp, suffix: string) => `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}${suffix}`,
    [coreOrigin],
  );

  const getStandaloneAppHref = useCallback(
    (app: CoreApp, page: AppPageLink) => {
      const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
      const url = new URL(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/open`);
      url.searchParams.set("redirectUri", themedRedirectUri);
      return url.toString();
    },
    [coreOrigin, shellResolvedTheme, shellThemePreference],
  );

  const launchAppPage = useCallback(
    async (app: CoreApp, page: AppPageLink, target: AppOpenTarget = "workspace") => {
      if (app.id === shellAppId) {
        setWorkspace(null);
        setActiveView(canManageApps ? "dashboard" : "available-apps");
        return;
      }

      if (app.runtimeState !== "running") {
        setState((current) => ({ ...current, error: "App must be running before it can be opened." }));
        return;
      }

      if (target === "tab") {
        window.open(getStandaloneAppHref(app, page), "_blank", "noreferrer");
        return;
      }

      const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
      if (workspace?.appId === app.id) {
        setActiveView("available-apps");
        setWorkspace({
          appId: app.id,
          title: app.displayName,
          pageLabel: page.label,
          path: page.path,
          src: themedRedirectUri,
          externalUrl: getStandaloneAppHref(app, page),
        });
        return;
      }

      const actionKey = `${app.id}:open`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));

      try {
        const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: themedRedirectUri });
        const launch = (await response.json()) as AppLaunchResponse;
        setActiveView("available-apps");
        setWorkspace({
          appId: app.id,
          title: app.displayName,
          pageLabel: page.label,
          path: page.path,
          src: launch.redirectUri,
          externalUrl: launch.redirectUri,
        });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unable to create app launch link.";
        setState((current) => ({ ...current, error: message }));
        toast.error("App launch failed", { description: message });
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, canManageApps, getStandaloneAppHref, sendCsrfJson, shellAppId, shellResolvedTheme, shellThemePreference, workspace?.appId],
  );

  const runAppAction = useCallback(
    async (app: CoreApp, action: AppAction) => {
      const actionKey = `${app.id}:${action}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const endpoint = action === "backup" ? appEndpoint(app, "/backups") : appEndpoint(app, `/${action}`);
        await sendCsrfJson(endpoint, action === "backup" ? { reason: "manual" } : {});
        await refresh();
        toast.success(`${app.displayName}: ${action} complete`);
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Core lifecycle action failed.";
        setState((current) => ({ ...current, error: message }));
        toast.error("App action failed", { description: message });
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, coreOrigin, refresh, sendCsrfJson],
  );

  const switchAppRuntime = useCallback(
    async (app: CoreApp, targetRuntime: string) => {
      if (!targetRuntime || targetRuntime === app.selectedRuntime) {
        return;
      }

      const actionKey = `${app.id}:switch-runtime:${targetRuntime}`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));
      try {
        const planResponse = await fetch(appEndpoint(app, "/switch-runtime/plan"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetRuntime }),
        });
        redirectToCoreLoginIfAuthRequired(planResponse, coreOrigin);
        if (!planResponse.ok) {
          throw new Error(await readCoreError(planResponse));
        }

        const plan = (await planResponse.json()) as CoreRuntimeSwitchPlan;
        await sendCsrfJson(appEndpoint(app, "/switch-runtime"), {
          targetRuntime: plan.targetRuntime,
          planDigest: plan.planDigest,
        });
        await refresh();
        toast.success("Runtime switched", {
          description: `${app.displayName}: ${plan.currentRuntime || "none"} to ${plan.targetRuntime}`,
        });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        const message = error instanceof Error ? error.message : "Runtime switch failed.";
        setState((current) => ({ ...current, error: message }));
        toast.error("Runtime switch failed", { description: message });
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, coreOrigin, refresh, sendCsrfJson],
  );

  const loadAppLogs = useCallback(
    async (app: CoreApp) => {
      setActivePanel({ appId: app.id, view: "logs" });
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetch(`${appEndpoint(app, "/logs")}?tail=200`, { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as LogsResponse;
        setDetailPanel({ loading: false, error: null, logs: payload.text || "", backups: null, backupCleanupPlan: null, updatePlan: null });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core logs are unavailable.", logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint, coreOrigin],
  );

  const loadAppBackups = useCallback(
    async (app: CoreApp, activate = true) => {
      if (activate) {
        setActivePanel({ appId: app.id, view: "backups" });
      }
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetch(appEndpoint(app, "/backups"), { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as BackupsResponse;
        setDetailPanel({ loading: false, error: null, logs: null, backups: payload.backups, backupCleanupPlan: null, updatePlan: null });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core backups are unavailable.", logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint, coreOrigin],
  );

  const loadUpdatePlan = useCallback(
    async (app: CoreApp) => {
      setActivePanel({ appId: app.id, view: "update" });
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetch(appEndpoint(app, "/update/plan"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as CoreUpdatePlan;
        setDetailPanel({ loading: false, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: payload });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Update plan is unavailable.", logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint, coreOrigin],
  );

  const openAppPanel = useCallback(
    (app: CoreApp, view: DetailView, options?: OpenPanelOptions) => {
      if (view === "logs") {
        void loadAppLogs(app);
        return;
      }
      if (view === "backups") {
        void loadAppBackups(app);
        return;
      }
      if (view === "update") {
        void loadUpdatePlan(app);
        return;
      }
      setActivePanel({ appId: app.id, view, configureSection: options?.configureSection });
      setDetailPanel(emptyDetailPanelState());
    },
    [loadAppBackups, loadAppLogs, loadUpdatePlan],
  );

  const createManualBackup = useCallback(
    async (app: CoreApp) => {
      const actionKey = `${app.id}:backup`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/backups"), { reason: "manual" });
        await refresh();
        if (activePanel?.appId === app.id && activePanel.view === "backups") {
          await loadAppBackups(app, false);
        }
        toast.success("Backup created", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [activePanel, appEndpoint, loadAppBackups, refresh, sendCsrfJson],
  );

  const restoreBackup = useCallback(
    async (app: CoreApp, backup: CoreBackup) => {
      if (!window.confirm(`Restore backup ${backup.backupId}?`)) {
        return;
      }

      const actionKey = `${app.id}:restore:${backup.backupId}`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, `/backups/${encodeURIComponent(backup.backupId)}/restore`), { createPreRestoreBackup: true });
        await refresh();
        await loadAppBackups(app, false);
        toast.success("Backup restored", { description: backup.backupId });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Restore failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, loadAppBackups, refresh, sendCsrfJson],
  );

  const deleteBackup = useCallback(
    async (app: CoreApp, backup: CoreBackup) => {
      if (!window.confirm(`Delete backup ${backup.backupId}?`)) {
        return;
      }

      const actionKey = `${app.id}:delete-backup:${backup.backupId}`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, `/backups/${encodeURIComponent(backup.backupId)}`), undefined, "DELETE");
        await loadAppBackups(app, false);
        toast.success("Backup deleted", { description: backup.backupId });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup delete failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const previewBackupCleanup = useCallback(
    async (app: CoreApp) => {
      const actionKey = `${app.id}:backup-cleanup-plan`;
      setBusyAction(actionKey);
      try {
        const response = await fetch(appEndpoint(app, "/backups/cleanup/plan"), { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as CoreBackupCleanupPlan;
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: null,
          backupCleanupPlan: payload,
        }));
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup cleanup preview failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, coreOrigin],
  );

  const applyBackupCleanup = useCallback(
    async (app: CoreApp, plan: CoreBackupCleanupPlan) => {
      if (!window.confirm(`Delete ${plan.candidates.length} backup cleanup candidates?`)) {
        return;
      }

      const actionKey = `${app.id}:backup-cleanup`;
      setBusyAction(actionKey);
      try {
        const response = await sendCsrfJson(appEndpoint(app, "/backups/cleanup"), { planDigest: plan.planDigest });
        const result = (await response.json()) as CoreBackupCleanupApplyResponse;
        await loadAppBackups(app, false);
        if (result.skipped.length > 0) {
          setDetailPanel((current) => ({
            ...current,
            loading: false,
            error: `${result.skipped.length} backup cleanup candidates were skipped; refresh and preview again.`,
            backupCleanupPlan: null,
          }));
        } else {
          toast.success("Backup cleanup complete", { description: `${result.deleted.length} deleted` });
        }
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup cleanup failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, loadAppBackups, sendCsrfJson],
  );

  const configureApp = useCallback(
    async (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => {
      const actionKey = `${app.id}:configure`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/configure"), { settings, autostart });
        await refresh();
        setActivePanel(null);
        toast.success("Settings saved", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Configure failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const applyUpdate = useCallback(
    async (app: CoreApp, plan: CoreUpdatePlan) => {
      const actionKey = `${app.id}:update`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/update"), {
          planDigest: plan.planDigest,
          manifestPath: plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
          targetChannel: plan.targetChannel,
        });
        await refresh();
        setActivePanel(null);
        toast.success("Update applied", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Update failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const removeApp = useCallback(
    async (app: CoreApp, options: RemoveOptions) => {
      if (!window.confirm(`Remove ${app.displayName}?`)) {
        return;
      }

      const actionKey = `${app.id}:remove`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/remove"), {
          deleteRuntimeState: true,
          deleteData: options.deleteData,
          deleteBackups: options.deleteBackups,
          deleteSource: options.deleteSource,
          ignoreRuntimeErrors: options.ignoreRuntimeErrors,
        });
        await refresh();
        setActivePanel(null);
        if (workspace?.appId === app.id) {
          setWorkspace(null);
        }
        toast.success("App removed", { description: app.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Remove failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson, workspace?.appId],
  );

  const loadInstallPlan = useCallback(
    async (manifestPath: string, selectedRuntime?: string | null) => {
      setInstallPanel((current) => ({ loading: true, error: null, plan: current.plan }));
      try {
        const response = await fetch(`${coreOrigin}/api/apps/install/plan`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifestPath,
            selectedRuntime: selectedRuntime?.trim() || null,
            system: false,
          }),
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const plan = (await response.json()) as CoreInstallPlan;
        setInstallPanel({ loading: false, error: null, plan });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setInstallPanel({
          loading: false,
          error: error instanceof Error ? error.message : "Install review is unavailable.",
          plan: null,
        });
      }
    },
    [coreOrigin],
  );

  const applyInstall = useCallback(
    async (plan: CoreInstallPlan, settings: Record<string, string | null>, autostart: boolean) => {
      setBusyAction("install");
      try {
        await sendCsrfJson(`${coreOrigin}/api/apps/install`, {
          manifestPath: plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
          selectedChannel: plan.selectedChannel,
          system: false,
          settings,
          autostart,
        });
        await refresh();
        setInstallOpen(false);
        setInstallPanel(emptyInstallPanelState());
        toast.success("App installed", { description: plan.displayName });
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }

        setInstallPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Install failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [coreOrigin, refresh, sendCsrfJson],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const systemApps = useMemo(() => state.apps.filter((app) => app.system), [state.apps]);
  const uiRuntimeApps = useMemo(() => runtimeApps.filter((app) => getAppPageLinks(app).length > 0), [runtimeApps]);
  const effectiveView = canManageApps ? activeView : "available-apps";
  const selectedApp = activePanel ? state.apps.find((app) => app.id === activePanel.appId) ?? null : null;

  function setCompact(compact: boolean) {
    setSidebarCompact(compact);
    window.localStorage.setItem(SIDEBAR_COMPACT_STORAGE_KEY, String(compact));
  }

  function openInstallDialog() {
    setInstallOpen(true);
    setInstallPanel(emptyInstallPanelState());
  }

  return (
    <div
      className={cn(
        "grid min-h-dvh bg-muted/30 transition-[grid-template-columns] duration-200",
        sidebarCompact ? "grid-cols-[72px_minmax(0,1fr)]" : "grid-cols-[280px_minmax(0,1fr)]",
      )}
    >
      <aside className="sticky top-0 h-dvh border-r bg-sidebar text-sidebar-foreground">
        <ShellSidebar
          compact={sidebarCompact}
          activeView={effectiveView}
          workspace={workspace}
          coreOrigin={coreOrigin}
          activeUser={activeUser}
          canManageApps={Boolean(canManageApps)}
          runtimeApps={uiRuntimeApps}
          busyAction={busyAction}
          onCompactChange={setCompact}
          onNavigate={(view) => {
            setActiveView(view);
            setWorkspace(null);
          }}
          onLaunchApp={launchAppPage}
          getStandaloneHref={getStandaloneAppHref}
        />
      </aside>

      <div className={cn("h-dvh min-w-0", workspace ? "overflow-hidden bg-background" : "overflow-y-auto")}>
        <main className={cn("w-full", workspace ? "h-full" : "mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8")}>
          {workspace ? (
            <EmbeddedWorkspacePanel
              workspace={workspace}
              theme={shellResolvedTheme}
              themePreference={shellThemePreference}
            />
          ) : (
            <>
              {state.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {state.error}
                </div>
              )}

              {state.status?.warnings?.length ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                  {state.status.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}

              {state.loading && !state.status ? (
                <EmptyState icon={LoaderCircle} title="Loading Core state" description="Waiting for Core status and current session." iconClassName="animate-spin" />
              ) : effectiveView === "users" && canManageApps ? (
                <UserManagementPanel coreOrigin={coreOrigin} activeUser={activeUser} sendCsrfJson={sendCsrfJson} />
              ) : effectiveView === "installed-apps" && canManageApps ? (
                <InstalledAppsPage
                  coreOrigin={coreOrigin}
                  runtimeApps={runtimeApps}
                  systemApps={systemApps}
                  shellAppId={shellAppId}
                  canManageApps={Boolean(canManageApps)}
                  loading={state.loading}
                  busyAction={busyAction}
                  onRefresh={() => void refresh()}
                  onInstall={openInstallDialog}
                  onAction={runAppAction}
                  onSwitchRuntime={switchAppRuntime}
                  onCreateBackup={createManualBackup}
                  onOpenPanel={openAppPanel}
                />
              ) : effectiveView === "dashboard" && canManageApps ? (
                <DashboardPage
                  state={state}
                  runtimeApps={runtimeApps}
                  onRefresh={() => void refresh()}
                  onOpenInstalledApps={() => setActiveView("installed-apps")}
                />
              ) : (
                <AvailableAppsPage
                  apps={uiRuntimeApps}
                  loading={state.loading}
                  busyAction={busyAction}
                  onLaunchApp={launchAppPage}
                  getStandaloneHref={getStandaloneAppHref}
                />
              )}
            </>
          )}
        </main>
      </div>

      <InstallReviewDialog
        opened={installOpen}
        detail={installPanel}
        busyAction={busyAction}
        onClose={() => setInstallOpen(false)}
        onReview={loadInstallPlan}
        onApply={applyInstall}
      />

      {selectedApp && activePanel && (
        <AppDetailsDialog
          app={selectedApp}
          view={activePanel.view}
          configureSection={activePanel.configureSection}
          canManageApps={Boolean(canManageApps)}
          busyAction={busyAction}
          detail={detailPanel}
          onClose={() => setActivePanel(null)}
          onRefreshLogs={loadAppLogs}
          onRefreshBackups={loadAppBackups}
          onCreateBackup={createManualBackup}
          onRestoreBackup={restoreBackup}
          onDeleteBackup={deleteBackup}
          onPreviewBackupCleanup={previewBackupCleanup}
          onApplyBackupCleanup={applyBackupCleanup}
          onConfigure={configureApp}
          onReloadUpdatePlan={loadUpdatePlan}
          onApplyUpdate={applyUpdate}
          onRemove={removeApp}
        />
      )}
    </div>
  );
}

function ShellSidebar({
  compact,
  activeView,
  workspace,
  coreOrigin,
  activeUser,
  canManageApps,
  runtimeApps,
  busyAction,
  onCompactChange,
  onNavigate,
  onLaunchApp,
  getStandaloneHref,
}: {
  compact: boolean;
  activeView: ShellView;
  workspace: EmbeddedWorkspace | null;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  canManageApps: boolean;
  runtimeApps: CoreApp[];
  busyAction: string | null;
  onCompactChange: (compact: boolean) => void;
  onNavigate: (view: ShellView) => void;
  onLaunchApp: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("relative flex h-18 shrink-0 items-center border-b px-3", compact ? "justify-center" : "gap-2")}>
        <button
          type="button"
          className={cn("flex min-w-0 items-center gap-3 rounded-md focus-visible:ring-ring/50 focus-visible:ring-[3px]", compact && "justify-center")}
          onClick={() => onNavigate("dashboard")}
          title="Hosty"
        >
          <BrandMark compact={compact} />
          {!compact && (
            <span className="block truncate text-sm font-semibold uppercase">Hosty</span>
          )}
        </button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute right-0 top-1/2 z-20 size-7 -translate-y-1/2 translate-x-1/2 rounded-full bg-background shadow-sm"
          aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
          title={compact ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => onCompactChange(!compact)}
        >
          {compact ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <nav className={cn("min-h-0 flex-1 overflow-y-auto py-4", compact ? "px-2" : "px-3")} aria-label="Host navigation">
        <div className={cn(compact ? "space-y-4" : "space-y-6")}>
          {canManageApps && (
            <NavigationSection title="Host" compact={compact}>
              <SidebarButton compact={compact} active={activeView === "dashboard" && !workspace} icon={Gauge} label="Dashboard" onClick={() => onNavigate("dashboard")} />
              <SidebarButton compact={compact} active={activeView === "installed-apps" && !workspace} icon={Boxes} label="Installed Apps" onClick={() => onNavigate("installed-apps")} />
              <SidebarButton compact={compact} active={activeView === "users"} icon={Users} label="User Management" onClick={() => onNavigate("users")} />
            </NavigationSection>
          )}

          <NavigationSection title="Apps" compact={compact}>
            {runtimeApps.length === 0 ? (
              <NavigationPlaceholder compact={compact} icon={LayoutGrid} label="No apps registered" />
            ) : (
              runtimeApps.map((app) => (
                <RuntimeAppNavigationItem
                  key={app.id}
                  app={app}
                  compact={compact}
                  busyAction={busyAction}
                  workspace={workspace}
                  onLaunch={onLaunchApp}
                  getStandaloneHref={getStandaloneHref}
                />
              ))
            )}
          </NavigationSection>
        </div>
      </nav>

      <div className={cn("shrink-0 border-t", compact ? "space-y-2 px-2 py-3" : "space-y-3 p-3")}>
        <SidebarFooterAccount compact={compact} coreOrigin={coreOrigin} activeUser={activeUser} />
      </div>
    </div>
  );
}

function BrandMark({ compact }: { compact: boolean }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-md", compact ? "size-10" : "size-10")}>
      <img src="/hosty-icon-light-64.png" alt="" className="size-10 rounded-md dark:hidden" />
      <img src="/hosty-icon-dark-64.png" alt="" className="hidden size-10 rounded-md dark:block" />
    </span>
  );
}

function NavigationSection({ title, compact, children }: { title: string; compact: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className={cn("px-2 text-xs font-medium uppercase text-muted-foreground", compact && "sr-only")}>{title}</h2>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SidebarButton({
  compact,
  active,
  icon: Icon,
  label,
  onClick,
}: {
  compact: boolean;
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md text-sm transition-colors",
        compact ? "justify-center px-0" : "px-2",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      title={compact ? label : undefined}
      onClick={onClick}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!compact && <span className="truncate">{label}</span>}
    </button>
  );
}

function NavigationPlaceholder({ compact, icon: Icon, label }: { compact: boolean; icon: LucideIcon; label: string }) {
  return (
    <div className={cn("flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground", compact && "justify-center px-0")} title={label}>
      <Icon className="h-4 w-4 shrink-0" />
      {!compact && <span className="truncate">{label}</span>}
    </div>
  );
}

function RuntimeAppNavigationItem({
  app,
  compact,
  busyAction,
  workspace,
  onLaunch,
  getStandaloneHref,
}: {
  app: CoreApp;
  compact: boolean;
  busyAction: string | null;
  workspace: EmbeddedWorkspace | null;
  onLaunch: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = getAppPageLinks(app);
  const primaryPage = pages[0] ?? null;
  const running = app.runtimeState === "running";
  const active = workspace?.appId === app.id;
  const canOpen = running && primaryPage !== null;
  const canOpenStandalone = canOpen;

  useEffect(() => {
    if (active && !compact && pages.length > 1) {
      setExpanded(true);
    }
  }, [active, compact, pages.length]);

  return (
    <div className="space-y-1">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          className={cn(
            "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-sm transition-colors",
            compact ? "justify-center px-0" : "px-2",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : canOpen
                ? "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                : "cursor-not-allowed text-muted-foreground opacity-70",
          )}
          disabled={!canOpen}
          title={canOpen ? app.displayName : `${app.displayName} is ${app.runtimeState || app.operationStatus}`}
          onClick={() => {
            if (primaryPage) {
              void onLaunch(app, primaryPage, "workspace");
            }
          }}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          {!compact && (
            <span className="min-w-0 flex-1 truncate text-left">{app.displayName}</span>
          )}
        </button>
        {!compact && canOpenStandalone && primaryPage && (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 focus-visible:opacity-100"
          >
            <a
              href={getStandaloneHref(app, primaryPage)}
              target="_blank"
              rel="noreferrer"
              title={`Open ${app.displayName} standalone`}
              aria-label={`Open ${app.displayName} standalone`}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        )}
        {!compact && pages.length > 1 && (
          <Button type="button" variant="ghost" size="icon-sm" className="size-8 shrink-0" onClick={() => setExpanded((current) => !current)}>
            <ChevronRight className={cn("h-4 w-4 transition-transform", expanded && "rotate-90")} />
          </Button>
        )}
      </div>
      {!compact && expanded && pages.length > 1 && (
        <div className="ml-6 space-y-1 border-l pl-2">
          {pages.map((page) => (
            <button
              key={`${app.id}:${page.path}`}
              type="button"
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                workspace?.appId === app.id && workspace.path === page.path && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              disabled={busyAction === `${app.id}:open`}
              onClick={() => void onLaunch(app, page, "workspace")}
            >
              {busyAction === `${app.id}:open` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Home className="h-3.5 w-3.5" />}
              <span className="truncate">{page.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarFooterAccount({
  compact,
  coreOrigin,
  activeUser,
}: {
  compact: boolean;
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
}) {
  const accountLabel = activeUser?.displayName || activeUser?.email || "Anonymous";
  const accountDescription = activeUser?.email && activeUser.email !== accountLabel ? activeUser.email : activeUser?.role || "No active session";

  if (!activeUser) {
    return (
      <div className="space-y-2">
        <ThemeMenuButton compact={compact} />
        <Button asChild variant={compact ? "ghost" : "outline"} size={compact ? "icon-lg" : "default"} className={cn(!compact && "w-full justify-start")}>
          <a href={`${coreOrigin}/login`} title="Login">
            <LogIn className="h-4 w-4" />
            {!compact && "Login"}
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ThemeMenuButton compact={compact} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={compact ? "ghost" : "outline"}
            size={compact ? "icon-lg" : "default"}
            className={cn(compact ? "mx-auto flex size-11 rounded-md" : "h-auto w-full justify-start px-3 py-2 text-left")}
            title={compact ? accountLabel : undefined}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-rose-600 text-xs font-semibold text-white">
              {getAccountInitials(activeUser)}
            </span>
            {!compact && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{accountLabel}</span>
                  <span className="block truncate text-xs text-muted-foreground">{accountDescription}</span>
                </span>
                <ChevronDown className="h-4 w-4" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-72">
          <DropdownMenuLabel className="space-y-1">
            <span className="block truncate text-sm">{accountLabel}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">{accountDescription}</span>
            <Badge variant="outline">{activeUser.role}</Badge>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href={`${coreOrigin}/logout`}>
              <LogOut className="h-4 w-4" />
              Logout
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ThemeMenuButton({ compact }: { compact: boolean }) {
  const { theme, setTheme } = useTheme();
  const selectedTheme = theme || "system";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon-lg" : "default"}
          className={cn(compact ? "mx-auto flex size-11" : "w-full justify-start")}
          title="Theme"
        >
          <Monitor className="h-4 w-4" />
          {!compact && <span>Theme</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-44">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={selectedTheme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun className="h-4 w-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="h-4 w-4" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="h-4 w-4" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold leading-7">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </section>
  );
}

function AvailableAppsPage({
  apps,
  loading,
  busyAction,
  onLaunchApp,
  getStandaloneHref,
}: {
  apps: CoreApp[];
  loading: boolean;
  busyAction: string | null;
  onLaunchApp: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title="Apps" description="Runtime apps available to the current user." />
      {loading && apps.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : apps.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="No apps available" description="No runtime app UI is available for this account." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {apps.map((app) => {
            const pages = getAppPageLinks(app);
            const primaryPage = pages[0] ?? null;
            const canOpen = app.runtimeState === "running" && primaryPage !== null;
            const busy = busyAction === `${app.id}:open`;
            return (
              <div key={app.id} className="rounded-lg border bg-card p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h2 className="truncate text-base font-semibold">{app.displayName}</h2>
                    <p className="truncate text-xs text-muted-foreground">{app.id}</p>
                  </div>
                  <StatusBadge value={app.runtimeState || app.operationStatus} />
                </div>
                {app.description && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{app.description}</p>}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canOpen || busy}
                    onClick={() => {
                      if (primaryPage) {
                        void onLaunchApp(app, primaryPage, "workspace");
                      }
                    }}
                  >
                    {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LayoutGrid className="h-4 w-4" />}
                    Open
                  </Button>
                  {primaryPage && (
                    <Button asChild variant="outline" size="sm" className={cn(!canOpen && "pointer-events-none opacity-50")} aria-disabled={!canOpen}>
                      <a
                        href={canOpen ? getStandaloneHref(app, primaryPage) : undefined}
                        target="_blank"
                        rel="noreferrer"
                        tabIndex={canOpen ? undefined : -1}
                        onClick={(event) => {
                          if (!canOpen) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Standalone
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DashboardPage({
  state,
  runtimeApps,
  onRefresh,
  onOpenInstalledApps,
}: {
  state: LoadState;
  runtimeApps: CoreApp[];
  onRefresh: () => void;
  onOpenInstalledApps: () => void;
}) {
  const running = runtimeApps.filter((app) => app.runtimeState === "running").length;
  const installed = runtimeApps.filter((app) => app.operationStatus === "installed").length;
  const attention = runtimeApps.filter((app) => app.lastError || app.operationStatus === "failed" || app.runtimeState === "unknown").length;

  return (
    <div className="space-y-8">
      <PageHeader title="Dashboard" description="Host overview widgets" />

      <InstalledAppsWidget
        apps={runtimeApps}
        running={running}
        installed={installed}
        attention={attention}
        loading={state.loading}
        onRefresh={onRefresh}
        onOpenInstalledApps={onOpenInstalledApps}
      />

      <CoreStatusWidget status={state.status} loading={state.loading} />
    </div>
  );
}

function InstalledAppsWidget({
  apps,
  running,
  installed,
  attention,
  loading,
  onRefresh,
  onOpenInstalledApps,
}: {
  apps: CoreApp[];
  running: number;
  installed: number;
  attention: number;
  loading: boolean;
  onRefresh: () => void;
  onOpenInstalledApps: () => void;
}) {
  const health = getHealthSummary(apps.length, running, attention);
  const metrics = [
    { label: "Running", value: running, icon: Activity, tone: "text-emerald-700 bg-emerald-500/10" },
    { label: "Installed", value: installed, icon: PackageCheck, tone: "text-zinc-700 bg-zinc-500/10 dark:text-zinc-300" },
    { label: "Needs attention", value: attention, icon: CircleAlert, tone: "text-amber-700 bg-amber-500/10" },
  ];

  return (
    <Card className="rounded-lg py-0">
      <CardHeader className="gap-4 border-b px-5 py-4 sm:flex sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Installed Apps</CardTitle>
            <Badge variant="outline" className={cn("border-transparent", health.className)}>{health.label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">App count, runtime state, and basic Core health checks.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="icon" onClick={onRefresh} disabled={loading} aria-label="Refresh installed apps widget">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-5 py-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-4xl font-semibold leading-none">{apps.length}</div>
                <div className="mt-1 text-sm text-muted-foreground">{pluralize(apps.length, "app")} installed</div>
              </div>
              <div className="rounded-md bg-sky-500/10 p-2 text-sky-700">
                <Boxes className="h-5 w-5" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Runtime coverage</span>
                <span>{running}/{apps.length || 0} running</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", attention > 0 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${getRuntimeCoverage(running, apps.length)}%` }} />
              </div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {metrics.map((metric) => (
              <div key={metric.label} className="rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{metric.label}</span>
                  <span className={cn("rounded-md p-1.5", metric.tone)}>
                    <metric.icon className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-3 text-2xl font-semibold">{metric.value}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">The full app list, lifecycle actions, install flow, updates, backups, and settings live on the Installed Apps page.</p>
          <Button type="button" variant="outline" onClick={onOpenInstalledApps}>
            Open Installed Apps
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CoreStatusWidget({ status, loading }: { status: CoreStatus | null; loading: boolean }) {
  const facts = [
    ["Component", status?.component || "unknown"],
    ["Listen URL", status?.listenUrl || "unknown"],
    ["Core origin", status?.corePublicOrigin || "not configured"],
    ["Shell origin", status?.shellPublicOrigin || "not configured"],
    ["Local runtime host", status?.runtimePublicHost || "unknown"],
    ["Data root", status?.dataRoot || "unknown"],
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Core</CardTitle>
            <CardDescription>Core process and runtime origins.</CardDescription>
          </div>
          <StatusBadge value={status?.status || (loading ? "loading" : "offline")} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <Fact key={label} label={label} value={value} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function InstalledAppsPage({
  coreOrigin,
  runtimeApps,
  systemApps,
  shellAppId,
  canManageApps,
  loading,
  busyAction,
  onRefresh,
  onInstall,
  onAction,
  onSwitchRuntime,
  onCreateBackup,
  onOpenPanel,
}: {
  coreOrigin: string;
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  loading: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onInstall: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const isRefreshing = loading;
  const hasAnyApps = runtimeApps.length > 0 || systemApps.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installed Apps"
        description="App state is resolved through the Core backend API and runtime state."
        actions={(
          <>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={isRefreshing} aria-label="Refresh apps">
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </Button>
            {canManageApps && (
              <Button onClick={onInstall}>
                <Plus className="h-4 w-4" />
                Install App
              </Button>
            )}
          </>
        )}
      />

      {loading && !hasAnyApps ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !hasAnyApps ? (
        <EmptyState icon={Boxes} title="No installed apps" description="Install a runtime app to make it available in the shell." />
      ) : (
        <div className="space-y-6">
          <InstalledAppTableSection
            coreOrigin={coreOrigin}
            title="Runtime Apps"
            description="User-installed runtime apps and their lifecycle state."
            emptyTitle="No runtime apps installed"
            emptyDescription="Install a runtime app to make it available in the shell."
            apps={runtimeApps}
            shellAppId={shellAppId}
            canManageApps={canManageApps}
            busyAction={busyAction}
            onAction={onAction}
            onSwitchRuntime={onSwitchRuntime}
            onCreateBackup={onCreateBackup}
            onOpenPanel={onOpenPanel}
          />
          <InstalledAppTableSection
            coreOrigin={coreOrigin}
            title="System Apps"
            description="Core-managed Shell and platform runtime apps. Runtime switching and inspection are available to administrators."
            emptyTitle="No system apps registered"
            emptyDescription="Core has not registered a system app yet."
            apps={systemApps}
            shellAppId={shellAppId}
            canManageApps={canManageApps}
            busyAction={busyAction}
            onAction={onAction}
            onSwitchRuntime={onSwitchRuntime}
            onCreateBackup={onCreateBackup}
            onOpenPanel={onOpenPanel}
          />
        </div>
      )}
    </div>
  );
}

function AppServiceDetailsPanel({
  app,
  healthState,
  canConfigurePublicOrigins,
  onConfigurePublicOrigins,
}: {
  app: CoreApp;
  healthState?: RuntimeHealthState;
  canConfigurePublicOrigins: boolean;
  onConfigurePublicOrigins: () => void;
}) {
  const serviceRows = buildRuntimeServiceRows(app, healthState?.health);
  const copyEndpointUrl = async (url: string) => {
    try {
      await copyTextToClipboard(url);
      toast.success("URL copied", { description: url });
    } catch {
      toast.error("Copy failed", { description: "Clipboard access is unavailable." });
    }
  };

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      {healthState?.loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading services
        </div>
      )}
      {healthState?.error && <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">{healthState.error}</div>}

      {serviceRows.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">No services reported</div>
      ) : (
        <div className="grid gap-2">
          {serviceRows.map((service) => (
            <div key={service.service} className="rounded-md bg-muted/30 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{service.service}</div>
                  {service.message && <div className="truncate text-xs text-muted-foreground">{service.message}</div>}
                </div>
                <StatusBadge value={service.status} />
              </div>
              {service.endpoints.length === 0 ? (
                <div className="mt-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">No endpoints</div>
              ) : (
                <div className="mt-2 grid gap-1.5">
                  {service.endpoints.map((endpoint) => {
                    const publicOrigin = getEndpointPublicOrigin(app, endpoint);
                    return (
                      <div key={endpoint.key} className={cn("grid gap-2 text-xs", endpoint.public && "md:grid-cols-2")}>
                        <EndpointUrlBlock
                          url={endpoint.url}
                          missingText="not assigned"
                          copyTitle="Copy local endpoint URL"
                          openTitle="Open local endpoint URL"
                          onCopy={copyEndpointUrl}
                        />
                        {endpoint.public && (
                          <EndpointUrlBlock
                            url={publicOrigin}
                            missingText="not configured"
                            copyTitle="Copy public origin"
                            openTitle="Open public origin"
                            onCopy={copyEndpointUrl}
                            configureTitle="Configure public origin"
                            onConfigure={canConfigurePublicOrigins ? onConfigurePublicOrigins : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EndpointUrlBlock({
  url,
  missingText,
  copyTitle,
  openTitle,
  configureTitle,
  onCopy,
  onConfigure,
}: {
  url?: string | null;
  missingText: string;
  copyTitle: string;
  openTitle: string;
  configureTitle?: string;
  onCopy: (url: string) => void | Promise<void>;
  onConfigure?: () => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className={cn("truncate font-mono", url ? "text-foreground" : "text-muted-foreground")}>{url || missingText}</span>
      {url ? (
        <span className="flex items-center gap-1">
          <IconButton title={copyTitle} onClick={() => void onCopy(url)}>
            <Copy className="h-4 w-4" />
          </IconButton>
          <Button type="button" variant="ghost" size="icon-sm" title={openTitle} aria-label={openTitle} asChild>
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </span>
      ) : onConfigure ? (
        <IconButton title={configureTitle || "Configure"} onClick={onConfigure}>
          <Settings2 className="h-4 w-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy copy path below when browser clipboard access is unavailable.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("Clipboard copy failed.");
  }
}

function InstalledAppTableSection({
  coreOrigin,
  title,
  description,
  emptyTitle,
  emptyDescription,
  apps,
  shellAppId,
  canManageApps,
  busyAction,
  onAction,
  onSwitchRuntime,
  onCreateBackup,
  onOpenPanel,
}: {
  coreOrigin: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const [expandedAppIds, setExpandedAppIds] = useState<Set<string>>(() => new Set());
  const [healthByApp, setHealthByApp] = useState<Record<string, RuntimeHealthState>>({});

  useEffect(() => {
    const appIds = new Set(apps.map((app) => app.id));
    setExpandedAppIds((current) => {
      const next = new Set([...current].filter((appId) => appIds.has(appId)));
      return next.size === current.size ? current : next;
    });
    setHealthByApp((current) => {
      const entries = Object.entries(current).filter(([appId]) => appIds.has(appId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [apps]);

  const loadAppHealth = useCallback(async (app: CoreApp) => {
    setHealthByApp((current) => ({
      ...current,
      [app.id]: {
        loading: true,
        error: null,
        health: current[app.id]?.health ?? null,
      },
    }));

    try {
      const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/health`, { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }
      const health = (await response.json()) as AppHealthResponse;
      setHealthByApp((current) => ({
        ...current,
        [app.id]: {
          loading: false,
          error: null,
          health,
        },
      }));
    } catch (error) {
      if (isAuthRequiredRedirectError(error)) {
        return;
      }

      setHealthByApp((current) => ({
        ...current,
        [app.id]: {
          loading: false,
          error: error instanceof Error ? error.message : "Health is unavailable.",
          health: current[app.id]?.health ?? null,
        },
      }));
    }
  }, [coreOrigin]);

  const toggleAppExpanded = (app: CoreApp) => {
    const shouldExpand = !expandedAppIds.has(app.id);
    setExpandedAppIds((current) => {
      const next = new Set(current);
      if (shouldExpand) {
        next.add(app.id);
      } else {
        next.delete(app.id);
      }
      return next;
    });

    if (shouldExpand) {
      void loadAppHealth(app);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">{apps.length}</Badge>
      </div>
      {apps.length === 0 ? (
        <EmptyState icon={Boxes} title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[240px]">App</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Autostart</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>UI</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const expanded = expandedAppIds.has(app.id);
                const healthState = healthByApp[app.id];

                return (
                  <Fragment key={app.id}>
                    <InstalledAppRow
                      app={app}
                      isShell={app.id === shellAppId}
                      expanded={expanded}
                      healthLoading={healthState?.loading ?? false}
                      canManageApps={canManageApps}
                      busyAction={busyAction}
                      onToggleExpanded={() => toggleAppExpanded(app)}
                      onAction={onAction}
                      onSwitchRuntime={onSwitchRuntime}
                      onCreateBackup={onCreateBackup}
                      onOpenPanel={onOpenPanel}
                    />
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/20 px-4 py-3">
                          <AppServiceDetailsPanel
                            app={app}
                            healthState={healthState}
                            canConfigurePublicOrigins={canManageApps && !app.system}
                            onConfigurePublicOrigins={() => onOpenPanel(app, "configure", { configureSection: "publicOrigins" })}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function InstalledAppRow({
  app,
  isShell,
  expanded,
  healthLoading,
  canManageApps,
  busyAction,
  onToggleExpanded,
  onAction,
  onSwitchRuntime,
  onCreateBackup,
  onOpenPanel,
}: {
  app: CoreApp;
  isShell: boolean;
  expanded: boolean;
  healthLoading: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  onToggleExpanded: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const running = app.runtimeState === "running";
  const canOpen = !app.system && getAppPageLinks(app).length > 0;
  const canControl = canManageApps && !app.system;
  const canSwitchRuntime = canManageApps;
  const canInspect = canManageApps;
  const canBackup = canControl && app.capabilities.includes("backup");
  const canConfigure = canControl;
  const canUpdate = canControl && app.capabilities.includes("update");
  const canRemove = canControl && app.capabilities.includes("remove");
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;
  const autostartEnabled = isAppAutostartEnabled(app);

  return (
    <TableRow data-testid={`app-row-${app.id}`}>
      <TableCell>
        <div className="flex min-w-0 items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mt-0.5 shrink-0"
            title={expanded ? "Hide services" : "Show services"}
            aria-label={expanded ? "Hide services" : "Show services"}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            {healthLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{app.displayName}</span>
              {app.system && <Badge variant="secondary">System</Badge>}
              {isShell && <Badge variant="outline">Shell</Badge>}
              {app.lastError && <CircleAlert className="h-4 w-4 text-destructive" />}
            </div>
            <div className="truncate text-xs text-muted-foreground">{app.id}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <RuntimeSwitcher
          app={app}
          canSwitch={canSwitchRuntime}
          busyAction={busyAction}
          onSwitchRuntime={onSwitchRuntime}
        />
      </TableCell>
      <TableCell>{app.version}</TableCell>
      <TableCell><Badge variant={autostartEnabled ? "outline" : "secondary"}>{autostartEnabled ? "On" : "Off"}</Badge></TableCell>
      <TableCell><StatusBadge value={app.runtimeState || app.operationStatus} /></TableCell>
      <TableCell>
        <Badge variant={canOpen ? "outline" : "secondary"}>{canOpen ? "Available" : "No UI"}</Badge>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {canControl && (running ? (
            <IconButton title="Stop app" disabled={isBusy("stop")} onClick={() => onAction(app, "stop")}>
              {isBusy("stop") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            </IconButton>
          ) : (
            <IconButton title="Start app" disabled={isBusy("start")} onClick={() => onAction(app, "start")}>
              {isBusy("start") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </IconButton>
          ))}
          {canControl && (
            <IconButton title="Restart app" disabled={isBusy("restart")} onClick={() => onAction(app, "restart")}>
              {isBusy("restart") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            </IconButton>
          )}
          <InstalledAppActionsMenu
            app={app}
            canInspect={canInspect}
            canBackup={canBackup}
            canConfigure={canConfigure}
            canUpdate={canUpdate}
            canRemove={canRemove}
            busyAction={busyAction}
            onCreateBackup={onCreateBackup}
            onOpenPanel={onOpenPanel}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function RuntimeSwitcher({
  app,
  canSwitch,
  busyAction,
  onSwitchRuntime,
}: {
  app: CoreApp;
  canSwitch: boolean;
  busyAction: string | null;
  onSwitchRuntime: (app: CoreApp, targetRuntime: string) => void;
}) {
  const runtimeProfiles = app.runtimeProfiles ?? [];
  const currentRuntime = app.selectedRuntime || "none";
  const switchable = canSwitch && runtimeProfiles.length > 1;
  const switching = busyAction?.startsWith(`${app.id}:switch-runtime:`) ?? false;

  if (!switchable) {
    return <span className="font-mono text-sm">{currentRuntime}</span>;
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate font-mono text-sm">{currentRuntime}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Switch runtime for ${app.displayName}`}
            title="Switch runtime"
            disabled={switching}
          >
            {switching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Runtime</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {runtimeProfiles.map((profile) => {
            const selected = profile.key === app.selectedRuntime;
            const targetBusy = busyAction === `${app.id}:switch-runtime:${profile.key}`;
            return (
              <DropdownMenuItem
                key={profile.key}
                disabled={switching}
                onClick={() => onSwitchRuntime(app, profile.key)}
              >
                {targetBusy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className={cn("h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
                )}
                <span className="min-w-0 flex-1 truncate">{formatRuntimeProfileLabel(profile)}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InstalledAppActionsMenu({
  app,
  canInspect,
  canBackup,
  canConfigure,
  canUpdate,
  canRemove,
  busyAction,
  onCreateBackup,
  onOpenPanel,
}: {
  app: CoreApp;
  canInspect: boolean;
  canBackup: boolean;
  canConfigure: boolean;
  canUpdate: boolean;
  canRemove: boolean;
  busyAction: string | null;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: OpenAppPanel;
}) {
  const hasLogs = canInspect && app.capabilities.includes("logs");
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;
  const hasMenuActions = hasLogs || canBackup || canConfigure || canUpdate || canRemove;

  if (!hasMenuActions) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {hasLogs && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "logs")}>
            <FileText className="h-4 w-4" />
            Logs
          </DropdownMenuItem>
        )}
        {canBackup && (
          <>
            <DropdownMenuItem disabled={isBusy("backup")} onClick={() => onCreateBackup(app)}>
              {isBusy("backup") ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              Create backup
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenPanel(app, "backups")}>
              <Database className="h-4 w-4" />
              Backups
            </DropdownMenuItem>
          </>
        )}
        {(canConfigure || canUpdate) && <DropdownMenuSeparator />}
        {canConfigure && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "configure")}>
            <Settings2 className="h-4 w-4" />
            Configure
          </DropdownMenuItem>
        )}
        {canUpdate && (
          <DropdownMenuItem onClick={() => onOpenPanel(app, "update")}>
            <Upload className="h-4 w-4" />
            Update
          </DropdownMenuItem>
        )}
        {canRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onOpenPanel(app, "remove")}>
              <Trash2 className="h-4 w-4" />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IconButton({ title, children, onClick, disabled, destructive }: { title: string; children: React.ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" title={title} aria-label={title} disabled={disabled} onClick={onClick} className={cn(destructive && "text-destructive hover:text-destructive")}>
      {children}
    </Button>
  );
}

function InstallReviewDialog({
  opened,
  detail,
  busyAction,
  onClose,
  onReview,
  onApply,
}: {
  opened: boolean;
  detail: InstallPanelState;
  busyAction: string | null;
  onClose: () => void;
  onReview: (manifestPath: string, selectedRuntime?: string | null) => void;
  onApply: (plan: CoreInstallPlan, settings: Record<string, string | null>, autostart: boolean) => void;
}) {
  const [manifestPath, setManifestPath] = useState("");
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [reviewedManifestPath, setReviewedManifestPath] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});
  const [autostartDraft, setAutostartDraft] = useState(true);
  const reviewedPlan = detail.plan && manifestPath.trim() === reviewedManifestPath ? detail.plan : null;
  const runtimeProfiles =
    reviewedPlan?.runtimeProfiles && reviewedPlan.runtimeProfiles.length > 0
      ? reviewedPlan.runtimeProfiles
      : reviewedPlan
        ? [{ key: reviewedPlan.targetRuntime, type: reviewedPlan.targetRuntimeType, default: true }]
        : [];
  const selectedRuntimeValue = selectedRuntime || reviewedPlan?.targetRuntime || "";
  const selectedRuntimeProfile = runtimeProfiles.find((profile) => profile.key === selectedRuntimeValue);
  const selectedRuntimeLabel = selectedRuntimeProfile ? formatRuntimeProfileLabel(selectedRuntimeProfile) : selectedRuntimeValue || "Select runtime";

  useEffect(() => {
    if (!detail.plan || manifestPath.trim() !== reviewedManifestPath) {
      setSettingsDraft({});
      return;
    }

    setSelectedRuntime(detail.plan.targetRuntime);
    setSettingsDraft(Object.fromEntries(detail.plan.settings.map((setting) => [setting.key, setting.secret ? "" : setting.defaultValue || ""])));
    setAutostartDraft(detail.plan.defaultAutostart ?? true);
  }, [detail.plan, manifestPath, reviewedManifestPath]);

  const submitReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedManifestPath = manifestPath.trim();
    setReviewedManifestPath(normalizedManifestPath);
    setSelectedRuntime("");
    onReview(normalizedManifestPath);
  };

  const changeRuntime = (runtime: string) => {
    setSelectedRuntime(runtime);
    onReview(manifestPath.trim(), runtime);
  };

  const apply = () => {
    if (!reviewedPlan) {
      return;
    }

    const settings: Record<string, string | null> = {};
    for (const setting of reviewedPlan.settings) {
      const value = settingsDraft[setting.key] ?? "";
      if (!setting.secret || value.length > 0) {
        settings[setting.key] = value;
      }
    }

    onApply(reviewedPlan, settings, autostartDraft);
  };

  return (
    <Dialog open={opened} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install App</DialogTitle>
          <DialogDescription>Review a runtime app manifest before installing it into Core.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submitReview} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="manifestPath">Manifest path or URL</Label>
            <Input
              id="manifestPath"
              value={manifestPath}
              onChange={(event) => setManifestPath(event.target.value)}
              placeholder="/path/to/manifest.json or https://example.test/manifest.json"
              required
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="outline" disabled={detail.loading || manifestPath.trim().length === 0}>
              {detail.loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Review
            </Button>
          </div>
        </form>

        {detail.error && <InlineError message={detail.error} />}
        {detail.loading && !reviewedPlan && <EmptyState icon={LoaderCircle} title="Loading install review" iconClassName="animate-spin" />}

        {reviewedPlan && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{reviewedPlan.displayName}</h3>
                <p className="text-sm text-muted-foreground">{reviewedPlan.description || "Runtime app manifest reviewed."}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="selectedRuntime">Runtime</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      id="selectedRuntime"
                      type="button"
                      variant="outline"
                      className="w-full justify-between px-3 font-normal"
                      disabled={detail.loading || runtimeProfiles.length <= 1}
                    >
                      <span className="truncate">{selectedRuntimeLabel}</span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                    <DropdownMenuRadioGroup value={selectedRuntimeValue} onValueChange={changeRuntime}>
                      {runtimeProfiles.map((profile) => (
                        <DropdownMenuRadioItem key={profile.key} value={profile.key}>
                          {formatRuntimeProfileLabel(profile)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FactCard label="App" value={reviewedPlan.displayName} />
              <FactCard label="Version" value={reviewedPlan.currentVersion ? `${reviewedPlan.currentVersion} to ${reviewedPlan.targetVersion}` : reviewedPlan.targetVersion} />
              <FactCard label="Runtime" value={reviewedPlan.targetRuntime} />
              <FactCard label="Manifest digest" value={reviewedPlan.targetManifestDigest.slice(0, 16)} />
            </div>
            {reviewedPlan.settings.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Settings</h3>
                {reviewedPlan.settings.map((setting) => (
                  <SettingInput key={setting.key} setting={setting} value={settingsDraft[setting.key] ?? ""} onChange={(value) => setSettingsDraft((current) => ({ ...current, [setting.key]: value }))} />
                ))}
              </div>
            )}
            <div className="rounded-md border bg-muted/30 p-3">
              <CheckboxRow label="Start at Core startup" checked={autostartDraft} onChange={setAutostartDraft} />
            </div>
            <DialogFooter>
              {reviewedPlan.action !== "install" && <p className="text-sm text-muted-foreground">Already installed</p>}
              <Button onClick={apply} disabled={reviewedPlan.action !== "install" || detail.loading || busyAction === "install"}>
                {busyAction === "install" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Install App
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserManagementPanel({
  coreOrigin,
  activeUser,
  sendCsrfJson,
}: {
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  sendCsrfJson: (endpoint: string, body?: unknown, method?: string) => Promise<Response>;
}) {
  const [users, setUsers] = useState<HostUserSummary[]>([]);
  const [invitations, setInvitations] = useState<UserInvitationSummary[]>([]);
  const [apps, setApps] = useState<AssignableAppSummary[]>([]);
  const [ttlOptions, setTtlOptions] = useState<InviteTtlOption[]>([
    { label: "15 minutes", ttlMs: 15 * 60 * 1000 },
    { label: "24 hours", ttlMs: 24 * 60 * 60 * 1000 },
    { label: "7 days", ttlMs: 7 * 24 * 60 * 60 * 1000 },
  ]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteRole, setInviteRole] = useState<"host.admin" | "host.user">("host.user");
  const [inviteTtlMs, setInviteTtlMs] = useState(24 * 60 * 60 * 1000);
  const [inviteAppIds, setInviteAppIds] = useState<string[]>([]);
  const [createdInvite, setCreatedInvite] = useState<{ setupUrl: string; token: string } | null>(null);
  const [copiedInviteField, setCopiedInviteField] = useState<"url" | "token" | null>(null);
  const [accessUserId, setAccessUserId] = useState<string | null>(null);
  const [accessAppIds, setAccessAppIds] = useState<string[]>([]);

  const accessUser = users.find((user) => user.id === accessUserId) ?? null;
  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending");
  const filteredUsers = users.filter((user) => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return user.id.toLowerCase().includes(query) ||
      user.email?.toLowerCase().includes(query) ||
      user.displayName?.toLowerCase().includes(query) ||
      user.role.toLowerCase().includes(query);
  });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${coreOrigin}/api/auth/users`, { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      const payload = (await response.json()) as UserManagementResponse;
      setUsers(payload.users || []);
      setInvitations(payload.invitations || []);
      setApps(payload.apps || []);
      if (payload.inviteTtlOptions?.length) {
        setTtlOptions(payload.inviteTtlOptions);
        setInviteTtlMs(payload.inviteTtlOptions[1]?.ttlMs ?? payload.inviteTtlOptions[0].ttlMs);
      }
    } catch (caught) {
      if (isAuthRequiredRedirectError(caught)) {
        return;
      }

      setError(caught instanceof Error ? caught.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, [coreOrigin]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const runUserAction = useCallback(
    async (actionKey: string, action: () => Promise<void>) => {
      setPendingAction(actionKey);
      setError(null);
      try {
        await action();
        await loadUsers();
      } catch (caught) {
        if (isAuthRequiredRedirectError(caught)) {
          return;
        }

        setError(caught instanceof Error ? caught.message : "User action failed.");
      } finally {
        setPendingAction(null);
      }
    },
    [loadUsers],
  );

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runUserAction("invite", async () => {
      const response = await sendCsrfJson(`${coreOrigin}/api/auth/invitations`, {
        email: inviteEmail,
        displayName: inviteDisplayName || null,
        role: inviteRole,
        ttlMs: inviteTtlMs,
        assignedAppIds: inviteRole === "host.user" ? inviteAppIds : [],
      });
      const payload = (await response.json()) as { setupUrl: string; token: string };
      setCreatedInvite({ setupUrl: payload.setupUrl, token: payload.token });
      setInviteEmail("");
      setInviteDisplayName("");
      setInviteRole("host.user");
      setInviteAppIds([]);
      setInviteOpen(false);
      toast.success("Invitation created");
    });
  };

  function updateRole(user: HostUserSummary) {
    const nextRole = user.role === "host.admin" ? "host.user" : "host.admin";
    if (user.id === activeUser?.id && user.role === "host.admin" && nextRole === "host.user") {
      setError("Administrators cannot change their own role to user.");
      return;
    }

    void runUserAction(`role:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}`, { role: nextRole }, "PATCH");
    });
  }

  function disableUser(user: HostUserSummary) {
    if (user.id === activeUser?.id) {
      setError("Administrators cannot disable their own account.");
      return;
    }

    if (!window.confirm(`Disable ${user.displayName || user.email || user.id}?`)) {
      return;
    }

    void runUserAction(`disable:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}`, undefined, "DELETE");
    });
  }

  function revokeInvite(invitation: UserInvitationSummary) {
    void runUserAction(`invite:${invitation.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/invitations/${encodeURIComponent(invitation.id)}`, undefined, "DELETE");
    });
  }

  function openAccessEditor(user: HostUserSummary) {
    setAccessUserId(user.id);
    setAccessAppIds(user.assignedAppIds);
  }

  function saveAccess() {
    if (!accessUser) {
      return;
    }

    void runUserAction(`access:${accessUser.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(accessUser.id)}/assignments`, { assignedAppIds: accessAppIds }, "PUT");
      setAccessUserId(null);
    });
  }

  async function copyInviteField(field: "url" | "token", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedInviteField(field);
      window.setTimeout(() => setCopiedInviteField(null), 1400);
    } catch {
      setError("Clipboard access failed.");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Management"
        description="Manage Host accounts, invitations, roles, and app access."
        actions={(
          <>
            <Button variant="outline" size="icon" onClick={() => void loadUsers()} disabled={loading} aria-label="Refresh users">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" />
              Invite User
            </Button>
          </>
        )}
      />

      {error && <InlineError message={error} />}

      <Card>
        <CardHeader className="gap-4 sm:grid sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <CardTitle>Users</CardTitle>
            <CardDescription>{users.length} account{users.length === 1 ? "" : "s"}</CardDescription>
          </div>
          <Input className="w-full sm:w-72" placeholder="Search users" value={search} onChange={(event) => setSearch(event.target.value)} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading users</TableCell></TableRow>
              ) : filteredUsers.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No users</TableCell></TableRow>
              ) : filteredUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="min-w-48">
                      <div className="font-medium">{user.displayName || user.email || user.id}</div>
                      <div className="text-xs text-muted-foreground">{user.email || user.id}</div>
                    </div>
                  </TableCell>
                  <TableCell><RoleBadge role={user.role} disabled={user.disabled} /></TableCell>
                  <TableCell>{user.authProvider || "Local"}</TableCell>
                  <TableCell>{user.role === "host.admin" ? "All apps" : `${user.assignedAppIds.length} apps`}</TableCell>
                  <TableCell>{user.activeSessionCount}</TableCell>
                  <TableCell>{formatDateTime(user.lastSeenAt)}</TableCell>
                  <TableCell className="text-right">
                    <UserRowActionsMenu
                      user={user}
                      activeUserId={activeUser?.id ?? null}
                      pendingAction={pendingAction}
                      onOpenAccessEditor={openAccessEditor}
                      onUpdateRole={updateRole}
                      onDisableUser={disableUser}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending Invitations</CardTitle>
          <CardDescription>{pendingInvitations.length} pending</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingInvitations.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No pending invitations.</TableCell></TableRow>
              ) : pendingInvitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell>{invitation.email}</TableCell>
                  <TableCell><RoleBadge role={invitation.role} /></TableCell>
                  <TableCell>{invitation.role === "host.admin" ? "All apps" : `${invitation.assignedAppIds.length} apps`}</TableCell>
                  <TableCell>{new Date(invitation.expiresAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => revokeInvite(invitation)} disabled={pendingAction === `invite:${invitation.id}`}>
                      <Trash2 className="h-4 w-4" />
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
            <DialogDescription>Create a setup link and assign app access.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitInvite} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="inviteEmail">Email</Label>
                <Input id="inviteEmail" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inviteDisplayName">Display name</Label>
                <Input id="inviteDisplayName" value={inviteDisplayName} onChange={(event) => setInviteDisplayName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inviteRole">Role</Label>
                <select id="inviteRole" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={inviteRole} onChange={(event) => {
                  const role = event.target.value === "host.admin" ? "host.admin" : "host.user";
                  setInviteRole(role);
                  if (role === "host.admin") {
                    setInviteAppIds([]);
                  }
                }}>
                  <option value="host.user">User</option>
                  <option value="host.admin">Admin</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="inviteTtl">Expires</Label>
                <select id="inviteTtl" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={inviteTtlMs} onChange={(event) => setInviteTtlMs(Number(event.target.value))}>
                  {ttlOptions.map((option) => <option key={option.ttlMs} value={option.ttlMs}>{option.label}</option>)}
                </select>
              </div>
            </div>
            {inviteRole === "host.user" && (
              <AppAccessPicker apps={apps} selectedAppIds={inviteAppIds} onChange={setInviteAppIds} />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pendingAction === "invite"}>
                {pendingAction === "invite" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Generate link
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(createdInvite)} onOpenChange={(open) => !open && setCreatedInvite(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Setup link generated</DialogTitle>
            <DialogDescription>Send this link to the invited user.</DialogDescription>
          </DialogHeader>
          {createdInvite && (
            <div className="space-y-3">
              <CopyField label="Setup URL" value={createdInvite.setupUrl} copied={copiedInviteField === "url"} onCopy={() => void copyInviteField("url", createdInvite.setupUrl)} />
              <CopyField label="Token" value={createdInvite.token} copied={copiedInviteField === "token"} onCopy={() => void copyInviteField("token", createdInvite.token)} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(accessUser)} onOpenChange={(open) => !open && setAccessUserId(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{accessUser ? `App access: ${accessUser.displayName || accessUser.email || accessUser.id}` : "App access"}</DialogTitle>
            <DialogDescription>Select runtime apps this user can open.</DialogDescription>
          </DialogHeader>
          {accessUser && (
            <div className="space-y-4">
              <AppAccessPicker apps={apps} selectedAppIds={accessAppIds} onChange={setAccessAppIds} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAccessUserId(null)}>Cancel</Button>
                <Button type="button" onClick={saveAccess} disabled={pendingAction === `access:${accessUser.id}`}>
                  {pendingAction === `access:${accessUser.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save access
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UserRowActionsMenu({
  user,
  activeUserId,
  pendingAction,
  onOpenAccessEditor,
  onUpdateRole,
  onDisableUser,
}: {
  user: HostUserSummary;
  activeUserId: string | null;
  pendingAction: string | null;
  onOpenAccessEditor: (user: HostUserSummary) => void;
  onUpdateRole: (user: HostUserSummary) => void;
  onDisableUser: (user: HostUserSummary) => void;
}) {
  const isSelf = activeUserId === user.id;
  const roleActionKey = `role:${user.id}`;
  const disableActionKey = `disable:${user.id}`;
  const roleActionDisabled = user.disabled || pendingAction === roleActionKey || (isSelf && user.role === "host.admin");
  const disableActionDisabled = user.disabled || pendingAction === disableActionKey || isSelf;
  const roleActionLabel = user.role === "host.admin" ? "Make user" : "Make admin";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="User actions" title="User actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {user.role === "host.user" && (
          <DropdownMenuItem disabled={user.disabled} onClick={() => onOpenAccessEditor(user)}>
            <UserCog className="h-4 w-4" />
            Access
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={roleActionDisabled} onClick={() => onUpdateRole(user)}>
          {pendingAction === roleActionKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {roleActionLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={disableActionDisabled} onClick={() => onDisableUser(user)}>
          {pendingAction === disableActionKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
          Disable
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppAccessPicker({ apps, selectedAppIds, onChange }: { apps: AssignableAppSummary[]; selectedAppIds: string[]; onChange: (ids: string[]) => void }) {
  const knownIds = new Set(apps.map((app) => app.id));
  const options = [
    ...apps,
    ...selectedAppIds.filter((appId) => !knownIds.has(appId)).map((appId) => ({ id: appId, name: appId, version: "", operationStatus: "unavailable" })),
  ];
  const selected = new Set(selectedAppIds);

  return (
    <div className="space-y-2">
      <Label>Runtime app access</Label>
      <div className="max-h-64 overflow-auto rounded-md border">
        {options.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No runtime apps</div>
        ) : options.map((app) => (
          <label key={app.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
            <input
              type="checkbox"
              checked={selected.has(app.id)}
              onChange={(event) => {
                if (event.target.checked) {
                  onChange(Array.from(new Set([...selectedAppIds, app.id])).sort());
                } else {
                  onChange(selectedAppIds.filter((candidate) => candidate !== app.id));
                }
              }}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{app.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{app.id}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function AppDetailsDialog({
  app,
  view,
  configureSection,
  canManageApps,
  busyAction,
  detail,
  onClose,
  onRefreshLogs,
  onRefreshBackups,
  onCreateBackup,
  onRestoreBackup,
  onDeleteBackup,
  onPreviewBackupCleanup,
  onApplyBackupCleanup,
  onConfigure,
  onReloadUpdatePlan,
  onApplyUpdate,
  onRemove,
}: {
  app: CoreApp;
  view: DetailView;
  configureSection?: "publicOrigins";
  canManageApps: boolean;
  busyAction: string | null;
  detail: DetailPanelState;
  onClose: () => void;
  onRefreshLogs: (app: CoreApp) => void;
  onRefreshBackups: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
  onPreviewBackupCleanup: (app: CoreApp) => void;
  onApplyBackupCleanup: (app: CoreApp, plan: CoreBackupCleanupPlan) => void;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void;
  onReloadUpdatePlan: (app: CoreApp) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
}) {
  const canMutateApp = canManageApps && !app.system;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn("sm:max-w-3xl", view === "logs" && "max-h-[calc(100vh-2rem)] overflow-hidden sm:max-w-5xl")}>
        <DialogHeader>
          <DialogTitle>{detailTitle(view)} · {app.displayName}</DialogTitle>
          <DialogDescription>{app.id}</DialogDescription>
        </DialogHeader>
        {detail.error && <InlineError message={detail.error} />}
        {view === "logs" && <LogsPanel app={app} detail={detail} onRefresh={onRefreshLogs} />}
        {view === "backups" && canMutateApp && (
          <BackupsPanel
            app={app}
            detail={detail}
            busyAction={busyAction}
            onRefresh={onRefreshBackups}
            onCreateBackup={onCreateBackup}
            onRestoreBackup={onRestoreBackup}
            onDeleteBackup={onDeleteBackup}
            onPreviewCleanup={onPreviewBackupCleanup}
            onApplyCleanup={onApplyBackupCleanup}
          />
        )}
        {view === "backups" && !canMutateApp && <InlineError message="System app backup controls are not available in Shell." />}
        {view === "configure" && <ConfigurePanel app={app} busyAction={busyAction} canManageApps={canMutateApp} initialOpenSection={configureSection} onConfigure={onConfigure} />}
        {view === "update" && (canMutateApp ? (
          <UpdatePanel app={app} detail={detail} busyAction={busyAction} onReloadPlan={onReloadUpdatePlan} onApplyUpdate={onApplyUpdate} />
        ) : (
          <InlineError message="System app update controls are not available in Shell." />
        ))}
        {view === "remove" && <RemovePanel app={app} busyAction={busyAction} canRemove={canMutateApp} onRemove={onRemove} />}
      </DialogContent>
    </Dialog>
  );
}

function LogsPanel({ app, detail, onRefresh }: { app: CoreApp; detail: DetailPanelState; onRefresh: (app: CoreApp) => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => onRefresh(app)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <pre className="max-h-[min(480px,calc(100vh-14rem))] min-w-0 max-w-full overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-50">{detail.loading ? "Loading logs" : detail.logs || "No logs"}</pre>
    </div>
  );
}

function BackupsPanel({
  app,
  detail,
  busyAction,
  onRefresh,
  onCreateBackup,
  onRestoreBackup,
  onDeleteBackup,
  onPreviewCleanup,
  onApplyCleanup,
}: {
  app: CoreApp;
  detail: DetailPanelState;
  busyAction: string | null;
  onRefresh: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
  onPreviewCleanup: (app: CoreApp) => void;
  onApplyCleanup: (app: CoreApp, plan: CoreBackupCleanupPlan) => void;
}) {
  const backups = detail.backups || [];
  const cleanupPlan = detail.backupCleanupPlan;
  const isRunning = app.runtimeState === "running";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onCreateBackup(app)} disabled={busyAction === `${app.id}:backup`}>
          {busyAction === `${app.id}:backup` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
          Create backup
        </Button>
        <Button variant="outline" onClick={() => onRefresh(app, false)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Refresh
        </Button>
        <Button variant="outline" onClick={() => onPreviewCleanup(app)} disabled={busyAction === `${app.id}:backup-cleanup-plan`}>
          <FileText className="h-4 w-4" />
          Preview prune
        </Button>
      </div>
      {cleanupPlan && (
        <div className="rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{cleanupPlan.candidates.length} prune candidates</div>
              <code className="block truncate text-xs text-muted-foreground">{cleanupPlan.planDigest}</code>
            </div>
            <Button variant="destructive" onClick={() => onApplyCleanup(app, cleanupPlan)} disabled={cleanupPlan.candidates.length === 0 || busyAction === `${app.id}:backup-cleanup`}>
              <Trash2 className="h-4 w-4" />
              Apply prune
            </Button>
          </div>
        </div>
      )}
      {detail.loading ? (
        <EmptyState icon={LoaderCircle} title="Loading backups" iconClassName="animate-spin" />
      ) : backups.length === 0 ? (
        <EmptyState icon={Database} title="No backups" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Retention</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {backups.map((backup) => (
              <TableRow key={backup.backupId}>
                <TableCell>
                  <div className="font-medium">{backup.reason}</div>
                  <div className="text-xs text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</div>
                  <code className="text-xs text-muted-foreground">{backup.backupId}</code>
                </TableCell>
                <TableCell>{backup.fileCount}</TableCell>
                <TableCell>{formatBytes(backup.archiveSize)}</TableCell>
                <TableCell>{backup.retention?.reason || "unknown"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <IconButton title="Restore" disabled={isRunning || busyAction === `${app.id}:restore:${backup.backupId}`} onClick={() => onRestoreBackup(app, backup)}><Upload className="h-4 w-4" /></IconButton>
                    <IconButton title="Delete" disabled={busyAction === `${app.id}:delete-backup:${backup.backupId}`} onClick={() => onDeleteBackup(app, backup)} destructive><Trash2 className="h-4 w-4" /></IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ConfigurePanel({
  app,
  busyAction,
  canManageApps,
  initialOpenSection,
  onConfigure,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  initialOpenSection?: "publicOrigins";
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void;
}) {
  const settings = app.settings || [];
  const appSettings = settings.filter((setting) => !isPublicOriginSettingKey(setting.key));
  const publicOriginSettings = settings.filter((setting) => isPublicOriginSettingKey(setting.key));
  const publicOriginGroups = buildPublicOriginGroups(app, publicOriginSettings);
  const settingsSignature = settings
    .map((setting) => `${setting.key}\u0000${setting.type}\u0000${setting.secret ? "1" : "0"}\u0000${setting.required ? "1" : "0"}\u0000${setting.value ?? ""}`)
    .join("\u0001");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [autostartDraft, setAutostartDraft] = useState(isAppAutostartEnabled(app));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [publicOriginsOpen, setPublicOriginsOpen] = useState(false);

  useEffect(() => {
    const nextDraft = Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? "" : setting.value || ""]));
    const nextAppSettings = settings.filter((setting) => !isPublicOriginSettingKey(setting.key));
    setDraft(nextDraft);
    setAutostartDraft(isAppAutostartEnabled(app));
    setSettingsOpen(hasMissingRequiredSettings(nextAppSettings, nextDraft));
    setPublicOriginsOpen(initialOpenSection === "publicOrigins");
  }, [app.id, app.autostart, settingsSignature, initialOpenSection]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: Record<string, string | null> = {};
    for (const setting of settings) {
      const value = draft[setting.key] ?? "";
      if (!setting.secret || value.length > 0) {
        payload[setting.key] = value;
      }
    }
    onConfigure(app, payload, autostartDraft);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-md border bg-muted/30 p-3">
        <CheckboxRow label="Start at Core startup" checked={autostartDraft} disabled={!canManageApps} onChange={setAutostartDraft} />
      </div>
      <ConfigureSection
        title="App settings"
        testId="configure-app-settings"
        count={appSettings.length}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        attention={hasMissingRequiredSettings(appSettings, draft)}
      >
        {appSettings.length > 0 ? (
          <div className="space-y-3">
            {appSettings.map((setting) => (
              <SettingInput key={setting.key} setting={setting} value={draft[setting.key] ?? ""} disabled={!canManageApps} onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This app has no app-owned settings.</p>
        )}
      </ConfigureSection>
      <ConfigureSection
        title="Public origins"
        testId="configure-public-origins"
        count={publicOriginSettings.length}
        open={publicOriginsOpen}
        onOpenChange={setPublicOriginsOpen}
      >
        {publicOriginSettings.length > 0 ? (
          <div className="space-y-4">
            {publicOriginGroups.map((group) => (
              <div key={group.service} className="space-y-2">
                <h3 className="text-sm font-medium">{group.service}</h3>
                <div className="space-y-2">
                  {group.items.map(({ setting, endpoint }) => (
                    <PublicOriginInput
                      key={setting.key}
                      setting={setting}
                      endpoint={endpoint}
                      value={draft[setting.key] ?? ""}
                      disabled={!canManageApps}
                      onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This app has no public endpoints.</p>
        )}
      </ConfigureSection>
      <DialogFooter>
        <Button type="submit" disabled={!canManageApps || busyAction === `${app.id}:configure`}>
          {busyAction === `${app.id}:configure` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
          Save settings
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdatePanel({ app, detail, busyAction, onReloadPlan, onApplyUpdate }: { app: CoreApp; detail: DetailPanelState; busyAction: string | null; onReloadPlan: (app: CoreApp) => void; onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void }) {
  const plan = detail.updatePlan;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => onReloadPlan(app)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Recheck
        </Button>
      </div>
      {detail.loading ? (
        <EmptyState icon={LoaderCircle} title="Loading update plan" iconClassName="animate-spin" />
      ) : plan ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FactCard label="Version" value={`${plan.currentVersion} to ${plan.targetVersion}`} />
            <FactCard label="Runtime" value={`${plan.currentRuntime || "none"} to ${plan.targetRuntime}`} />
            <FactCard label="Backup" value={plan.willCreatePreUpdateBackup ? "pre-update" : "none"} />
            <FactCard label="Plan digest" value={plan.planDigest.slice(0, 16)} />
          </div>
          <div className="rounded-md border p-4">
            <h3 className="mb-2 text-sm font-medium">Changes</h3>
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No changes reported.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {plan.changes.map((change) => <li key={change}>{formatUpdateChange(change)}</li>)}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => onApplyUpdate(app, plan)} disabled={plan.changes.length === 0 || busyAction === `${app.id}:update`}>
              {busyAction === `${app.id}:update` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Apply update
            </Button>
          </DialogFooter>
        </>
      ) : (
        <EmptyState icon={Upload} title="No update plan" />
      )}
    </div>
  );
}

function RemovePanel({ app, busyAction, canRemove, onRemove }: { app: CoreApp; busyAction: string | null; canRemove: boolean; onRemove: (app: CoreApp, options: RemoveOptions) => void }) {
  const [options, setOptions] = useState<RemoveOptions>({
    deleteData: false,
    deleteBackups: false,
    deleteSource: false,
    ignoreRuntimeErrors: false,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        Runtime state is always removed. Optional cleanup controls app data, backups, and source checkout.
      </div>
      <div className="space-y-2">
        <CheckboxRow label="Delete app data" checked={options.deleteData} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, deleteData: checked }))} />
        <CheckboxRow label="Delete backups" checked={options.deleteBackups} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, deleteBackups: checked }))} />
        <CheckboxRow label="Delete source checkout" checked={options.deleteSource} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, deleteSource: checked }))} />
        <CheckboxRow label="Ignore runtime errors" checked={options.ignoreRuntimeErrors} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, ignoreRuntimeErrors: checked }))} />
      </div>
      <DialogFooter>
        <Button variant="destructive" onClick={() => onRemove(app, options)} disabled={!canRemove || busyAction === `${app.id}:remove`}>
          {busyAction === `${app.id}:remove` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Remove app
        </Button>
      </DialogFooter>
    </div>
  );
}

function formatUpdateChange(change: string): string {
  if (change === "manifest") {
    return "Manifest content changed";
  }

  if (change.startsWith("version:")) {
    return `Version changed from ${formatArrowValue(change.slice("version:".length))}`;
  }

  if (change.startsWith("runtime:")) {
    return `Runtime changed from ${formatArrowValue(change.slice("runtime:".length))}`;
  }

  if (change.startsWith("service:")) {
    return formatServiceChange(splitToken(change.slice("service:".length), 2));
  }

  if (change.startsWith("image:")) {
    const [service, diff] = splitToken(change.slice("image:".length), 1);
    return `Service ${service} image changed from ${formatArrowValue(diff)}`;
  }

  if (change.startsWith("command:")) {
    const [service] = splitToken(change.slice("command:".length), 1);
    return `Service ${service} command changed`;
  }

  if (change.startsWith("workingDirectory:")) {
    const [service, diff] = splitToken(change.slice("workingDirectory:".length), 1);
    return `Service ${service} working directory changed from ${formatArrowValue(diff)}`;
  }

  if (change.startsWith("port:")) {
    return formatResourceChange("Port", change.slice("port:".length));
  }

  if (change.startsWith("environment:")) {
    return formatResourceChange("Environment variable", change.slice("environment:".length));
  }

  if (change.startsWith("setting:")) {
    return formatSettingChange(change.slice("setting:".length));
  }

  if (change.startsWith("dependency:")) {
    return formatResourceChange("Dependency", change.slice("dependency:".length));
  }

  if (change.startsWith("endpoint:")) {
    return formatResourceChange("Endpoint", change.slice("endpoint:".length));
  }

  if (change.startsWith("data:")) {
    return formatDataChange(change.slice("data:".length));
  }

  if (change.startsWith("capability:")) {
    return formatResourceChange("Capability", change.slice("capability:".length));
  }

  return change;
}

function formatServiceChange(parts: string[]): string {
  const [service, action, detail] = parts;
  if (action === "added") {
    return `Service ${service} added (${detail})`;
  }

  if (action === "removed") {
    return `Service ${service} removed (${detail})`;
  }

  if (action === "runtimeType") {
    return `Service ${service} runtime type changed from ${formatArrowValue(detail || "")}`;
  }

  return `Service ${service} changed`;
}

function formatSettingChange(payload: string): string {
  const [setting, action, detail] = splitToken(payload, 2);
  if (action === "type") {
    return `Setting ${setting} type changed from ${formatArrowValue(detail || "")}`;
  }

  if (action === "secret") {
    return `Setting ${setting} secret flag changed from ${formatArrowValue(detail || "")}`;
  }

  return formatResourceChange("Setting", payload);
}

function formatDataChange(payload: string): string {
  const [action, detail] = splitToken(payload, 1);
  if (action === "added") {
    return `Data directory added at ${detail}`;
  }

  if (action === "removed") {
    return `Data directory removed from ${detail}`;
  }

  if (action === "target") {
    return `Data directory target changed from ${formatArrowValue(detail || "")}`;
  }

  return "Data directory changed";
}

function formatResourceChange(label: string, payload: string): string {
  const [name, detail] = splitToken(payload, 1);
  if (detail.startsWith("added:")) {
    return `${label} ${name} added (${detail.slice("added:".length)})`;
  }

  if (detail.startsWith("removed:")) {
    return `${label} ${name} removed (${detail.slice("removed:".length)})`;
  }

  if (detail === "added") {
    return `${label} ${name} added`;
  }

  if (detail === "removed") {
    return `${label} ${name} removed`;
  }

  if (detail === "changed") {
    return `${label} ${name} changed`;
  }

  if (detail.includes("->")) {
    return `${label} ${name} changed from ${formatArrowValue(detail)}`;
  }

  const [attribute, value] = splitToken(detail, 1);
  if (value) {
    return `${label} ${name} ${attribute} changed from ${formatArrowValue(value)}`;
  }

  return `${label} ${name} changed`;
}

function formatArrowValue(value: string): string {
  const separator = value.indexOf("->");
  if (separator === -1) {
    return value || "unknown";
  }

  return `${value.slice(0, separator)} to ${value.slice(separator + 2)}`;
}

function splitToken(value: string, fixedParts: number): string[] {
  const parts: string[] = [];
  let rest = value;
  for (let index = 0; index < fixedParts; index++) {
    const separator = rest.indexOf(":");
    if (separator === -1) {
      parts.push(rest);
      rest = "";
      break;
    }

    parts.push(rest.slice(0, separator));
    rest = rest.slice(separator + 1);
  }

  parts.push(rest);
  return parts;
}

function CheckboxRow({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function EmbeddedWorkspacePanel({
  workspace,
  theme,
  themePreference,
}: {
  workspace: EmbeddedWorkspace;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState(workspace.src);

  if (workspace.src !== loadedSrc) {
    setLoadedSrc(workspace.src);
    setLoaded(false);
  }

  const postTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) {
      return;
    }

    try {
      frame.contentWindow.postMessage(
        {
          type: "hosty:shell-theme",
          theme,
          preference: themePreference,
        },
        getPostMessageTargetOrigin(workspace.src),
      );
    } catch {
      // The frame can still be about:blank or chrome-error while a local app is restarting.
    }
  }, [theme, themePreference, workspace.src]);

  useEffect(() => {
    if (loaded) {
      postTheme();
    }
  }, [loaded, postTheme]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        key={`${workspace.appId}:${workspace.path}:${workspace.src}`}
        className={cn("hosty-app-frame transition-opacity duration-100", loaded ? "opacity-100" : "opacity-0")}
        title={`${workspace.title}: ${workspace.pageLabel}`}
        src={workspace.src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        allow="clipboard-write"
        style={{ colorScheme: theme }}
        onLoad={handleLoad}
      />
    </div>
  );
}

function getPostMessageTargetOrigin(src: string) {
  try {
    return new URL(src, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

function ConfigureSection({ title, testId, count, open, attention, onOpenChange, children }: { title: string; testId: string; count: number; open: boolean; attention?: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <section data-testid={testId} className="rounded-md border bg-background">
      <button
        type="button"
        className="flex min-h-12 w-full items-center justify-between gap-3 px-3 text-left"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm font-medium">{title}</span>
          <Badge variant={attention ? "default" : "outline"}>{count}</Badge>
        </span>
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </section>
  );
}

function PublicOriginInput({ setting, endpoint, value, disabled, onChange }: { setting: CoreSetting; endpoint?: CoreEndpoint; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const currentUrl = endpoint?.url || "not assigned";
  const endpointKey = endpoint?.key || getPublicOriginEndpointLabel(setting.key);
  const inputLabel = `Public origin for ${endpoint?.service || "service"} ${endpointKey}`;

  return (
    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)] md:items-center">
      <div className="min-w-0 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <div className={cn("truncate font-mono", endpoint?.url ? "text-foreground" : "text-muted-foreground")}>{currentUrl}</div>
      </div>
      <Input
        id={`setting-${setting.key}`}
        type="url"
        value={value}
        aria-label={inputLabel}
        placeholder={`https://${endpointKey || "app"}.example.com`}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SettingInput({ setting, value, disabled, onChange }: { setting: CoreInstallSetting | CoreSetting; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const label = formatSettingLabel(setting.key);
  return (
    <div className="space-y-2">
      <Label htmlFor={`setting-${setting.key}`} className="flex items-center gap-2" title={setting.key}>
        {label}
        <Badge variant="outline">{setting.secret ? "secret" : setting.type}</Badge>
        {setting.required && <Badge variant="secondary">required</Badge>}
      </Label>
      <Input
        id={`setting-${setting.key}`}
        type={setting.secret ? "password" : setting.type === "url" ? "url" : "text"}
        value={value}
        placeholder={setting.secret ? "Unchanged" : setting.type === "url" ? "https://app.example.com" : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const publicOriginSettingPrefix = "HOSTY_PUBLIC_ORIGIN_";

function isPublicOriginSettingKey(key: string) {
  return key.startsWith(publicOriginSettingPrefix);
}

function getPublicOriginEndpointLabel(key: string) {
  if (!isPublicOriginSettingKey(key)) {
    return "";
  }

  return key.slice(publicOriginSettingPrefix.length).toLowerCase().replaceAll("_", ".");
}

function formatSettingLabel(key: string) {
  if (isPublicOriginSettingKey(key)) {
    const endpoint = getPublicOriginEndpointLabel(key);
    return endpoint.length > 0 ? `Public origin (${endpoint})` : "Public origin";
  }

  return key;
}

function findPublicOriginEndpoint(app: CoreApp, settingKey: string) {
  return app.endpoints?.find((endpoint) => buildPublicOriginSettingKey(endpoint.key) === settingKey);
}

function buildPublicOriginGroups(app: CoreApp, settings: CoreSetting[]) {
  const groups = new Map<string, { service: string; items: Array<{ setting: CoreSetting; endpoint?: CoreEndpoint }> }>();
  for (const setting of settings) {
    const endpoint = findPublicOriginEndpoint(app, setting.key);
    const service = endpoint?.service?.trim() || "service";
    const group = groups.get(service) ?? { service, items: [] };
    group.items.push({ setting, endpoint });
    groups.set(service, group);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: group.items.sort((left, right) =>
        (left.endpoint?.key || left.setting.key).localeCompare(right.endpoint?.key || right.setting.key)),
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

function buildPublicOriginSettingKey(endpointKey: string) {
  return `${publicOriginSettingPrefix}${normalizePublicOriginEndpointKey(endpointKey)}`;
}

function normalizePublicOriginEndpointKey(value: string) {
  const normalized = (value || "endpoint")
    .split("")
    .map((character) => /[a-zA-Z0-9]/.test(character) ? character.toUpperCase() : "_")
    .join("")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ENDPOINT";
}

function hasMissingRequiredSettings(settings: CoreSetting[], draft: Record<string, string>) {
  return settings.some((setting) => setting.required && !setting.secret && (draft[setting.key] ?? "").trim().length === 0);
}

function InlineError({ message }: { message: string }) {
  return <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</div>;
}

function EmptyState({ icon: Icon, title, description, iconClassName }: { icon: LucideIcon; title: string; description?: string; iconClassName?: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border bg-card p-6 text-center">
      <Icon className={cn("mb-3 h-6 w-6 text-muted-foreground", iconClassName)} />
      <div className="font-medium">{title}</div>
      {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const running = normalized.includes("running") || normalized.includes("ok") || normalized.includes("ready");
  const attention = normalized.includes("error") || normalized.includes("failed") || normalized.includes("unknown") || normalized.includes("offline");
  return (
    <Badge variant="outline" className={cn("gap-1.5", (running || attention) && "border-transparent", running && "bg-emerald-500/10 text-emerald-700", attention && "bg-amber-500/10 text-amber-700")}>
      <span className={cn("h-2 w-2 rounded-full", running ? "bg-emerald-500" : attention ? "bg-amber-500" : "bg-muted-foreground")} />
      {value}
    </Badge>
  );
}

function RoleBadge({ role, disabled }: { role: "host.admin" | "host.user"; disabled?: boolean }) {
  if (disabled) {
    return <Badge variant="secondary">Disabled</Badge>;
  }

  return <Badge variant={role === "host.admin" ? "default" : "outline"}>{role === "host.admin" ? "Admin" : "User"}</Badge>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function FactCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <Fact label={label} value={value} />
    </div>
  );
}

function CopyField({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Input value={value} readOnly />
        <Button type="button" variant="outline" onClick={onCopy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function getAppPageLinks(app: CoreApp): AppPageLink[] {
  const navigation = app.navigation || [];
  if (navigation.length > 0) {
    return navigation
      .map((item) => {
        const redirectUri = item.embeddedUrl || buildRedirectUriFromAppPath(app, item.path);
        return redirectUri ? { label: item.label, path: item.path, redirectUri } : null;
      })
      .filter((item): item is AppPageLink => item !== null);
  }

  const home = app.embeddedUrl || getOpenEndpoint(app)?.url;
  return home ? [{ label: "Home", path: "/", redirectUri: home }] : [];
}

function buildRedirectUriFromAppPath(app: CoreApp, path: string) {
  const base = app.embeddedUrl || getOpenEndpoint(app)?.url;
  if (!base) {
    return null;
  }

  try {
    const url = new URL(base);
    url.pathname = path.startsWith("/") ? path : `/${path}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return base;
  }
}

function getOpenEndpoint(app: CoreApp) {
  return app.endpoints?.find((endpoint) => endpoint.public && endpoint.url) ?? app.endpoints?.find((endpoint) => endpoint.url);
}

function getConfiguredPublicOrigin(app: CoreApp, endpointKey: string) {
  const settingKey = buildPublicOriginSettingKey(endpointKey);
  const value = app.settings?.find((setting) => setting.key === settingKey)?.value?.trim();
  return value && value.length > 0 ? value : null;
}

function getEndpointPublicOrigin(app: CoreApp, endpoint: CoreEndpoint) {
  const value = endpoint.publicOrigin?.trim() || getConfiguredPublicOrigin(app, endpoint.key);
  return value && value.length > 0 ? value : null;
}

function buildRuntimeServiceRows(app: CoreApp, health: AppHealthResponse | null | undefined): RuntimeServiceRow[] {
  const services = new Map<string, RuntimeServiceRow>();
  const ensureService = (service: string) => {
    const existing = services.get(service);
    if (existing) {
      return existing;
    }

    const created: RuntimeServiceRow = {
      service,
      status: health?.status || app.runtimeState || app.operationStatus,
      message: null,
      endpoints: [],
    };
    services.set(service, created);
    return created;
  };

  for (const service of health?.services || []) {
    const row = ensureService(service.service || "default");
    row.status = service.status || row.status;
    row.message = service.message || null;
  }

  const healthServices = health?.services || [];
  const fallbackEndpointService = healthServices.length === 1 ? healthServices[0].service : "endpoints";
  for (const endpoint of app.endpoints || []) {
    const service = getEndpointService(endpoint, fallbackEndpointService);
    ensureService(service).endpoints.push(endpoint);
  }

  return Array.from(services.values())
    .map((service) => ({
      ...service,
      endpoints: [...service.endpoints].sort((left, right) => left.key.localeCompare(right.key)),
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

function getEndpointService(endpoint: CoreEndpoint, fallback = "endpoints") {
  const service = endpoint.service?.trim();
  if (service) {
    return service;
  }

  const separatorIndex = endpoint.key.indexOf(".");
  return separatorIndex > 0 ? endpoint.key.slice(0, separatorIndex) : fallback;
}

function getHealthSummary(total: number, running: number, attention: number) {
  if (attention > 0) {
    return { label: `${attention} need attention`, className: "bg-amber-500/10 text-amber-700" };
  }
  if (total === 0) {
    return { label: "No apps", className: "bg-muted text-muted-foreground" };
  }
  if (running === total) {
    return { label: "Healthy", className: "bg-emerald-500/10 text-emerald-700" };
  }
  return { label: `${running}/${total} running`, className: "bg-sky-500/10 text-sky-700" };
}

function getRuntimeCoverage(running: number, total: number) {
  if (total === 0) {
    return 0;
  }
  return Math.round((running / total) * 100);
}

function formatRuntimeProfileLabel(profile: CoreInstallRuntimeProfile) {
  return `${profile.key}${profile.default ? " (default)" : ""} - ${profile.type}`;
}

function pluralize(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}

function getAccountInitials(user: NonNullable<SessionResponse["user"]>) {
  const source = user.displayName || user.email || user.id;
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U";
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

function detailTitle(view: DetailView) {
  switch (view) {
    case "logs":
      return "Logs";
    case "backups":
      return "Backups";
    case "configure":
      return "Configure";
    case "update":
      return "Update";
    case "remove":
      return "Remove";
  }
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
