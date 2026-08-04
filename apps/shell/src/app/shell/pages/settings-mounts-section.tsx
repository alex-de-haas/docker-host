"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { HardDrive, LoaderCircle, Lock, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CoreGlobalMount } from "../types";
import { EmptyState, IconButton, InlineError } from "../ui";

const CONTROL_CLASS =
  "flex h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

type DraftMount = { name: string; hostPath: string; mode: string; description: string };

// Default mode mirrors Core, which treats an omitted mode as "rw" (no extra cap on the slot mode).
const emptyDraft: DraftMount = { name: "", hostPath: "", mode: "rw", description: "" };

// Host-wide shared mounts. Previously a dialog reached from the Installed Apps header, which put a
// host-level configuration surface behind a button on a page about apps.
export function SettingsMountsSection({
  globalMounts,
  canManageApps,
  onSave,
  onDelete,
}: {
  globalMounts: CoreGlobalMount[];
  canManageApps: boolean;
  onSave: (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => Promise<void>;
  onDelete: (name: string, force?: boolean) => Promise<void>;
}) {
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
  const [confirmForce, setConfirmForce] = useState<string | null>(null);

  const openAdd = () => {
    setDraft(emptyDraft);
    setEditing(null);
    setDialogError(null);
    setDialogOpen(true);
  };

  const openEdit = (mount: CoreGlobalMount) => {
    setDraft({ name: mount.name, hostPath: mount.hostPath, mode: mount.mode, description: mount.description ?? "" });
    setEditing(mount.name);
    setDialogError(null);
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
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Shared mounts</h3>
          <p className="text-xs text-muted-foreground">Host folders apps can attach by reference.</p>
        </div>
        <Button onClick={openAdd} disabled={!canManageApps}>
          <Plus className="h-4 w-4" />
          Add mount
        </Button>
      </div>

      {listError && <InlineError message={listError} />}

      {globalMounts.length === 0 ? (
        <EmptyState icon={HardDrive} title="No shared mounts" description="Add a host folder to make it available to apps." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
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
                <TableRow key={mount.name}>
                  <TableCell className="font-mono text-xs">{mount.name}</TableCell>
                  <TableCell className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {mount.mode === "ro" && <Lock className="h-3 w-3 shrink-0" />}
                      {/* Explicit === false: an older Core omits the field, and absent must not read as missing. */}
                      {mount.hostPathExists === false && (
                        <span
                          className="inline-flex shrink-0 text-amber-600 dark:text-amber-500"
                          title="Host path not found. Apps using this mount will fail to start until it exists — expected if the drive is not attached."
                        >
                          <TriangleAlert className="h-3 w-3" aria-label="Host path not found" />
                        </span>
                      )}
                      {mount.hostPath}
                    </span>
                  </TableCell>
                  <TableCell>{mount.mode}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{mount.usedBy > 0 ? `${mount.usedBy} app${mount.usedBy === 1 ? "" : "s"}` : "—"}</TableCell>
                  <TableCell>
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
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit shared mount: ${editing}` : "Add shared mount"}</DialogTitle>
            <DialogDescription>Paths must be absolute and outside the Hosty data root.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
            <DialogBody className="space-y-3">
              {dialogError && <InlineError message={dialogError} />}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="shared-mount-name">Name</Label>
                  <Input
                    id="shared-mount-name"
                    placeholder="media"
                    value={draft.name}
                    disabled={editing !== null}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="shared-mount-mode">Mode</Label>
                  <select
                    id="shared-mount-mode"
                    className={`${CONTROL_CLASS} w-full`}
                    value={draft.mode}
                    onChange={(event) => setDraft((current) => ({ ...current, mode: event.target.value }))}
                  >
                    <option value="ro">ro</option>
                    <option value="rw">rw</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="shared-mount-path">Host path</Label>
                <Input
                  id="shared-mount-path"
                  placeholder="/srv/media"
                  className="font-mono text-xs"
                  value={draft.hostPath}
                  onChange={(event) => setDraft((current) => ({ ...current, hostPath: event.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="shared-mount-description">Description</Label>
                <Input
                  id="shared-mount-description"
                  placeholder="Optional"
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || draft.name.trim().length === 0 || draft.hostPath.trim().length === 0}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editing ? "Save mount" : "Add mount"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
