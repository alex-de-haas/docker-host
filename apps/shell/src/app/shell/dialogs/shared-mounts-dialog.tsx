"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { HardDrive, LoaderCircle, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

export function SharedMountsDialog({
  open,
  globalMounts,
  canManageApps,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  globalMounts: CoreGlobalMount[];
  canManageApps: boolean;
  onClose: () => void;
  onSave: (input: { name: string; hostPath: string; mode?: string; description?: string | null }) => Promise<void>;
  onDelete: (name: string, force?: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftMount>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Names whose delete was blocked because they are still referenced; a second click forces it.
  const [confirmForce, setConfirmForce] = useState<string | null>(null);

  const resetForm = () => {
    setDraft(emptyDraft);
    setEditing(null);
    setConfirmForce(null);
  };

  const startEdit = (mount: CoreGlobalMount) => {
    setDraft({ name: mount.name, hostPath: mount.hostPath, mode: mount.mode, description: mount.description ?? "" });
    setEditing(mount.name);
    setError(null);
    setConfirmForce(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSave({
        name: draft.name.trim(),
        hostPath: draft.hostPath.trim(),
        mode: draft.mode,
        description: draft.description.trim() || null,
      });
      resetForm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Saving the shared mount failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mount: CoreGlobalMount, force: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await onDelete(mount.name, force);
      setConfirmForce(null);
      if (editing === mount.name) {
        resetForm();
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Deleting the shared mount failed.";
      // Core's in-use rejection message names how many apps reference the mount; offer a force delete.
      if (!force && /referenced by|in[_ ]use/i.test(message)) {
        setConfirmForce(mount.name);
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Shared mounts</DialogTitle>
          <DialogDescription>Host folders apps can attach by reference. Paths must be absolute and outside the Hosty data root.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {error && <InlineError message={error} />}
          <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="shared-mount-name">Name</Label>
                <Input
                  id="shared-mount-name"
                  placeholder="media"
                  value={draft.name}
                  disabled={!canManageApps || editing !== null}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="shared-mount-mode">Mode</Label>
                <select
                  id="shared-mount-mode"
                  className={`${CONTROL_CLASS} w-full`}
                  value={draft.mode}
                  disabled={!canManageApps}
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
                disabled={!canManageApps}
                onChange={(event) => setDraft((current) => ({ ...current, hostPath: event.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="shared-mount-description">Description</Label>
              <Input
                id="shared-mount-description"
                placeholder="Optional"
                value={draft.description}
                disabled={!canManageApps}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy || !canManageApps || draft.name.trim().length === 0 || draft.hostPath.trim().length === 0}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {editing ? "Save mount" : "Add mount"}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={resetForm} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </form>

          {globalMounts.length === 0 ? (
            <EmptyState icon={HardDrive} title="No shared mounts" description="Add a host folder above to make it available to apps." />
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
                          {mount.hostPath}
                        </span>
                      </TableCell>
                      <TableCell>{mount.mode}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{mount.usedBy > 0 ? `${mount.usedBy} app${mount.usedBy === 1 ? "" : "s"}` : "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <IconButton title="Edit mount" disabled={!canManageApps || busy} onClick={() => startEdit(mount)}>
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
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
