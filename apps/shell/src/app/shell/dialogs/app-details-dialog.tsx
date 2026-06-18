"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Archive, Database, FileText, HardDrive, Info, LoaderCircle, Plus, RefreshCw, Settings2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { detailTitle, formatBytes, formatUpdateChange, isAppAutostartEnabled } from "../app-helpers";
import {
  buildPublicOriginGroups,
  ConfigureSection,
  hasMissingRequiredSettings,
  isPublicOriginSettingKey,
  PublicOriginInput,
  SettingInput,
} from "../settings";
import type {
  CoreApp,
  CoreBackup,
  CoreBackupCleanupPlan,
  CoreMountSlot,
  CoreUpdatePlan,
  DetailPanelState,
  DetailView,
  MountBindingInput,
  RemoveOptions,
} from "../types";
import { CheckboxRow, EmptyState, FactCard, IconButton, InlineError } from "../ui";

export function AppDetailsDialog({
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
  onConfigureMounts,
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
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
  onReloadUpdatePlan: (app: CoreApp) => void;
  onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void;
  onRemove: (app: CoreApp, options: RemoveOptions) => void;
}) {
  const canMutateApp = canManageApps && !app.system;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn("sm:max-w-3xl", view === "logs" && "sm:max-w-5xl")}>
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
        {view === "mounts" && (canMutateApp ? (
          <MountsPanel app={app} busyAction={busyAction} onConfigureMounts={onConfigureMounts} />
        ) : (
          <InlineError message="System app external storage controls are not available in Shell." />
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

function LogsPanel({ app, detail, onRefresh }: { app: CoreApp; detail: DetailPanelState; onRefresh: (app: CoreApp) => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 justify-end">
        <Button variant="outline" onClick={() => onRefresh(app)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <pre className="min-h-0 min-w-0 max-w-full flex-1 overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-50">{detail.loading ? "Loading logs" : detail.logs || "No logs"}</pre>
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

  // Reset the draft/section state while rendering when the app identity or its
  // settings change, instead of in an effect.
  // https://react.dev/learn/you-might-not-need-an-effect
  const resetSignature = `${app.id}\u0001${app.autostart}\u0001${initialOpenSection ?? ""}\u0001${settingsSignature}`;
  const [prevResetSignature, setPrevResetSignature] = useState<string | null>(null);
  if (prevResetSignature !== resetSignature) {
    setPrevResetSignature(resetSignature);
    const nextDraft = Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? "" : setting.value || ""]));
    setDraft(nextDraft);
    setAutostartDraft(isAppAutostartEnabled(app));
    setSettingsOpen(hasMissingRequiredSettings(appSettings, nextDraft));
    setPublicOriginsOpen(initialOpenSection === "publicOrigins");
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

function MountsPanel({
  app,
  busyAction,
  onConfigureMounts,
}: {
  app: CoreApp;
  busyAction: string | null;
  onConfigureMounts: (app: CoreApp, mounts: MountBindingInput[]) => void;
}) {
  const slots: CoreMountSlot[] = app.mounts || [];
  const slotsSignature = JSON.stringify(slots.map((slot) => [slot.key, slot.bindings.map((binding) => [binding.label, binding.hostPath])]));
  const [rows, setRows] = useState<Record<string, Array<{ label: string; hostPath: string }>>>({});

  useEffect(() => {
    setRows(Object.fromEntries(slots.map((slot) => [slot.key, slot.bindings.map((binding) => ({ label: binding.label, hostPath: binding.hostPath }))])));
    // slots is derived from app.mounts; slotsSignature captures its contents so user edits are not reset on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, slotsSignature]);

  if (slots.length === 0) {
    return <EmptyState icon={HardDrive} title="No external storage" description="This app does not declare any external mount slots." />;
  }

  const updateRow = (key: string, index: number, field: "label" | "hostPath", value: string) => {
    setRows((current) => {
      const next = (current[key] ?? []).slice();
      next[index] = { ...next[index], [field]: value };
      return { ...current, [key]: next };
    });
  };

  const addRow = (key: string) => {
    setRows((current) => ({ ...current, [key]: [...(current[key] ?? []), { label: "", hostPath: "" }] }));
  };

  const removeRow = (key: string, index: number) => {
    setRows((current) => ({ ...current, [key]: (current[key] ?? []).filter((_, rowIndex) => rowIndex !== index) }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const mounts: MountBindingInput[] = [];
    for (const slot of slots) {
      for (const row of rows[slot.key] ?? []) {
        const label = row.label.trim();
        const hostPath = row.hostPath.trim();
        if (label.length > 0 && hostPath.length > 0) {
          mounts.push({ key: slot.key, label, hostPath });
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
          External folders live outside app data and are never backed up or deleted by Hosty. Host paths must be absolute and outside the Hosty data root.
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
                      <Input
                        aria-label={`${slot.key} label`}
                        placeholder="label"
                        className="w-40"
                        value={row.label}
                        onChange={(event) => updateRow(slot.key, index, "label", event.target.value)}
                      />
                      <Input
                        aria-label={`${slot.key} host path`}
                        placeholder="/srv/path"
                        className="flex-1"
                        value={row.hostPath}
                        onChange={(event) => updateRow(slot.key, index, "hostPath", event.target.value)}
                      />
                      <IconButton title="Remove path" destructive onClick={() => removeRow(slot.key, index)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
              {canAdd && (
                <Button type="button" variant="outline" size="sm" onClick={() => addRow(slot.key)}>
                  <Plus className="h-4 w-4" />
                  Add path
                </Button>
              )}
            </div>
          );
        })}
      </DialogBody>
      <DialogFooter>
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
          Save external storage
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdatePanel({ app, detail, busyAction, onReloadPlan, onApplyUpdate }: { app: CoreApp; detail: DetailPanelState; busyAction: string | null; onReloadPlan: (app: CoreApp) => void; onApplyUpdate: (app: CoreApp, plan: CoreUpdatePlan) => void }) {
  const plan = detail.updatePlan;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 justify-end">
        <Button variant="outline" onClick={() => onReloadPlan(app)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Recheck
        </Button>
      </div>
      <DialogBody className="space-y-4">
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
        <DialogFooter>
          <Button onClick={() => onApplyUpdate(app, plan)} disabled={plan.changes.length === 0 || busyAction === `${app.id}:update`}>
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
