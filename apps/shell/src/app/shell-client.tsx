"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
};

type CoreEndpoint = {
  key: string;
  protocol: string;
  url?: string | null;
  public: boolean;
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
  operationStatus: string;
  runtimeState: string;
  lastOperation?: string | null;
  lastError?: string | null;
  capabilities: string[];
  settings?: CoreSetting[];
  endpoints?: CoreEndpoint[];
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

type CoreInstallSetting = {
  key: string;
  type: string;
  defaultValue?: string | null;
  secret: boolean;
};

type CoreInstallRuntimeProfile = {
  key: string;
  type: string;
  default: boolean;
};

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
  runtimeProfiles?: CoreInstallRuntimeProfile[];
  settings: CoreInstallSetting[];
};

type CoreError = {
  code?: string;
  message?: string;
};

type AppAction = "start" | "stop" | "restart" | "backup";
type DetailView = "logs" | "backups" | "configure" | "update" | "remove";
type ShellView = "dashboard" | "apps" | "users";
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
  assignedModuleIds: string[];
  lastSeenAt?: string | null;
};

type UserInvitationSummary = {
  id: string;
  email: string;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  assignedModuleIds: string[];
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
  modules?: AssignableAppSummary[];
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
};

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

export function ShellClient({
  coreOrigin,
  shellAppId,
}: {
  coreOrigin: string;
  shellAppId: string;
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
  const [activeView, setActiveView] = useState<ShellView>("dashboard");
  const [workspace, setWorkspace] = useState<EmbeddedWorkspace | null>(null);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const shellThemePreference = normalizeThemePreference(theme);
  const shellResolvedTheme = resolveShellTheme(resolvedTheme);

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

      if (!statusResponse.ok) {
        throw new Error(`Core status returned ${statusResponse.status}.`);
      }

      const status = (await statusResponse.json()) as CoreStatus;
      const session = sessionResponse.ok ? ((await sessionResponse.json()) as SessionResponse) : null;
      if (session && !session.authenticated) {
        setState({
          loading: false,
          error: null,
          status,
          apps: [],
          session,
          updatedAt: new Date().toISOString(),
        });
        window.location.assign(`${coreOrigin}/login`);
        return;
      }

      let apps: AppsResponse = { apps: [] };
      if (session?.authenticated) {
        const appsResponse = await fetch(`${coreOrigin}/api/apps`, { credentials: "include" });
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
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Core is unavailable.",
      }));
    }
  }, [coreOrigin]);

  const loadCsrfToken = useCallback(async () => {
    const response = await fetch(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
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

      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      return response;
    },
    [loadCsrfToken],
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
        setActiveView("dashboard");
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

      const actionKey = `${app.id}:open`;
      setBusyAction(actionKey);
      setState((current) => ({ ...current, error: null }));

      try {
        const themedRedirectUri = appendHostyThemeParams(page.redirectUri, shellResolvedTheme, shellThemePreference);
        const response = await sendCsrfJson(appEndpoint(app, "/launch-code"), { redirectUri: themedRedirectUri });
        const launch = (await response.json()) as AppLaunchResponse;
        setActiveView("apps");
        setWorkspace({
          appId: app.id,
          title: app.displayName,
          pageLabel: page.label,
          path: page.path,
          src: launch.redirectUri,
          externalUrl: launch.redirectUri,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create app launch link.";
        setState((current) => ({ ...current, error: message }));
        toast.error("App launch failed", { description: message });
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, getStandaloneAppHref, sendCsrfJson, shellAppId, shellResolvedTheme, shellThemePreference],
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
        const message = error instanceof Error ? error.message : "Core lifecycle action failed.";
        setState((current) => ({ ...current, error: message }));
        toast.error("App action failed", { description: message });
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint, refresh, sendCsrfJson],
  );

  const loadAppLogs = useCallback(
    async (app: CoreApp) => {
      setActivePanel({ appId: app.id, view: "logs" });
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetch(`${appEndpoint(app, "/logs")}?tail=200`, { credentials: "include" });
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as LogsResponse;
        setDetailPanel({ loading: false, error: null, logs: payload.text || "", backups: null, backupCleanupPlan: null, updatePlan: null });
      } catch (error) {
        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core logs are unavailable.", logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint],
  );

  const loadAppBackups = useCallback(
    async (app: CoreApp, activate = true) => {
      if (activate) {
        setActivePanel({ appId: app.id, view: "backups" });
      }
      setDetailPanel({ loading: true, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      try {
        const response = await fetch(appEndpoint(app, "/backups"), { credentials: "include" });
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as BackupsResponse;
        setDetailPanel({ loading: false, error: null, logs: null, backups: payload.backups, backupCleanupPlan: null, updatePlan: null });
      } catch (error) {
        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Core backups are unavailable.", logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint],
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
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const payload = (await response.json()) as CoreUpdatePlan;
        setDetailPanel({ loading: false, error: null, logs: null, backups: null, backupCleanupPlan: null, updatePlan: payload });
      } catch (error) {
        setDetailPanel({ loading: false, error: error instanceof Error ? error.message : "Update plan is unavailable.", logs: null, backups: null, backupCleanupPlan: null, updatePlan: null });
      }
    },
    [appEndpoint],
  );

  const openAppPanel = useCallback(
    (app: CoreApp, view: DetailView) => {
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
      setActivePanel({ appId: app.id, view });
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
        setDetailPanel((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Backup cleanup preview failed.",
        }));
      } finally {
        setBusyAction(null);
      }
    },
    [appEndpoint],
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
    async (app: CoreApp, settings: Record<string, string | null>) => {
      const actionKey = `${app.id}:configure`;
      setBusyAction(actionKey);
      try {
        await sendCsrfJson(appEndpoint(app, "/configure"), { settings });
        await refresh();
        setActivePanel(null);
        toast.success("Settings saved", { description: app.displayName });
      } catch (error) {
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
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }

        const plan = (await response.json()) as CoreInstallPlan;
        setInstallPanel({ loading: false, error: null, plan });
      } catch (error) {
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
    async (plan: CoreInstallPlan, settings: Record<string, string | null>) => {
      setBusyAction("install");
      try {
        await sendCsrfJson(`${coreOrigin}/api/apps/install`, {
          manifestPath: plan.manifestPath,
          selectedRuntime: plan.targetRuntime,
          selectedChannel: plan.selectedChannel,
          system: false,
          settings,
        });
        await refresh();
        setInstallOpen(false);
        setInstallPanel(emptyInstallPanelState());
        toast.success("App installed", { description: plan.displayName });
      } catch (error) {
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

  const activeUser = state.session?.authenticated ? state.session.user : null;
  const canManageApps = activeUser?.role === "host.admin";
  const runtimeApps = useMemo(() => state.apps.filter((app) => !app.system), [state.apps]);
  const uiRuntimeApps = useMemo(() => runtimeApps.filter((app) => getAppPageLinks(app).length > 0), [runtimeApps]);
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
          activeView={activeView}
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
          onAction={runAppAction}
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
              ) : activeView === "users" && canManageApps ? (
                <UserManagementPanel coreOrigin={coreOrigin} activeUser={activeUser} sendCsrfJson={sendCsrfJson} />
              ) : activeView === "apps" ? (
                <InstalledAppsPage
                  apps={runtimeApps}
                  shellAppId={shellAppId}
                  canManageApps={Boolean(canManageApps)}
                  loading={state.loading}
                  busyAction={busyAction}
                  onRefresh={() => void refresh()}
                  onInstall={openInstallDialog}
                  onAction={runAppAction}
                  onCreateBackup={createManualBackup}
                  onOpenPanel={openAppPanel}
                />
              ) : (
                <DashboardPage
                  state={state}
                  runtimeApps={runtimeApps}
                  onRefresh={() => void refresh()}
                  onOpenInstalledApps={() => setActiveView("apps")}
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
          isShell={selectedApp.id === shellAppId}
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
  onAction,
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
  onAction: (app: CoreApp, action: AppAction) => void;
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
          <NavigationSection title="Host" compact={compact}>
            <SidebarButton compact={compact} active={activeView === "dashboard" && !workspace} icon={Gauge} label="Dashboard" onClick={() => onNavigate("dashboard")} />
            <SidebarButton compact={compact} active={activeView === "apps" && !workspace} icon={Boxes} label="Installed Apps" onClick={() => onNavigate("apps")} />
            {canManageApps && (
              <SidebarButton compact={compact} active={activeView === "users"} icon={Users} label="User Management" onClick={() => onNavigate("users")} />
            )}
          </NavigationSection>

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
                  onAction={onAction}
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
  onAction,
}: {
  app: CoreApp;
  compact: boolean;
  busyAction: string | null;
  workspace: EmbeddedWorkspace | null;
  onLaunch: (app: CoreApp, page: AppPageLink, target?: AppOpenTarget) => Promise<void>;
  getStandaloneHref: (app: CoreApp, page: AppPageLink) => string;
  onAction: (app: CoreApp, action: AppAction) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = getAppPageLinks(app);
  const primaryPage = pages[0] ?? null;
  const running = app.runtimeState === "running";
  const active = workspace?.appId === app.id;
  const canOpen = running && primaryPage !== null;
  const canOpenStandalone = canOpen;
  const canStart = !running;
  const startBusy = busyAction === `${app.id}:start`;
  const compactStartMode = compact && canStart;

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
              : canOpen || compactStartMode
                ? "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                : "cursor-not-allowed text-muted-foreground opacity-70",
          )}
          disabled={compactStartMode ? startBusy : !canOpen}
          title={compactStartMode ? `Start ${app.displayName}` : app.displayName}
          onClick={() => {
            if (compactStartMode) {
              onAction(app, "start");
              return;
            }

            if (primaryPage) {
              void onLaunch(app, primaryPage, "workspace");
            }
          }}
        >
          {compactStartMode && startBusy ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
          ) : compactStartMode ? (
            <Play className="h-4 w-4 shrink-0" />
          ) : (
            <LayoutGrid className="h-4 w-4 shrink-0" />
          )}
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
        {!compact && canStart && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0"
            title={`Start ${app.displayName}`}
            aria-label={`Start ${app.displayName}`}
            disabled={startBusy}
            onClick={() => onAction(app, "start")}
          >
            {startBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
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
    ["Runtime host", status?.runtimePublicHost || "unknown"],
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
  apps,
  shellAppId,
  canManageApps,
  loading,
  busyAction,
  onRefresh,
  onInstall,
  onAction,
  onCreateBackup,
  onOpenPanel,
}: {
  apps: CoreApp[];
  shellAppId: string;
  canManageApps: boolean;
  loading: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onInstall: () => void;
  onAction: (app: CoreApp, action: AppAction) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: (app: CoreApp, view: DetailView) => void;
}) {
  const isRefreshing = loading;

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

      {loading && apps.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : apps.length === 0 ? (
        <EmptyState icon={Boxes} title="No installed apps" description="Install a runtime app to make it available in the shell." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[240px]">App</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>UI</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <InstalledAppRow
                  key={app.id}
                  app={app}
                  isShell={app.id === shellAppId}
                  canManageApps={canManageApps}
                  busyAction={busyAction}
                  onAction={onAction}
                  onCreateBackup={onCreateBackup}
                  onOpenPanel={onOpenPanel}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function InstalledAppRow({
  app,
  isShell,
  canManageApps,
  busyAction,
  onAction,
  onCreateBackup,
  onOpenPanel,
}: {
  app: CoreApp;
  isShell: boolean;
  canManageApps: boolean;
  busyAction: string | null;
  onAction: (app: CoreApp, action: AppAction) => void;
  onCreateBackup: (app: CoreApp) => void;
  onOpenPanel: (app: CoreApp, view: DetailView) => void;
}) {
  const running = app.runtimeState === "running";
  const canOpen = isShell || getAppPageLinks(app).length > 0;
  const canControl = canManageApps && !isShell;
  const canInspect = canManageApps;
  const canBackup = canManageApps && app.capabilities.includes("backup");
  const canConfigure = canControl && Boolean(app.settings?.length);
  const canUpdate = canControl && app.capabilities.includes("update");
  const canRemove = canControl && app.capabilities.includes("remove");
  const isBusy = (action: string) => busyAction === `${app.id}:${action}`;

  return (
    <TableRow>
      <TableCell>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{app.displayName}</span>
            {app.lastError && <CircleAlert className="h-4 w-4 text-destructive" />}
          </div>
          <div className="truncate text-xs text-muted-foreground">{app.id}</div>
        </div>
      </TableCell>
      <TableCell>{app.selectedRuntime || "none"}</TableCell>
      <TableCell>{app.version}</TableCell>
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
  onOpenPanel: (app: CoreApp, view: DetailView) => void;
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
  onApply: (plan: CoreInstallPlan, settings: Record<string, string | null>) => void;
}) {
  const [manifestPath, setManifestPath] = useState("");
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [reviewedManifestPath, setReviewedManifestPath] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});
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

    onApply(reviewedPlan, settings);
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
              <FactCard label="Digest" value={reviewedPlan.targetManifestDigest.slice(0, 16)} />
            </div>
            {reviewedPlan.settings.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Settings</h3>
                {reviewedPlan.settings.map((setting) => (
                  <SettingInput key={setting.key} setting={setting} value={settingsDraft[setting.key] ?? ""} onChange={(value) => setSettingsDraft((current) => ({ ...current, [setting.key]: value }))} />
                ))}
              </div>
            )}
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
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      const payload = (await response.json()) as UserManagementResponse;
      setUsers(payload.users || []);
      setInvitations(payload.invitations || []);
      setApps(payload.apps || payload.modules || []);
      if (payload.inviteTtlOptions?.length) {
        setTtlOptions(payload.inviteTtlOptions);
        setInviteTtlMs(payload.inviteTtlOptions[1]?.ttlMs ?? payload.inviteTtlOptions[0].ttlMs);
      }
    } catch (caught) {
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
    setAccessAppIds(user.assignedModuleIds);
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
                  <TableCell>{user.role === "host.admin" ? "All apps" : `${user.assignedModuleIds.length} apps`}</TableCell>
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
                  <TableCell>{invitation.role === "host.admin" ? "All apps" : `${invitation.assignedModuleIds.length} apps`}</TableCell>
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
  isShell,
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
  isShell: boolean;
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
  onConfigure: (app: CoreApp, settings: Record<string, string | null>) => void;
  onReloadUpdatePlan: (app: CoreApp) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn("sm:max-w-3xl", view === "logs" && "sm:max-w-5xl")}>
        <DialogHeader>
          <DialogTitle>{detailTitle(view)} · {app.displayName}</DialogTitle>
          <DialogDescription>{app.id}</DialogDescription>
        </DialogHeader>
        {detail.error && <InlineError message={detail.error} />}
        {view === "logs" && <LogsPanel app={app} detail={detail} onRefresh={onRefreshLogs} />}
        {view === "backups" && (
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
        {view === "configure" && <ConfigurePanel app={app} busyAction={busyAction} canManageApps={canManageApps && !isShell} onConfigure={onConfigure} />}
        {view === "update" && <UpdatePanel app={app} detail={detail} busyAction={busyAction} onReloadPlan={onReloadUpdatePlan} onApplyUpdate={onApplyUpdate} />}
        {view === "remove" && <RemovePanel app={app} busyAction={busyAction} canRemove={canManageApps && !isShell} onRemove={onRemove} />}
      </DialogContent>
    </Dialog>
  );
}

function LogsPanel({ app, detail, onRefresh }: { app: CoreApp; detail: DetailPanelState; onRefresh: (app: CoreApp) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => onRefresh(app)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <pre className="max-h-[480px] overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-50">{detail.loading ? "Loading logs" : detail.logs || "No logs"}</pre>
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

function ConfigurePanel({ app, busyAction, canManageApps, onConfigure }: { app: CoreApp; busyAction: string | null; canManageApps: boolean; onConfigure: (app: CoreApp, settings: Record<string, string | null>) => void }) {
  const settings = app.settings || [];
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? "" : setting.value || ""])));
  }, [app.id, settings]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: Record<string, string | null> = {};
    for (const setting of settings) {
      const value = draft[setting.key] ?? "";
      if (!setting.secret || value.length > 0) {
        payload[setting.key] = value;
      }
    }
    onConfigure(app, payload);
  };

  if (settings.length === 0) {
    return <EmptyState icon={Settings2} title="No settings" />;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {settings.map((setting) => (
        <SettingInput key={setting.key} setting={setting} value={draft[setting.key] ?? ""} disabled={!canManageApps} onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))} />
      ))}
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
            <FactCard label="Digest" value={plan.planDigest.slice(0, 16)} />
          </div>
          <div className="rounded-md border p-4">
            <h3 className="mb-2 text-sm font-medium">Changes</h3>
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No changes reported.</p>
            ) : (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {plan.changes.map((change) => <li key={change}>- {change}</li>)}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => onApplyUpdate(app, plan)} disabled={busyAction === `${app.id}:update`}>
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
  const postTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) {
      return;
    }

    frame.contentWindow.postMessage(
      {
        type: "hosty:shell-theme",
        theme,
        preference: themePreference,
      },
      getPostMessageTargetOrigin(workspace.src),
    );
  }, [theme, themePreference, workspace.src]);

  useEffect(() => {
    postTheme();
  }, [postTheme]);

  return (
    <iframe
      ref={iframeRef}
      key={`${workspace.appId}:${workspace.path}:${workspace.src}`}
      className="hosty-app-frame"
      title={`${workspace.title}: ${workspace.pageLabel}`}
      src={workspace.src}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      allow="clipboard-write"
      onLoad={postTheme}
    />
  );
}

function getPostMessageTargetOrigin(src: string) {
  try {
    return new URL(src, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

function SettingInput({ setting, value, disabled, onChange }: { setting: CoreInstallSetting | CoreSetting; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`setting-${setting.key}`} className="flex items-center gap-2">
        {setting.key}
        <Badge variant="outline">{setting.secret ? "secret" : setting.type}</Badge>
      </Label>
      <Input
        id={`setting-${setting.key}`}
        type={setting.secret ? "password" : "text"}
        value={value}
        placeholder={setting.secret ? "Unchanged" : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
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
