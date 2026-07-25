"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Database, FileText, FolderGit2, HardDrive, Info, LoaderCircle, Lock, Plus, Radio, RefreshCw, Rss, Settings2, Trash2, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { detailTitle, formatBytes, formatUpdateChange, isAppAutostartEnabled } from "../app-helpers";
import { getAppFeeds, isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import {
  buildPublicOriginGroups,
  isPublicOriginSettingKey,
  PublicOriginInput,
  SettingInput,
} from "../settings";
import type {
  CoreApp,
  CoreAppFeedsResponse,
  CoreBackup,
  CoreBackupCleanupPlan,
  CoreGlobalMount,
  CoreMountSlot,
  CoreRemovalImpact,
  CoreUpdatePlan,
  DetailPanelState,
  DetailView,
  LogsResponse,
  LogsServiceSegment,
  MountBindingInput,
  RemoveOptions,
  SettingsTab,
} from "../types";
import { CheckboxRow, EmptyState, FactCard, IconButton, InlineError } from "../ui";

export function AppDetailsDialog({
  app,
  view,
  settingsTab,
  coreOrigin,
  globalMounts,
  canManageApps,
  isShell,
  busyAction,
  detail,
  onClose,
  onRefreshBackups,
  onCreateBackup,
  onRestoreBackup,
  onDeleteBackup,
  onPreviewBackupCleanup,
  onApplyBackupCleanup,
  onConfigure,
  onConfigureMounts,
  onConfigureSource,
  onClearSource,
  onSetDevelopmentMode,
  onApplyUpdate,
  onSetFeed,
  onRemove,
  onLoadRemovalImpact,
  onRevealSetting,
}: {
  app: CoreApp;
  view: DetailView;
  settingsTab?: SettingsTab;
  coreOrigin: string;
  globalMounts: CoreGlobalMount[];
  canManageApps: boolean;
  // True when this app is the Shell serving the current page — its update view carries a
  // self-update warning (the Shell restarts under the operator, then the page reloads).
  isShell: boolean;
  busyAction: string | null;
  detail: DetailPanelState;
  onClose: () => void;
  onRefreshBackups: (app: CoreApp, activate?: boolean) => void;
  onCreateBackup: (app: CoreApp) => void;
  onRestoreBackup: (app: CoreApp, backup: CoreBackup) => void;
  onDeleteBackup: (app: CoreApp, backup: CoreBackup) => void;
  onPreviewBackupCleanup: (app: CoreApp) => void;
  onApplyBackupCleanup: (app: CoreApp, plan: CoreBackupCleanupPlan) => void;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void;
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
  onConfigureSource: (app: CoreApp, path: string) => void;
  onClearSource: (app: CoreApp) => void;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan, manifestPath?: string) => void;
  onSetFeed: (app: CoreApp, feedId: string) => void;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
  // Advisory "what does this affect" preview, loaded when the remove view opens.
  onLoadRemovalImpact?: (appId: string) => Promise<CoreRemovalImpact | null>;
  // Fetches one setting's stored value on the operator's explicit reveal click (admin-gated in Core).
  onRevealSetting?: (app: CoreApp, key: string) => Promise<string | null>;
}) {
  // Every verb is available for system apps, removal included: "system" governs who may see and reach
  // an app, never whether it can be uninstalled. The remove panel explains the consequences instead.
  const canRemoveApp = canManageApps;
  const canConfigureApp = canManageApps;
  const canUpdateApp = canManageApps;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detailTitle(view)} · {app.displayName}</DialogTitle>
          <DialogDescription>{app.id}</DialogDescription>
        </DialogHeader>
        {detail.error && <InlineError message={detail.error} />}
        {view === "backups" && (canManageApps ? (
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
        ) : (
          <InlineError message="You do not have permission to manage app backups." />
        ))}
        {view === "settings" && (canConfigureApp ? (
          <SettingsDialog
            app={app}
            busyAction={busyAction}
            canManageApps={canConfigureApp}
            globalMounts={globalMounts}
            initialTab={settingsTab}
            onConfigure={onConfigure}
            onConfigureMounts={onConfigureMounts}
            onConfigureSource={onConfigureSource}
            onClearSource={onClearSource}
            onSetDevelopmentMode={onSetDevelopmentMode}
            onRevealSetting={onRevealSetting}
          />
        ) : (
          <InlineError message="You do not have permission to manage app settings." />
        ))}
        {view === "update" && (canUpdateApp ? (
          <UpdatePanel app={app} detail={detail} coreOrigin={coreOrigin} canManageApps={canUpdateApp} isShell={isShell} busyAction={busyAction} onApplyUpdate={onApplyUpdate} onSetFeed={onSetFeed} />
        ) : (
          <InlineError message="You do not have permission to update apps." />
        ))}
        {view === "remove" && (
          <RemovePanel
            app={app}
            busyAction={busyAction}
            canRemove={canRemoveApp}
            isShell={isShell}
            onRemove={onRemove}
            onLoadImpact={onLoadRemovalImpact}
          />
        )}
        {view === "logs" && <ConsoleLogsPanel app={app} coreOrigin={coreOrigin} />}
      </DialogContent>
    </Dialog>
  );
}

