export type StorageSize = { allocatedBytes: number | null; logicalBytes: number };
export type StorageCategory = StorageSize & { id: string; partial: boolean };
export type StorageResource = StorageSize & {
  id: string;
  category: string;
  kind: string;
  label: string;
  relativePath: string;
  partial: boolean;
  appId: string | null;
  relatedAppIds: string[];
  workspaceId: string | null;
  worktreeId: string | null;
  parts: (StorageSize & { id: string })[];
};
export type StorageSnapshot = StorageSize & {
  id: string;
  startedAt: string;
  measuredAt: string;
  durationMs: number;
  partial: boolean;
  disk: { totalBytes: number; availableBytes: number } | null;
  categories: StorageCategory[];
  resources: StorageResource[];
  issues: { relativePath: string; code: string }[];
  issueCount: number;
  excludedSymlinkCount: number;
  excludedMountCount: number;
};
export type StorageState = { snapshot: StorageSnapshot | null; isScanning: boolean; lastError: string | null };

export const STORAGE_CATEGORIES: Record<string, { label: string; color: string; description: string }> = {
  apps: { label: "Applications", color: "#6366f1", description: "Installed files, application data, caches and logs." },
  sources: { label: "Sources & workspaces", color: "#06b6d4", description: "Repositories, shared Git data and individual working trees." },
  environments: { label: "Test environments", color: "#f59e0b", description: "Isolated environments and their own data." },
  backups: { label: "Backups", color: "#ec4899", description: "Stored application backups." },
  core: { label: "Core", color: "#10b981", description: "Core files, versions, logs and platform data." },
  other: { label: "Other", color: "#94a3b8", description: "Files inside the Hosty data root outside the other categories." },
};
export const STORAGE_PARTS: Record<string, string> = { data: "Data", cache: "Cache", logs: "Logs", installed: "Installed files", other: "Other" };

export function storageCategoryLabel(id: string) { return STORAGE_CATEGORIES[id]?.label ?? id; }
export function storageColor(id: string): string {
  if (STORAGE_CATEGORIES[id]) return STORAGE_CATEGORIES[id].color;
  // Resource identity determines its color, so sorting or recounting never changes the legend.
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return `hsl(${hash % 360} 62% 52%)`;
}
export function formatStorageBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}
export function storagePercent(bytes: number | null, total: number | null): string {
  if (bytes === null || total === null) return "Unavailable";
  if (total <= 0 || bytes <= 0) return "0%";
  const percentage = bytes / total * 100;
  return percentage < 0.1 ? "<0.1%" : `${percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}
export function largestFirst<T extends StorageSize & { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => (right.allocatedBytes ?? right.logicalBytes) - (left.allocatedBytes ?? left.logicalBytes) || left.id.localeCompare(right.id));
}
export function appStorage(snapshot: StorageSnapshot, appId: string) {
  const own = largestFirst(snapshot.resources.filter(resource => resource.appId === appId));
  const related = largestFirst(snapshot.resources.filter(resource => resource.appId !== appId && resource.relatedAppIds.includes(appId)));
  const allocatedBytes = own.length > 0 && own.every(resource => resource.allocatedBytes !== null)
    ? own.reduce((sum, resource) => sum + resource.allocatedBytes!, 0) : null;
  return { own, related, allocatedBytes };
}
