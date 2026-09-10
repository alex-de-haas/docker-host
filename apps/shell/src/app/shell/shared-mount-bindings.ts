import type { CoreApp, CoreGlobalMount, CoreMountSlot } from "./types";

export type MountAssignments = Record<string, string[]>;
export type MountAssignmentChange = { appId: string; keys: string[]; expectedKeys: string[] };
export type MountAssignmentResult = { change: MountAssignmentChange; error?: string };

export function assignedMountKeys(app: Pick<CoreApp, "mounts">, name: string): string[] {
  return (app.mounts ?? []).filter(slot => slot.bindings.some(binding => binding.globalMountName === name)).map(slot => slot.key).sort();
}

export function mountAssignments(apps: Pick<CoreApp, "id" | "mounts">[], name: string): MountAssignments {
  return Object.fromEntries(apps.map(app => [app.id, assignedMountKeys(app, name)]));
}

export function assignmentChanges(baseline: MountAssignments, selected: MountAssignments): MountAssignmentChange[] {
  return Object.entries(selected).flatMap(([appId, keys]) => {
    const expectedKeys = baseline[appId] ?? [];
    const sorted = [...keys].sort();
    return JSON.stringify(sorted) === JSON.stringify([...expectedKeys].sort()) ? [] : [{ appId, keys: sorted, expectedKeys }];
  });
}

export function mountSlotConflict(slot: CoreMountSlot, name: string): string | null {
  const other = slot.bindings.filter(binding => binding.globalMountName !== name);
  if (!slot.multiple && other.length) return `Already uses ${other[0].label}. This slot accepts one folder.`;
  if (other.some(binding => binding.label === name)) return `An inline binding already uses the label ${name}.`;
  return null;
}

export function sharedMountPath(app: Pick<CoreApp, "selectedRuntime" | "runtimeProfiles">, slot: Pick<CoreMountSlot, "key">, mount: Pick<CoreGlobalMount, "name" | "hostPath">) {
  const runtime = app.runtimeProfiles?.find(profile => profile.key === app.selectedRuntime) ?? app.runtimeProfiles?.find(profile => profile.default);
  return runtime?.type === "localCommand" ? mount.hostPath : runtime?.type === "docker" ? `/mnt/${slot.key}/${mount.name}` : "Resolved on next start";
}

export function sharedMountMode(slot: Pick<CoreMountSlot, "mode">, mount: Pick<CoreGlobalMount, "mode">) {
  return slot.mode === "ro" || mount.mode === "ro" ? "ro" : "rw";
}

// Each app is an independent transaction. Never undo successful writes to manufacture a fleet-wide
// transaction, and never retry them after another app fails.
export async function saveMountAssignments(changes: MountAssignmentChange[], save: (change: MountAssignmentChange) => Promise<void>): Promise<MountAssignmentResult[]> {
  const results: MountAssignmentResult[] = [];
  for (const change of changes) {
    try { await save(change); results.push({ change }); }
    catch (error) { results.push({ change, error: error instanceof Error && error.message ? error.message : "Saving bindings failed." }); }
  }
  return results;
}

export function acceptSavedAssignments(baseline: MountAssignments, results: MountAssignmentResult[]): MountAssignments {
  const next = { ...baseline };
  for (const result of results) if (!result.error) next[result.change.appId] = result.change.keys;
  return next;
}
