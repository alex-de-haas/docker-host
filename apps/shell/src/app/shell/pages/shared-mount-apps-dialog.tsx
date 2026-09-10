"use client";

import { useState } from "react";
import { Check, LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CoreApp, CoreGlobalMount } from "../types";
import { acceptSavedAssignments, assignmentChanges, mountAssignments, mountSlotConflict, saveMountAssignments, sharedMountMode, sharedMountPath, type MountAssignmentChange, type MountAssignmentResult } from "../shared-mount-bindings";

export function SharedMountAppsDialog({ mount, apps, onSave, onRefresh, onReload, onClose, onSaved }: {
  mount: CoreGlobalMount;
  apps: CoreApp[];
  onSave: (name: string, change: MountAssignmentChange) => Promise<void>;
  onRefresh: () => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
  onSaved: (apps: CoreApp[]) => void;
}) {
  // Keep the reviewed selection stable while app events update the surrounding page.
  const [reviewedApps] = useState(() => apps.filter(app => (app.mounts?.length ?? 0) > 0));
  const [baseline, setBaseline] = useState(() => mountAssignments(reviewedApps, mount.name));
  const [selected, setSelected] = useState(baseline);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MountAssignmentResult[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const changes = assignmentChanges(baseline, selected);
  const visible = reviewedApps.filter(app => `${app.displayName} ${app.id}`.toLowerCase().includes(query.toLowerCase()));
  const errors = new Map(results.filter(result => result.error).map(result => [result.change.appId, result.error]));

  const save = async () => {
    setBusy(true);
    setRefreshError(null);
    try {
      const outcome = await saveMountAssignments(changes, change => onSave(mount.name, change));
      setResults(outcome);
      setBaseline(current => acceptSavedAssignments(current, outcome));
      const saved = reviewedApps.filter(app => outcome.some(result => result.change.appId === app.id && !result.error));
      if (saved.length) onSaved(saved);
      let refreshed = true;
      try { await onRefresh(); }
      catch { refreshed = false; setRefreshError("Bindings were saved, but the list could not be refreshed. Close and reopen this editor to reload it."); }
      if (refreshed && outcome.every(result => !result.error)) onClose();
    } finally { setBusy(false); }
  };

  return <Dialog open onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>Apps using {mount.name}</DialogTitle>
        <DialogDescription>Choose where this folder is attached. Running apps need a restart to apply changes.</DialogDescription>
        <p className="break-all font-mono text-xs text-muted-foreground">{mount.hostPath}</p>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search apps" placeholder="Search apps" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} disabled={busy} />
        </div>
        {refreshError && <p role="alert" className="text-sm text-destructive">{refreshError}</p>}
        {results.some(result => result.error) && <p role="alert" className="text-sm text-amber-600">Some bindings could not be saved. Successful changes are kept; retry saves only the remaining changes. Reload assignments to review conflicting edits; this resets unsaved selections.</p>}
        {errors.size > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await onReload(); } catch { setRefreshError("Assignments could not be reloaded. Try again."); setBusy(false); }
        }}>Reload assignments</Button>}
        {errors.size > 0 && query && <p className="text-xs text-muted-foreground">Clear the search to see all save errors.</p>}
        {visible.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{reviewedApps.length ? "No matching apps." : "No installed apps declare shared folder slots."}</p>}
        {visible.map(app => <section key={app.id} className="rounded-lg border p-3" aria-label={app.displayName}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div><p className="text-sm font-medium">{app.displayName}</p><p className="text-xs text-muted-foreground">{app.id}</p></div>
            {results.some(result => result.change.appId === app.id && !result.error) && <span className="flex items-center gap-1 text-xs text-emerald-600"><Check className="size-3" />Saved</span>}
          </div>
          {(app.mounts ?? []).map(slot => {
            const checked = selected[app.id]?.includes(slot.key) ?? false;
            const conflict = mountSlotConflict(slot, mount.name);
            const removingRequired = slot.required && !checked && baseline[app.id]?.includes(slot.key) && !slot.bindings.some(binding => binding.globalMountName !== mount.name);
            return <label key={slot.key} className="flex items-start gap-3 rounded-md px-1 py-2 text-sm">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-foreground" checked={checked} disabled={busy || Boolean(conflict && !checked)}
                aria-label={`${app.displayName}: ${slot.key}`} onChange={event => {
                  const checked = event.target.checked;
                  setSelected(current => ({ ...current, [app.id]: checked ? [...(current[app.id] ?? []), slot.key] : (current[app.id] ?? []).filter(key => key !== slot.key) }));
                  setResults(current => current.filter(result => result.change.appId !== app.id));
                }} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"><span>{slot.key}{slot.required && <span className="ml-2 text-xs text-muted-foreground">Required</span>}</span><span className="text-xs text-muted-foreground">{sharedMountMode(slot, mount) === "ro" ? "Read only" : "Read & write"}{slot.service ? ` · ${slot.service}` : ""}</span></span>
                <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">{sharedMountPath(app, slot, mount)}</span>
                {conflict && <span className="mt-1 block text-xs text-amber-600">{conflict}</span>}
                {removingRequired && <span className="mt-1 block text-xs text-amber-600">This app cannot start until its required slot has a folder.</span>}
              </span>
            </label>;
          })}
          {errors.has(app.id) && <p role="alert" className="mt-2 text-sm text-destructive">{errors.get(app.id)}</p>}
        </section>)}
      </DialogBody>
      <DialogFooter className="items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">{changes.length} app{changes.length === 1 ? "" : "s"} to change</p>
        <div className="flex gap-2"><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} disabled={busy || changes.length === 0}>{busy && <LoaderCircle className="size-4 animate-spin" />}Save changes</Button></div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