type ConsoleLogsState = { loading: boolean; error: string | null; text: string; services: LogsServiceSegment[] };

// Per-app console logs (docker logs) tail, opened from the Installed Apps actions menu. Served
// on-demand by Core, so it works even when the telemetry backend is off — deliberately distinct from
// the structured OTLP-logs stream in the Observability section. Multi-service apps get a tab per service.
function ConsoleLogsPanel({ app, coreOrigin }: { app: CoreApp; coreOrigin: string }) {
  const [state, setState] = useState<ConsoleLogsState>({ loading: false, error: null, text: "", services: [] });
  const [activeService, setActiveService] = useState<string | null>(null);

  const loadLogs = useCallback(async (signal?: AbortSignal) => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/logs?tail=200`, {
        credentials: "include",
        signal,
      });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }
      const payload = (await response.json()) as LogsResponse;
      const services = payload.services ?? [];
      setState({ loading: false, error: null, text: payload.text || "", services });
      setActiveService((current) =>
        current && services.some((segment) => segment.service === current) ? current : services[0]?.service ?? null,
      );
    } catch (error) {
      // A superseded request (app switched / dialog closed) aborts — leave the newer request's state.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (isAuthRequiredRedirectError(error)) {
        return;
      }
      setState({
        loading: false,
        error: error instanceof Error ? error.message : "Console logs are unavailable.",
        text: "",
        services: [],
      });
    }
  }, [app.id, coreOrigin]);

  // Abort an in-flight fetch when the app changes or the dialog closes, so a slow response for a
  // previous app can never overwrite the current one's logs.
  useEffect(() => {
    const controller = new AbortController();
    void loadLogs(controller.signal);
    return () => controller.abort();
  }, [loadLogs]);

  const hasTabs = state.services.length > 1;
  const activeSegment = state.services.find((segment) => segment.service === activeService) ?? state.services[0];
  const body = state.loading
    ? "Loading logs"
    : state.services.length > 0
      ? activeSegment?.text || "No logs"
      : state.text || "No logs";

  return (
    <DialogBody className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void loadLogs()} disabled={state.loading}>
          <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin")} />
          Refresh
        </Button>
        {hasTabs &&
          state.services.map((segment) => (
            <Button
              key={segment.service}
              variant={segment.service === activeService ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setActiveService(segment.service)}
            >
              {segment.service}
            </Button>
          ))}
      </div>
      {state.error && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          {state.error}
        </div>
      )}
      <pre className="min-h-[20rem] min-w-0 max-w-full flex-1 overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-50">
        {body}
      </pre>
    </DialogBody>
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
    <DialogBody className="space-y-4">
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
      {isRunning && (
        <div className="flex items-start gap-2 rounded-md border p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Creating a backup briefly stops this running app while its data is copied, then restarts it.</span>
        </div>
      )}
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
    </DialogBody>
  );
}

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "app", label: "App settings" },
  { id: "publicOrigins", label: "Public origins" },
  { id: "mounts", label: "Mounts" },
  { id: "source", label: "Source" },
];

// Consolidated runtime-app configuration: App settings, Public origins, and Mounts as tabs. A tab is
// hidden when the app has no matching data; with a single tab the bar is omitted. App settings and
// public origins share one settings form (one configure endpoint); mounts saves separately.
function SettingsDialog({
  app,
  busyAction,
  canManageApps,
  globalMounts,
  initialTab,
  onConfigure,
  onConfigureMounts,
  onConfigureSource,
  onClearSource,
  onSetDevelopmentMode,
  onRevealSetting,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  globalMounts: CoreGlobalMount[];
  initialTab?: SettingsTab;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void;
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
  onConfigureSource: (app: CoreApp, path: string) => void;
  onClearSource: (app: CoreApp) => void;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
  onRevealSetting?: (app: CoreApp, key: string) => Promise<string | null>;
}) {
  const settings = app.settings || [];
  const hasPublicOrigins = settings.some((setting) => isPublicOriginSettingKey(setting.key));
  const hasMounts = (app.mounts?.length ?? 0) > 0;
  const hasSource = Boolean(app.supportsSource);
  const availableTabs = SETTINGS_TABS.filter((tab) => {
    switch (tab.id) {
      case "app":
        return true;
      case "publicOrigins":
        return hasPublicOrigins;
      case "mounts":
        return hasMounts;
      case "source":
        return hasSource;
    }
  });
  const defaultTab: SettingsTab = initialTab && availableTabs.some((tab) => tab.id === initialTab) ? initialTab : "app";
  const [active, setActive] = useState<SettingsTab>(defaultTab);

  // Reset the active tab while rendering when the app or requested tab changes.
  const resetSignature = `${app.id}|${initialTab ?? ""}`;
  const [prevReset, setPrevReset] = useState<string | null>(null);
  if (prevReset !== resetSignature) {
    setPrevReset(resetSignature);
    setActive(defaultTab);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {availableTabs.length > 1 && (
        <div className="flex gap-1 border-b">
          {availableTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                active === tab.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      {/* All forms stay mounted (toggled with hidden) so drafts survive tab switches. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", active !== "app" && active !== "publicOrigins" && "hidden")}>
        <SettingsForm
          app={app}
          section={active === "publicOrigins" ? "publicOrigins" : "app"}
          busyAction={busyAction}
          canManageApps={canManageApps}
          onConfigure={onConfigure}
          onRevealSetting={onRevealSetting}
        />
      </div>
      {hasMounts && (
        <div className={cn("flex min-h-0 flex-1 flex-col", active !== "mounts" && "hidden")}>
          <MountsForm
            app={app}
            busyAction={busyAction}
            canManageApps={canManageApps}
            globalMounts={globalMounts}
            onConfigureMounts={onConfigureMounts}
          />
        </div>
      )}
      {hasSource && (
        <div className={cn("flex min-h-0 flex-1 flex-col", active !== "source" && "hidden")}>
          <SourceForm
            app={app}
            busyAction={busyAction}
            canManageApps={canManageApps}
            onConfigureSource={onConfigureSource}
            onClearSource={onClearSource}
            onSetDevelopmentMode={onSetDevelopmentMode}
          />
        </div>
      )}
    </div>
  );
}

function SettingsForm({
  app,
  section,
  busyAction,
  canManageApps,
  onConfigure,
  onRevealSetting,
}: {
  app: CoreApp;
  section: "app" | "publicOrigins";
  busyAction: string | null;
  canManageApps: boolean;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void;
  onRevealSetting?: (app: CoreApp, key: string) => Promise<string | null>;
}) {
  const settings = app.settings || [];
  const appSettings = settings.filter((setting) => !isPublicOriginSettingKey(setting.key));
  const publicOriginSettings = settings.filter((setting) => isPublicOriginSettingKey(setting.key));
  const publicOriginGroups = buildPublicOriginGroups(app, publicOriginSettings);
  const settingsSignature = settings
    .map((setting) => [setting.key, setting.type, setting.secret ? "1" : "0", setting.required ? "1" : "0", setting.value ?? ""].join("\u0000"))
    .join("\u0001");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [autostartDraft, setAutostartDraft] = useState(isAppAutostartEnabled(app));

  // Reset the draft while rendering when the app identity or its settings change, not in an effect.
  // https://react.dev/learn/you-might-not-need-an-effect
  const resetSignature = `${app.id}\u0001${app.autostart}\u0001${settingsSignature}`;
  const [prevResetSignature, setPrevResetSignature] = useState<string | null>(null);
  if (prevResetSignature !== resetSignature) {
    setPrevResetSignature(resetSignature);
    setDraft(Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? "" : setting.value || ""])));
    setAutostartDraft(isAppAutostartEnabled(app));
  }

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
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        {section === "app" ? (
          <>
            <div className="rounded-md border bg-muted/30 p-3">
              <CheckboxRow label="Start at Core startup" checked={autostartDraft} disabled={!canManageApps} onChange={setAutostartDraft} />
            </div>
            {appSettings.length > 0 ? (
              <div className="space-y-3">
                {appSettings.map((setting) => (
                  <SettingInput
                    key={setting.key}
                    setting={setting}
                    value={draft[setting.key] ?? ""}
                    disabled={!canManageApps}
                    onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))}
                    onReveal={onRevealSetting && setting.secret ? () => onRevealSetting(app, setting.key) : undefined}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This app has no app-owned settings.</p>
            )}
          </>
        ) : (
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
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="submit" disabled={!canManageApps || busyAction === `${app.id}:configure`}>
          {busyAction === `${app.id}:configure` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
          Save settings
        </Button>
      </DialogFooter>
    </form>
  );
}

type MountRow = { source: "global" | "local"; globalMountName: string; label: string; hostPath: string };

const MOUNT_CONTROL_CLASS =
  "flex h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function MountsForm({
  app,
  busyAction,
  canManageApps,
  globalMounts,
  onConfigureMounts,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  globalMounts: CoreGlobalMount[];
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
}) {
  const slots: CoreMountSlot[] = app.mounts || [];
  const slotsSignature = JSON.stringify(
    slots.map((slot) => [slot.key, slot.bindings.map((binding) => [binding.source ?? "local", binding.globalMountName ?? "", binding.label, binding.hostPath])]),
  );
  const [rows, setRows] = useState<Record<string, MountRow[]>>({});

  useEffect(() => {
    setRows(Object.fromEntries(slots.map((slot) => [
      slot.key,
      slot.bindings.map((binding) => ({
        source: binding.source === "global" ? "global" : "local",
        globalMountName: binding.globalMountName ?? "",
        label: binding.label,
        hostPath: binding.hostPath,
      } satisfies MountRow)),
    ])));
    // slotsSignature captures app.mounts contents so user edits are not reset on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, slotsSignature]);

  const globalByName = useMemo(() => new Map(globalMounts.map((mount) => [mount.name, mount])), [globalMounts]);

  const updateRow = (key: string, index: number, patch: Partial<MountRow>) => {
    setRows((current) => {
      const next = (current[key] ?? []).slice();
      next[index] = { ...next[index], ...patch };
      return { ...current, [key]: next };
    });
  };

  const addRow = (key: string) => {
    const source: "global" | "local" = globalMounts.length > 0 ? "global" : "local";
    setRows((current) => ({
      ...current,
      [key]: [...(current[key] ?? []), { source, globalMountName: globalMounts[0]?.name ?? "", label: "", hostPath: "" }],
    }));
  };

  const removeRow = (key: string, index: number) => {
    setRows((current) => ({ ...current, [key]: (current[key] ?? []).filter((_, rowIndex) => rowIndex !== index) }));
  };

  if (slots.length === 0) {
    return <EmptyState icon={HardDrive} title="No external storage" description="This app does not declare any external mount slots." />;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const mounts: MountBindingInput[] = [];
    for (const slot of slots) {
      for (const row of rows[slot.key] ?? []) {
        if (row.source === "global") {
          if (row.globalMountName) {
            mounts.push({ key: slot.key, globalMountName: row.globalMountName });
          }
        } else {
          const label = row.label.trim();
          const hostPath = row.hostPath.trim();
          if (label.length > 0 && hostPath.length > 0) {
            mounts.push({ key: slot.key, label, hostPath });
          }
        }
      }
    }
    onConfigureMounts(app, mounts);
  };

  const busy = busyAction === `${app.id}:mounts`;

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Global mounts come from Shared mounts — label and path are fixed. Local paths bind a host folder directly; they must be absolute and outside the Hosty data root. External folders are never backed up or deleted by Hosty.
        </p>
        {slots.map((slot) => {
          const slotRows = rows[slot.key] ?? [];
          const canAdd = slot.multiple || slotRows.length === 0;
          return (
            <div key={slot.key} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{slot.key}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {[slot.mode, slot.multiple ? "multiple" : "single", slot.required ? "required" : "optional", slot.service ? `service: ${slot.service}` : null].filter(Boolean).join(" · ")}
                </span>
              </div>
              {slotRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No host paths configured.</p>
              ) : (
                <div className="space-y-2">
                  {slotRows.map((row, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <select
                        aria-label={`${slot.key} source`}
                        className={cn(MOUNT_CONTROL_CLASS, "w-28")}
                        value={row.source}
                        disabled={!canManageApps}
                        onChange={(event) =>
                          updateRow(
                            slot.key,
                            index,
                            event.target.value === "global"
                              ? { source: "global", globalMountName: row.globalMountName || globalMounts[0]?.name || "" }
                              : { source: "local" },
                          )
                        }
                      >
                        <option value="global" disabled={globalMounts.length === 0}>Global</option>
                        <option value="local">Local</option>
                      </select>
                      {row.source === "global" ? (
                        <>
                          <select
                            aria-label={`${slot.key} shared mount`}
                            className={cn(MOUNT_CONTROL_CLASS, "w-44")}
                            value={row.globalMountName}
                            disabled={!canManageApps || globalMounts.length === 0}
                            onChange={(event) => updateRow(slot.key, index, { globalMountName: event.target.value })}
                          >
                            {globalMounts.length === 0 ? (
                              <option value="">No shared mounts</option>
                            ) : (
                              globalMounts.map((mount) => (
                                <option key={mount.name} value={mount.name}>{mount.name}</option>
                              ))
                            )}
                          </select>
                          <div className="flex h-9 flex-1 items-center gap-1.5 rounded-md border bg-muted/40 px-3 text-muted-foreground">
                            <Lock className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate font-mono text-xs">{globalByName.get(row.globalMountName)?.hostPath ?? "—"}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <Input
                            aria-label={`${slot.key} label`}
                            placeholder="label"
                            className="w-44"
                            value={row.label}
                            disabled={!canManageApps}
                            onChange={(event) => updateRow(slot.key, index, { label: event.target.value })}
                          />
                          <Input
                            aria-label={`${slot.key} host path`}
                            placeholder="/srv/path"
                            className="flex-1 font-mono text-xs"
                            value={row.hostPath}
                            disabled={!canManageApps}
                            onChange={(event) => updateRow(slot.key, index, { hostPath: event.target.value })}
                          />
                        </>
                      )}
                      <IconButton title="Remove path" destructive disabled={!canManageApps} onClick={() => removeRow(slot.key, index)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
              {canAdd && (
                <Button type="button" variant="outline" size="sm" disabled={!canManageApps} onClick={() => addRow(slot.key)}>
                  <Plus className="h-4 w-4" />
                  Add path
                </Button>
              )}
            </div>
          );
        })}
      </DialogBody>
      <DialogFooter>
        <Button type="submit" disabled={busy || !canManageApps}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
          Save mounts
        </Button>
      </DialogFooter>
    </form>
  );
}

// Source override for apps that can run from a local folder (CoreApp.supportsSource). "Standard"
// clears the override so Core uses its recorded source; "Custom" points the app at an operator
// repo folder. The stored override arrives on the app summary, so saving refreshes it in place.
function SourceForm({
  app,
  busyAction,
  canManageApps,
  onConfigureSource,
  onClearSource,
  onSetDevelopmentMode,
}: {
  app: CoreApp;
  busyAction: string | null;
  canManageApps: boolean;
  onConfigureSource: (app: CoreApp, path: string) => void;
  onClearSource: (app: CoreApp) => void;
  onSetDevelopmentMode: (app: CoreApp, runtime: string, enabled: boolean) => void;
}) {
  // Source (localCommand) runtimes can be flipped between live (Development Mode ON) and reviewed (OFF).
  // Require developmentMode to be present so the toggle only appears against a Core that supports it
  // (older Core omits the field and has no /development-mode endpoint).
  const sourceRuntimes = (app.runtimeProfiles ?? []).filter(
    (profile) => profile.type === "localCommand" && profile.developmentMode !== undefined,
  );
  const devBusy = busyAction === `${app.id}:development-mode`;
  const overridePath = app.sourceOverridePath ?? "";
  const [mode, setMode] = useState<"standard" | "custom">(overridePath ? "custom" : "standard");
  const [pathDraft, setPathDraft] = useState(overridePath);

  // Reset while rendering when the app identity or its stored override changes, not in an effect.
  // https://react.dev/learn/you-might-not-need-an-effect
  const resetSignature = `${app.id}\u0001${overridePath}`;
  const [prevReset, setPrevReset] = useState<string | null>(null);
  if (prevReset !== resetSignature) {
    setPrevReset(resetSignature);
    setMode(overridePath ? "custom" : "standard");
    setPathDraft(overridePath);
  }

  const busy = busyAction === `${app.id}:source`;
  const trimmedPath = pathDraft.trim();
  const customInvalid = mode === "custom" && trimmedPath.length === 0;
  // Only enable Save when it would change something: a new custom path, or clearing an existing override.
  const dirty = mode === "custom" ? trimmedPath !== overridePath : overridePath.length > 0;
  const modeName = `${app.id}-source-mode`;
  const inputId = `${app.id}-source-path`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === "custom") {
      if (trimmedPath.length === 0) {
        return;
      }
      onConfigureSource(app, trimmedPath);
    } else {
      onClearSource(app);
    }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        {sourceRuntimes.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Development Mode</div>
            <p className="text-xs text-muted-foreground">
              On runs the runtime live from the source folder below (edits adopted on restart, no reviewed
              update). Off uses the reviewed manifest and hides the Live badge. Takes effect on the
              runtime&apos;s next start.
            </p>
            <div className="space-y-1.5">
              {sourceRuntimes.map((profile) => {
                const on = (profile.developmentMode ?? profile.development) === true;
                return (
                  <div key={profile.key} className="flex items-center gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        <code className="font-mono">{profile.key}</code>
                        {profile.key === app.selectedRuntime ? (
                          <span className="ml-2 text-xs text-muted-foreground">selected</span>
                        ) : null}
                      </div>
                      <div className={cn("text-xs", on ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                        {on ? "Live — runs from source" : "Reviewed — not run live"}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`Development Mode for ${profile.key}`}
                      disabled={!canManageApps || devBusy}
                      onClick={() => onSetDevelopmentMode(app, profile.key, !on)}
                      className={cn(
                        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                        on ? "bg-emerald-600 dark:bg-emerald-500" : "bg-input",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
                          on ? "translate-x-4" : "translate-x-0.5",
                        )}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-muted-foreground">
            When a runtime&apos;s Development Mode is on, Core runs the app live from the selected source folder and adopts manifest edits on restart. The folder must exist on the host.
          </p>
        </div>
        <div className="space-y-2">
          <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3", mode === "standard" && "border-foreground")}>
            <input
              type="radio"
              name={modeName}
              className="mt-1"
              checked={mode === "standard"}
              disabled={!canManageApps}
              onChange={() => setMode("standard")}
            />
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium">Standard Hosty source</div>
              <div className="text-xs text-muted-foreground">
                Use the source Core recorded when the app was installed
                {app.sourceManagedPath ? (
                  <> · <code className="font-mono">{app.sourceManagedPath}</code></>
                ) : null}
                .
              </div>
            </div>
          </label>
          <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3", mode === "custom" && "border-foreground")}>
            <input
              type="radio"
              name={modeName}
              className="mt-1"
              checked={mode === "custom"}
              disabled={!canManageApps}
              onChange={() => setMode("custom")}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="text-sm font-medium">Custom source folder</div>
              <div className="text-xs text-muted-foreground">Point this app at a repository folder on the host.</div>
              <Input
                id={inputId}
                placeholder="/srv/apps/my-app"
                className="font-mono text-xs"
                value={pathDraft}
                disabled={!canManageApps || mode !== "custom"}
                onChange={(event) => setPathDraft(event.target.value)}
              />
            </div>
          </label>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="submit" disabled={!canManageApps || busy || customInvalid || !dirty}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderGit2 className="h-4 w-4" />}
          Save source
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdatePanel({
  app,
  detail,
  coreOrigin,
  canManageApps,
  isShell,
  busyAction,
  onApplyUpdate,
  onSetFeed,
}: {
  app: CoreApp;
  detail: DetailPanelState;
  coreOrigin: string;
  canManageApps: boolean;
  isShell: boolean;
  busyAction: string | null;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan, manifestPath?: string) => void;
  onSetFeed: (app: CoreApp, feedId: string) => void;
}) {
  const plan = detail.updatePlan;

  // A live source runtime adopts its manifest on restart and has no reviewed-update path; the Update
  // affordance is normally hidden, but a deep link can still open this view, so explain rather than
  // running a plan that Core would refuse (see CoreApp.live and runtime-app-update.md).
  if (app.live) {
    return (
      <DialogBody>
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-1">
            <p className="font-medium text-emerald-700 dark:text-emerald-300">This runtime is live</p>
            <p className="text-muted-foreground">Core runs this app from your source folder and adopts manifest edits on restart, so there is no reviewed update. Switch to a compiled runtime to use reviewed updates.</p>
          </div>
        </div>
      </DialogBody>
    );
  }

  // sourceConfigured is optional; only treat an explicit `false` from Core as "not configured".
  const sourceMissing = plan?.sourceConfigured === false;
  // The plan never switches the runtime — that is the Runtime switcher's job — so this stays hidden in
  // the normal flow. Show the card only when Core reports a current runtime that actually differs from
  // the target (a defensive off-chance); a missing currentRuntime (older Core) is treated as "no
  // change", not as "none", so it never falsely lights the card.
  const runtimeChanges = plan?.currentRuntime != null && plan.currentRuntime !== plan.targetRuntime;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        <FeedSection app={app} coreOrigin={coreOrigin} canManageApps={canManageApps} busyAction={busyAction} onSetFeed={onSetFeed} />
        {isShell && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This is the Shell serving this page. Applying the update briefly restarts it — keep this tab open; the page
              reloads automatically once the new Shell is up. If the new build fails to start, recover from a terminal with{" "}
              <code className="rounded bg-muted px-1">hosty apps start hosty.shell</code>.
            </span>
          </div>
        )}
        {sourceMissing && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>This plan was built from the source Core recorded at install and cannot detect edits to the original. To compare against a specific folder or URL, set a source override in Settings &rarr; Source, then reopen Update to rebuild the plan.</span>
          </div>
        )}
        {detail.loading ? (
          <EmptyState icon={LoaderCircle} title="Loading update plan" iconClassName="animate-spin" />
        ) : plan ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <FactCard label="Version" value={`${plan.currentVersion} to ${plan.targetVersion}`} />
              <FactCard label="Backup" value={plan.willCreatePreUpdateBackup ? "pre-update" : "none"} />
              {runtimeChanges && (
                <FactCard label="Runtime" value={`${plan.currentRuntime} to ${plan.targetRuntime}`} />
              )}
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
          </>
        ) : (
          <EmptyState icon={Upload} title="No update plan" />
        )}
      </DialogBody>
      {!detail.loading && plan && (
        <DialogFooter className="sm:items-center">
          <Button onClick={() => onApplyUpdate(app, plan)} disabled={plan.changes.length === 0 || busyAction === `${app.id}:update`}>
            {busyAction === `${app.id}:update` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Apply update
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}

// The followed-feed selector reads the app-owned feed document through Core. Marketplace is not part
// of this lifecycle path: Core resolves the installed app's FeedsUrl and owns validation/selection.
function FeedSection({
  app,
  coreOrigin,
  canManageApps,
  busyAction,
  onSetFeed,
}: {
  app: CoreApp;
  coreOrigin: string;
  canManageApps: boolean;
  busyAction: string | null;
  onSetFeed: (app: CoreApp, feedId: string) => void;
}) {
  const [feedState, setFeedState] = useState<CoreAppFeedsResponse | null>(null);
  const feeds = feedState?.feeds ?? null;
  const followed = feedState ? (feedState.followedFeedId ?? null) : (app.followedFeedId ?? null);
  const [selected, setSelected] = useState<string>(followed ?? "");

  useEffect(() => {
    // Abort the in-flight fetch on unmount or app change so a stale response can't overwrite newer
    // state while the installed app summary refreshes.
    const controller = new AbortController();
    (async () => {
      try {
        setFeedState(await getAppFeeds(coreOrigin, app.id, controller.signal));
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        // A direct-manifest install has no FeedsUrl; Core reports no feed surface for it.
        setFeedState(null);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [coreOrigin, app.followedFeedId, app.id]);

  // Track the record when a save lands (the app prop refreshes with the new followed feed) — the
  // render-time reset pattern SettingsDialog uses, which the set-state-in-effect lint rule prefers.
  const [prevFollowed, setPrevFollowed] = useState<string | null>(followed);
  if (prevFollowed !== followed) {
    setPrevFollowed(followed);
    setSelected(followed ?? "");
  }

  if (!feeds || feeds.length === 0) {
    return null;
  }

  const followedMissing = followed !== null && !feeds.some((feed) => feed.id === followed);
  const busy = busyAction === `${app.id}:feed`;

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <Rss className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Update feed</h3>
      </div>
      {followed === null && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>No feed set — feed updates are not detected for this app. Choose a feed to follow.</span>
        </div>
      )}
      {followedMissing && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>The followed feed &lsquo;{followed}&rsquo; is no longer declared by the app. Choose another feed.</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={!canManageApps || busy}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          aria-label="Update feed"
        >
          {/* Clearing is a first-class action (the endpoint accepts a blank feedId), so a followed app
              offers "None"; an unfollowed one just prompts for a choice. */}
          {followed === null ? <option value="">Choose a feed…</option> : <option value="">None (stop following)</option>}
          {followedMissing && <option value={followed}>{followed} (missing)</option>}
          {feeds.map((feed) => (
            <option key={feed.id} value={feed.id}>
              {feed.id}
              {feed.default && feeds.length > 1 ? " (default)" : ""}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          onClick={() => onSetFeed(app, selected)}
          disabled={!canManageApps || busy || selected === followed || (followed === null && selected.length === 0)}
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rss className="h-4 w-4" />}
          {selected.length === 0 && followed !== null ? "Stop following" : "Follow feed"}
        </Button>
      </div>
    </div>
  );
}

// The confirmation surface for an uninstall. Its warnings are computed, never authored per app: Core
// reports which installed apps declare a dependency on this one and who consumes the platform
// capabilities it provides, so a third-party app that took over a first-party role reads the same way.
// See docs/features/removable-system-apps/.
function RemovePanel({
  app,
  busyAction,
  canRemove,
  isShell,
  onRemove,
  onLoadImpact,
}: {
  app: CoreApp;
  busyAction: string | null;
  canRemove: boolean;
  isShell: boolean;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
  onLoadImpact?: (appId: string) => Promise<CoreRemovalImpact | null>;
}) {
  const [options, setOptions] = useState<RemoveOptions>({
    deleteData: false,
    deleteBackups: false,
    deleteSource: false,
    ignoreRuntimeErrors: false,
  });
  // Starts loading when a loader is wired at all, so the state never has to be set synchronously
  // from the effect.
  const [impactState, setImpactState] = useState<{ loading: boolean; impact: CoreRemovalImpact | null }>(() => ({
    loading: Boolean(onLoadImpact),
    impact: null,
  }));

  useEffect(() => {
    if (!onLoadImpact) {
      return;
    }

    let active = true;
    void onLoadImpact(app.id)
      .then((result) => {
        if (active) {
          setImpactState({ loading: false, impact: result });
        }
      })
      // An unavailable preview must not stand between the operator and the uninstall they asked for;
      // the panel simply shows no impact section.
      .catch(() => {
        if (active) {
          setImpactState({ loading: false, impact: null });
        }
      });

    return () => {
      active = false;
    };
  }, [app.id, onLoadImpact]);

  const dependents = impactState.impact?.dependents ?? [];
  const consumers = (impactState.impact?.capabilities ?? []).flatMap((capability) =>
    capability.consumers.map((consumer) => ({ slot: capability.slot, ...consumer })),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Runtime state is always removed. Optional cleanup controls app data, backups, and source checkout.
        </div>

        {isShell && (
          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <p className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                This is the Shell serving the page you are on. Removing it takes this web UI with it — the host and its apps keep
                running, and everything stays reachable from the terminal.
              </span>
            </p>
            <p className="pl-6">
              Reinstall with <code className="rounded bg-muted px-1">hosty setup --with {app.id}</code>.
            </p>
          </div>
        )}

        {impactState.loading && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Checking what this affects…
          </p>
        )}

        {(dependents.length > 0 || consumers.length > 0) && (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <p className="font-medium">Other apps depend on this one</p>
            <ul className="space-y-1">
              {dependents.map((dependent) => (
                <li key={`dependent-${dependent.appId}`}>
                  <span className="font-medium">{dependent.displayName}</span>
                  {dependent.required ? " requires it" : " uses it"}
                  {dependent.aliases.length > 0 && ` (${dependent.aliases.join(", ")})`}
                  {dependent.runtimeState === "running"
                    ? " — running now, and loses the connection at its next start."
                    : " — loses the connection when it next starts."}
                </li>
              ))}
              {consumers.map((consumer) => (
                <li key={`consumer-${consumer.slot}-${consumer.appId}`}>
                  <span className="font-medium">{consumer.displayName}</span> uses the {consumer.slot} this app provides; it keeps
                  running, and what it sends goes nowhere.
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2">
          <CheckboxRow label="Delete app data" checked={options.deleteData} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, deleteData: checked }))} />
          <CheckboxRow label="Delete backups" checked={options.deleteBackups} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, deleteBackups: checked }))} />
          <CheckboxRow label="Delete source checkout" checked={options.deleteSource} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, deleteSource: checked }))} />
          <CheckboxRow label="Ignore runtime errors" checked={options.ignoreRuntimeErrors} disabled={!canRemove} onChange={(checked) => setOptions((current) => ({ ...current, ignoreRuntimeErrors: checked }))} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="destructive" onClick={() => onRemove(app, options)} disabled={!canRemove || busyAction === `${app.id}:remove`}>
          {busyAction === `${app.id}:remove` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Remove app
        </Button>
      </DialogFooter>
    </div>
  );
}
