export type InstalledApp = {
  id: string; name: string; version: string | null; source: string; runtime: string | null;
  state: string; openUrl: string | null; manageUrl: string | null;
  update: { state: string; availableVersion: string | null; message: string | null } | null;
};
export type InstalledAppsResult = { appIds: string[]; apps: InstalledApp[] };
