"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Archive, Database, FileText, FolderGit2, HardDrive, Info, LoaderCircle, Lock, Plus, Radio, RefreshCw, Settings2, Trash2, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { detailTitle, formatBytes, formatUpdateChange, isAppAutostartEnabled } from "../app-helpers";
import {
  buildPublicOriginGroups,
  isPublicOriginSettingKey,
  PublicOriginInput,
  SettingInput,
} from "../settings";
import type {
  CoreApp,
  CoreBackup,
  CoreBackupCleanupPlan,
  CoreGlobalMount,
  CoreMountSlot,
  CoreUpdatePlan,
  DetailPanelState,
  DetailView,
  MountBindingInput,
  RemoveOptions,
  SettingsTab,
} from "../types";
import { CheckboxRow, EmptyState, FactCard, IconButton, InlineError } from "../ui";

export function AppDetailsDialog({
  app,
  view,
  settingsTab,
  globalMounts,
  canManageApps,
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
  onReloadUpdatePlan,
  onApplyUpdate,
  onRemove,
}: {
  app: CoreApp;
  view: DetailView;
  settingsTab?: SettingsTab;
  globalMounts: CoreGlobalMount[];
  canManageApps: boolean;
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
  onReloadUpdatePlan: (app: CoreApp, manifestPath?: string) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan, manifestPath?: string) => void;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
}) {
  // Settings (env/public origins/mounts/source) are available for system apps too; only backups,
  // update, and remove stay hidden for them.
  const canMutateApp = canManageApps && !app.system;
  const canConfigureApp = canManageApps;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detailTitle(view)} · {app.displayName}</DialogTitle>
          <DialogDescription>{app.id}</DialogDescription>
        </DialogHeader>
        {detail.error && <InlineError message={detail.error} />}
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
          />
        ) : (
          <InlineError message="You do not have permission to manage app settings." />
        ))}
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
}: {
  app: CoreApp;
  section: "app" | "publicOrigins";
  busyAction: string | null;
  canManageApps: boolean;
  onConfigure: (app: CoreApp, settings: Record<string, string | null>, autostart?: boolean) => void;
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
                  <SettingInput key={setting.key} setting={setting} value={draft[setting.key] ?? ""} disabled={!canManageApps} onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))} />
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

function UpdatePanel({ app, detail, busyAction, onReloadPlan, onApplyUpdate }: { app: CoreApp; detail: DetailPanelState; busyAction: string | null; onReloadPlan: (app: CoreApp, manifestPath?: string) => void; onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan, manifestPath?: string) => void }) {
  const plan = detail.updatePlan;

  // Operator-supplied source folder or manifest URL, plus the source the shown plan was built
  // from. Reset while rendering when the app identity changes instead of in an effect.
  // https://react.dev/learn/you-might-not-need-an-effect
  const [source, setSource] = useState("");
  const [lastCheckedSource, setLastCheckedSource] = useState("");
  const [prevAppId, setPrevAppId] = useState(app.id);
  if (prevAppId !== app.id) {
    setPrevAppId(app.id);
    setSource("");
    setLastCheckedSource("");
  }

  // A live source runtime adopts its manifest on restart and has no reviewed-update path; the Update
  // affordance is normally hidden, but a deep link can still open this view, so explain rather than
  // running a plan that Core would refuse (see CoreApp.live, runtime-app-marketplace.md "Live source").
  // Placed after the hooks above so render order stays stable (react-hooks/rules-of-hooks).
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

  const trimmedSource = source.trim();
  const manifestPath = trimmedSource || undefined;
  // sourceConfigured is optional; only treat an explicit `false` from Core as "not configured".
  const sourceMissing = plan?.sourceConfigured === false;
  // The shown plan was built from `lastCheckedSource`; if the field changed since, applying would
  // hit Core's plan-digest guard, so require a Recheck first instead of failing with a raw error.
  const planStale = Boolean(plan) && trimmedSource !== lastCheckedSource;
  const updateInputId = `${app.id}-update-source`;

  const recheck = () => {
    setLastCheckedSource(trimmedSource);
    onReloadPlan(app, manifestPath);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full space-y-1.5 sm:max-w-md">
          <Label htmlFor={updateInputId}>Source folder or manifest URL</Label>
          <Input
            id={updateInputId}
            placeholder="/srv/apps/my-app or https://example.com/manifest.json"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Leave blank to use the source Core recorded when the app was installed.</p>
        </div>
        <Button variant="outline" onClick={recheck} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Recheck
        </Button>
      </div>
      <DialogBody className="space-y-4">
        {sourceMissing && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Recheck only read Core&apos;s internal copy of this app, so it cannot detect edits to the original source. Enter the source folder or manifest URL above and Recheck again to compare against it.</span>
          </div>
        )}
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
          </>
        ) : (
          <EmptyState icon={Upload} title="No update plan" />
        )}
      </DialogBody>
      {!detail.loading && plan && (
        <DialogFooter className="sm:items-center">
          {planStale && (
            <p className="text-xs text-amber-700 dark:text-amber-300 sm:mr-auto">Source changed since the last check. Recheck before applying.</p>
          )}
          <Button onClick={() => onApplyUpdate(app, plan, manifestPath)} disabled={plan.changes.length === 0 || planStale || busyAction === `${app.id}:update`}>
            {busyAction === `${app.id}:update` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Apply update
          </Button>
        </DialogFooter>
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Runtime state is always removed. Optional cleanup controls app data, backups, and source checkout.
        </div>
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
