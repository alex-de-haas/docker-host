"use client";

import type { FormEvent } from "react";
import { Fragment, useState } from "react";
import { ChevronRight, LoaderCircle, Lock, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useConfirmation } from "@/components/reui/confirmation";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CoreApp, CoreGlobalMount, SharedMountsLoadStatus } from "../types";
import { HostyEmptySlots, HostyLoader } from "../../../../../../shared/web/hosty-states";
import { SharedMountAppsDialog } from "./shared-mount-apps-dialog";
import { sharedMountMode, sharedMountPath, type MountAssignmentChange } from "../shared-mount-bindings";
import { EmptyState, IconButton, InlineError } from "../ui";

type DraftMount = { name: string; hostPath: string; mode: string; description: string };

// Default mode mirrors Core, which treats an omitted mode as "rw" (no extra cap on the slot mode).
const emptyDraft: DraftMount = { name: "", hostPath: "", mode: "rw", description: "" };

// Host-wide shared mounts. Previously a dialog reached from the Installed Apps header, which put a
// host-level configuration surface behind a button on a page about apps.
export function SettingsMountsSection({
  globalMounts,
  loadStatus = { loading: false, loaded: true, error: null },
  apps,
  onSaveBindings,
  onRefresh,
  canManageApps,
  onSave,
  onDelete,
}: {
  globalMounts: CoreGlobalMount[];
  loadStatus?: SharedMountsLoadStatus;
  apps: CoreApp[];
  onSaveBindings: (name: string, change: MountAssignmentChange) => Promise<void>;
  onRefresh: () => Promise<void>;
  canManageApps: boolean;
  onSave: (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => Promise<void>;
  onDelete: (name: string, force?: boolean) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editorRevision, setEditorRevision] = useState(0);
  const [managing, setManaging] = useState<CoreGlobalMount | null>(null);
  const [savedApps, setSavedApps] = useState<CoreApp[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftMount>(emptyDraft);
  // Name of the mount being edited; null means the dialog adds a new one. Names are the mount's
  // identity in Core, so editing never allows renaming.
  const [editing, setEditing] = useState<string | null>(null);
  // Save failures render inside the dialog; delete failures render above the table.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Names whose delete was blocked because they are still referenced; a second click forces it.
  const { confirm, dialog: confirmationDialog } = useConfirmation();
  const [confirmForce, setConfirmForce] = useState<string | null>(null);

  // Opening either dialog also disarms a pending force delete: leaving it armed across an edit
  // would turn a later single click on that row's trash button into a force delete with no fresh
  // rejection in sight.
  const openAdd = () => {
    setDraft(emptyDraft);
    setEditing(null);
    setDialogError(null);
    setListError(null);
    setConfirmForce(null);
    setDialogOpen(true);
  };

  const openEdit = (mount: CoreGlobalMount) => {
    setDraft({ name: mount.name, hostPath: mount.hostPath, mode: mount.mode, description: mount.description ?? "" });
    setEditing(mount.name);
    setDialogError(null);
    setListError(null);
    setConfirmForce(null);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setDraft(emptyDraft);
    setEditing(null);
    setDialogError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManageApps) {
      return;
    }
    setDialogError(null);
    setBusy(true);
    try {
      await onSave({
        name: draft.name.trim(),
        hostPath: draft.hostPath.trim(),
        mode: draft.mode,
        description: draft.description.trim() || null,
      });
      closeDialog();
    } catch (caught) {
      setDialogError(caught instanceof Error ? caught.message : "Saving the shared mount failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mount: CoreGlobalMount, force: boolean) => {
    if (!await confirm({ title: force ? "Force delete shared mount?" : "Delete shared mount?", action: "Delete mount", destructive: true,
      description: force ? `${mount.name}: existing app bindings become inert. The directory and its data remain on disk.` : `Remove ${mount.name} from the shared mount library? The directory and its data remain on disk.` })) return;
    setListError(null);
    setBusy(true);
    try {
      await onDelete(mount.name, force);
      setConfirmForce(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Deleting the shared mount failed.";
      // Core's in-use rejection message names how many apps reference the mount; offer a force delete.
      if (!force && /referenced by|in[_ ]use/i.test(message)) {
        setConfirmForce(mount.name);
      }
      setListError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      {confirmationDialog}
      <Frame>
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Shared mounts</h2>
          <Button size="sm" onClick={openAdd} disabled={!canManageApps || busy}>
            <Plus data-icon="inline-start" />
            Add mount
          </Button>
        </FrameHeader>
        <FramePanel className="p-0">
          {savedApps.length > 0 && <p role="status" className="border-b px-4 py-3 text-sm text-muted-foreground">
            Bindings saved for {savedApps.map(app => app.displayName).join(", ")}.
            {savedApps.some(app => app.runtimeState === "running") ? " Restart running apps to apply the changes." : " Changes apply on the next start."}
          </p>}
          {listError && <div className="p-4"><InlineError message={listError} /></div>}
          {loadStatus.error && <div className="flex flex-col items-start gap-3 p-4">
            <div role="alert"><InlineError message={loadStatus.error} /></div>
            {loadStatus.loaded && globalMounts.length > 0 && <p className="text-sm text-muted-foreground">Previously loaded shared mounts are shown.</p>}
            <Button size="sm" variant="outline" disabled={busy || loadStatus.loading} onClick={() => void onRefresh()}>Retry shared mounts</Button>
          </div>}
          {loadStatus.loading && <p role="status" className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4" />Loading shared mounts…</p>}

          {globalMounts.length === 0 ? loadStatus.loaded && !loadStatus.error && !loadStatus.loading && (
            <div className="[&>div]:rounded-none [&>div]:border-0">
              <EmptyState title="No shared mounts" description="Add a host folder to make it available to apps." />
            </div>
          ) : (
            <Table className="[&_th:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4">
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Host path</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {globalMounts.map((mount) => (
                  <Fragment key={mount.name}>
                  <TableRow>
                    <TableCell className="py-3 font-mono text-xs"><button type="button" className="flex items-center gap-2 rounded-sm py-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0 focus-visible:ring-brand" aria-expanded={expanded.has(mount.name)} aria-controls={`mount-usage-${mount.name}`} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(mount.name)) next.delete(mount.name); else next.add(mount.name); return next; })}>
                      <ChevronRight className={`size-4 shrink-0 ${expanded.has(mount.name) ? "rotate-90" : ""}`} />{mount.name}
                    </button></TableCell>
                    <TableCell title={mount.hostPath} className="max-w-[200px] truncate py-3 font-mono text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        {mount.mode === "ro" && <Lock className="h-3 w-3 shrink-0" />}
                        {/* Explicit === false: an older Core omits the field, and absent must not read as missing. */}
                        {mount.hostPathExists === false && (
                          <span
                            className="inline-flex shrink-0 text-warning-foreground"
                            title="Host path not found. Apps using this mount will fail to start until it exists — expected if the drive is not attached."
                          >
                            <TriangleAlert className="h-3 w-3" aria-label="Host path not found" />
                          </span>
                        )}
                        {mount.hostPath}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">{mount.mode}</TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">{mount.usedBy > 0 ? `${mount.usedBy} app${mount.usedBy === 1 ? "" : "s"}` : "—"}</TableCell>
                    <TableCell className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton title="Edit mount" disabled={!canManageApps || busy} onClick={() => openEdit(mount)}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          title={confirmForce === mount.name ? "Force delete (bindings become inert)" : "Delete mount"}
                          destructive
                          disabled={!canManageApps || busy}
                          onClick={() => remove(mount, confirmForce === mount.name)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expanded.has(mount.name) && <TableRow id={`mount-usage-${mount.name}`} className="hover:bg-transparent">
                    <TableCell colSpan={5} className="whitespace-normal bg-muted/20 p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <h3 className="text-sm font-medium">App bindings</h3>
                        <Button size="sm" variant="outline" disabled={!canManageApps || busy} onClick={() => setManaging(mount)}><Plus className="size-4" />Manage apps</Button>
                      </div>
                      {apps.some(app => app.mounts?.some(slot => slot.bindings.some(binding => binding.globalMountName === mount.name))) ?
                        <div className="divide-y">
                          {apps.flatMap(app => (app.mounts ?? []).filter(slot => slot.bindings.some(binding => binding.globalMountName === mount.name)).map(slot => (
                            <div key={`${app.id}/${slot.key}`} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_6rem] sm:items-center sm:gap-4">
                              <div className="min-w-0"><p className="text-sm font-medium">{app.displayName}</p><p className="truncate text-xs text-muted-foreground">{app.selectedRuntime}</p></div>
                              <div><p className="text-sm">{slot.key}</p>{slot.service && <p className="text-xs text-muted-foreground">{slot.service}</p>}</div>
                              <p className="break-all font-mono text-xs text-muted-foreground" title="Path in app">{sharedMountPath(app, slot, mount)}</p>
                              <span className="text-xs text-muted-foreground">{sharedMountMode(slot, mount) === "ro" ? "Read only" : "Read & write"}</span>
                            </div>
                          )))}
                        </div> : <div className="flex items-center gap-3 py-3"><HostyEmptySlots className="size-8" /><p className="text-sm text-muted-foreground">No apps use this folder yet. Choose Manage apps to attach it.</p></div>}
                    </TableCell>
                  </TableRow>}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </FramePanel>
      </Frame>

      {managing && <SharedMountAppsDialog key={editorRevision} mount={managing} apps={apps} onSave={onSaveBindings} onRefresh={onRefresh} onReload={async () => { await onRefresh(); setEditorRevision(value => value + 1); }} onClose={() => setManaging(null)} onSaved={changed => setSavedApps(current => [...current.filter(app => !changed.some(next => next.id === app.id)), ...changed])} />}

      {/* Dismissal (Escape, overlay, the X button) is ignored while a save is in flight: resetting
          the form under a pending request would let its completion close or error a dialog the
          operator has since repurposed. */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && !busy && closeDialog()}>
        <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
          <DialogHeader className="text-left">
            <DialogTitle className="break-words pr-6 text-base leading-6">{editing ? `Edit shared mount: ${editing}` : "Add shared mount"}</DialogTitle>
            <DialogDescription>Paths must be absolute and outside the Hosty data root.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
            <DialogBody className="flex flex-col gap-4">
              {dialogError && <InlineError message={dialogError} />}
              <Frame>
                <FramePanel className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-2">
                      <Label htmlFor="shared-mount-name">Name</Label>
                      <Input
                        id="shared-mount-name"
                        placeholder="media"
                        value={draft.name}
                        disabled={editing !== null}
                        onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-2">
                      <Label htmlFor="shared-mount-mode">Mode</Label>
                      <Select value={draft.mode} onValueChange={(value) => setDraft((current) => ({ ...current, mode: value }))}>
                        <SelectTrigger id="shared-mount-mode" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectGroup>
                          <SelectItem value="ro">ro</SelectItem>
                          <SelectItem value="rw">rw</SelectItem>
                        </SelectGroup></SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <Label htmlFor="shared-mount-path">Host path</Label>
                    <Input
                      id="shared-mount-path"
                      placeholder="/srv/media"
                      className="font-mono text-xs"
                      value={draft.hostPath}
                      onChange={(event) => setDraft((current) => ({ ...current, hostPath: event.target.value }))}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <Label htmlFor="shared-mount-description">Description</Label>
                    <Input
                      id="shared-mount-description"
                      placeholder="Optional"
                      value={draft.description}
                      onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                    />
                  </div>
                </FramePanel>
              </Frame>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !canManageApps || draft.name.trim().length === 0 || draft.hostPath.trim().length === 0}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editing ? "Save mount" : "Add mount"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
